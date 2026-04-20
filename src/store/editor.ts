import type {
  IAnalyzeScriptPayload,
  IEditorDocument,
  IExecutionEnvironment,
  IRunLogEntry,
  IRunResult,
  IScriptFilePayload,
  TDocumentEncoding,
  TExecutorKind,
  TLogLevel,
} from '@/types/editor';
import { DEFAULT_EXECUTOR, DEFAULT_SCRIPT } from '@/utils/templates';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

const MAX_TERMINAL_OUTPUT_LENGTH = 120_000;
const MAX_TERMINAL_OUTPUT_CHUNK_LENGTH = 4_096;
const MAX_RUN_LOG_ENTRIES = 500;

const countCharacters = (content: string): number => Array.from(content).length;

/**
 * 归一化路径用于"同文件判重"。
 * - 反斜杠统一为正斜杠。
 * - 仅 Windows 风格路径（`X:/...` 或 UNC `//host/...`）做大小写折叠；
 *   POSIX 路径（`/home/...`、`/mnt/c/...`）保持大小写敏感，
 *   避免在 Linux/WSL 下把不同文件误判成同一个。
 */
const normalizePath = (value: string | null | undefined): string => {
  if (!value) return '';
  const forwardSlashed = value.replace(/\\/g, '/');
  const isWindowsStyle = /^[a-zA-Z]:\//.test(forwardSlashed) || forwardSlashed.startsWith('//');
  return isWindowsStyle ? forwardSlashed.toLowerCase() : forwardSlashed;
};

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
  const environment = ref<IExecutionEnvironment>({
    recommended: DEFAULT_EXECUTOR,
    hasAny: false,
    executors: [],
  });
  const cursorLine = ref(1);
  const cursorColumn = ref(1);
  const selectedExecutor = ref<TExecutorKind>(DEFAULT_EXECUTOR);
  const terminalOutputChunks = ref<string[]>([]);
  const terminalOutputLength = ref(0);
  const terminalOutputVersion = ref(0);
  const runLogs = ref<IRunLogEntry[]>([]);
  const lastRunResult = ref<IRunResult | null>(null);
  const isRunning = ref(false);
  const workspaceRootPath = ref<string | null>(null);
  const protectedWorkspaceRootPaths = ref<string[]>([]);
  const activeDocumentId = ref('');
  const pendingTerminalRunId = ref<string | null>(null);
  const documentAnalysis = ref<Record<string, IAnalyzeScriptPayload>>({});

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
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return undefined;
    return documents.value.find(
      (item) => item.path !== null && normalizePath(item.path) === normalizedPath,
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

    const nextChunks = [...terminalOutputChunks.value];
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
    cursorLine.value = 1;
    cursorColumn.value = 1;
  };

  const createDocumentTab = (): IEditorDocument => {
    const nextDocument = createDocument(documents.value);
    documents.value.push(nextDocument);
    setActiveDocument(nextDocument.id);
    return nextDocument;
  };

  const openDocumentTab = (
    payload: IScriptFilePayload,
  ): { document: IEditorDocument; reusedExisting: boolean } => {
    const existingDocument = findDocumentByPath(payload.path);
    if (existingDocument) {
      setActiveDocument(existingDocument.id);
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
    return { document: nextDocument, reusedExisting: false };
  };

  const openImageDocument = (
    path: string,
    name: string,
  ): { document: IEditorDocument; reusedExisting: boolean } => {
    const existingDocument = findDocumentByPath(path);
    if (existingDocument) {
      setActiveDocument(existingDocument.id);
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
    if (documents.value.length === 0) {
      activeDocumentId.value = '';
      cursorLine.value = 1;
      cursorColumn.value = 1;
      return null;
    }
    if (wasActive) {
      const fallbackDocument = documents.value[Math.max(0, targetIndex - 1)] ?? documents.value[0];
      activeDocumentId.value = fallbackDocument.id;
      cursorLine.value = 1;
      cursorColumn.value = 1;
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

  const appendLog = (level: TLogLevel, title: string, detail: string): void => {
    runLogs.value.unshift({
      id: createLogId(),
      level,
      title,
      detail,
      createdAt: new Date().toISOString(),
    });
    if (runLogs.value.length > MAX_RUN_LOG_ENTRIES) {
      runLogs.value.length = MAX_RUN_LOG_ENTRIES;
    }
  };

  const setWorkspaceRootPath = (path: string | null): void => {
    workspaceRootPath.value = path;
  };

  const setProtectedWorkspaceRootPaths = (paths: string[]): void => {
    protectedWorkspaceRootPaths.value = [...paths];
  };

  const clearDocuments = (): void => {
    documents.value = [];
    activeDocumentId.value = '';
    cursorLine.value = 1;
    cursorColumn.value = 1;
    documentAnalysis.value = {};
  };

  const clearLogs = (): void => {
    runLogs.value = [];
    setTerminalOutputChunks([]);
    lastRunResult.value = null;
  };

  const setPendingTerminalRunId = (value: string | null): void => {
    pendingTerminalRunId.value = value;
  };

  const clearWorkspaceSession = (): void => {
    clearDocuments();
    workspaceRootPath.value = null;
    clearLogs();
    isRunning.value = false;
    pendingTerminalRunId.value = null;
  };

  return {
    documents,
    document,
    hasActiveDocument,
    activeDocumentId,
    environment,
    cursorLine,
    cursorColumn,
    selectedExecutor,
    terminalOutputLength,
    terminalOutputVersion,
    runLogs,
    lastRunResult,
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
    getDocumentById,
    findDocumentByPath,
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
    appendLog,
    setWorkspaceRootPath,
    setProtectedWorkspaceRootPaths,
    setPendingTerminalRunId,
    setDocumentAnalysis,
    clearDocumentAnalysis,
    clearDocuments,
    clearWorkspaceSession,
    clearLogs,
  };
});
