import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { markStartup } from '@/utils/startup-profiler';
import { createStartupShellState } from '@/utils/startup-shell';
import { consumeProgrammaticWindowCloseAllowance } from '@/utils/window-close';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';

export type TEditorExpose = {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  rerunDiagnostics: () => void;
  layoutEditor: () => void;
};

const READY_PAINT_FALLBACK_TIMEOUT_MS = 96;
const MAX_DOCUMENT_NAV_HISTORY = 120;
const AI_PANEL_DEFAULT_WIDTH = 450;
const AI_PANEL_MIN_WIDTH = 350;
const AI_PANEL_MAX_WIDTH = 550;
const DASHBOARD_SIDEBAR_WIDTH = 288;

const isPrimaryModifierShortcut = (event: KeyboardEvent, code: string, key: string): boolean =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.code === code || event.key.toLowerCase() === key);

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
  const terminalHeight = ref(236);
  const terminalHeightBeforeMaximize = ref(236);
  const isTerminalMaximized = ref(false);
  const activeSidebarView = ref<TWorkbenchSidebarView>(
    workbench.editorStore.sessionSnapshot.workbench.activeSidebarView,
  );
  const startupWorkspaceRoot = ref<IWorkspaceDirectoryPayload | null>(null);
  const hasEmittedReady = ref(false);
  const isStartupShellPrimed = ref(false);
  const isRestoringWorkbenchSession = ref(false);
  const documentBackStack = ref<string[]>([]);
  const documentForwardStack = ref<string[]>([]);
  let isApplyingDocumentNavigation = false;
  let isSyncingAiPanelWidth = false;
  let isSyncingTerminalPanelHeight = false;

  let nativeCloseRequestedUnlisten: (() => void) | null = null;
  let isUnmounted = false;
  let editorLayoutAfterSidebarFrameId: number | null = null;
  let editorLiveResizeFrameId: number | null = null;
  let globalKeydownCleanup: (() => void) | null = null;

  const sidebarWidth = computed(() => DASHBOARD_SIDEBAR_WIDTH);
  const startupShellState = computed(() =>
    createStartupShellState(workbench.editorStore.sessionSnapshot),
  );
  const isStartupShellVisible = computed(
    () => isStartupShellPrimed.value && !workbench.editorStore.hasActiveDocument,
  );
  const visibleWorkspaceRootPath = computed(() =>
    isStartupShellVisible.value
      ? (startupShellState.value?.workspaceRoot ?? workbench.editorStore.workspaceRootPath)
      : workbench.editorStore.workspaceRootPath,
  );

  const clampAiPanelWidth = (value: number): number =>
    Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, Math.round(value)));

  const clampTerminalPanelHeight = (value: number): number => Math.max(140, Math.round(value));

  watch(
    () => workbench.appStore.aiPanelWidth,
    (nextWidth) => {
      // 防回环：若当前正在同步中则跳过
      if (isSyncingAiPanelWidth) {
        return;
      }
      isSyncingAiPanelWidth = true;
      const clampedWidth = clampAiPanelWidth(nextWidth);
      if (clampedWidth !== aiPanelWidth.value) {
        aiPanelWidth.value = clampedWidth;
      }

      if (clampedWidth !== nextWidth) {
        workbench.appStore.setAiPanelWidth(clampedWidth);
      }
      isSyncingAiPanelWidth = false;
    },
    { immediate: true },
  );

  watch(
    () => workbench.appStore.terminalPanelHeight,
    (nextHeight) => {
      // 防回环：若当前正在同步中则跳过
      if (isSyncingTerminalPanelHeight) {
        return;
      }
      isSyncingTerminalPanelHeight = true;
      const clampedHeight = clampTerminalPanelHeight(nextHeight);

      if (clampedHeight !== terminalHeight.value && !isTerminalMaximized.value) {
        terminalHeight.value = clampedHeight;
      }

      if (clampedHeight !== terminalHeightBeforeMaximize.value) {
        terminalHeightBeforeMaximize.value = clampedHeight;
      }

      if (clampedHeight !== nextHeight) {
        workbench.appStore.setTerminalPanelHeight(clampedHeight);
      }
      isSyncingTerminalPanelHeight = false;
    },
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

  const canNavigateDocumentBack = computed(() => {
    if (documentBackStack.value.length > 0) {
      return true;
    }

    const currentDocumentId = workbench.editorStore.activeDocumentId;
    return currentDocumentId
      ? resolveAdjacentDocumentId(currentDocumentId, 'back') !== null
      : false;
  });

  const canNavigateDocumentForward = computed(() => {
    if (documentForwardStack.value.length > 0) {
      return true;
    }

    const currentDocumentId = workbench.editorStore.activeDocumentId;
    return currentDocumentId
      ? resolveAdjacentDocumentId(currentDocumentId, 'forward') !== null
      : false;
  });

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

  const navigateDocumentBack = (): void => {
    const currentDocumentId = workbench.editorStore.activeDocumentId;
    if (!currentDocumentId) {
      return;
    }

    const targetDocumentId =
      pickNextNavigableDocumentId(documentBackStack, currentDocumentId) ??
      resolveAdjacentDocumentId(currentDocumentId, 'back');
    if (!targetDocumentId) {
      return;
    }

    documentForwardStack.value = trimDocumentNavHistory([
      ...documentForwardStack.value,
      currentDocumentId,
    ]);
    isApplyingDocumentNavigation = true;
    workbench.activateDocument(targetDocumentId);
  };

  const navigateDocumentForward = (): void => {
    const currentDocumentId = workbench.editorStore.activeDocumentId;
    if (!currentDocumentId) {
      return;
    }

    const targetDocumentId =
      pickNextNavigableDocumentId(documentForwardStack, currentDocumentId) ??
      resolveAdjacentDocumentId(currentDocumentId, 'forward');
    if (!targetDocumentId) {
      return;
    }

    documentBackStack.value = trimDocumentNavHistory([
      ...documentBackStack.value,
      currentDocumentId,
    ]);
    isApplyingDocumentNavigation = true;
    workbench.activateDocument(targetDocumentId);
  };

  const gitBranchName = computed(() => gitStore.status.headBranchName ?? null);
  const gitAddedCount = computed(
    () =>
      gitStore.status.stagedCount + gitStore.status.unstagedCount + gitStore.status.untrackedCount,
  );
  const gitRemovedCount = computed(() => 0);

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

  const handleShellWindowResizeFrame = (): void => {
    handleShellWindowResizeEnd();
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
    terminalHeight.value = 100000;
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
      isStartupShellPrimed.value = false;
    }
  };

  const initializeWorkbench = async (): Promise<void> => {
    markStartup('workbench-initialize-start');
    isStartupShellPrimed.value = true;

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

      if (!isRestoringWorkbenchSession.value) {
        openEditorMode();
      }

      if (isApplyingDocumentNavigation) {
        isApplyingDocumentNavigation = false;
        return;
      }

      if (previousDocumentId && hasDocumentInEditorStore(previousDocumentId)) {
        documentBackStack.value = trimDocumentNavHistory([
          ...documentBackStack.value,
          previousDocumentId,
        ]);
      }

      documentForwardStack.value = [];
    },
  );

  watch(
    () => (workbench.editorStore.documents ?? []).map((item) => item.id),
    (documentIds) => {
      const documentIdSet = new Set(documentIds);
      documentBackStack.value = documentBackStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );
      documentForwardStack.value = documentForwardStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );
    },
    { immediate: true },
  );

  onMounted(() => {
    isUnmounted = false;
    isStartupShellPrimed.value = true;
    markStartup('shell-workbench-mounted');
    window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
    window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrame);
    window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
    window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);

    mountViewportState();

    bindGlobalKeydownCapture();
    void bindNativeWindowCloseRequest();
    void initializeWorkbench();
  });

  onBeforeUnmount(() => {
    isUnmounted = true;
    window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
    window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrame);
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
    startupShellState,
    isStartupShellVisible,
    visibleWorkspaceRootPath,
    diagnosticsTransitionsEnabled,
    startupWorkspaceRoot,
    canNavigateDocumentBack,
    canNavigateDocumentForward,
    navigateDocumentBack,
    navigateDocumentForward,
    gitBranchName,
    gitAddedCount,
    gitRemovedCount,
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
