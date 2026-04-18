import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import { useAppStore } from '@/store/app';
import { useEditorStore } from '@/store/editor';
import type {
  ICommandTemplate,
  IEditorDocument,
  IExecutionEnvironment,
  IRunResult,
  TDocumentEncoding
} from '@/types/editor';
import {
  DEFAULT_TERMINAL_SESSION_ID,
  type ITerminalRunCompletePayload,
} from '@/types/terminal';
import { desktopRuntimeReady, waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { getFileBaseName, isImageAssetPath } from '@/utils/file-assets';
import {
  COMMAND_TEMPLATES,
  COMMENT_TEMPLATES,
  DEFAULT_EXECUTOR,
  getExecutorLabel,
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
const TERMINAL_OUTPUT_BATCH_INTERVAL_MS = 16;

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

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
  return segments.length > 0 ? segments[segments.length - 1] || normalizedPath : normalizedPath;
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
  let bufferedTerminalOutput = '';
  let bufferedTerminalOutputTimerId: number | null = null;
  let activeTerminalRunMeta:
    | {
      runId: string;
      startedAt: string;
      commandLine: string;
      usedTempFile: boolean;
      receivedLiveOutput: boolean;
    }
    | null = null;

  const canRun = computed(() => {
    if (!isTextDocument(editorStore.document) || editorStore.document.content.trim().length <= 0) {
      return false;
    }

    return editorStore.environment.hasAny;
  });
  const canSave = computed(() => isTextDocument(editorStore.document));

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

  const flushBufferedTerminalOutput = (): void => {
    clearBufferedTerminalOutputTimer();

    if (!bufferedTerminalOutput) {
      return;
    }

    editorStore.appendTerminalOutput(bufferedTerminalOutput);
    bufferedTerminalOutput = '';
  };

  const resetBufferedTerminalOutput = (): void => {
    clearBufferedTerminalOutputTimer();
    bufferedTerminalOutput = '';
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

  const dispatchScriptToIntegratedTerminal = async (
    document: IEditorDocument,
    runId: string,
  ) => {
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
    if (isImageAssetPath(path)) {
      const imageName = getFileBaseName(path);
      const result = editorStore.openImageDocument(path, imageName);
      syncWorkspaceRootByPath(path);

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
    if (!isTextDocument(document)) {
      throw new Error('当前内容不是可执行脚本。');
    }

    const runId = `terminal-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    editorStore.setPendingTerminalRunId(runId);
    activeTerminalRunMeta = null;

    const dispatchResult = await dispatchScriptToIntegratedTerminal(document, runId);
    activeTerminalRunMeta = {
      runId,
      startedAt: dispatchResult.startedAt,
      commandLine: dispatchResult.commandLine,
      usedTempFile: dispatchResult.usedTempFile,
      receivedLiveOutput: false,
    };

    resetBufferedTerminalOutput();
    editorStore.lastRunResult = null;
    editorStore.setTerminalOutput('');
    editorStore.appendLog('success', '已发送到集成终端', dispatchResult.commandLine);

    if (dispatchResult.usedTempFile) {
      editorStore.appendLog(
        'info',
        '临时脚本文件',
        '当前未保存内容已通过临时 shell 文件发送到集成终端执行。',
      );
    }

    void tauriService
      .waitForTerminalRun({
        statusPath: dispatchResult.statusPath,
        outputPath: dispatchResult.outputPath,
      })
      .then(async (result) => {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 120);
        });

        handleIntegratedTerminalRunComplete({
          sessionId: DEFAULT_TERMINAL_SESSION_ID,
          runId,
          exitCode: result.exitCode,
          output: result.output,
          finishedAt: result.finishedAt,
        });
      })
      .catch((error) => {
        if (editorStore.pendingTerminalRunId !== runId) {
          return;
        }

        resetBufferedTerminalOutput();
        const message = error instanceof Error ? error.message : '等待终端执行完成失败';
        editorStore.isRunning = false;
        editorStore.setPendingTerminalRunId(null);
        activeTerminalRunMeta = null;
        editorStore.appendLog('error', '终端执行状态异常', message);
        useMessage().error(message);
      });

    useMessage().success('脚本已发送到集成终端');
  };

  const handleIntegratedTerminalRunComplete = (payload: ITerminalRunCompletePayload): void => {
    const pendingRunId = editorStore.pendingTerminalRunId;
    if (payload.runId !== pendingRunId && payload.runId !== activeTerminalRunMeta?.runId) {
      return;
    }

    flushBufferedTerminalOutput();
    const activeRun = activeTerminalRunMeta;
    const safeOutput = payload.output;
    const hadLiveTerminalOutput = Boolean(activeRun?.receivedLiveOutput) || editorStore.terminalOutput.length > 0;
    if (safeOutput) {
      editorStore.setTerminalOutput(safeOutput);
    }

    if (!hadLiveTerminalOutput) {
      editorStore.queueTerminalReplayOutput({
        runId: payload.runId,
        content: safeOutput,
        restorePrompt: true,
      });
    }
    const durationMs = activeRun
      ? Math.max(0, new Date(payload.finishedAt).getTime() - new Date(activeRun.startedAt).getTime())
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
      useMessage().success('脚本执行完成');
    } else {
      useMessage().error('脚本执行失败，请查看下方日志输出。');
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

    let shouldKeepRunning = false;

    try {
      shouldKeepRunning = true;
      await runScriptInIntegratedTerminal(currentDocument);
    } catch (error) {
      shouldKeepRunning = false;
      resetBufferedTerminalOutput();
      editorStore.setPendingTerminalRunId(null);
      activeTerminalRunMeta = null;
      const message = error instanceof Error ? error.message : '脚本执行失败';
      editorStore.appendLog('error', '脚本执行失败', message);
      editorStore.setTerminalOutput(message);
      useMessage().error(message);
    } finally {
      if (!shouldKeepRunning) {
        editorStore.isRunning = false;
      }
    }
  };

  const updateContent = (value: string): void => {
    editorStore.updateActiveDocumentContent(value);
  };

  const appendTerminalOutput = (value: string): void => {
    if (!value) {
      return;
    }

    if (activeTerminalRunMeta) {
      activeTerminalRunMeta.receivedLiveOutput = true;
    }

    bufferedTerminalOutput += value;
    if (bufferedTerminalOutputTimerId !== null) {
      return;
    }

    bufferedTerminalOutputTimerId = window.setTimeout(() => {
      flushBufferedTerminalOutput();
    }, TERMINAL_OUTPUT_BATCH_INTERVAL_MS);
  };

  const updateEncoding = (value: TDocumentEncoding): void => {
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
    saveDocument,
    saveDocumentAs,
    requestCloseDocument,
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
