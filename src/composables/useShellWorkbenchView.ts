import { useWorkbench } from '@/composables/useWorkbench';
import { useGitStore } from '@/store/git';
import type { TWorkbenchSidebarView } from '@/types/app';
import type {
  IAnalyzeScriptPayload,
  ICommandTemplate,
  IEditorSelectionSummary,
  IWorkspaceDirectoryPayload,
} from '@/types/editor';
import type { ITerminalRunCompletedPayload } from '@/types/terminal';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { consumeProgrammaticWindowCloseAllowance } from '@/utils/window-close';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
} from '@/utils/window-resize-events';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

export type TEditorExpose = {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  rerunDiagnostics: () => void;
  layoutEditor: () => void;
};

export type TSettingsOverlayExpose = {
  focusSearch: () => void;
  requestClose: () => Promise<boolean>;
};

type TWorkbenchSurfaceMode = 'workbench' | 'settings';

const SETTINGS_STATUS_MESSAGE_DURATION_MS = 2200;
const WIDE_SIDEBAR_VIEWS: readonly TWorkbenchSidebarView[] = [
  'source-control',
  'explorer',
  'search',
  'run',
  'extensions',
  'ai',
];

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const resolveDiagnosticsPanelWidth = (availableWidth: number): number => {
  const normalizedWidth = Math.max(0, Math.round(availableWidth));
  if (normalizedWidth <= 0) {
    return 0;
  }

  const inset = normalizedWidth >= 960 ? 24 : 16;
  const hardMaxWidth = Math.max(0, normalizedWidth - inset);
  if (hardMaxWidth <= 0) {
    return normalizedWidth;
  }

  const sizeStrategy =
    normalizedWidth >= 1680
      ? { ratio: 0.28, minWidth: 320, softMaxWidth: 460 }
      : normalizedWidth >= 1440
        ? { ratio: 0.3, minWidth: 300, softMaxWidth: 440 }
        : normalizedWidth >= 1200
          ? { ratio: 0.32, minWidth: 280, softMaxWidth: 420 }
          : normalizedWidth >= 960
            ? { ratio: 0.34, minWidth: 260, softMaxWidth: 400 }
            : normalizedWidth >= 760
              ? { ratio: 0.38, minWidth: 220, softMaxWidth: 360 }
              : { ratio: 0.46, minWidth: 180, softMaxWidth: 320 };

  const resolvedMaxWidth = Math.min(hardMaxWidth, sizeStrategy.softMaxWidth);
  const resolvedMinWidth = Math.min(sizeStrategy.minWidth, resolvedMaxWidth);
  const preferredWidth = Math.round(normalizedWidth * sizeStrategy.ratio);

  return clampNumber(preferredWidth, resolvedMinWidth, resolvedMaxWidth);
};

