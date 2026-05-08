import { useDocumentLifecycle } from '@/composables/useDocumentLifecycle';
import { useDocumentPersistence } from '@/composables/useDocumentPersistence';
import { useMessage } from '@/composables/useMessage';
import { useTerminalRun } from '@/composables/useTerminalRun';
import { useTheme } from '@/composables/useTheme';
import { useWindowResizeState } from '@/composables/useWindowResizeState';
import { useWorkbenchDocumentIO } from '@/composables/useWorkbenchDocumentIO';
import { saveSession } from '@/services/sessionStore';
import { tauriService } from '@/services/tauri';
import { useAppStore } from '@/store/app';
import { useEditorStore } from '@/store/editor';
import { useGitStore } from '@/store/git';
import type {
  ICommandTemplate,
  IExecutionEnvironment,
  IWorkspaceDirectoryPayload,
  TDocumentEncoding,
} from '@/types/editor';
import { desktopRuntimeReady, waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import { isShellScriptPath } from '@/utils/file-assets';
import { COMMAND_TEMPLATES, COMMENT_TEMPLATES, DEFAULT_EXECUTOR } from '@/utils/templates';
import { computed, onScopeDispose } from 'vue';

const EMPTY_ENVIRONMENT: IExecutionEnvironment = {
  recommended: DEFAULT_EXECUTOR,
  hasAny: false,
  executors: [],
};
const WORKBENCH_RUNTIME_WAIT_MS = 160;

const isTextDocument = (document: { kind: string }): boolean => document.kind === 'text';

const isShellScriptDocument = (document: { kind: string; path: string | null; name: string }): boolean =>
  isTextDocument(document) && isShellScriptPath(document.path ?? document.name);

export const useWorkbench = () => {
  const appStore = useAppStore();
  const editorStore = useEditorStore();
  const gitStore = useGitStore();
  const notifier = useMessage();
  useTheme();
  useWindowResizeState();
  let executionEnvironmentSyncTimerId: number | null = null;

  onScopeDispose(() => {
    if (executionEnvironmentSyncTimerId !== null) {
      window.clearTimeout(executionEnvironmentSyncTimerId);
      executionEnvironmentSyncTimerId = null;
    }
  });

  const reportError = (scene: string, error: unknown, fallbackMessage: string): void => {
    const message = toErrorMessage(error, fallbackMessage);
    editorStore.appendLog('error', scene, message);
    notifier.error(message);
  };

  const syncExecutionEnvironment = async (): Promise<void> => {
    try {
      const environment = await tauriService.detectEnvironment();
      editorStore.setEnvironment(environment);
      editorStore.selectedExecutor = DEFAULT_EXECUTOR;
      editorStore.appendLog(
        environment.hasAny ? 'success' : 'error',
        '执行环境检测',
        environment.hasAny
          ? '已检测到可用的 WSL2 运行环境。'
          : '当前系统未发现可用的 WSL2 运行环境，建议先安装或启用 WSL2。',
      );
    } catch (error) {
      reportError('执行环境检测失败', error, '执行环境检测失败');
    }
  };

  const canRun = computed(() => {
    if (!editorStore.hasActiveDocument || !isShellScriptDocument(editorStore.document)) {
      return false;
    }

    if (editorStore.document.content.trim().length <= 0) {
      return false;
    }

    return editorStore.environment.hasAny;
  });

  const canSave = computed(
    () => editorStore.hasActiveDocument && isTextDocument(editorStore.document),
  );

  const flushSession = async (): Promise<void> => {
    await saveSession(editorStore.sessionSnapshot);
  };

  const refreshGitRepositoryStatus = async (
    workspaceRootPath: string | null = editorStore.workspaceRootPath,
  ): Promise<void> => {
    if (!workspaceRootPath) {
      gitStore.reset();
      return;
    }

    try {
      await gitStore.refreshRepositoryStatus(workspaceRootPath);
    } catch (error) {
      const message = toErrorMessage(error, '刷新 Git 状态失败');
      editorStore.appendLog('error', '刷新 Git 状态失败', message);
    }
  };

  const {
    buildDefaultScriptContent,
    formatDocumentWithShfmt,
    formatWorkspaceFileByPath,
    saveDocument,
    saveDocumentAs,
    saveDirtyDocuments,
  } = useDocumentPersistence({
    appStore,
    editorStore,
    refreshGitRepositoryStatus,
  });

  const {
    ensureDirtyDocumentsHandled,
    requestCloseDocument,
    requestCloseWorkspace,
    requestCloseApplication,
  } = useDocumentLifecycle({
    editorStore,
    gitStore,
    saveDocument,
    saveDirtyDocuments,
    flushSession,
  });

  const { runScript, appendTerminalOutput, handleIntegratedTerminalRunCompleted } = useTerminalRun({
    canRun,
    editorStore,
  });

  const { createNewDocument, restoreSession, openDocument, openFolder, openDocumentByPath, openGitDiffPreview, openGitDiffPreviewPayload } =
    useWorkbenchDocumentIO({
      editorStore,
      notifier,
      reportError,
      buildDefaultScriptContent,
      ensureDirtyDocumentsHandled,
      refreshGitRepositoryStatus,
    });

  const initialize = async (): Promise<{
    startupWorkspaceDirectory: IWorkspaceDirectoryPayload | null;
  }> => {
    const startupWorkspaceDirectory: IWorkspaceDirectoryPayload | null = null;

    const runtimeReady = await waitForDesktopRuntime(WORKBENCH_RUNTIME_WAIT_MS);
    if (!runtimeReady) {
      gitStore.reset();
      editorStore.setEnvironment(EMPTY_ENVIRONMENT);
      editorStore.selectedExecutor = DEFAULT_EXECUTOR;
      editorStore.appendLog(
        'info',
        '浏览器预览模式',
        '当前界面运行在浏览器预览环境，默认执行方案为 WSL2，打开、保存与执行脚本仅在 Tauri 桌面端可用。',
      );
      return {
        startupWorkspaceDirectory,
      };
    }

    editorStore.setEnvironment(EMPTY_ENVIRONMENT);
    editorStore.selectedExecutor = DEFAULT_EXECUTOR;
    executionEnvironmentSyncTimerId = window.setTimeout(() => {
      executionEnvironmentSyncTimerId = null;
      void syncExecutionEnvironment();
    }, 0);


    return {
      startupWorkspaceDirectory,
    };
  };

  const activateDocument = (documentId: string): void => {
    editorStore.setActiveDocument(documentId);
  };

  const updateContent = (value: string): void => {
    editorStore.updateActiveDocumentContent(value);
  };

  const updateEncoding = (value: TDocumentEncoding): void => {
    if (!editorStore.hasActiveDocument) {
      return;
    }

    editorStore.updateActiveDocumentEncoding(value);
    editorStore.appendLog('info', '切换编码', `当前编码已切换为 ${value.toUpperCase()}。`);
  };

  const toggleTheme = (): void => {
    appStore.applyTheme(appStore.theme === 'dark' ? 'light' : 'dark');
  };

  const notifyTemplateInserted = (template: ICommandTemplate): void => {
    editorStore.appendLog('info', '插入模板', `已插入模板：${template.title}`);
    notifier.success(`已插入 ${template.title}`);
  };

  return {
    appStore,
    editorStore,
    isDesktopRuntime: computed(() => desktopRuntimeReady.value),
    canRun,
    canSave,
    commandTemplates: COMMAND_TEMPLATES,
    commentTemplates: COMMENT_TEMPLATES,
    initialize,
    restoreSession: () => restoreSession(editorStore.sessionSnapshot),
    flushSession,
    createNewDocument,
    openDocument,
    openFolder,
    openDocumentByPath,
    openGitDiffPreview,
    openGitDiffPreviewPayload,
    formatDocumentWithShfmt,
    formatWorkspaceFileByPath,
    saveDocument,
    saveDocumentAs,
    requestCloseDocument,
    requestCloseWorkspace,
    requestCloseApplication,
    activateDocument,
    runScript,
    handleIntegratedTerminalRunCompleted,
    updateContent,
    appendTerminalOutput,
    updateEncoding,
    toggleTheme,
    notifyTemplateInserted,
  };
};
