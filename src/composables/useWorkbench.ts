import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import { useAppStore } from '@/store/app';
import { useEditorStore } from '@/store/editor';
import type {
  ICommandTemplate,
  IEditorDocument,
  IExecutionEnvironment,
  TDocumentEncoding,
  TExecutorKind,
} from '@/types/editor';
import { DEFAULT_TERMINAL_SESSION_ID } from '@/types/terminal';
import { desktopRuntimeReady, waitForDesktopRuntime } from '@/utils/desktop-runtime';
import {
  COMMAND_TEMPLATES,
  COMMENT_TEMPLATES,
  DEFAULT_EXECUTOR,
  getExecutorLabel,
  resolvePreferredExecutor,
} from '@/utils/templates';
import { computed } from 'vue';

const buildLogDetail = (title: string, detail: string): string => `${title}：${detail}`;

const EMPTY_ENVIRONMENT: IExecutionEnvironment = {
  recommended: DEFAULT_EXECUTOR,
  hasAny: false,
  executors: [],
};
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 28;

const isExecutorAvailable = (environment: IExecutionEnvironment, executor: TExecutorKind): boolean =>
  executor !== 'auto' &&
  environment.executors.some((item) => item.type === executor && item.available);

const resolveRequestedExecutor = (
  environment: IExecutionEnvironment,
  executor: TExecutorKind,
): TExecutorKind => (executor === 'auto' ? resolvePreferredExecutor(environment) : executor);

const normalizeLocalPath = (path: string): string => path.replace(/\\/g, '/');

const getParentDirectory = (path: string): string | null => {
  const normalizedPath = normalizeLocalPath(path);
  const separatorIndex = normalizedPath.lastIndexOf('/');
  if (separatorIndex <= 0) {
    return null;
  }

  return path.slice(0, separatorIndex);
};

const getPathName = (path: string): string => {
  const normalizedPath = normalizeLocalPath(path).replace(/\/+$/, '');
  const segments = normalizedPath.split('/');
  return segments.at(-1) || normalizedPath;
};

type TDirtyCloseAction = 'save' | 'discard' | 'cancel';

const resolveCloseConfirmMessage = (
  dirtyDocuments: IEditorDocument[],
  scene: 'close-document' | 'close-application',
): { title: string; message: string } => {
  if (scene === 'close-document') {
    return {
      title: '未保存的更改',
      message: `文件“${dirtyDocuments[0]?.name ?? '当前文件'}”仍有未保存内容，是否保存后再关闭？`,
    };
  }

  if (dirtyDocuments.length === 1) {
    return {
      title: '未保存的更改',
      message: `文件“${dirtyDocuments[0]?.name ?? '当前文件'}”仍有未保存内容，是否保存后再关闭应用？`,
    };
  }

  return {
    title: '未保存的更改',
    message: `当前有 ${dirtyDocuments.length} 个文件尚未保存，是否保存后再关闭应用？`,
  };
};

