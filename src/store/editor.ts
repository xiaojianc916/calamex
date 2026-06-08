import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import { WORKBENCH_TAB_LIMITS } from '@/constants/workbench';
import { tauriSessionStorage } from '@/store/plugins/tauriSessionStorage';
import type { IAiDiffEditorPreview } from '@/types/ai/patch';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  ICommandTemplate,
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
import type { IGitDiffPreviewPayload } from '@/types/git';
import type { TDocumentDraft, TSessionSnapshot, TSessionWorkbenchState } from '@/types/session';
import { computeDocumentMetrics } from '@/utils/document-metrics';
import { createUniqueId } from '@/utils/id';
import { formatFileSystemTextForDisplay, normalizeFileSystemPath } from '@/utils/path';
import { DEFAULT_EXECUTOR, DEFAULT_SCRIPT } from '@/utils/templates';
import { createTerminalOutputBuffer } from '@/utils/terminal-output-buffer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TERMINAL_OUTPUT_LENGTH = 120_000;
const MAX_TERMINAL_OUTPUT_CHUNK_LENGTH = 4_096;
const MAX_RUN_LOG_ENTRIES = 500;
const MAX_RUN_HISTORY_ENTRIES = 30;
const MAX_OPEN_TABS = WORKBENCH_TAB_LIMITS.maxOpenTabs;
const MAX_LOADED_CLEAN_TEXT_BUFFERS = WORKBENCH_TAB_LIMITS.maxLoadedCleanTextBuffers;
const MAX_RECENT_WORKSPACES = 10;
const MAX_RECENT_FILES = 50;
const MAX_VIEW_STATE_ENTRIES = WORKBENCH_TAB_LIMITS.maxViewStateEntries;
const MAX_EXPLORER_EXPANDED_PATHS = 120;
const MAX_DRAFT_ENTRIES = WORKBENCH_TAB_LIMITS.maxDraftEntries;
/** 单个草稿内容上限，超过则不缓存草稿，避免会话快照膨胀（脚本通常很小）。 */
const MAX_DRAFT_CONTENT_LENGTH = 512_000;

/**
 * 只有 text / image 文档会进 sessionSnapshot.openTabs 持久化。
 * 用 satisfies 把这个白名单与 TSessionSnapshot 的 union 绑死:
 * 将来 openTabs.kind 加新成员时,此处会编译期报错提示同步。
 */
const PERSISTABLE_TAB_KINDS = ['text', 'image'] as const satisfies ReadonlyArray<
  NonNullable<TSessionSnapshot['openTabs'][number]['kind']>
>;
type TPersistableTabKind = (typeof PERSISTABLE_TAB_KINDS)[number];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const isPersistableTabKind = (kind: IEditorDocument['kind']): kind is TPersistableTabKind =>
  (PERSISTABLE_TAB_KINDS as readonly string[]).includes(kind);

const hasPath = (item: IEditorDocument): item is IEditorDocument & { path: string } =>
  item.path !== null && item.path.length > 0;

const isLoadedTextDocument = (document: IEditorDocument): boolean =>
  document.kind === 'text' && document.bufferLoaded !== false;

const isUnloadableCleanTextDocument = (
  document: IEditorDocument,
  activeDocumentId: string,
): boolean =>
  document.kind === 'text' &&
  document.bufferLoaded !== false &&
  Boolean(document.path) &&
  !document.isDirty &&
  document.id !== activeDocumentId;

/**
 * 把 path 推到 recent 列表头部 (去重 + 截断到 max)。
 * pushRecentFile / pushRecentWorkspace 共用此实现。
 *
 * 返回 null 表示 path 不合法 (规范化后为空),调用方应不更新列表。
 */
const pushRecentEntry = (list: readonly string[], path: string, max: number): string[] | null => {
  const normalized = normalizeFileSystemPath(path);
  if (!normalized) return null;
  return [normalized, ...list.filter((item) => normalizeFileSystemPath(item) !== normalized)].slice(
    0,
    max,
  );
};