export const useShellWorkbenchView = (onReady: () => void) => {
  const editorRef = ref<TEditorExpose | null>(null);
  const editorViewportRef = ref<HTMLElement | null>(null);
  const settingsOverlayRef = ref<TSettingsOverlayExpose | null>(null);
  const workbench = useWorkbench();
  const gitStore = useGitStore();

  const isTerminalVisible = ref(true);
  const isSidebarVisible = ref(true);
  const isAiPanelVisible = ref(false);
  const isDiagnosticsPanelVisible = ref(false);
  const activeSurfaceMode = ref<TWorkbenchSurfaceMode>('workbench');
  const terminalHeight = ref(236);
  const terminalHeightBeforeMaximize = ref(236);
  const isTerminalMaximized = ref(false);
  const activeSidebarView = ref<TWorkbenchSidebarView>('explorer');
  const statusbarMessage = ref<string | null>(null);
  const editorViewportWidth = ref(0);
  const diagnosticsTransitionsEnabled = ref(true);
  const startupWorkspaceRoot = ref<IWorkspaceDirectoryPayload | null>(null);
  const hasEmittedReady = ref(false);

  let editorViewportResizeObserver: ResizeObserver | null = null;
  let diagnosticsResizeSettleTimerId: number | null = null;
  let editorViewportResizeFrameId: number | null = null;
  let nativeCloseRequestedUnlisten: (() => void) | null = null;
  let previousEditorViewportSize = { width: 0, height: 0 };
  let pendingEditorViewportSize: { width: number; height: number } | null = null;
  let isUnmounted = false;
  let isShellWindowResizing = false;
  let statusbarMessageTimerId: number | null = null;
  let editorLayoutAfterSidebarFrameId: number | null = null;
  let focusBeforeSettingsOpen: HTMLElement | null = null;
  let globalKeydownCleanup: (() => void) | null = null;
  let previousSidebarView: TWorkbenchSidebarView = 'explorer';

  const sidebarWidth = computed(() =>
    WIDE_SIDEBAR_VIEWS.includes(activeSidebarView.value) ? 280 : 240,
  );

  const gitBranchName = computed(() => gitStore.status.headBranchName ?? null);
  const gitAddedCount = computed(
    () =>
      gitStore.status.stagedCount + gitStore.status.unstagedCount + gitStore.status.untrackedCount,
  );
  const gitRemovedCount = computed(() => 0);

  const shouldRenderDiagnosticsPanel = computed(
    () => workbench.editorStore.hasActiveDocument && workbench.editorStore.document.kind === 'text',
  );
  const isSettingsView = computed(() => activeSurfaceMode.value === 'settings');
  const isWorkbenchContentVisible = computed(() => activeSurfaceMode.value === 'workbench');
  const canToggleDiagnosticsPanel = computed(() => shouldRenderDiagnosticsPanel.value);
  const diagnosticIssueCount = computed(() => workbench.editorStore.activeDiagnostics.length);
  const diagnosticsPanelMotionClass = computed(() =>
    diagnosticsTransitionsEnabled.value
      ? 'transition-[opacity,transform,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
      : 'transition-none',
  );
  const diagnosticsPanelStyle = computed(() => {
    const availableWidth = editorViewportWidth.value;
    if (availableWidth <= 0) {
      return undefined;
    }

    const resolvedWidth = resolveDiagnosticsPanelWidth(availableWidth);
    return {
      width: `${resolvedWidth}px`,
      maxWidth: '100%',
    };
  });

  const scheduleDiagnosticsTransitionRestore = (): void => {
    if (diagnosticsResizeSettleTimerId !== null) {
      window.clearTimeout(diagnosticsResizeSettleTimerId);
    }

    diagnosticsResizeSettleTimerId = window.setTimeout(() => {
      diagnosticsTransitionsEnabled.value = true;
      diagnosticsResizeSettleTimerId = null;
    }, 140);
  };

  const handleEditorViewportResize = (width: number, height: number): void => {
    const normalizedWidth = Math.round(width);
    const normalizedHeight = Math.round(height);

    if (normalizedWidth <= 0 || normalizedHeight <= 0) {
      return;
    }

    if (editorViewportWidth.value !== normalizedWidth) {
      editorViewportWidth.value = normalizedWidth;
    }

    if (
      previousEditorViewportSize.width === normalizedWidth &&
      previousEditorViewportSize.height === normalizedHeight
    ) {
      return;
    }

    previousEditorViewportSize = { width: normalizedWidth, height: normalizedHeight };
    diagnosticsTransitionsEnabled.value = false;
    scheduleDiagnosticsTransitionRestore();
  };

  const flushEditorViewportResize = (): void => {
    editorViewportResizeFrameId = null;
    if (!pendingEditorViewportSize) {
      return;
    }

    const { width, height } = pendingEditorViewportSize;
    pendingEditorViewportSize = null;
    handleEditorViewportResize(width, height);
  };

  const queueEditorViewportResize = (width: number, height: number): void => {
    pendingEditorViewportSize = {
      width: Math.round(width),
      height: Math.round(height),
    };

    if (isShellWindowResizing) {
      return;
    }

    if (editorViewportResizeFrameId !== null) {
      return;
    }

    editorViewportResizeFrameId = window.requestAnimationFrame(flushEditorViewportResize);
  };

  const handleShellWindowResizeStart = (): void => {
    isShellWindowResizing = true;
    diagnosticsTransitionsEnabled.value = false;

    if (diagnosticsResizeSettleTimerId !== null) {
      window.clearTimeout(diagnosticsResizeSettleTimerId);
      diagnosticsResizeSettleTimerId = null;
    }
  };

  const handleShellWindowResizeEnd = (): void => {
    if (editorViewportRef.value) {
      pendingEditorViewportSize = {
        width: Math.round(editorViewportRef.value.clientWidth),
        height: Math.round(editorViewportRef.value.clientHeight),
      };
    }
  };

  const handleShellWindowResizeSettled = (): void => {
    isShellWindowResizing = false;

    if (editorViewportResizeFrameId !== null) {
      window.cancelAnimationFrame(editorViewportResizeFrameId);
      editorViewportResizeFrameId = null;
    }

    if (editorViewportRef.value) {
      pendingEditorViewportSize = {
        width: Math.round(editorViewportRef.value.clientWidth),
        height: Math.round(editorViewportRef.value.clientHeight),
      };
    }
    flushEditorViewportResize();
    scheduleDiagnosticsTransitionRestore();
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

  const closeSettingsView = async (): Promise<void> => {
    if (!isSettingsView.value) {
      return;
    }

    activeSurfaceMode.value = 'workbench';
    await nextTick();

    if (focusBeforeSettingsOpen && document.contains(focusBeforeSettingsOpen)) {
      focusBeforeSettingsOpen.focus();
      focusBeforeSettingsOpen = null;
      return;
    }

    focusBeforeSettingsOpen = null;
    editorRef.value?.focusEditor();
  };

  const requestCloseSettingsView = async (): Promise<boolean> => {
    if (!isSettingsView.value) {
      return true;
    }

    if (!settingsOverlayRef.value) {
      await closeSettingsView();
      return true;
    }

    return settingsOverlayRef.value.requestClose();
  };

  const runAfterClosingSettings = async (action: () => void | Promise<void>): Promise<boolean> => {
    const didCloseSettings = await requestCloseSettingsView();
    if (!didCloseSettings) {
      return false;
    }

    await action();
    return true;
  };

  const openDiagnosticsPanel = async (): Promise<void> => {
    if (!canToggleDiagnosticsPanel.value || isDiagnosticsPanelVisible.value) {
      return;
    }

    await runAfterClosingSettings(() => {
      isDiagnosticsPanelVisible.value = true;
    });
  };

  const openTerminal = async (): Promise<void> => {
    await runAfterClosingSettings(() => {
      isAiPanelVisible.value = false;
      if (activeSidebarView.value === 'ai') {
        activeSidebarView.value = previousSidebarView;
        isSidebarVisible.value = true;
      }
      isTerminalVisible.value = true;
    });
  };

  const handleTerminalHeightChange = (value: number): void => {
    terminalHeight.value = value;
    if (!isTerminalMaximized.value) {
      terminalHeightBeforeMaximize.value = value;
    }
  };

  const toggleTerminalMaximize = (): void => {
    isAiPanelVisible.value = false;

    if (!isTerminalVisible.value) {
      isTerminalVisible.value = true;
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

  const toggleSidebar = (): void => {
    isSidebarVisible.value = !isSidebarVisible.value;
    scheduleEditorLayoutAfterSidebarChange();
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

  const clearStatusbarMessageTimer = (): void => {
    if (statusbarMessageTimerId !== null) {
      window.clearTimeout(statusbarMessageTimerId);
      statusbarMessageTimerId = null;
    }
  };

  const showStatusbarMessage = (message: string): void => {
    clearStatusbarMessageTimer();
    statusbarMessage.value = message;
    statusbarMessageTimerId = window.setTimeout(() => {
      statusbarMessage.value = null;
      statusbarMessageTimerId = null;
    }, SETTINGS_STATUS_MESSAGE_DURATION_MS);
  };

  const openSettingsView = async (): Promise<void> => {
    if (isSettingsView.value) {
      return;
    }

    focusBeforeSettingsOpen =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeSurfaceMode.value = 'settings';
    await nextTick();
    settingsOverlayRef.value?.focusSearch();
  };

  const toggleSettingsView = async (): Promise<void> => {
    if (isSettingsView.value) {
      await requestCloseSettingsView();
      return;
    }

    await openSettingsView();
  };

  const handleSettingsSaved = (message: string): void => {
    showStatusbarMessage(message);
  };

  const handleRequestCloseApplication = async (): Promise<void> => {
    await runAfterClosingSettings(() => workbench.requestCloseApplication());
  };

  const handleGlobalKeydownCapture = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }

    const isSettingsShortcut =
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (event.key === ',' || event.code === 'Comma');

    if (isSettingsShortcut) {
      event.preventDefault();
      event.stopPropagation();
      void toggleSettingsView();
      return;
    }

    if (isSettingsView.value && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void requestCloseSettingsView();
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
    previousSidebarView = view;
    isAiPanelVisible.value = false;
    isSidebarVisible.value = true;
    scheduleEditorLayoutAfterSidebarChange();
  };

  const openAiPanel = (): void => {
    activeSidebarView.value = 'ai';
    isAiPanelVisible.value = true;
    isTerminalVisible.value = false;
    isSidebarVisible.value = false;
    scheduleEditorLayoutAfterSidebarChange();
  };

  const closeAiPanel = (): void => {
    isAiPanelVisible.value = false;
    if (activeSidebarView.value === 'ai') {
      activeSidebarView.value = previousSidebarView;
      isSidebarVisible.value = true;
    }
    scheduleEditorLayoutAfterSidebarChange();
  };

  const handleSelectSidebarView = async (view: TWorkbenchSidebarView): Promise<void> => {
    if (view === 'ai') {
      await runAfterClosingSettings(() => {
        if (isAiPanelVisible.value) {
          closeAiPanel();
          return;
        }

        openAiPanel();
      });
      return;
    }

    if (isSettingsView.value) {
      await runAfterClosingSettings(() => {
        showSidebarView(view);
      });
      return;
    }

    if (activeSidebarView.value === view) {
      if (view === 'source-control') {
        isSidebarVisible.value = true;
        return;
      }

      toggleSidebar();
      return;
    }

    showSidebarView(view);
  };

  const hideTerminal = (): void => {
    isTerminalVisible.value = false;
  };

  const clearTerminalLogs = (): void => {
    workbench.editorStore.clearLogs();
  };

  const emitWorkbenchReady = async (): Promise<void> => {
    if (hasEmittedReady.value || isUnmounted) {
      return;
    }

    await nextTick();
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    if (isUnmounted || hasEmittedReady.value) {
      return;
    }

    hasEmittedReady.value = true;
    onReady();
  };

  const initializeWorkbench = async (): Promise<void> => {
    const result = await workbench.initialize();
    if (isUnmounted) {
      return;
    }

    startupWorkspaceRoot.value = result.startupWorkspaceDirectory;
    await workbench.restoreSession();
    await emitWorkbenchReady();
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
    await runAfterClosingSettings(async () => {
      closeDiagnosticsPanel();
      isAiPanelVisible.value = false;
      if (activeSidebarView.value === 'ai') {
        activeSidebarView.value = previousSidebarView;
        isSidebarVisible.value = true;
      }
      isTerminalVisible.value = true;
      await workbench.runScript();
    });
  };

  const handleIntegratedTerminalRunCompleted = (payload: ITerminalRunCompletedPayload): void => {
    workbench.handleIntegratedTerminalRunCompleted(payload);
  };

  watch(
    () => [workbench.editorStore.hasActiveDocument, workbench.editorStore.document.kind],
    () => {
      if (!shouldRenderDiagnosticsPanel.value && isDiagnosticsPanelVisible.value) {
        closeDiagnosticsPanel();
      }
    },
    { immediate: true },
  );

  onMounted(() => {
    isUnmounted = false;
    window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
    window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
    window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);

    if (editorViewportRef.value) {
      previousEditorViewportSize = {
        width: editorViewportRef.value.clientWidth,
        height: editorViewportRef.value.clientHeight,
      };
      editorViewportWidth.value = editorViewportRef.value.clientWidth;
    }

    if (typeof ResizeObserver !== 'undefined' && editorViewportRef.value) {
      editorViewportResizeObserver = new ResizeObserver((entries) => {
        const targetEntry = entries[0];
        if (!targetEntry) {
          return;
        }

        queueEditorViewportResize(targetEntry.contentRect.width, targetEntry.contentRect.height);
      });
      editorViewportResizeObserver.observe(editorViewportRef.value);
    }

    bindGlobalKeydownCapture();
    void bindNativeWindowCloseRequest();
    void initializeWorkbench();
  });

  onBeforeUnmount(() => {
    isUnmounted = true;
    window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
    window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
    clearStatusbarMessageTimer();
    globalKeydownCleanup?.();
    nativeCloseRequestedUnlisten?.();
    nativeCloseRequestedUnlisten = null;
    editorViewportResizeObserver?.disconnect();
    editorViewportResizeObserver = null;

    if (editorViewportResizeFrameId !== null) {
      window.cancelAnimationFrame(editorViewportResizeFrameId);
      editorViewportResizeFrameId = null;
    }

    if (editorLayoutAfterSidebarFrameId !== null) {
      window.cancelAnimationFrame(editorLayoutAfterSidebarFrameId);
      editorLayoutAfterSidebarFrameId = null;
    }

    if (diagnosticsResizeSettleTimerId !== null) {
      window.clearTimeout(diagnosticsResizeSettleTimerId);
      diagnosticsResizeSettleTimerId = null;
    }
  });

  return {
    ...workbench,
    gitStore,
    editorRef,
    editorViewportRef,
    settingsOverlayRef,
    isTerminalVisible,
    isSidebarVisible,
    isAiPanelVisible,
    isDiagnosticsPanelVisible,
    isSettingsView,
    isWorkbenchContentVisible,
    terminalHeight,
    isTerminalMaximized,
    activeSidebarView,
    statusbarMessage,
    sidebarWidth,
    diagnosticsTransitionsEnabled,
    startupWorkspaceRoot,
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
    toggleTerminalMaximize,
    closeSettingsView,
    toggleSettingsView,
    handleSettingsSaved,
    handleRequestCloseApplication,
    toggleDiagnosticsPanel,
    handleSelectSidebarView,
    hideTerminal,
    openTerminal,
    closeAiPanel,
    clearTerminalLogs,
    handleRunScript,
    handleIntegratedTerminalRunCompleted,
  };
};
