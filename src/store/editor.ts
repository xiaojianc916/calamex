import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
  IExecutionEnvironment,
  IRunHistoryEntry,
  IRunLogEntry,
  IRunResult,
  IScriptFilePayload,
  TDocumentEncoding,
  TExecutorKind,
  TLogLevel,
  TRunLogScope,
} from '@/types/editor';
import type { TSessionSnapshot } from '@/types/session';
import { tauriSessionStorage } from '@/store/plugins/tauriSessionStorage';
import { normalizeFileSystemPath } from '@/utils/path';
import { DEFAULT_EXECUTOR, DEFAULT_SCRIPT } from '@/utils/templates';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

const MAX_TERMINAL_OUTPUT_LENGTH = 120_000;
const MAX_TERMINAL_OUTPUT_CHUNK_LENGTH = 4_096;
const MAX_RUN_LOG_ENTRIES = 500;
const MAX_RUN_HISTORY_ENTRIES = 30;
const MAX_OPEN_TABS = 30;
const MAX_RECENT_WORKSPACES = 10;
const MAX_RECENT_FILES = 50;
const MAX_VIEW_STATE_ENTRIES = 30;

const countCharacters = (content: string): number => Array.from(content).length;

/**
 * 把可能在 UTF-16 代理对中间截断的字符串按 code point 边界修正。
 */
const clampToCodeUnitBoundary = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  let sliced = value.slice(value.length - maxLength);
  // 若第一个 code unit 是低位代理项，则跳过一个字符，避免单独的半个代理对
  const firstCode = sliced.charCodeAt(0);
  if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
    sliced = sliced.slice(1);
  }
  return sliced;
};

const trimLeadingCodeUnitBoundary = (value: string, startIndex: number): string => {
  if (startIndex <= 0) return value;
  if (startIndex >= value.length) return '';

  let sliced = value.slice(startIndex);
  if (!sliced) {
    return '';
  }

  const firstCode = sliced.charCodeAt(0);
  if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
    sliced = sliced.slice(1);
  }

  return sliced;
};

const EMPTY_DOCUMENT: Readonly<IEditorDocument> = Object.freeze({
  id: '',
  path: null,
  name: '未打开文件',
  kind: 'text',
  content: '',
  encoding: 'utf-8',
  savedContent: '',
  savedEncoding: 'utf-8',
  isDirty: false,
  lineCount: 1,
  charCount: 0,
});

const createEmptyScriptAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});

let idSequence = 0;
const createUniqueId = (prefix: string): string => {
  const cryptoRef =
    typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return `${prefix}-${cryptoRef.randomUUID()}`;
  }
  idSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

const createDocumentId = (): string => createUniqueId('document');
const createLogId = (): string => createUniqueId('log');
const createRunHistoryId = (): string => createUniqueId('run-history');

const createEmptySessionSnapshot = (): TSessionSnapshot => ({
  schemaVersion: 1,
  workspaceRoot: null,
  openTabs: [],
  activeTabPath: null,
  viewStates: [],
  recentWorkspaces: [],
  recentFiles: [],
  savedAt: new Date().toISOString(),
});

const syncDocumentState = (document: IEditorDocument): IEditorDocument => {
  document.lineCount = document.content.length === 0 ? 1 : document.content.split('\n').length;
  document.charCount = countCharacters(document.content);
  document.isDirty =
    document.content !== document.savedContent || document.encoding !== document.savedEncoding;
  return document;
};

const resolveUntitledName = (documents: IEditorDocument[]): string => {
  const occupiedNames = new Set(
    documents.filter((item) => !item.path).map((item) => item.name.toLowerCase()),
  );
  if (!occupiedNames.has('untitled.sh')) {
    return 'untitled.sh';
  }
  // 从 1 开始，避免 untitled-1.sh 被显式创建后出现的歧义
  let index = 1;
  while (occupiedNames.has(`untitled-${index}.sh`)) {
    index += 1;
  }
  return `untitled-${index}.sh`;
};