const EMPTY_DOCUMENT: Readonly<IEditorDocument> = Object.freeze({
  id: '',
  path: null,
  name: '未打开文件',
  kind: 'text',
  bufferLoaded: true,
  lastAccessedAt: new Date(0).toISOString(),
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

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

const createDocumentId = (): string => createUniqueId('document');
const createLogId = (): string => createUniqueId('log');
const createRunHistoryId = (): string => createUniqueId('run-history');

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

const createEmptySessionSnapshot = (): TSessionSnapshot => ({
  schemaVersion: 1,
  workspaceRoot: null,
  openTabs: [],
  activeTabPath: null,
  viewStates: [],
  workbench: {
    activeSidebarView: 'explorer',
    explorerExpandedPaths: [],
    explorerSelectedPath: null,
    isTerminalVisible: true,
  },
  recentWorkspaces: [],
  recentFiles: [],
  drafts: [],
  savedAt: new Date().toISOString(),
});

const syncDocumentState = (document: IEditorDocument): IEditorDocument => {
  if (document.kind === 'text' && document.bufferLoaded === false) {
    document.content = '';
    document.savedContent = '';
    document.isDirty = false;
    document.lineCount = 1;
    document.charCount = 0;
    return document;
  }

  const { lineCount, charCount } = computeDocumentMetrics(document.content);
  document.lineCount = lineCount;
  document.charCount = charCount;
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
  // 从 1 开始,避免 untitled-1.sh 被显式创建后出现的歧义
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
  const bufferLoaded = overrides.bufferLoaded ?? true;
  return syncDocumentState({
    id: overrides.id ?? createDocumentId(),
    path: overrides.path ?? null,
    name: overrides.name ?? resolveUntitledName(documents),
    kind,
    bufferLoaded,
    lastAccessedAt: overrides.lastAccessedAt ?? new Date().toISOString(),
    content,
    encoding,
    savedContent: overrides.savedContent ?? content,
    savedEncoding: overrides.savedEncoding ?? encoding,
    isDirty: false,
    lineCount: 1,
    charCount: 0,
    aiDiffPreview: overrides.aiDiffPreview,
    gitDiffPreview: overrides.gitDiffPreview,
  });
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditorStore = defineStore(
  'editor',
  () => {
    // State
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
    const terminalOutputBuffer = createTerminalOutputBuffer({
      maxLength: MAX_TERMINAL_OUTPUT_LENGTH,
      maxChunkLength: MAX_TERMINAL_OUTPUT_CHUNK_LENGTH,
    });
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

    // Internal helpers

    const touchSessionSnapshot = (): void => {
      sessionSnapshot.value.savedAt = new Date().toISOString();
    };

    const touchDocumentAccess = (targetDocument: IEditorDocument): void => {
      targetDocument.lastAccessedAt = new Date().toISOString();
      if (targetDocument.kind === 'text' && targetDocument.bufferLoaded !== false) {
        targetDocument.bufferLoaded = true;
      }
    };

    const clearDocumentAnalysis = (documentId: string): void => {
      if (!(documentId in documentAnalysis.value)) {
        return;
      }
      const nextValue = { ...documentAnalysis.value };
      delete nextValue[documentId];
      documentAnalysis.value = nextValue;
    };

    const evictInactiveDocumentBuffers = (): void => {
      const activeId = activeDocumentId.value;
      const candidates = documents.value
        .filter((item) => isUnloadableCleanTextDocument(item, activeId))
        .sort((left, right) => {
          const leftTime = Date.parse(left.lastAccessedAt ?? '');
          const rightTime = Date.parse(right.lastAccessedAt ?? '');
          return (
            (Number.isFinite(leftTime) ? leftTime : 0) -
            (Number.isFinite(rightTime) ? rightTime : 0)
          );
        });

      const overflow = candidates.length - MAX_LOADED_CLEAN_TEXT_BUFFERS;
      if (overflow <= 0) {
        return;
      }

      candidates.slice(0, overflow).forEach((targetDocument) => {
        targetDocument.content = '';
        targetDocument.savedContent = '';
        targetDocument.bufferLoaded = false;
        targetDocument.lineCount = 1;
        targetDocument.charCount = 0;
        targetDocument.isDirty = false;
        clearDocumentAnalysis(targetDocument.id);
      });
    };

    const pushRecentFile = (path: string): void => {
      const next = pushRecentEntry(sessionSnapshot.value.recentFiles, path, MAX_RECENT_FILES);
      if (next) {
        sessionSnapshot.value.recentFiles = next;
      }
    };

    const pushRecentWorkspace = (path: string): void => {
      const next = pushRecentEntry(
        sessionSnapshot.value.recentWorkspaces,
        path,
        MAX_RECENT_WORKSPACES,
      );
      if (next) {
        sessionSnapshot.value.recentWorkspaces = next;
      }
    };

    const syncSessionOpenTabs = (): void => {
      // 用 type predicate 同时 narrow 掉 path === null 与 ai-diff/git-diff 文档,
      // 让下面 .map 拿到的 item 是 { path: string; kind: TPersistableTabKind }。
      sessionSnapshot.value.openTabs = documents.value
        .filter(hasPath)
        .filter((item): item is IEditorDocument & { path: string; kind: TPersistableTabKind } =>
          isPersistableTabKind(item.kind),
        )
        .slice(0, WORKBENCH_TAB_LIMITS.maxPersistedOpenTabs)
        .map((item, index) => ({
          path: item.path,
          pinned: false,
          order: index,
          kind: item.kind,
        }));

      // 先取局部常量再判空,让 TS 在闭包内也能收窄掉 null,避免使用非空断言。
      const activeTabPath = sessionSnapshot.value.activeTabPath;
      if (
        activeTabPath &&
        !sessionSnapshot.value.openTabs.some(
          (tab) => normalizeFileSystemPath(tab.path) === normalizeFileSystemPath(activeTabPath),
        )
      ) {
        sessionSnapshot.value.activeTabPath = sessionSnapshot.value.openTabs[0]?.path ?? null;
      }
    };

    /**
     * 通过 watcher 维护 activeDocumentId,确保 activeDocumentId 始终指向
     * documents 中实际存在的文档 (或在空列表时为空字符串)。
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

    // Getters

    const hasActiveDocument = computed(
      () => activeDocumentId.value !== '' && documents.value.length > 0,
    );

    /**
     * 注: 此名遮蔽了浏览器全局 `document`。setup 函数体内任何用到 DOM 的代码
     * 都会取到这个 computed 而不是 window.document。如果以后此 store 要接触
     * DOM,建议把 computed 改名为 activeDocument (会影响外部 API,谨慎)。
     */
    const document = computed<IEditorDocument>(
      () => documents.value.find((item) => item.id === activeDocumentId.value) ?? EMPTY_DOCUMENT,
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
    /** 按严重程度分组，单次遍历代替三个独立 computed */
    const activeDiagnosticCounts = computed(() => {
      let errors = 0;
      let warnings = 0;
      let infos = 0;
      for (const item of activeDiagnostics.value) {
        switch (item.level) {
          case 'error':
            errors += 1;
            break;
          case 'warning':
            warnings += 1;
            break;
          default:
            infos += 1;
            break;
        }
      }
      return { errors, warnings, infos };
    });
    const activeDiagnosticErrors = computed(() => activeDiagnosticCounts.value.errors);
    const activeDiagnosticWarnings = computed(() => activeDiagnosticCounts.value.warnings);
    const activeDiagnosticInfos = computed(() => activeDiagnosticCounts.value.infos);

    const canOpenMoreTabs = computed(() => documents.value.length < MAX_OPEN_TABS);
    const hasRunArtifacts = computed(
      () =>
        activeRunSummary.value !== null ||
        lastRunResult.value !== null ||
        runLogs.value.length > 0 ||
        runHistory.value.length > 0 ||
        terminalOutputLength.value > 0,
    );

    /**
     * 当前运行的 runId:优先取 pending,其次取 activeRunSummary。
     * 供运行编排(useTerminalRun)与终端控制(useIntegratedTerminal)共用,
     * 避免两处各自拼接相同的 store 解析表达式。
     */
    const currentRunId = computed<string | null>(
      () => pendingTerminalRunId.value ?? activeRunSummary.value?.runId ?? null,
    );

    // Actions: view state & workbench

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

    // Actions: unsaved drafts (崩溃 / 意外重载后恢复未保存内容)

    const clearDocumentDraft = (path: string): void => {
      const normalized = normalizeFileSystemPath(path);
      if (!normalized) return;
      const next = sessionSnapshot.value.drafts.filter(
        (item) => normalizeFileSystemPath(item.path) !== normalized,
      );
      if (next.length !== sessionSnapshot.value.drafts.length) {
        sessionSnapshot.value.drafts = next;
        touchSessionSnapshot();
      }
    };

    const captureDocumentDraft = (path: string, content: string, baselineContent: string): void => {
      const normalized = normalizeFileSystemPath(path);
      if (!normalized) return;
      // 无未保存差异或内容过大:清除已有草稿,不再缓存。
      if (content === baselineContent || content.length > MAX_DRAFT_CONTENT_LENGTH) {
        clearDocumentDraft(normalized);
        return;
      }
      sessionSnapshot.value.drafts = [
        {
          path: normalized,
          content,
          baselineContent,
          updatedAt: new Date().toISOString(),
        },
        ...sessionSnapshot.value.drafts.filter(
          (item) => normalizeFileSystemPath(item.path) !== normalized,
        ),
      ].slice(0, MAX_DRAFT_ENTRIES);
      touchSessionSnapshot();
    };

    const getDocumentDraft = (path: string): TDocumentDraft | null => {
      const normalized = normalizeFileSystemPath(path);
      if (!normalized) return null;
      return (
        sessionSnapshot.value.drafts.find(
          (item) => normalizeFileSystemPath(item.path) === normalized,
        ) ?? null
      );
    };

    /**
     * 文档(从磁盘)打开后,尝试用已缓存草稿恢复未保存内容。
     * 仅当磁盘内容仍等于草稿基线(未被外部改动)且草稿确有差异时才恢复;
     * 否则视为过期草稿并清除。返回是否真正恢复了草稿。
     */
    const restoreDraftForDocument = (documentId: string): boolean => {
      const targetDocument = getDocumentById(documentId);
      if (
        targetDocument?.kind !== 'text' ||
        !targetDocument.path ||
        targetDocument.bufferLoaded === false
      ) {
        return false;
      }
      const draft = getDocumentDraft(targetDocument.path);
      if (!draft) return false;
      if (
        draft.baselineContent !== targetDocument.savedContent ||
        draft.content === targetDocument.savedContent
      ) {
        clearDocumentDraft(targetDocument.path);
        return false;
      }
      targetDocument.content = draft.content;
      targetDocument.bufferLoaded = true;
      syncDocumentState(targetDocument);
      return true;
    };

    const setWorkbenchSessionState = (patch: Partial<TSessionWorkbenchState>): void => {
      const explorerExpandedPaths = patch.explorerExpandedPaths
        ?.map((path) => normalizeFileSystemPath(path))
        .filter(Boolean)
        .slice(0, MAX_EXPLORER_EXPANDED_PATHS);
      sessionSnapshot.value.workbench = {
        ...sessionSnapshot.value.workbench,
        ...patch,
        ...(explorerExpandedPaths ? { explorerExpandedPaths } : {}),
        ...(patch.explorerSelectedPath !== undefined
          ? {
              explorerSelectedPath: patch.explorerSelectedPath
                ? normalizeFileSystemPath(patch.explorerSelectedPath)
                : null,
            }
          : {}),
      };
      touchSessionSnapshot();
    };

    // Actions: terminal output

    const syncTerminalOutputMetadata = (): void => {
      terminalOutputLength.value = terminalOutputBuffer.length;
      terminalOutputVersion.value += 1;
    };

    const getTerminalOutputSnapshot = (): string => terminalOutputBuffer.toString();

    const setTerminalOutputChunks = (chunks: readonly string[]): void => {
      terminalOutputBuffer.replaceWithChunks(chunks);
      syncTerminalOutputMetadata();
    };

    const appendTerminalOutputChunk = (value: string): void => {
      if (!terminalOutputBuffer.append(value)) {
        return;
      }
      syncTerminalOutputMetadata();
    };

    const setTerminalOutput = (value: string): void => {
      terminalOutputBuffer.replaceWithText(value);
      syncTerminalOutputMetadata();
    };

    /** 历史 API 别名;与 appendTerminalOutputChunk 完全同义。新代码可任选其一。 */
    const appendTerminalOutput = (value: string): void => {
      appendTerminalOutputChunk(value);
    };

    // Actions: document open / close

    const setActiveDocument = (documentId: string): void => {
      const targetDocument = documents.value.find((item) => item.id === documentId);
      if (!targetDocument) {
        return;
      }
      touchDocumentAccess(targetDocument);
      activeDocumentId.value = targetDocument.id;
      sessionSnapshot.value.activeTabPath = targetDocument.path;
      touchSessionSnapshot();
      cursorLine.value = 1;
      cursorColumn.value = 1;
      activeSelectionSummary.value = null;
      evictInactiveDocumentBuffers();
    };

    const createDocumentTab = (overrides: Partial<IEditorDocument> = {}): IEditorDocument => {
      const nextDocument = createDocument(documents.value, overrides);
      documents.value.push(nextDocument);
      setActiveDocument(nextDocument.id);
      syncSessionOpenTabs();
      touchSessionSnapshot();
      return nextDocument;
    };

    const openUnloadedTextDocumentTab = (
      path: string,
      name: string,
    ): { document: IEditorDocument; reusedExisting: boolean } => {
      const existingDocument = findDocumentByPath(path);
      if (existingDocument) {
        return { document: existingDocument, reusedExisting: true };
      }

      const nextDocument = createDocument(documents.value, {
        path,
        name,
        kind: 'text',
        content: '',
        savedContent: '',
        encoding: 'utf-8',
        savedEncoding: 'utf-8',
        bufferLoaded: false,
      });
      documents.value.push(nextDocument);
      pushRecentFile(path);
      syncSessionOpenTabs();
      touchSessionSnapshot();
      return { document: nextDocument, reusedExisting: false };
    };

    const openDocumentTab = (
      payload: IScriptFilePayload,
    ): { document: IEditorDocument; reusedExisting: boolean } => {
      const existingDocument = findDocumentByPath(payload.path);
      if (existingDocument) {
        existingDocument.path = payload.path;
        existingDocument.name = payload.name;
        existingDocument.kind = 'text';
        existingDocument.content = payload.content;
        existingDocument.encoding = payload.encoding;
        existingDocument.savedContent = payload.content;
        existingDocument.savedEncoding = payload.encoding;
        existingDocument.bufferLoaded = true;
        syncDocumentState(existingDocument);
        setActiveDocument(existingDocument.id);
        pushRecentFile(payload.path);
        syncSessionOpenTabs();
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
        bufferLoaded: true,
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
        bufferLoaded: true,
      });
      documents.value.push(nextDocument);
      setActiveDocument(nextDocument.id);
      pushRecentFile(path);
      syncSessionOpenTabs();
      touchSessionSnapshot();
      return { document: nextDocument, reusedExisting: false };
    };

    const openAiDiffDocument = (
      preview: IAiDiffEditorPreview,
    ): { document: IEditorDocument; reusedExisting: boolean } => {
      const existingDocument = documents.value.find(
        (item) => item.kind === 'ai-diff' && item.aiDiffPreview?.id === preview.id,
      );
      if (existingDocument) {
        existingDocument.aiDiffPreview = preview;
        existingDocument.name = preview.title;
        setActiveDocument(existingDocument.id);
        touchSessionSnapshot();
        return { document: existingDocument, reusedExisting: true };
      }
      const nextDocument = createDocument(documents.value, {
        id: preview.id,
        path: `ai-diff://${encodeURIComponent(preview.id)}`,
        name: preview.title,
        kind: 'ai-diff',
        content: '',
        savedContent: '',
        bufferLoaded: true,
        aiDiffPreview: preview,
      });
      documents.value.push(nextDocument);
      setActiveDocument(nextDocument.id);
      syncSessionOpenTabs();
      touchSessionSnapshot();
      return { document: nextDocument, reusedExisting: false };
    };

    const openGitDiffDocument = (
      preview: IGitDiffPreviewPayload,
    ): { document: IEditorDocument; reusedExisting: boolean } => {
      const existingDocument = documents.value.find(
        (item) => item.kind === 'git-diff' && item.gitDiffPreview?.id === preview.id,
      );
      if (existingDocument) {
        existingDocument.gitDiffPreview = preview;
        existingDocument.name = preview.title;
        existingDocument.content = preview.modifiedContent;
        existingDocument.savedContent = preview.modifiedContent;
        existingDocument.bufferLoaded = true;
        syncDocumentState(existingDocument);
        setActiveDocument(existingDocument.id);
        touchSessionSnapshot();
        return { document: existingDocument, reusedExisting: true };
      }
      const nextDocument = createDocument(documents.value, {
        id: preview.id,
        path: `git-diff://${encodeURIComponent(preview.id)}`,
        name: preview.title,
        kind: 'git-diff',
        content: preview.modifiedContent,
        savedContent: preview.modifiedContent,
        bufferLoaded: true,
        gitDiffPreview: preview,
      });
      documents.value.push(nextDocument);
      setActiveDocument(nextDocument.id);
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
      targetDocument.bufferLoaded = true;
      // 统一由本地计数器重新核算,避免与 payload.lineCount/charCount 不一致造成闪跳
      syncDocumentState(targetDocument);
      touchDocumentAccess(targetDocument);
      if (payload.path) {
        pushRecentFile(payload.path);
        syncSessionOpenTabs();
        // 已落盘:对应未保存草稿不再需要,清除以免下次启动误恢复。
        clearDocumentDraft(payload.path);
        touchSessionSnapshot();
      }
      evictInactiveDocumentBuffers();
      return targetDocument;
    };

    const unloadDocumentBuffer = (documentId: string): boolean => {
      const targetDocument = getDocumentById(documentId);
      if (
        !targetDocument ||
        !isUnloadableCleanTextDocument(targetDocument, activeDocumentId.value)
      ) {
        return false;
      }

      targetDocument.content = '';
      targetDocument.savedContent = '';
      targetDocument.bufferLoaded = false;
      targetDocument.lineCount = 1;
      targetDocument.charCount = 0;
      targetDocument.isDirty = false;
      clearDocumentAnalysis(documentId);
      return true;
    };

    // 未保存草稿的写入会变更 sessionSnapshot,从而触发持久化插件对整个会话快照做
    // JSON 序列化 + Zod 全量校验。若每次按键都同步写草稿,大文件会在输入热路径上
    // 反复付出 O(快照) 的序列化/校验开销。这里把草稿写入防抖:仅在输入停顿后落定
    // 一次,把按键热路径从 O(快照) 降到 O(1)(均摊)。文档自身的 content / 行列统计 /
    // isDirty 仍在 updateDocumentContent 中同步更新,状态栏与脏标记不受影响;草稿仅
    // 用于崩溃恢复,停顿后落定即可。
    const DRAFT_CAPTURE_DEBOUNCE_MS = 400;
    let draftCaptureTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingDraftDocumentId: string | null = null;

    const runDraftCapture = (documentId: string): void => {
      const targetDocument = getDocumentById(documentId);
      if (
        targetDocument?.kind !== 'text' ||
        !targetDocument.path ||
        targetDocument.bufferLoaded === false
      ) {
        return;
      }
      captureDocumentDraft(
        targetDocument.path,
        targetDocument.content,
        targetDocument.savedContent,
      );
    };

    const flushPendingDraftCapture = (): void => {
      if (draftCaptureTimer !== null) {
        clearTimeout(draftCaptureTimer);
        draftCaptureTimer = null;
      }
      const documentId = pendingDraftDocumentId;
      pendingDraftDocumentId = null;
      if (documentId !== null) {
        runDraftCapture(documentId);
      }
    };

    const scheduleDraftCapture = (documentId: string): void => {
      // 切到另一个文档前,先把上一个文档待写的草稿立即落定,避免防抖窗口内丢失。
      if (pendingDraftDocumentId !== null && pendingDraftDocumentId !== documentId) {
        flushPendingDraftCapture();
      }
      pendingDraftDocumentId = documentId;
      if (draftCaptureTimer !== null) {
        clearTimeout(draftCaptureTimer);
      }
      draftCaptureTimer = setTimeout(() => {
        draftCaptureTimer = null;
        const id = pendingDraftDocumentId;
        pendingDraftDocumentId = null;
        if (id !== null) {
          runDraftCapture(id);
        }
      }, DRAFT_CAPTURE_DEBOUNCE_MS);
    };

    const updateDocumentContent = (documentId: string, content: string): void => {
      const targetDocument = getDocumentById(documentId);
      if (targetDocument?.kind !== 'text') {
        return;
      }
      targetDocument.bufferLoaded = true;
      targetDocument.content = content;
      touchDocumentAccess(targetDocument);
      syncDocumentState(targetDocument);
      // 内容变更后维护未保存草稿(与磁盘基线 savedContent 比较),写入防抖见上。
      if (targetDocument.path) {
        scheduleDraftCapture(targetDocument.id);
      }
    };

    const updateActiveDocumentContent = (content: string): void => {
      updateDocumentContent(document.value.id, content);
    };

    const updateDocumentEncoding = (documentId: string, encoding: TDocumentEncoding): void => {
      const targetDocument = getDocumentById(documentId);
      if (targetDocument?.kind !== 'text' || targetDocument.bufferLoaded === false) {
        return;
      }
      targetDocument.encoding = encoding;
      syncDocumentState(targetDocument);
    };

    const updateActiveDocumentEncoding = (encoding: TDocumentEncoding): void => {
      updateDocumentEncoding(document.value.id, encoding);
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
      const closingDocument = documents.value[targetIndex];
      const wasActive = closingDocument.id === activeDocumentId.value;
      // 关闭标签即放弃其未保存草稿(用户已通过关闭流程确认)。
      if (closingDocument.path) {
        clearDocumentDraft(closingDocument.path);
      }
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
        const fallbackDocument =
          documents.value[Math.max(0, targetIndex - 1)] ?? documents.value[0];
        activeDocumentId.value = fallbackDocument.id;
        touchDocumentAccess(fallbackDocument);
        sessionSnapshot.value.activeTabPath = fallbackDocument.path;
        cursorLine.value = 1;
        cursorColumn.value = 1;
        activeSelectionSummary.value = null;
        evictInactiveDocumentBuffers();
        return fallbackDocument;
      }
      return getDocumentById();
    };

    // Actions: environment / logs / run

    // environment 刷新 (同一会话内执行器集合可能未变) 时,若用户当前选择的执行器仍然可用,
    // 则保留其选择;否则回退到推荐执行器。切换工作区时的重置由 clearWorkspaceSession 负责,
    // 两者对 selectedExecutor 的语义在此对齐。
    const setEnvironment = (payload: IExecutionEnvironment): void => {
      environment.value = payload;
      const currentStillAvailable = payload.executors.some(
        (option) => option.type === selectedExecutor.value && option.available,
      );
      if (!currentStillAvailable) {
        selectedExecutor.value = payload.recommended;
      }
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
        detail: formatFileSystemTextForDisplay(detail),
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

    // 切换工作区时重置执行器选择,与 setEnvironment 的会话内保留策略对齐。
    const clearWorkspaceSession = (): void => {
      clearDocuments();
      workspaceRootPath.value = null;
      sessionSnapshot.value.workspaceRoot = null;
      sessionSnapshot.value.workbench.explorerExpandedPaths = [];
      sessionSnapshot.value.workbench.explorerSelectedPath = null;
      clearLogs();
      activeRunSummary.value = null;
      isRunning.value = false;
      pendingTerminalRunId.value = null;
      selectedExecutor.value = DEFAULT_EXECUTOR;
      touchSessionSnapshot();
    };

    return {
      // state
      documents,
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
      sessionSnapshot,
      // getters
      document,
      documentTitle,
      hasActiveDocument,
      dirtyDocuments,
      hasDirtyDocuments,
      activeScriptAnalysis,
      activeDiagnostics,
      activeDiagnosticErrors,
      activeDiagnosticWarnings,
      activeDiagnosticInfos,
      canOpenMoreTabs,
      hasRunArtifacts,
      currentRunId,
      // queries
      getDocumentById,
      findDocumentByPath,
      getEditorViewState,
      getTerminalOutputSnapshot,
      // actions
      saveEditorViewState,
      clearDocumentDraft,
      restoreDraftForDocument,
      setWorkbenchSessionState,
      setActiveDocument,
      createDocumentTab,
      openUnloadedTextDocumentTab,
      openDocumentTab,
      openImageDocument,
      openAiDiffDocument,
      openGitDiffDocument,
      applyDocumentPayload,
      unloadDocumentBuffer,
      evictInactiveDocumentBuffers,
      updateDocumentContent,
      updateActiveDocumentContent,
      updateDocumentEncoding,
      updateActiveDocumentEncoding,
      closeDocument,
      setEnvironment,
      setTerminalOutput,
      appendTerminalOutput,
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
  },
  {
    persist: {
      key: 'shell-ide:editor',
      storage: tauriSessionStorage,
      pick: ['sessionSnapshot'],
    },
  },
);
