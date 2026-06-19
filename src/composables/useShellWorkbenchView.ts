import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDocumentNavigationHistory } from '@/composables/useDocumentNavigationHistory';
import { useGitRepositoryStatusBootstrap } from '@/composables/useGitRepositoryStatusBootstrap';
import { useShellWorkbenchAiBridge } from '@/composables/useShellWorkbenchAiBridge';
import { useShellWorkbenchViewportState } from '@/composables/useShellWorkbenchViewportState';
import { useWorkbench } from '@/composables/useWorkbench';
import { useGitStore } from '@/store/git';
import type { TWorkbenchPrimaryMode, TWorkbenchSidebarView } from '@/types/app';
import type {
  IAnalyzeScriptPayload,
  ICommandTemplate,
  IEditorSelectionSummary,
  IWorkspaceDirectoryPayload,
} from '@/types/editor';
import type { ITerminalRunCompletedPayload } from '@/types/terminal';
import { waitForDesktopRuntime } from '@/utils/platform/desktop-runtime';
import { markStartup } from '@/utils/platform/startup-profiler';
import { consumeProgrammaticWindowCloseAllowance } from '@/utils/window/window-close';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';

export type TEditorExpose = {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  rerunDiagnostics: () => void;
  layoutEditor: () => void;
};

const READY_PAINT_FALLBACK_TIMEOUT_MS = 96;
const AI_PANEL_DEFAULT_WIDTH = 450;
const AI_PANEL_MIN_WIDTH = 350;
const AI_PANEL_MAX_WIDTH = 550;
const DASHBOARD_SIDEBAR_WIDTH = 288;

// 终端面板默认高度（约 8-10 行终端输出）。
const TERMINAL_DEFAULT_HEIGHT = 236;
// 终端最大化时使用的像素值：远超任何屏幕高度，撑满 flex 父容器。
const TERMINAL_MAXIMIZED_PX = 100_000;

const isPrimaryModifierShortcut = (event: KeyboardEvent, code: string, key: string): boolean =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.code === code || event.key.toLowerCase() === key);

const scheduleStartupNonCriticalTask = (task: () => void, timeoutMs = 1600): void => {
  if (typeof window === 'undefined') {
    return;
  }

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => task(), { timeout: timeoutMs });
    return;
  }

  window.setTimeout(task, timeoutMs);
};

const waitForInitialWorkbenchPaint = async (): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;
    let timeoutId: number | null = null;

    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId);
      }

      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
      }

      resolve();
    };

    // 双 rAF：第一帧后浏览器已完成布局但可能尚未完成绘制；
    // 第二帧回调执行时首帧绘制已落屏，确保终端 attach 时机在首次可见帧之后，
    // 避免 xterm 在未绘制的容器上初始化导致尺寸计算为 0。
    firstFrameId = window.requestAnimationFrame(() => {
      firstFrameId = null;
      secondFrameId = window.requestAnimationFrame(() => {
        secondFrameId = null;
        finish();
      });
    });

    timeoutId = window.setTimeout(finish, READY_PAINT_FALLBACK_TIMEOUT_MS);
  });

