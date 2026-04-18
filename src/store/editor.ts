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
import { computed, ref } from 'vue';

const countCharacters = (content: string): number => Array.from(content).length;
const normalizePath = (value: string | null | undefined): string =>
  value ? value.replace(/\\/g, '/').toLowerCase() : '';
const MAX_TERMINAL_OUTPUT_LENGTH = 120_000;

type TTerminalReplayRequest = {
  runId: string;
  content: string;
  restorePrompt: boolean;
};

const createEmptyScriptAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});

let documentSequence = 0;

const createDocumentId = (): string => `document-${Date.now()}-${documentSequence++}`;

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

  let index = 2;
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
  const terminalOutput = ref<string>('');
  const runLogs = ref<IRunLogEntry[]>([]);
  const lastRunResult = ref<IRunResult | null>(null);
  const isRunning = ref(false);
  const workspaceRootPath = ref<string | null>(null);
  const activeDocumentId = ref('');
  const pendingTerminalRunId = ref<string | null>(null);
  const terminalReplayOutput = ref<TTerminalReplayRequest | null>(null);
  const documentAnalysis = ref<Record<string, IAnalyzeScriptPayload>>({});

  const ensureDocumentCollection = (): IEditorDocument => {
    if (documents.value.length > 0) {
      const activeDocument = documents.value.find((item) => item.id === activeDocumentId.value);
      if (activeDocument) {
        return activeDocument;
      }

      activeDocumentId.value = documents.value[0].id;
      return documents.value[0];
    }

    const initialDocument = createDocument(documents.value, { name: 'untitled.sh' });
    documents.value = [initialDocument];
    activeDocumentId.value = initialDocument.id;
    return initialDocument;
  };

  const getDocumentById = (documentId?: string | null): IEditorDocument => {
    if (!documentId) {
      return ensureDocumentCollection();
    }

    return documents.value.find((item) => item.id === documentId) ?? ensureDocumentCollection();
  };

  const findDocumentByPath = (path: string): IEditorDocument | undefined => {
    const normalizedPath = normalizePath(path);
    return documents.value.find((item) => normalizePath(item.path) === normalizedPath);
  };

  const document = computed<IEditorDocument>(() => ensureDocumentCollection());
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
    () =>
      activeDiagnostics.value.filter((item) => item.level === 'error').length,
  );
  const activeDiagnosticWarnings = computed(
    () =>
      activeDiagnostics.value.filter((item) => item.level === 'warning').length,
  );
  const activeDiagnosticInfos = computed(
    () =>
      activeDiagnostics.value.filter((item) => item.level === 'info' || item.level === 'style')
        .length,
  );

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
      return {
        document: existingDocument,
        reusedExisting: true,
      };
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
    return {
      document: nextDocument,
      reusedExisting: false,
    };
  };

  const openImageDocument = (
    path: string,
    name: string,
  ): { document: IEditorDocument; reusedExisting: boolean } => {
    const existingDocument = findDocumentByPath(path);
    if (existingDocument) {
      setActiveDocument(existingDocument.id);
      return {
        document: existingDocument,
        reusedExisting: true,
      };
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
    return {
      document: nextDocument,
      reusedExisting: false,
    };
  };

  const applyDocumentPayload = (
    documentId: string,
    payload: IScriptFilePayload,
  ): IEditorDocument => {
    const targetDocument = getDocumentById(documentId);
    targetDocument.path = payload.path;
    targetDocument.name = payload.name;
    targetDocument.kind = 'text';
    targetDocument.content = payload.content;
    targetDocument.encoding = payload.encoding;
    targetDocument.savedContent = payload.content;
    targetDocument.savedEncoding = payload.encoding;
    targetDocument.lineCount = payload.lineCount;
    targetDocument.charCount = payload.charCount;
    targetDocument.isDirty = false;
    return targetDocument;
  };

  const updateDocumentContent = (documentId: string, content: string): void => {
    const targetDocument = getDocumentById(documentId);
    if (targetDocument.kind !== 'text') {
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
    if (targetDocument.kind !== 'text') {
      return;
    }

    targetDocument.encoding = encoding;
    syncDocumentState(targetDocument);
  };

  const updateActiveDocumentEncoding = (encoding: TDocumentEncoding): void => {
    updateDocumentEncoding(document.value.id, encoding);
  };

  const closeDocument = (documentId: string): IEditorDocument => {
    const targetIndex = documents.value.findIndex((item) => item.id === documentId);
    if (targetIndex === -1) {
      return ensureDocumentCollection();
    }

    const wasActive = documents.value[targetIndex].id === activeDocumentId.value;
    delete documentAnalysis.value[documentId];
    documents.value.splice(targetIndex, 1);

    if (documents.value.length === 0) {
      const replacementDocument = createDocument(documents.value, { name: 'untitled.sh' });
      documents.value = [replacementDocument];
      activeDocumentId.value = replacementDocument.id;
      cursorLine.value = 1;
      cursorColumn.value = 1;
      return replacementDocument;
    }

    if (wasActive) {
      const fallbackDocument = documents.value[Math.max(0, targetIndex - 1)] ?? documents.value[0];
      activeDocumentId.value = fallbackDocument.id;
      cursorLine.value = 1;
      cursorColumn.value = 1;
      return fallbackDocument;
    }

    return ensureDocumentCollection();
  };

  const setEnvironment = (payload: IExecutionEnvironment): void => {
    environment.value = payload;
    selectedExecutor.value = DEFAULT_EXECUTOR;
  };

  const setTerminalOutput = (value: string): void => {
    terminalOutput.value = value.slice(-MAX_TERMINAL_OUTPUT_LENGTH);
  };

  const appendTerminalOutput = (value: string): void => {
    if (!value) {
      return;
    }

    terminalOutput.value = `${terminalOutput.value}${value}`.slice(-MAX_TERMINAL_OUTPUT_LENGTH);
  };

  const setCursorPosition = (line: number, column: number): void => {
    cursorLine.value = Math.max(1, line);
    cursorColumn.value = Math.max(1, column);
  };

  const appendLog = (level: TLogLevel, title: string, detail: string): void => {
    runLogs.value.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level,
      title,
      detail,
      createdAt: new Date().toISOString(),
    });
  };

  const setWorkspaceRootPath = (path: string | null): void => {
    workspaceRootPath.value = path;
  };

  const clearLogs = (): void => {
    runLogs.value = [];
    terminalOutput.value = '';
    lastRunResult.value = null;
  };

  const setPendingTerminalRunId = (value: string | null): void => {
    pendingTerminalRunId.value = value;
  };

  const queueTerminalReplayOutput = (value: TTerminalReplayRequest | null): void => {
    terminalReplayOutput.value = value;
  };

  const setDocumentAnalysis = (documentId: string, payload: IAnalyzeScriptPayload): void => {
    documentAnalysis.value = {
      ...documentAnalysis.value,
      [documentId]: payload,
    };
  };

  const clearDocumentAnalysis = (documentId: string): void => {
    if (!(documentId in documentAnalysis.value)) {
      return;
    }

    const nextValue = { ...documentAnalysis.value };
    delete nextValue[documentId];
    documentAnalysis.value = nextValue;
  };

  ensureDocumentCollection();

  return {
    documents,
    document,
    activeDocumentId,
    environment,
    cursorLine,
    cursorColumn,
    selectedExecutor,
    terminalOutput,
    runLogs,
    lastRunResult,
    isRunning,
    workspaceRootPath,
    pendingTerminalRunId,
    terminalReplayOutput,
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
    setCursorPosition,
    appendLog,
    setWorkspaceRootPath,
    setPendingTerminalRunId,
    queueTerminalReplayOutput,
    setDocumentAnalysis,
    clearDocumentAnalysis,
    clearLogs,
  };
});
