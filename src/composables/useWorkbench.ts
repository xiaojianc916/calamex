import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import { useAppStore } from '@/store/app';
import { useEditorStore } from '@/store/editor';
import { useGitStore } from '@/store/git';
import type {
  ICommandTemplate,
  IEditorDocument,
  IExecutionEnvironment,
  IRunResult,
  IWorkspaceDirectoryPayload,
  TDocumentEncoding,
} from '@/types/editor';
import {
  DEFAULT_TERMINAL_SESSION_ID,
  type ITerminalRunCompletePayload,
  type ITerminalRunOutputEvent,
} from '@/types/terminal';
import { desktopRuntimeReady, waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { getFileBaseName, isImageAssetPath } from '@/utils/file-assets';
import {
  COMMAND_TEMPLATES,
  COMMENT_TEMPLATES,
  DEFAULT_EXECUTOR,
  getExecutorLabel,
} from '@/utils/templates';
import {
  allowNextProgrammaticWindowClose,
  clearProgrammaticWindowCloseAllowance,
} from '@/utils/window-close';
import { computed, onScopeDispose } from 'vue';

const buildLogDetail = (title: string, detail: string): string => `${title}：${detail}`;

const EMPTY_ENVIRONMENT: IExecutionEnvironment = {
  recommended: DEFAULT_EXECUTOR,
  hasAny: false,
  executors: [],
};
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 28;
const TERMINAL_OUTPUT_BATCH_INTERVAL_MS = 120;
const TERMINAL_RUN_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;

const formatShellScriptWithWasm = async (
  source: string,
  path?: string | null,
): Promise<string> => {
  const { formatShellScript } = await import('@/utils/shfmt');
  return formatShellScript(source, path);
};

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

const getPathName = (path: string): string => {
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalizedPath.split('/');
  return segments.length > 0 ? segments[segments.length - 1] || normalizedPath : normalizedPath;
};

type TDirtyCloseAction = 'save' | 'discard' | 'cancel';
type TDirtyCloseScene =
  | 'close-document'
  | 'close-application'
  | 'close-workspace'
  | 'switch-workspace';

const resolveCloseConfirmMessage = (
  dirtyDocuments: IEditorDocument[],
  scene: TDirtyCloseScene,
): { title: string; message: string } => {
  const fileName = dirtyDocuments[0]?.name ?? '当前文件';

  if (scene === 'close-document') {
    return {
      title: '保存更改？',
      message: `文件“${fileName}”的未保存修改将会丢失。`,
    };
  }

  if (scene === 'close-workspace') {
    return dirtyDocuments.length === 1
      ? {
        title: '保存更改？',
        message: `关闭工作区前，文件“${fileName}”的未保存修改将会丢失。`,
      }
      : {
        title: '保存更改？',
        message: `关闭工作区前，${dirtyDocuments.length} 个文件的未保存修改将会丢失。`,
      };
  }

  if (scene === 'switch-workspace') {
    return dirtyDocuments.length === 1
      ? {
        title: '保存更改？',
        message: `切换工作区前，文件“${fileName}”的未保存修改将会丢失。`,
      }
      : {
        title: '保存更改？',
        message: `切换工作区前，${dirtyDocuments.length} 个文件的未保存修改将会丢失。`,
      };
  }

  if (dirtyDocuments.length === 1) {
    return {
      title: '保存更改？',
      message: `关闭应用前，文件“${fileName}”的未保存修改将会丢失。`,
    };
  }

  return {
    title: '保存更改？',
    message: `关闭应用前，${dirtyDocuments.length} 个文件的未保存修改将会丢失。`,
  };
};

export const useWorkbench = () => {
  const appStore = useAppStore();
  const editorStore = useEditorStore();
  const gitStore = useGitStore();
  let bufferedTerminalOutput = '';
  let bufferedTerminalOutputTimerId: number | null = null;
  let terminalRunFallbackTimerId: number | null = null;
  let isDisposed = false;
  let activeTerminalRunMeta: {
    runId: string;
    startedAt: string;
    commandLine: string;
    usedTempFile: boolean;
  } | null = null;

  const canRun = computed(() => {
    if (!editorStore.hasActiveDocument || !isTextDocument(editorStore.document)) {
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
      const message = error instanceof Error ? error.message : '刷新 Git 状态失败';
      editorStore.appendLog('error', '刷新 Git 状态失败', message);
    }
  };

  const getAppWindow = async () => {
    const runtimeReady = await waitForDesktopRuntime();
    if (!runtimeReady) {
      return null;
    }

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
  };

  const clearBufferedTerminalOutputTimer = (): void => {
    if (bufferedTerminalOutputTimerId === null) {
      return;
    }

    window.clearTimeout(bufferedTerminalOutputTimerId);
    bufferedTerminalOutputTimerId = null;
  };

  const clearTerminalRunFallbackTimer = (): void => {
    if (terminalRunFallbackTimerId === null) {
      return;
    }

    window.clearTimeout(terminalRunFallbackTimerId);
    terminalRunFallbackTimerId = null;
  };

  const flushBufferedTerminalOutput = (): void => {
    clearBufferedTerminalOutputTimer();

    if (!bufferedTerminalOutput) {
      return;
    }

    if (isDisposed) {
      bufferedTerminalOutput = '';
      return;
    }

    editorStore.appendTerminalOutput(bufferedTerminalOutput);
    bufferedTerminalOutput = '';
  };

  const resetBufferedTerminalOutput = (): void => {
    clearBufferedTerminalOutputTimer();
    bufferedTerminalOutput = '';
  };

  const scheduleTerminalRunCompletionTimeout = (runId: string): void => {
    clearTerminalRunFallbackTimer();
    terminalRunFallbackTimerId = window.setTimeout(() => {
      terminalRunFallbackTimerId = null;

      if (isDisposed || editorStore.pendingTerminalRunId !== runId) {
        return;
      }

      resetBufferedTerminalOutput();
      editorStore.isRunning = false;
      editorStore.setPendingTerminalRunId(null);
      activeTerminalRunMeta = null;

      const message = '终端运行超时，已停止等待完成事件，请检查终端状态。';
      editorStore.appendLog('error', '终端运行超时', message);
      useMessage().error(message);
    }, TERMINAL_RUN_COMPLETION_TIMEOUT_MS);
  };

  const ensureIntegratedTerminalSession = async (): Promise<void> => {
    await tauriService.ensureTerminalSession({
      sessionId: DEFAULT_TERMINAL_SESSION_ID,
      cwd: null,
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    });
  };

  const shouldReconnectIntegratedTerminal = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('目标终端会话不存在');
  };

  const dispatchScriptToIntegratedTerminal = async (document: IEditorDocument, runId: string) => {
    try {
      return await tauriService.dispatchScriptToTerminal({
        sessionId: DEFAULT_TERMINAL_SESSION_ID,
        path: document.path,
        content: document.content,
        isDirty: document.isDirty,
        runId,
      });
    } catch (error) {
      if (!shouldReconnectIntegratedTerminal(error)) {
        throw error;
      }

      await ensureIntegratedTerminalSession();
      return tauriService.dispatchScriptToTerminal({
        sessionId: DEFAULT_TERMINAL_SESSION_ID,
        path: document.path,
        content: document.content,
        isDirty: document.isDirty,
        runId,
      });
    }
  };

  const closeAppWindow = async (): Promise<void> => {
    const appWindow = await getAppWindow();
    if (!appWindow) {
      return;
    }

    allowNextProgrammaticWindowClose();

    try {
      await appWindow.close();
    } catch (error) {
      clearProgrammaticWindowCloseAllowance();
      throw error;
    }
  };

  const confirmCloseForDirtyDocuments = async (
    dirtyDocuments: IEditorDocument[],
    scene: TDirtyCloseScene,
  ): Promise<TDirtyCloseAction> => {
    if (dirtyDocuments.length === 0) {
      return 'discard';
    }

    const { title, message } = resolveCloseConfirmMessage(dirtyDocuments, scene);

    const action = await useDialog().confirm({
      title,
      description: message,
      confirmText: '保存',
      cancelText: '不保存',
      dismissText: '取消',
      variant: 'warning',
    });

    if (action === 'confirm') {
      return 'save';
    }

    if (action === 'cancel') {
      return 'discard';
    }

    return 'cancel';
  };

  const loadDocumentFromPath = async (path: string, scene: string): Promise<void> => {
    if (isImageAssetPath(path)) {
      const imageName = getFileBaseName(path);
      const result = editorStore.openImageDocument(path, imageName);

      if (result.reusedExisting) {
        editorStore.appendLog('info', scene, buildLogDetail('切换到已打开图片', path));
        useMessage().success(`已切换到 ${imageName}`);
        return;
      }

      editorStore.appendLog('success', scene, buildLogDetail('已加载图片', path));
      useMessage().success(`已打开图片 ${imageName}`);
      return;
    }

    const payload = await tauriService.loadScript(path);
    const result = editorStore.openDocumentTab(payload);

    if (result.reusedExisting) {
      editorStore.appendLog('info', scene, buildLogDetail('切换到已打开文件', payload.path));
      useMessage().success(`已切换到 ${payload.name}`);
      return;
    }

    editorStore.appendLog('success', scene, buildLogDetail('已加载文件', payload.path));
    useMessage().success(`已打开 ${payload.name}`);
  };

  const initialize = async (): Promise<{
    startupWorkspaceDirectory: IWorkspaceDirectoryPayload | null;
  }> => {
    let startupWorkspaceDirectory: IWorkspaceDirectoryPayload | null = null;

    const runtimeReady = await waitForDesktopRuntime();
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
      const message = error instanceof Error ? error.message : '执行环境检测失败';
      editorStore.appendLog('error', '执行环境检测失败', message);
      useMessage().error(message);
    }

    try {
      const startupWorkspace = await tauriService.getStartupWorkspace();
      editorStore.setProtectedWorkspaceRootPaths(startupWorkspace.protectedRootPaths);

      try {
        startupWorkspaceDirectory = await tauriService.listWorkspaceEntries(
          undefined,
          startupWorkspace.rootPath,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '加载默认文件夹目录结构失败';
        editorStore.appendLog('error', '加载默认文件夹目录结构失败', message);
      }

      editorStore.setWorkspaceRootPath(startupWorkspace.rootPath);
      void refreshGitRepositoryStatus(startupWorkspace.rootPath);

      if (startupWorkspace.defaultFilePath) {
        await loadDocumentFromPath(startupWorkspace.defaultFilePath, '加载默认工作区');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载默认工作区失败';
      editorStore.appendLog('error', '加载默认工作区失败', message);
      useMessage().error(message);
    }

    return {
      startupWorkspaceDirectory,
    };
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

      const dirtyDocuments = editorStore.dirtyDocuments;
      const action = await confirmCloseForDirtyDocuments(dirtyDocuments, 'switch-workspace');
      if (action === 'cancel') {
        return;
      }

      if (action === 'save') {
        const saved = await saveDirtyDocuments(dirtyDocuments.map((item) => item.id));
        if (!saved) {
          return;
        }
      }

      editorStore.clearDocuments();
      editorStore.setWorkspaceRootPath(path);
      void refreshGitRepositoryStatus(path);
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

  const formatDocumentWithShfmt = async (
    documentId = editorStore.document.id,
  ): Promise<boolean> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument) {
      useMessage().warning('当前没有可格式化的脚本文件。');
      return false;
    }

    if (!isTextDocument(targetDocument)) {
      useMessage().warning('当前图片预览不支持 shfmt 格式化。');
      return false;
    }

    try {
      const formattedContent = await formatShellScriptWithWasm(
        targetDocument.content,
        targetDocument.path ?? targetDocument.name,
      );
      const hasChanges = formattedContent !== targetDocument.content;

      editorStore.updateDocumentContent(documentId, formattedContent);
      editorStore.appendLog(
        'success',
        'shfmt 格式化',
        hasChanges
          ? `已格式化当前文件：${targetDocument.name}。`
          : `当前文件已符合 shfmt 格式：${targetDocument.name}。`,
      );
      useMessage().success(
        hasChanges ? '已通过 shfmt 格式化当前文件' : '当前文件已符合 shfmt 格式',
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'shfmt 格式化失败';
      editorStore.appendLog('error', 'shfmt 格式化失败', message);
      useMessage().error(message);
      return false;
    }
  };

  const formatWorkspaceFileByPath = async (path: string): Promise<boolean> => {
    try {
      const existingDocument = editorStore.findDocumentByPath(path);
      if (existingDocument && !isTextDocument(existingDocument)) {
        useMessage().warning('当前目标不是可由 shfmt 处理的脚本文件。');
        return false;
      }

      const sourceDocument =
        existingDocument && isTextDocument(existingDocument)
          ? {
            path: existingDocument.path,
            name: existingDocument.name,
            content: existingDocument.content,
            encoding: existingDocument.encoding,
          }
          : await tauriService.loadScript(path);

      const formattedContent = await formatShellScriptWithWasm(
        sourceDocument.content,
        sourceDocument.path ?? sourceDocument.name,
      );
      const savedPayload = await tauriService.saveScript({
        path,
        content: formattedContent,
        encoding: sourceDocument.encoding,
      });
      const hasChanges = formattedContent !== sourceDocument.content;

      if (existingDocument && isTextDocument(existingDocument)) {
        editorStore.applyDocumentPayload(existingDocument.id, savedPayload);
      }

      void refreshGitRepositoryStatus();

      editorStore.appendLog(
        'success',
        'shfmt 格式化',
        buildLogDetail(hasChanges ? '已格式化文件' : '已检查文件', savedPayload.path),
      );
      useMessage().success(
        hasChanges
          ? `已通过 shfmt 格式化 ${savedPayload.name}`
          : `${savedPayload.name} 已符合 shfmt 格式`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '工作区文件 shfmt 格式化失败';
      editorStore.appendLog('error', '工作区文件 shfmt 格式化失败', message);
      useMessage().error(message);
      return false;
    }
  };

  const saveDocumentAs = async (documentId = editorStore.document.id): Promise<boolean> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument) {
      return false;
    }

    if (!isTextDocument(targetDocument)) {
      useMessage().warning('当前图片预览为只读模式，暂不支持另存为。');
      return false;
    }

    try {
      const targetPath = await tauriService.pickSavePath(
        targetDocument.path ?? targetDocument.name,
      );
      if (!targetPath) {
        return false;
      }

      const payload = await tauriService.saveScript({
        path: targetPath,
        content: targetDocument.content,
        encoding: targetDocument.encoding,
      });

      editorStore.applyDocumentPayload(documentId, payload);
      void refreshGitRepositoryStatus();
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
    if (!targetDocument) {
      return false;
    }

    if (!isTextDocument(targetDocument)) {
      useMessage().warning('当前图片预览为只读模式，无需保存。');
      return false;
    }

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
      void refreshGitRepositoryStatus();
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
      if (!targetDocument) {
        continue;
      }

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
    if (!targetDocument) {
      return;
    }

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

  const requestCloseWorkspace = async (): Promise<void> => {
    const dirtyDocuments = editorStore.dirtyDocuments;
    const action = await confirmCloseForDirtyDocuments(dirtyDocuments, 'close-workspace');
    if (action === 'cancel') {
      return;
    }

    if (action === 'save') {
      const saved = await saveDirtyDocuments(dirtyDocuments.map((item) => item.id));
      if (!saved) {
        return;
      }
    }

    editorStore.clearWorkspaceSession();
    gitStore.reset();
    useMessage().success('工作区已关闭');
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
    if (!isTextDocument(document)) {
      throw new Error('当前文档不是可执行脚本文本。');
    }

    const runId = `terminal-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    editorStore.setPendingTerminalRunId(runId);
    activeTerminalRunMeta = null;

    const dispatchResult = await dispatchScriptToIntegratedTerminal(document, runId);
    if (isDisposed) {
      return;
    }

    activeTerminalRunMeta = {
      runId,
      startedAt: dispatchResult.startedAt,
      commandLine: dispatchResult.commandLine,
      usedTempFile: dispatchResult.usedTempFile,
    };

    resetBufferedTerminalOutput();
    editorStore.lastRunResult = null;
    editorStore.setTerminalOutput('');
    editorStore.appendLog('success', '已发送到集成终端', dispatchResult.commandLine);

    if (dispatchResult.usedTempFile) {
      editorStore.appendLog(
        'info',
        '临时脚本文件',
        '当前内容已写入临时 shell 脚本文件后执行。',
      );
    }

    scheduleTerminalRunCompletionTimeout(runId);
    useMessage().success('脚本已发送到集成终端。');
  };

  const handleIntegratedTerminalRunComplete = (payload: ITerminalRunCompletePayload): void => {
    if (isDisposed) {
      return;
    }

    const pendingRunId = editorStore.pendingTerminalRunId;
    if (payload.runId !== pendingRunId && payload.runId !== activeTerminalRunMeta?.runId) {
      return;
    }

    clearTerminalRunFallbackTimer();
    flushBufferedTerminalOutput();

    const activeRun = activeTerminalRunMeta;
    const safeOutput = editorStore.getTerminalOutputSnapshot();

    const durationMs = activeRun
      ? Math.max(
        0,
        new Date(payload.finishedAt).getTime() - new Date(activeRun.startedAt).getTime(),
      )
      : 0;
    const runResult: IRunResult = {
      success: payload.exitCode === 0,
      stdout: safeOutput,
      stderr: payload.exitCode === 0 ? '' : safeOutput,
      combinedOutput: safeOutput,
      exitCode: payload.exitCode,
      executor: 'wsl',
      executorLabel: getExecutorLabel('wsl'),
      durationMs,
      startedAt: activeRun?.startedAt ?? payload.finishedAt,
      finishedAt: payload.finishedAt,
      commandLine: activeRun?.commandLine ?? 'bash',
      logPath: null,
      usedTempFile: activeRun?.usedTempFile ?? false,
    };

    editorStore.lastRunResult = runResult;
    editorStore.isRunning = false;
    editorStore.setPendingTerminalRunId(null);
    activeTerminalRunMeta = null;

    editorStore.appendLog(
      runResult.success ? 'success' : 'error',
      runResult.success ? '执行完成' : '执行失败',
      `执行器：${runResult.executorLabel}，退出码：${runResult.exitCode ?? '未知'}，耗时：${runResult.durationMs}ms。`,
    );

    if (runResult.success) {
      useMessage().success('脚本执行完成。');
    } else {
      useMessage().error('脚本执行失败，请检查终端输出。');
    }
  };

  const runScript = async (): Promise<void> => {
    if (!canRun.value) {
      useMessage().warning(
        isTextDocument(editorStore.document)
          ? '请先提供可执行脚本内容，并确认当前系统存在可用的 WSL2 运行环境。'
          : '当前打开的是图片预览，无法直接执行。',
      );
      return;
    }

    const currentDocument = editorStore.document;
    if (!editorStore.environment.hasAny) {
      useMessage().error('当前系统不可用：WSL2。');
      return;
    }

    editorStore.isRunning = true;
    editorStore.appendLog(
      'info',
      '开始执行',
      `当前脚本将使用 ${getExecutorLabel(DEFAULT_EXECUTOR)} 执行。`,
    );

    try {
      await runScriptInIntegratedTerminal(currentDocument);
    } catch (error) {
      resetBufferedTerminalOutput();
      clearTerminalRunFallbackTimer();
      editorStore.setPendingTerminalRunId(null);
      activeTerminalRunMeta = null;
      editorStore.isRunning = false;
      const message = error instanceof Error ? error.message : '脚本执行失败';
      editorStore.appendLog('error', '脚本执行失败', message);
      editorStore.setTerminalOutput(message);
      useMessage().error(message);
    }
  };

  const updateContent = (value: string): void => {
    editorStore.updateActiveDocumentContent(value);
  };

  const appendTerminalOutput = (payload: ITerminalRunOutputEvent): void => {
    if (isDisposed || !payload.data) {
      return;
    }

    const pendingRunId = editorStore.pendingTerminalRunId;
    if (payload.runId !== pendingRunId && payload.runId !== activeTerminalRunMeta?.runId) {
      return;
    }

    bufferedTerminalOutput += payload.data;
    if (bufferedTerminalOutputTimerId !== null) {
      return;
    }

    bufferedTerminalOutputTimerId = window.setTimeout(() => {
      flushBufferedTerminalOutput();
    }, TERMINAL_OUTPUT_BATCH_INTERVAL_MS);
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
    useMessage().success(`已插入 ${template.title}`);
  };

  onScopeDispose(() => {
    isDisposed = true;
    resetBufferedTerminalOutput();
    clearTerminalRunFallbackTimer();
    activeTerminalRunMeta = null;
  });

  return {
    appStore,
    editorStore,
    isDesktopRuntime: computed(() => desktopRuntimeReady.value),
    canRun,
    canSave,
    commandTemplates: COMMAND_TEMPLATES,
    commentTemplates: COMMENT_TEMPLATES,
    initialize,
    createNewDocument,
    openDocument,
    openFolder,
    openDocumentByPath,
    formatDocumentWithShfmt,
    formatWorkspaceFileByPath,
    saveDocument,
    saveDocumentAs,
    requestCloseDocument,
    requestCloseWorkspace,
    requestCloseApplication,
    activateDocument,
    runScript,
    handleIntegratedTerminalRunComplete,
    updateContent,
    appendTerminalOutput,
    updateEncoding,
    toggleTheme,
    notifyTemplateInserted,
  };
};