export const useShellWorkbenchView = (onReady: () => void) => {
  const editorRef = ref<TEditorExpose | null>(null);
  const editorViewportRef = ref<HTMLElement | null>(null);
  const workbench = useWorkbench();
  const gitStore = useGitStore();

  const isTerminalVisible = ref(workbench.editorStore.sessionSnapshot.workbench.isTerminalVisible);
  const isSidebarVisible = ref(true);
  const aiPanelWidth = ref(AI_PANEL_DEFAULT_WIDTH);
  const isDiagnosticsPanelVisible = ref(false);
  const activePrimaryMode = ref<TWorkbenchPrimaryMode>(workbench.appStore.workbenchPrimaryMode);
  const terminalHeight = ref(TERMINAL_DEFAULT_HEIGHT);
  const terminalHeightBeforeMaximize = ref(TERMINAL_DEFAULT_HEIGHT);
  const isTerminalMaximized = ref(false);
  const activeSidebarView = ref<TWorkbenchSidebarView>(
    workbench.editorStore.sessionSnapshot.workbench.activeSidebarView,
  );
  const startupWorkspaceRoot = ref<IWorkspaceDirectoryPayload | null>(null);
  const hasEmittedReady = ref(false);
  const isRestoringWorkbenchSession = ref(false);
  const docHistory = useDocumentNavigationHistory();
  const documentBackStack = docHistory.backStack;
  const documentForwardStack = docHistory.forwardStack;

  let nativeCloseRequestedUnlisten: (() => void) | null = null;
  let isUnmounted = false;
  let editorLayoutAfterSidebarFrameId: number | null = null;
  let editorLiveResizeFrameId: number | null = null;
  let globalKeydownCleanup: (() => void) | null = null;

  const sidebarWidth = computed(() => DASHBOARD_SIDEBAR_WIDTH);
  const visibleWorkspaceRootPath = computed(() => workbench.editorStore.workspaceRootPath);

  // 工作台层级 Git 仓库状态初始化：打开工作区时即加载，与左侧 git 侧边栏是否激活解耦，
  // 确保右上角 GitHub 登录控件在工作区打开后立即可用（详见 useGitRepositoryStatusBootstrap）。
  useGitRepositoryStatusBootstrap(workbench.isDesktopRuntime, visibleWorkspaceRootPath);

  const startupExplorerExpandedPaths = computed(
    () => workbench.editorStore.sessionSnapshot.workbench.explorerExpandedPaths ?? [],
  );
  const startupExplorerSelectedPath = computed(
    () => workbench.editorStore.sessionSnapshot.workbench.explorerSelectedPath ?? null,
  );

  const clampAiPanelWidth = (value: number): number =>
    Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, Math.round(value)));

  const clampTerminalPanelHeight = (value: number): number => Math.max(140, Math.round(value));

  // 防回环：clamp 后写回 store 会再次触发本 watch，用闭包内 isSyncing 标志阻断回环。
  const createClampedPanelSync = (
    clamp: (value: number) => number,
    applyClamped: (clampedValue: number) => void,
    writeBack: (clampedValue: number) => void,
  ): ((nextValue: number) => void) => {
    let isSyncing = false;
    return (nextValue) => {
      if (isSyncing) {
        return;
      }
      isSyncing = true;
      const clampedValue = clamp(nextValue);
      applyClamped(clampedValue);
      if (clampedValue !== nextValue) {
        writeBack(clampedValue);
      }
      isSyncing = false;
    };
  };

  watch(
    () => workbench.appStore.aiPanelWidth,
    createClampedPanelSync(
      clampAiPanelWidth,
      (clampedWidth) => {
        if (clampedWidth !== aiPanelWidth.value) {
          aiPanelWidth.value = clampedWidth;
        }
      },
      (clampedWidth) => workbench.appStore.setAiPanelWidth(clampedWidth),
    ),
    { immediate: true },
  );

  watch(
    () => workbench.appStore.terminalPanelHeight,
    createClampedPanelSync(
      clampTerminalPanelHeight,
      (clampedHeight) => {
        if (clampedHeight !== terminalHeight.value && !isTerminalMaximized.value) {
          terminalHeight.value = clampedHeight;
        }

        if (clampedHeight !== terminalHeightBeforeMaximize.value) {
          terminalHeightBeforeMaximize.value = clampedHeight;
        }
      },
      (clampedHeight) => workbench.appStore.setTerminalPanelHeight(clampedHeight),
    ),
    { immediate: true },
  );

  const resolveAdjacentDocumentId = (
    currentDocumentId: string,
    direction: 'back' | 'forward',
  ): string | null => {
    const currentIndex = workbench.editorStore.documents.findIndex(
      (item) => item.id === currentDocumentId,
    );
    if (currentIndex < 0) {
      return null;
    }

    const adjacentIndex = direction === 'back' ? currentIndex - 1 : currentIndex + 1;
    const adjacentDocument = workbench.editorStore.documents[adjacentIndex];
    return adjacentDocument?.id ?? null;
  };

  const canNavigateDocument = (direction: 'back' | 'forward'): boolean => {
    if (direction === 'back' ? docHistory.canGoBack() : docHistory.canGoForward()) {
      return true;
    }

    const currentDocumentId = workbench.editorStore.activeDocumentId;
    return currentDocumentId
      ? resolveAdjacentDocumentId(currentDocumentId, direction) !== null
      : false;
  };

  const canNavigateDocumentBack = computed(() => canNavigateDocument('back'));
  const canNavigateDocumentForward = computed(() => canNavigateDocument('forward'));

  const hasDocumentInEditorStore = (documentId: string): boolean =>
    Boolean(workbench.editorStore.getDocumentById(documentId));

  const trimDocumentNavHistory = (stack: string[]): string[] =>
    stack.slice(Math.max(0, stack.length - MAX_DOCUMENT_NAV_HISTORY));

  const pickNextNavigableDocumentId = (
    stackRef: typeof documentBackStack,
    currentDocumentId: string,
  ): string | null => {
    while (stackRef.value.length > 0) {
      const candidate = stackRef.value.pop();
      if (!candidate || candidate === currentDocumentId) {
        continue;
      }

      if (hasDocumentInEditorStore(candidate)) {
        return candidate;
      }
    }

    return null;
  };

  const navigateDocument = (direction: 'back' | 'forward'): void => {
    const currentDocumentId = workbench.editorStore.activeDocumentId;
    if (!currentDocumentId) {
      return;
    }

    const targetDocumentId =
      docHistory.navigate(direction, currentDocumentId, hasDocumentInEditorStore) ??
      resolveAdjacentDocumentId(currentDocumentId, direction);
    if (!targetDocumentId) {
      return;
    }

    void workbench.activateDocument(targetDocumentId);
  };

  const navigateDocumentBack = (): void => navigateDocument('back');
  const navigateDocumentForward = (): void => navigateDocument('forward');

  const gitBranchName = computed(() => gitStore.status.headBranchName ?? null);

  /**
   * 按 Git status letter 精确分类统计文件变更数。
   *
   * 修复：此前 gitRemovedCount 恒为 0（写死），且 gitAddedCount 把 modified
   * 文件也算进了「新增」。现在直接遍历 status.files 数组按 index/worktree
   * status 分类：A=新增、D=删除、M/R=修改、?=未跟踪。
   */
  const gitChangeSummary = computed(() => {
    const files = gitStore.status.files;
    let added = 0;
    let modified = 0;
    let deleted = 0;

    for (const file of files) {
      if (file.isUntracked) {
        added++;
        continue;
      }
      const status = file.indexStatus ?? file.worktreeStatus;
      switch (status) {
        case 'A':
        case '?':
          added++;
          break;
        case 'D':
          deleted++;
          break;
        case 'M':
        case 'R':
          modified++;
          break;
        default:
          // C (copy)、T (type change) 等归入 modified
          modified++;
          break;
      }
    }

    return { added, modified, deleted, total: files.length };
  });

  const shouldRenderDiagnosticsPanel = computed(
    () => workbench.editorStore.hasActiveDocument && workbench.editorStore.document.kind === 'text',
  );
  const isEditorMode = computed(() => activePrimaryMode.value === 'editor');
  const isAiMode = computed(() => activePrimaryMode.value === 'ai');
  const canToggleDiagnosticsPanel = computed(
    () => isEditorMode.value && shouldRenderDiagnosticsPanel.value,
  );
  const diagnosticIssueCount = computed(() => workbench.editorStore.activeDiagnostics.length);
  const {
    diagnosticsTransitionsEnabled,
    diagnosticsPanelMotionClass,
    diagnosticsPanelStyle,
    handleShellWindowResizeStart,
    handleShellWindowResizeFrame,
    handleShellWindowResizeEnd,
    handleShellWindowResizeSettled,
    mount: mountViewportState,
    cleanup: cleanupViewportState,
  } = useShellWorkbenchViewportState({ editorViewportRef });

  const scheduleEditorLayoutDuringWindowResize = (): void => {
    if (editorLiveResizeFrameId !== null) {
      return;
    }

    editorLiveResizeFrameId = window.requestAnimationFrame(() => {
      editorLiveResizeFrameId = null;
      editorRef.value?.layoutEditor();
    });
  };

  const handleShellWindowResizeFrameEvent = (): void => {
    handleShellWindowResizeFrame();
    scheduleEditorLayoutDuringWindowResize();
  };

  const handleInsertTemplate = (template: ICommandTemplate): void => {
    editorRef.value?.insertSnippet(template.snippet);
    editorRef.value?.focusEditor();
    workbench.notifyTemplateInserted(template);
  };

  const handleFormatDocument = async (): Promise<void> => {
    await workbench.formatDocumentWithShfmt();
  };

  const handleCursorPositionChange = (line: number, column: number): void => {
    workbench.editorStore.setCursorPosition(line, column);
  };

  const handleSelectionChange = (selection: IEditorSelectionSummary | null): void => {
    workbench.editorStore.setActiveSelectionSummary(selection);
  };

  const handleDiagnosticsChange = (documentId: string, payload: IAnalyzeScriptPayload): void => {
    workbench.editorStore.setDocumentAnalysis(documentId, payload);
  };

  const handleSelectDiagnostic = (line: number, column: number): void => {
    editorRef.value?.revealPosition(line, column);
    editorRef.value?.focusEditor();
  };

  const handleRerunDiagnostics = (): void => {
    editorRef.value?.rerunDiagnostics();
  };

  const closeDiagnosticsPanel = (): void => {
    if (!isDiagnosticsPanelVisible.value) {
      return;
    }

    isDiagnosticsPanelVisible.value = false;
  };

  const applyPrimaryMode = (mode: TWorkbenchPrimaryMode): void => {
    if (mode === 'ai') {
      // 性能优化：切换 AI/编辑模式时不要强制改写终端可见性。
      // 终端是否可见属于“编辑模式布局状态”，强制写 false 会触发主界面分支切换
      // (split/maximized) 导致编辑器区域重建，进而造成切换卡顿。
      // AI 模式下编辑器区域本来就 v-show 隐藏，因此保留终端状态是安全的。
      isSidebarVisible.value = true;
      activePrimaryMode.value = 'ai';
      closeDiagnosticsPanel();
      return;
    }

    activePrimaryMode.value = 'editor';
  };

  const persistPrimaryMode = (mode: TWorkbenchPrimaryMode): void => {
    if (workbench.appStore.workbenchPrimaryMode !== mode) {
      workbench.appStore.setWorkbenchPrimaryMode(mode);
    }
  };

  watch(
    () => workbench.appStore.workbenchPrimaryMode,
    (nextMode) => {
      applyPrimaryMode(nextMode);
    },
    { immediate: true },
  );

  const openDiagnosticsPanel = async (): Promise<void> => {
    if (!canToggleDiagnosticsPanel.value || isDiagnosticsPanelVisible.value) {
      return;
    }

    openEditorMode();
    isDiagnosticsPanelVisible.value = true;
  };

  const openTerminal = async (): Promise<void> => {
    if (activePrimaryMode.value !== 'editor') {
      return;
    }

    isTerminalVisible.value = true;
  };

  const openEditorMode = (): void => {
    applyPrimaryMode('editor');
    persistPrimaryMode('editor');
  };

  const openAiMode = (): void => {
    applyPrimaryMode('ai');
    persistPrimaryMode('ai');
  };

  const handleTerminalHeightChange = (value: number): void => {
    const nextHeight = clampTerminalPanelHeight(value);
    terminalHeight.value = nextHeight;
    if (!isTerminalMaximized.value) {
      terminalHeightBeforeMaximize.value = nextHeight;
    }
    workbench.appStore.setTerminalPanelHeight(nextHeight);
  };

  const handleAiPanelWidthChange = (value: number): void => {
    const nextWidth = clampAiPanelWidth(value);
    aiPanelWidth.value = nextWidth;
    workbench.appStore.setAiPanelWidth(nextWidth);
  };

  const toggleTerminalMaximize = (): void => {
    if (activePrimaryMode.value !== 'editor') {
      return;
    }

    if (!isTerminalVisible.value) {
      isTerminalVisible.value = true;
      workbench.editorStore.setWorkbenchSessionState({ isTerminalVisible: true });
    }

    if (isTerminalMaximized.value) {
      isTerminalMaximized.value = false;
      terminalHeight.value = Math.max(160, terminalHeightBeforeMaximize.value);
      return;
    }

    terminalHeightBeforeMaximize.value = terminalHeight.value;
    isTerminalMaximized.value = true;
    terminalHeight.value = TERMINAL_MAXIMIZED_PX;
  };

  const scheduleEditorLayoutAfterSidebarChange = (): void => {
    void nextTick(() => {
      editorRef.value?.layoutEditor();

      if (editorLayoutAfterSidebarFrameId !== null) {
        window.cancelAnimationFrame(editorLayoutAfterSidebarFrameId);
      }

      editorLayoutAfterSidebarFrameId = window.requestAnimationFrame(() => {
        editorLayoutAfterSidebarFrameId = null;
        editorRef.value?.layoutEditor();
      });
    });
  };

  const handleRequestCloseApplication = async (): Promise<void> => {
    await workbench.requestCloseApplication();
  };

  const saveActiveDocumentFromShortcut = async (): Promise<void> => {
    if (
      activePrimaryMode.value !== 'editor' ||
      !workbench.isDesktopRuntime.value ||
      !workbench.canSave.value
    ) {
      return;
    }

    await workbench.saveDocument();
  };

  const handleGlobalKeydownCapture = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }

    if (isPrimaryModifierShortcut(event, 'KeyS', 's')) {
      event.preventDefault();
      event.stopPropagation();

      if (!event.repeat) {
        void saveActiveDocumentFromShortcut();
      }
    }
  };

  const bindGlobalKeydownCapture = (): void => {
    window.addEventListener('keydown', handleGlobalKeydownCapture, true);
    globalKeydownCleanup = () => {
      window.removeEventListener('keydown', handleGlobalKeydownCapture, true);
      globalKeydownCleanup = null;
    };
  };

  const toggleDiagnosticsPanel = async (): Promise<void> => {
    if (!canToggleDiagnosticsPanel.value) {
      return;
    }

    if (isDiagnosticsPanelVisible.value) {
      closeDiagnosticsPanel();
      return;
    }

    await openDiagnosticsPanel();
  };

  const showSidebarView = (view: TWorkbenchSidebarView): void => {
    activeSidebarView.value = view;
    isSidebarVisible.value = true;
    workbench.editorStore.setWorkbenchSessionState({ activeSidebarView: view });
    scheduleEditorLayoutAfterSidebarChange();
  };

  const handleSelectSidebarView = async (view: TWorkbenchSidebarView): Promise<void> => {
    if (view === 'ai') {
      openAiMode();
      return;
    }

    showSidebarView(view);
  };

  const hideTerminal = (): void => {
    isTerminalVisible.value = false;
    workbench.editorStore.setWorkbenchSessionState({ isTerminalVisible: false });
  };

  const emitWorkbenchReady = async (): Promise<void> => {
    if (hasEmittedReady.value || isUnmounted) {
      return;
    }

    await nextTick();
    await waitForInitialWorkbenchPaint();

    if (isUnmounted || hasEmittedReady.value) {
      return;
    }

    hasEmittedReady.value = true;
    markStartup('workbench-initial-paint-ready');
    onReady();
  };

  const restoreWorkbenchSession = async (): Promise<void> => {
    isRestoringWorkbenchSession.value = true;
    markStartup('restore-session-start');
    try {
      await workbench.restoreSession();
      markStartup('restore-session-done');
    } catch (error) {
      markStartup('restore-session-failed');
      if (isUnmounted) {
        return;
      }

      workbench.editorStore.appendLog(
        'error',
        '恢复会话失败',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      isRestoringWorkbenchSession.value = false;
    }
  };

  const initializeWorkbench = async (): Promise<void> => {
    markStartup('workbench-initialize-start');

    let result: Awaited<ReturnType<typeof workbench.initialize>>;
    try {
      result = await workbench.initialize();
      markStartup('workbench-initialize-done');
    } catch (error) {
      markStartup('workbench-initialize-failed');
      throw error;
    }

    if (isUnmounted) {
      return;
    }

    startupWorkspaceRoot.value = result.startupWorkspaceDirectory;
    await emitWorkbenchReady();

    if (isUnmounted) {
      return;
    }

    void restoreWorkbenchSession();
  };

  const bindNativeWindowCloseRequest = async (): Promise<void> => {
    const runtimeReady = await waitForDesktopRuntime(400);
    if (!runtimeReady || isUnmounted) {
      return;
    }

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    if (isUnmounted) {
      return;
    }

    const unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
      if (consumeProgrammaticWindowCloseAllowance()) {
        return;
      }

      event.preventDefault();
      await handleRequestCloseApplication();
    });

    if (isUnmounted) {
      unlisten();
      return;
    }

    nativeCloseRequestedUnlisten = unlisten;
  };

  const handleRunScript = async (): Promise<void> => {
    openEditorMode();
    closeDiagnosticsPanel();
    isTerminalVisible.value = true;
    workbench.editorStore.setWorkbenchSessionState({ isTerminalVisible: true });
    await workbench.runScript();
  };

  const handleExplorerSessionStateChange = (payload: {
    expandedPaths: string[];
    selectedPath: string | null;
  }): void => {
    workbench.editorStore.setWorkbenchSessionState({
      explorerExpandedPaths: payload.expandedPaths,
      explorerSelectedPath: payload.selectedPath,
    });
  };

  const handleIntegratedTerminalRunCompleted = (payload: ITerminalRunCompletedPayload): void => {
    workbench.handleIntegratedTerminalRunCompleted(payload);
  };

  const { titlebarRef, handleOpenCommandPalette } = useShellWorkbenchAiBridge();

  watch(
    () => [workbench.editorStore.hasActiveDocument, workbench.editorStore.document.kind],
    () => {
      if (!shouldRenderDiagnosticsPanel.value && isDiagnosticsPanelVisible.value) {
        closeDiagnosticsPanel();
      }
    },
    { immediate: true },
  );

  watch(
    () => workbench.editorStore.activeDocumentId,
    (nextDocumentId, previousDocumentId) => {
      if (!nextDocumentId || nextDocumentId === previousDocumentId) {
        return;
      }

      // 注意：这里不再强制 openEditorMode。仅切换 activeDocumentId（切换已打开的标签、
      // 文档前进后退）不应强制切到编辑模式；“新打开并激活文档”才进编辑模式的逻辑
      // 已下沉到 documents watch（依据旧值快照判定是否新增了文档）。
      if (docHistory.isNavigating.value) {
        docHistory.finishNavigation();
        return;
      }

      docHistory.recordNavigation(previousDocumentId, nextDocumentId, hasDocumentInEditorStore);
    },
  );

  watch(
    () => (workbench.editorStore.documents ?? []).map((item) => item.id),
    (documentIds, previousDocumentIds) => {
      const documentIdSet = new Set(documentIds);
      for (const id of documentIds) {
        if (!documentIdSet.has(id)) {
          docHistory.removeClosedDocument(id);
        }
      }
      // 也清理栈中已不存在的文档
      documentBackStack.value = documentBackStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );
      documentForwardStack.value = documentForwardStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );

      // 仅当“新打开了一个文档并将其激活”时才进入编辑模式。
      // 依据 watcher 提供的旧值快照判定是否新增了文档，读取实时 activeDocumentId，
      // 与 activeDocumentId watch 的执行顺序无关。切换已打开标签 / 前进后退不会新增文档，
      // 因此不会再被强制切到编辑模式（修复 activeDocumentId 变化即强制 openEditorMode 的回归）。
      if (previousDocumentIds === undefined || isRestoringWorkbenchSession.value) {
        return;
      }

      const previousDocumentIdSet = new Set(previousDocumentIds);
      const activeDocumentId = workbench.editorStore.activeDocumentId;
      const hasOpenedAndActivatedNewDocument =
        Boolean(activeDocumentId) &&
        documentIdSet.has(activeDocumentId as string) &&
        !previousDocumentIdSet.has(activeDocumentId as string);

      if (hasOpenedAndActivatedNewDocument) {
        openEditorMode();
      }
    },
    { immediate: true },
  );

  onMounted(() => {
    isUnmounted = false;
    markStartup('shell-workbench-mounted');
    window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
    window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrameEvent);
    window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
    window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);

    mountViewportState();

    bindGlobalKeydownCapture();
    scheduleStartupNonCriticalTask(() => {
      void bindNativeWindowCloseRequest();
    }, 1800);
    void initializeWorkbench();
  });

  onBeforeUnmount(() => {
    isUnmounted = true;
    window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
    window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrameEvent);
    window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
    globalKeydownCleanup?.();
    nativeCloseRequestedUnlisten?.();
    nativeCloseRequestedUnlisten = null;
    cleanupViewportState();

    if (editorLayoutAfterSidebarFrameId !== null) {
      window.cancelAnimationFrame(editorLayoutAfterSidebarFrameId);
      editorLayoutAfterSidebarFrameId = null;
    }

    if (editorLiveResizeFrameId !== null) {
      window.cancelAnimationFrame(editorLiveResizeFrameId);
      editorLiveResizeFrameId = null;
    }
  });

  return {
    ...workbench,
    gitStore,
    titlebarRef,
    editorRef,
    editorViewportRef,
    isTerminalVisible,
    isSidebarVisible,
    aiPanelWidth,
    isEditorMode,
    isAiMode,
    isDiagnosticsPanelVisible,
    terminalHeight,
    isTerminalMaximized,
    activeSidebarView,
    sidebarWidth,
    startupWorkspaceRoot,
    startupExplorerExpandedPaths,
    startupExplorerSelectedPath,
    visibleWorkspaceRootPath,
    diagnosticsTransitionsEnabled,
    canNavigateDocumentBack,
    canNavigateDocumentForward,
    navigateDocumentBack,
    navigateDocumentForward,
    gitBranchName,
    gitChangeSummary,
    shouldRenderDiagnosticsPanel,
    canToggleDiagnosticsPanel,
    diagnosticIssueCount,
    diagnosticsPanelMotionClass,
    diagnosticsPanelStyle,
    handleInsertTemplate,
    handleFormatDocument,
    handleCursorPositionChange,
    handleSelectionChange,
    handleDiagnosticsChange,
    handleSelectDiagnostic,
    handleRerunDiagnostics,
    handleTerminalHeightChange,
    handleAiPanelWidthChange,
    toggleTerminalMaximize,
    openEditorMode,
    openAiMode,
    handleRequestCloseApplication,
    toggleDiagnosticsPanel,
    handleSelectSidebarView,
    handleExplorerSessionStateChange,
    hideTerminal,
    openTerminal,
    handleRunScript,
    handleIntegratedTerminalRunCompleted,
    handleOpenCommandPalette,
  };
};