const createDocument = (
  documents: IEditorDocument[],
  overrides: Partial<IEditorDocument> = {},
): IEditorDocument => {
  const content = overrides.content ?? DEFAULT_SCRIPT;
  const encoding = overrides.encoding ?? 'utf-8';
  const kind = overrides.kind ?? 'text';
  return syncDocumentState({
    id: overrides.id ?? createDocumentId(),
    path: overrides.path ?? null,
    name: overrides.name ?? resolveUntitledName(documents),
    kind,
    content,
    encoding,
    savedContent: overrides.savedContent ?? content,
    savedEncoding: overrides.savedEncoding ?? encoding,
    isDirty: false,
    lineCount: 1,
    charCount: 0,
  });
};

export const useEditorStore = defineStore('editor', () => {
  const documents = ref<IEditorDocument[]>([]);
  const sessionSnapshot = ref<TSessionSnapshot>(createEmptySessionSnapshot());
  const environment = ref<IExecutionEnvironment>({
    recommended: DEFAULT_EXECUTOR,
    hasAny: false,
    executors: [],
  });
  const cursorLine = ref(1);
  const cursorColumn = ref(1);
  const activeSelectionSummary = ref<IEditorSelectionSummary | null>(null);
  const selectedExecutor = ref<TExecutorKind>(DEFAULT_EXECUTOR);
  const terminalOutputChunks = ref<string[]>([]);
  const terminalOutputLength = ref(0);
  const terminalOutputVersion = ref(0);
  const runLogs = ref<IRunLogEntry[]>([]);
  const runHistory = ref<IRunHistoryEntry[]>([]);
  const lastRunResult = ref<IRunResult | null>(null);
  const activeRunSummary = ref<IActiveRunSummary | null>(null);
  const isRunning = ref(false);
  const workspaceRootPath = ref<string | null>(null);
  const protectedWorkspaceRootPaths = ref<string[]>([]);
  const activeDocumentId = ref('');
  const pendingTerminalRunId = ref<string | null>(null);
  const documentAnalysis = ref<Record<string, IAnalyzeScriptPayload>>({});

  const touchSessionSnapshot = (): void => {
    sessionSnapshot.value.savedAt = new Date().toISOString();
  };

  const pushRecentFile = (path: string): void => {
    const normalized = normalizeFileSystemPath(path);
    if (!normalized) return;
    const next = [
      normalized,
      ...sessionSnapshot.value.recentFiles.filter(
        (item) => normalizeFileSystemPath(item) !== normalized,
      ),
    ].slice(0, MAX_RECENT_FILES);
    sessionSnapshot.value.recentFiles = next;
  };

  const pushRecentWorkspace = (path: string): void => {
    const normalized = normalizeFileSystemPath(path);
    if (!normalized) return;
    const next = [
      normalized,
      ...sessionSnapshot.value.recentWorkspaces.filter(
        (item) => normalizeFileSystemPath(item) !== normalized,
      ),
    ].slice(0, MAX_RECENT_WORKSPACES);
    sessionSnapshot.value.recentWorkspaces = next;
  };

  const syncSessionOpenTabs = (): void => {
    sessionSnapshot.value.openTabs = documents.value
      .filter((item) => Boolean(item.path))
      .slice(0, MAX_OPEN_TABS)
      .map((item, index) => ({
        path: item.path as string,
        pinned: false,
        order: index,
        kind: item.kind,
      }));

    if (
      sessionSnapshot.value.activeTabPath
      && !sessionSnapshot.value.openTabs.some(
        (tab) =>
          normalizeFileSystemPath(tab.path) === normalizeFileSystemPath(sessionSnapshot.value.activeTabPath),
      )
    ) {
      sessionSnapshot.value.activeTabPath = sessionSnapshot.value.openTabs[0]?.path ?? null;
    }
  };

  /**
   * 通过 watcher 维护 activeDocumentId，确保 activeDocumentId 始终指向
   * documents 中实际存在的文档（或在空列表时为空字符串）。
   * 这样 computed getter 就不再需要写 ref。
   */
  watch(
    [documents, activeDocumentId],
    () => {
      if (documents.value.length === 0) {
        if (activeDocumentId.value !== '') {
          activeDocumentId.value = '';
        }
        return;
      }
      const exists = documents.value.some((item) => item.id === activeDocumentId.value);
      if (!exists) {
        activeDocumentId.value = documents.value[0].id;
      }
    },
    { immediate: true, flush: 'sync' },
  );

  const getDocumentById = (documentId?: string | null): IEditorDocument | null => {
    if (!documentId) {
      if (!activeDocumentId.value) return null;
      return documents.value.find((item) => item.id === activeDocumentId.value) ?? null;
    }
    return documents.value.find((item) => item.id === documentId) ?? null;
  };

  const findDocumentByPath = (path: string): IEditorDocument | undefined => {
    if (!path) return undefined;
    const normalizedPath = normalizeFileSystemPath(path);
    if (!normalizedPath) return undefined;
    return documents.value.find(
      (item) => item.path !== null && normalizeFileSystemPath(item.path) === normalizedPath,
    );
  };

  const hasActiveDocument = computed(
    () => activeDocumentId.value !== '' && documents.value.length > 0,
  );
  const document = computed<IEditorDocument>(
    () =>
      documents.value.find((item) => item.id === activeDocumentId.value) ?? EMPTY_DOCUMENT,
  );
  const documentTitle = computed(() =>
    document.value.isDirty ? `${document.value.name} · 未保存` : document.value.name,
  );
  const dirtyDocuments = computed(() => documents.value.filter((item) => item.isDirty));
  const hasDirtyDocuments = computed(() => dirtyDocuments.value.length > 0);
  const activeScriptAnalysis = computed<IAnalyzeScriptPayload>(
    () => documentAnalysis.value[document.value.id] ?? createEmptyScriptAnalysis(),
  );
  const activeDiagnostics = computed(() => activeScriptAnalysis.value.diagnostics);
  const activeDiagnosticErrors = computed(
    () => activeDiagnostics.value.filter((item) => item.level === 'error').length,
  );
  const activeDiagnosticWarnings = computed(
    () => activeDiagnostics.value.filter((item) => item.level === 'warning').length,
  );
  const activeDiagnosticInfos = computed(
    () =>
      activeDiagnostics.value.filter((item) => item.level === 'info' || item.level === 'style')
        .length,
  );
  const canOpenMoreTabs = computed(() => documents.value.length < MAX_OPEN_TABS);
  const hasRunArtifacts = computed(
    () =>
      activeRunSummary.value !== null
      || lastRunResult.value !== null
      || runLogs.value.length > 0
      || runHistory.value.length > 0
      || terminalOutputLength.value > 0,
  );

  const saveEditorViewState = (path: string, viewState: Record<string, unknown>): void => {
    const normalized = normalizeFileSystemPath(path);
    if (!normalized) return;

    const nextEntries = [
      {
        path: normalized,
        viewState,
        updatedAt: new Date().toISOString(),
      },
      ...sessionSnapshot.value.viewStates.filter(
        (item) => normalizeFileSystemPath(item.path) !== normalized,
      ),
    ].slice(0, MAX_VIEW_STATE_ENTRIES);

    sessionSnapshot.value.viewStates = nextEntries;
    touchSessionSnapshot();
  };

  const getEditorViewState = (path: string): Record<string, unknown> | null => {
    const normalized = normalizeFileSystemPath(path);
    if (!normalized) return null;
    const item = sessionSnapshot.value.viewStates.find(
      (entry) => normalizeFileSystemPath(entry.path) === normalized,
    );
    return item?.viewState ?? null;
  };

  const getTerminalOutputSnapshot = (): string => terminalOutputChunks.value.join('');

  const setTerminalOutputChunks = (chunks: string[]): void => {
    const sanitizedChunks = chunks.filter((chunk) => chunk.length > 0);
    terminalOutputChunks.value = sanitizedChunks;
    terminalOutputLength.value = sanitizedChunks.reduce((total, chunk) => total + chunk.length, 0);
    terminalOutputVersion.value += 1;
  };

  const appendTerminalOutputChunk = (value: string): void => {
    if (!value) {
      return;
    }

    const nextChunks = terminalOutputChunks.value;
    const lastChunkIndex = nextChunks.length - 1;

    if (
      lastChunkIndex >= 0 &&
      nextChunks[lastChunkIndex].length + value.length <= MAX_TERMINAL_OUTPUT_CHUNK_LENGTH
    ) {
      nextChunks[lastChunkIndex] += value;
    } else {
      nextChunks.push(value);
    }

    let nextLength = terminalOutputLength.value + value.length;
    let overflow = nextLength - MAX_TERMINAL_OUTPUT_LENGTH;

    while (overflow > 0 && nextChunks.length > 0) {
      const firstChunk = nextChunks[0];

      if (firstChunk.length <= overflow) {
        overflow -= firstChunk.length;
        nextLength -= firstChunk.length;
        nextChunks.shift();
        continue;
      }

      const trimmedChunk = trimLeadingCodeUnitBoundary(firstChunk, overflow);
      nextLength -= firstChunk.length - trimmedChunk.length;
      overflow = 0;

      if (trimmedChunk.length > 0) {
        nextChunks[0] = trimmedChunk;
      } else {
        nextChunks.shift();
      }
    }

    terminalOutputChunks.value = nextChunks;
    terminalOutputLength.value = nextLength;
    terminalOutputVersion.value += 1;
  };

  const setActiveDocument = (documentId: string): void => {
    const targetDocument = documents.value.find((item) => item.id === documentId);
    if (!targetDocument) {
      return;
    }
    activeDocumentId.value = targetDocument.id;
    sessionSnapshot.value.activeTabPath = targetDocument.path;
    touchSessionSnapshot();
    cursorLine.value = 1;
    cursorColumn.value = 1;
    activeSelectionSummary.value = null;
  };

  const createDocumentTab = (overrides: Partial<IEditorDocument> = {}): IEditorDocument => {
    const nextDocument = createDocument(documents.value, overrides);
    documents.value.push(nextDocument);
    setActiveDocument(nextDocument.id);
    syncSessionOpenTabs();
    touchSessionSnapshot();
    return nextDocument;
  };

  const openDocumentTab = (
    payload: IScriptFilePayload,
  ): { document: IEditorDocument; reusedExisting: boolean } => {
    const existingDocument = findDocumentByPath(payload.path);
    if (existingDocument) {
      setActiveDocument(existingDocument.id);
      pushRecentFile(payload.path);
      touchSessionSnapshot();
      return { document: existingDocument, reusedExisting: true };
    }
    const nextDocument = createDocument(documents.value, {
      path: payload.path,
      name: payload.name,
      content: payload.content,
      encoding: payload.encoding,
      savedContent: payload.content,
      savedEncoding: payload.encoding,
    });
    documents.value.push(nextDocument);
    setActiveDocument(nextDocument.id);
    pushRecentFile(payload.path);
    syncSessionOpenTabs();
    touchSessionSnapshot();
    return { document: nextDocument, reusedExisting: false };
  };

  const openImageDocument = (
    path: string,
    name: string,
  ): { document: IEditorDocument; reusedExisting: boolean } => {
    const existingDocument = findDocumentByPath(path);
    if (existingDocument) {
      setActiveDocument(existingDocument.id);
      pushRecentFile(path);
      touchSessionSnapshot();
      return { document: existingDocument, reusedExisting: true };
    }
    const nextDocument = createDocument(documents.value, {
      path,
      name,
      kind: 'image',
      content: '',
      encoding: 'utf-8',
      savedContent: '',
      savedEncoding: 'utf-8',
    });
    documents.value.push(nextDocument);
    setActiveDocument(nextDocument.id);
    pushRecentFile(path);
    syncSessionOpenTabs();
    touchSessionSnapshot();
    return { document: nextDocument, reusedExisting: false };
  };

  const applyDocumentPayload = (
    documentId: string,
    payload: IScriptFilePayload,
  ): IEditorDocument => {
    const targetDocument = getDocumentById(documentId);
    if (!targetDocument) {
      return openDocumentTab(payload).document;
    }
    targetDocument.path = payload.path;
    targetDocument.name = payload.name;
    targetDocument.kind = 'text';
    targetDocument.content = payload.content;
    targetDocument.encoding = payload.encoding;
    targetDocument.savedContent = payload.content;
    targetDocument.savedEncoding = payload.encoding;
    // 统一由本地计数器重新核算，避免与 payload.lineCount/charCount 不一致造成闪跳
    syncDocumentState(targetDocument);
    if (payload.path) {
      pushRecentFile(payload.path);
      syncSessionOpenTabs();
      touchSessionSnapshot();
    }
    return targetDocument;
  };

  const updateDocumentContent = (documentId: string, content: string): void => {
    const targetDocument = getDocumentById(documentId);
    if (!targetDocument || targetDocument.kind !== 'text') {
      return;
    }
    targetDocument.content = content;
    syncDocumentState(targetDocument);
  };

  const updateActiveDocumentContent = (content: string): void => {
    updateDocumentContent(document.value.id, content);
  };

  const updateDocumentEncoding = (documentId: string, encoding: TDocumentEncoding): void => {
    const targetDocument = getDocumentById(documentId);
    if (!targetDocument || targetDocument.kind !== 'text') {
      return;
    }
    targetDocument.encoding = encoding;
    syncDocumentState(targetDocument);
  };

  const updateActiveDocumentEncoding = (encoding: TDocumentEncoding): void => {
    updateDocumentEncoding(document.value.id, encoding);
  };

  const clearDocumentAnalysis = (documentId: string): void => {
    if (!(documentId in documentAnalysis.value)) {
      return;
    }
    const nextValue = { ...documentAnalysis.value };
    delete nextValue[documentId];
    documentAnalysis.value = nextValue;
  };

  const setDocumentAnalysis = (documentId: string, payload: IAnalyzeScriptPayload): void => {
    documentAnalysis.value = {
      ...documentAnalysis.value,
      [documentId]: payload,
    };
  };

  const closeDocument = (documentId: string): IEditorDocument | null => {
    const targetIndex = documents.value.findIndex((item) => item.id === documentId);
    if (targetIndex === -1) {
      return getDocumentById();
    }
    const wasActive = documents.value[targetIndex].id === activeDocumentId.value;
    clearDocumentAnalysis(documentId);
    documents.value.splice(targetIndex, 1);
    syncSessionOpenTabs();
    touchSessionSnapshot();
    if (documents.value.length === 0) {
      activeDocumentId.value = '';
      sessionSnapshot.value.activeTabPath = null;
      cursorLine.value = 1;
      cursorColumn.value = 1;
      activeSelectionSummary.value = null;
      return null;
    }
    if (wasActive) {
      const fallbackDocument = documents.value[Math.max(0, targetIndex - 1)] ?? documents.value[0];
      activeDocumentId.value = fallbackDocument.id;
      cursorLine.value = 1;
      cursorColumn.value = 1;
      activeSelectionSummary.value = null;
      return fallbackDocument;
    }
    return getDocumentById();
  };

  const setEnvironment = (payload: IExecutionEnvironment): void => {
    environment.value = payload;
    selectedExecutor.value = DEFAULT_EXECUTOR;
  };

  const setTerminalOutput = (value: string): void => {
    const clampedValue = clampToCodeUnitBoundary(value, MAX_TERMINAL_OUTPUT_LENGTH);
    setTerminalOutputChunks(clampedValue ? [clampedValue] : []);
  };

  const appendTerminalOutput = (value: string): void => {
    appendTerminalOutputChunk(value);
  };

  const setCursorPosition = (line: number, column: number): void => {
    cursorLine.value = Math.max(1, Math.floor(line));
    cursorColumn.value = Math.max(1, Math.floor(column));
  };

  const setActiveSelectionSummary = (selection: IEditorSelectionSummary | null): void => {
    activeSelectionSummary.value = selection;
  };

  const appendLog = (
    level: TLogLevel,
    title: string,
    detail: string,
    options: {
      scope?: TRunLogScope;
      runId?: string | null;
      code?: string | null;
    } = {},
  ): IRunLogEntry => {
    const entry: IRunLogEntry = {
      id: createLogId(),
      level,
      title,
      detail,
      createdAt: new Date().toISOString(),
      scope: options.scope,
      runId: options.runId,
      code: options.code,
    };

    runLogs.value.unshift(entry);
    if (runLogs.value.length > MAX_RUN_LOG_ENTRIES) {
      runLogs.value.length = MAX_RUN_LOG_ENTRIES;
    }
    return entry;
  };

  const appendRunHistory = (entry: Omit<IRunHistoryEntry, 'id'>): void => {
    runHistory.value.unshift({
      id: createRunHistoryId(),
      ...entry,
    });

    if (runHistory.value.length > MAX_RUN_HISTORY_ENTRIES) {
      runHistory.value.length = MAX_RUN_HISTORY_ENTRIES;
    }
  };

  const setActiveRunSummary = (value: IActiveRunSummary | null): void => {
    activeRunSummary.value = value;
  };

  const setWorkspaceRootPath = (path: string | null): void => {
    workspaceRootPath.value = path;
    sessionSnapshot.value.workspaceRoot = path;
    if (path) {
      pushRecentWorkspace(path);
    }
    touchSessionSnapshot();
  };

  const setProtectedWorkspaceRootPaths = (paths: string[]): void => {
    protectedWorkspaceRootPaths.value = [...paths];
  };

  const clearDocuments = (): void => {
    documents.value = [];
    activeDocumentId.value = '';
    sessionSnapshot.value.openTabs = [];
    sessionSnapshot.value.activeTabPath = null;
    cursorLine.value = 1;
    cursorColumn.value = 1;
    activeSelectionSummary.value = null;
    documentAnalysis.value = {};
    touchSessionSnapshot();
  };

  const clearLogs = (): void => {
    runLogs.value = [];
    runHistory.value = [];
    setTerminalOutputChunks([]);
    lastRunResult.value = null;
  };

  const setPendingTerminalRunId = (value: string | null): void => {
    pendingTerminalRunId.value = value;
  };

  const clearWorkspaceSession = (): void => {
    clearDocuments();
    workspaceRootPath.value = null;
    sessionSnapshot.value.workspaceRoot = null;
    clearLogs();
    activeRunSummary.value = null;
    isRunning.value = false;
    pendingTerminalRunId.value = null;
    touchSessionSnapshot();
  };

  return {
    documents,
    document,
    hasActiveDocument,
    activeDocumentId,
    environment,
    cursorLine,
    cursorColumn,
    activeSelectionSummary,
    selectedExecutor,
    terminalOutputLength,
    terminalOutputVersion,
    runLogs,
    runHistory,
    lastRunResult,
    activeRunSummary,
    isRunning,
    workspaceRootPath,
    protectedWorkspaceRootPaths,
    pendingTerminalRunId,
    documentAnalysis,
    documentTitle,
    dirtyDocuments,
    hasDirtyDocuments,
    activeScriptAnalysis,
    activeDiagnostics,
    activeDiagnosticErrors,
    activeDiagnosticWarnings,
    activeDiagnosticInfos,
    canOpenMoreTabs,
    hasRunArtifacts,
    sessionSnapshot,
    getDocumentById,
    findDocumentByPath,
    getEditorViewState,
    saveEditorViewState,
    setActiveDocument,
    createDocumentTab,
    openDocumentTab,
    openImageDocument,
    applyDocumentPayload,
    updateDocumentContent,
    updateActiveDocumentContent,
    updateDocumentEncoding,
    updateActiveDocumentEncoding,
    closeDocument,
    setEnvironment,
    setTerminalOutput,
    appendTerminalOutput,
    getTerminalOutputSnapshot,
    setCursorPosition,
    setActiveSelectionSummary,
    appendLog,
    appendRunHistory,
    setWorkspaceRootPath,
    setProtectedWorkspaceRootPaths,
    setPendingTerminalRunId,
    setActiveRunSummary,
    setDocumentAnalysis,
    clearDocumentAnalysis,
    clearDocuments,
    clearWorkspaceSession,
    clearLogs,
  };
}, {
  persist: {
    key: 'shell-ide:editor',
    storage: tauriSessionStorage,
    pick: ['sessionSnapshot'],
  },
});