export const useWorkbench = () => {
  const appStore = useAppStore();
  const editorStore = useEditorStore();

  const canRun = computed(
    () => editorStore.environment.hasAny && editorStore.document.content.trim().length > 0,
  );

  const getAppWindow = async () => {
    const runtimeReady = await waitForDesktopRuntime();
    if (!runtimeReady) {
      return null;
    }

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
  };

  const closeAppWindow = async (): Promise<void> => {
    const appWindow = await getAppWindow();
    if (!appWindow) {
      return;
    }

    await appWindow.close();
  };

  const confirmCloseForDirtyDocuments = async (
    dirtyDocuments: IEditorDocument[],
    scene: 'close-document' | 'close-application',
  ): Promise<TDirtyCloseAction> => {
    if (dirtyDocuments.length === 0) {
      return 'discard';
    }

    const { title, message } = resolveCloseConfirmMessage(dirtyDocuments, scene);

    try {
      await useDialog().confirm({
        title,
        description: message,
        confirmText: '保存并关闭',
        cancelText: '直接关闭',
        variant: 'warning',
      });
      return 'save';
    } catch (action) {
      if (action === 'cancel') {
        return 'discard';
      }
      return 'cancel';
    }
  };

  const syncWorkspaceRootByPath = (path: string | null): void => {
    if (!path) {
      return;
    }

    const parentDirectory = getParentDirectory(path);
    if (parentDirectory) {
      editorStore.setWorkspaceRootPath(parentDirectory);
    }
  };

  const loadDocumentFromPath = async (path: string, scene: string): Promise<void> => {
    const payload = await tauriService.loadScript(path);
    const result = editorStore.openDocumentTab(payload);
    syncWorkspaceRootByPath(payload.path);

    if (result.reusedExisting) {
      editorStore.appendLog('info', scene, buildLogDetail('切换到已打开文件', payload.path));
      useMessage().success(`已切换到 ${payload.name}`);
      return;
    }

    editorStore.appendLog('success', scene, buildLogDetail('已加载文件', payload.path));
    useMessage().success(`已打开 ${payload.name}`);
  };

  const initialize = async (): Promise<void> => {
    const runtimeReady = await waitForDesktopRuntime();
    if (!runtimeReady) {
      editorStore.setEnvironment(EMPTY_ENVIRONMENT);
      editorStore.selectedExecutor = DEFAULT_EXECUTOR;
      editorStore.appendLog(
        'info',
        '浏览器预览模式',
        '当前界面运行在浏览器预览环境，默认执行方案为 WSL2，打开、保存与执行脚本仅在 Tauri 桌面端可用。',
      );
      return;
    }

    try {
      const environment = await tauriService.detectEnvironment();
      editorStore.setEnvironment(environment);
      editorStore.selectedExecutor = resolvePreferredExecutor(environment);
      const availableExecutorCount = environment.executors.filter((item) => item.available).length;
      const defaultExecutorLabel = getExecutorLabel(editorStore.selectedExecutor);
      editorStore.appendLog(
        environment.hasAny ? 'success' : 'error',
        '执行环境检测',
        environment.hasAny
          ? `已检测到 ${availableExecutorCount} 个可用执行环境，默认使用 ${defaultExecutorLabel}。`
          : '当前系统未发现可用的 WSL2 运行环境，建议先安装或启用 WSL2。',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行环境检测失败';
      editorStore.appendLog('error', '执行环境检测失败', message);
      useMessage().error(message);
    }
  };

  const createNewDocument = (): void => {
    const nextDocument = editorStore.createDocumentTab();
    editorStore.appendLog('info', '新建脚本', `已创建新的脚本草稿：${nextDocument.name}。`);
    useMessage().success('已创建新的脚本草稿');
  };

  const openDocument = async (): Promise<void> => {
    try {
      const path = await tauriService.pickOpenPath();
      if (!path) {
        return;
      }

      await loadDocumentFromPath(path, '打开脚本');
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开脚本失败';
      editorStore.appendLog('error', '打开脚本失败', message);
      useMessage().error(message);
    }
  };

  const openFolder = async (): Promise<void> => {
    try {
      const path = await tauriService.pickOpenFolderPath();
      if (!path) {
        return;
      }

      editorStore.setWorkspaceRootPath(path);
      editorStore.appendLog('success', '打开文件夹', buildLogDetail('资源目录', path));
      useMessage().success(`已打开文件夹 ${getPathName(path)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开文件夹失败';
      editorStore.appendLog('error', '打开文件夹失败', message);
      useMessage().error(message);
    }
  };

  const openDocumentByPath = async (path: string): Promise<void> => {
    try {
      const existingDocument = editorStore.findDocumentByPath(path);
      if (existingDocument) {
        editorStore.setActiveDocument(existingDocument.id);
        syncWorkspaceRootByPath(existingDocument.path);
        useMessage().success(`已切换到 ${existingDocument.name}`);
        return;
      }

      await loadDocumentFromPath(path, '资源管理器打开文件');
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开资源文件失败';
      editorStore.appendLog('error', '打开资源文件失败', message);
      useMessage().error(message);
    }
  };

  const saveDocumentAs = async (documentId = editorStore.document.id): Promise<boolean> => {
    const targetDocument = editorStore.getDocumentById(documentId);

    try {
      const targetPath = await tauriService.pickSavePath(targetDocument.path ?? targetDocument.name);
      if (!targetPath) {
        return false;
      }

      const payload = await tauriService.saveScript({
        path: targetPath,
        content: targetDocument.content,
        encoding: targetDocument.encoding,
      });

      editorStore.applyDocumentPayload(documentId, payload);
      syncWorkspaceRootByPath(payload.path);
      editorStore.appendLog('success', '另存为成功', buildLogDetail('保存路径', payload.path));
      useMessage().success('脚本已另存为');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '另存为失败';
      editorStore.appendLog('error', '另存为失败', message);
      useMessage().error(message);
      return false;
    }
  };

  const saveDocument = async (documentId = editorStore.document.id): Promise<boolean> => {
    const targetDocument = editorStore.getDocumentById(documentId);

    if (!targetDocument.path) {
      return saveDocumentAs(documentId);
    }

    try {
      const payload = await tauriService.saveScript({
        path: targetDocument.path,
        content: targetDocument.content,
        encoding: targetDocument.encoding,
      });

      editorStore.applyDocumentPayload(documentId, payload);
      syncWorkspaceRootByPath(payload.path);
      editorStore.appendLog('success', '保存成功', buildLogDetail('保存路径', payload.path));
      useMessage().success('脚本已保存');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败';
      editorStore.appendLog('error', '保存失败', message);
      useMessage().error(message);
      return false;
    }
  };

  const saveDirtyDocuments = async (documentIds: string[]): Promise<boolean> => {
    for (const documentId of documentIds) {
      const targetDocument = editorStore.getDocumentById(documentId);
      if (!targetDocument.isDirty) {
        continue;
      }

      const saved = await saveDocument(documentId);
      if (!saved) {
        return false;
      }
    }

    return true;
  };

  const requestCloseDocument = async (documentId: string): Promise<void> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument.isDirty) {
      editorStore.closeDocument(documentId);
      return;
    }

    const action = await confirmCloseForDirtyDocuments([targetDocument], 'close-document');
    if (action === 'cancel') {
      return;
    }

    if (action === 'save') {
      const saved = await saveDocument(documentId);
      if (!saved) {
        return;
      }
    }

    editorStore.closeDocument(documentId);
  };

  const requestCloseApplication = async (): Promise<void> => {
    const dirtyDocuments = editorStore.dirtyDocuments;
    if (dirtyDocuments.length === 0) {
      await closeAppWindow();
      return;
    }

    const action = await confirmCloseForDirtyDocuments(dirtyDocuments, 'close-application');
    if (action === 'cancel') {
      return;
    }

    if (action === 'save') {
      const saved = await saveDirtyDocuments(dirtyDocuments.map((item) => item.id));
      if (!saved) {
        return;
      }
    }

    await closeAppWindow();
  };

  const activateDocument = (documentId: string): void => {
    editorStore.setActiveDocument(documentId);
  };

  const runScriptInIntegratedTerminal = async (document: IEditorDocument): Promise<void> => {
    await tauriService.ensureTerminalSession({
      sessionId: DEFAULT_TERMINAL_SESSION_ID,
      cwd: null,
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    });

    const dispatchResult = await tauriService.dispatchScriptToTerminal({
      sessionId: DEFAULT_TERMINAL_SESSION_ID,
      path: document.path,
      content: document.content,
      isDirty: document.isDirty,
    });

    editorStore.lastRunResult = null;
    editorStore.setTerminalOutput('');
    editorStore.appendLog('success', 'Terminal run', dispatchResult.commandLine);

    if (dispatchResult.usedTempFile) {
      editorStore.appendLog(
        'info',
        'Temporary script file',
        'The current buffer was dispatched through a temporary shell file.',
      );
    }

    useMessage().success('Script sent to integrated terminal');
  };

  const runScriptWithCapturedOutput = async (
    document: IEditorDocument,
    executor: TExecutorKind,
  ): Promise<void> => {
    const result = await tauriService.runScript({
      path: document.path,
      content: document.content,
      encoding: document.encoding,
      executor,
      isDirty: document.isDirty,
    });

    editorStore.lastRunResult = result;
    editorStore.setTerminalOutput(result.combinedOutput);
    editorStore.appendLog(
      result.success ? 'success' : 'error',
      result.success ? 'Execution completed' : 'Execution failed',
      `Executor: ${result.executorLabel}, exit code: ${result.exitCode ?? 'unknown'}, duration: ${result.durationMs}ms.`,
    );

    if (result.usedTempFile) {
      editorStore.appendLog(
        'info',
        'Temporary script file',
        'The current buffer was executed through a temporary shell file.',
      );
    }

    if (result.success) {
      useMessage().success('Script execution completed');
    } else {
      useMessage().error('Script execution failed. Check the terminal output panel.');
    }
  };

  const runScript = async (): Promise<void> => {
    if (!canRun.value) {
      useMessage().warning('Please provide script content and an available executor first.');
      return;
    }

    const currentDocument = editorStore.document;
    const requestedExecutor = resolveRequestedExecutor(
      editorStore.environment,
      editorStore.selectedExecutor,
    );

    if (!isExecutorAvailable(editorStore.environment, requestedExecutor)) {
      useMessage().error(`${getExecutorLabel(requestedExecutor)} is not available on this system.`);
      return;
    }

    editorStore.isRunning = true;
    editorStore.appendLog(
      'info',
      'Run requested',
      `Using ${getExecutorLabel(requestedExecutor)} for the current script.`,
    );

    try {
      if (requestedExecutor === 'wsl') {
        await runScriptInIntegratedTerminal(currentDocument);
      } else {
        editorStore.appendLog(
          'info',
          'Captured output fallback',
          `${getExecutorLabel(requestedExecutor)} is not backed by the integrated WSL terminal, so the output will be captured in the panel instead.`,
        );
        await runScriptWithCapturedOutput(currentDocument, requestedExecutor);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Script execution failed';
      editorStore.appendLog('error', 'Script execution failed', message);
      editorStore.setTerminalOutput(message);
      useMessage().error(message);
    } finally {
      editorStore.isRunning = false;
    }
  };

  const updateContent = (value: string): void => {
    editorStore.updateActiveDocumentContent(value);
  };

  const updateEncoding = (value: TDocumentEncoding): void => {
    editorStore.updateActiveDocumentEncoding(value);
    editorStore.appendLog('info', '切换编码', `当前编码已切换为 ${value.toUpperCase()}。`);
  };

  const updateExecutor = (value: TExecutorKind): void => {
    editorStore.selectedExecutor = value;
    editorStore.appendLog(
      'info',
      '切换执行器',
      `当前执行方案已切换为 ${getExecutorLabel(value)}。`,
    );
  };

  const toggleTheme = (): void => {
    appStore.applyTheme(appStore.theme === 'dark' ? 'light' : 'dark');
  };

  const notifyTemplateInserted = (template: ICommandTemplate): void => {
    editorStore.appendLog('info', '插入模板', `已插入模板：${template.title}`);
    useMessage().success(`已插入 ${template.title}`);
  };

  return {
    appStore,
    editorStore,
    isDesktopRuntime: computed(() => desktopRuntimeReady.value),
    canRun,
    commandTemplates: COMMAND_TEMPLATES,
    commentTemplates: COMMENT_TEMPLATES,
    initialize,
    createNewDocument,
    openDocument,
    openFolder,
    openDocumentByPath,
    saveDocument,
    saveDocumentAs,
    requestCloseDocument,
    requestCloseApplication,
    activateDocument,
    runScript,
    updateContent,
    updateEncoding,
    updateExecutor,
    toggleTheme,
    notifyTemplateInserted,
  };
};
