import { useShellWorkbenchAiBridge } from '@/composables/useShellWorkbenchAiBridge';
import { useShellWorkbenchViewportState } from '@/composables/useShellWorkbenchViewportState';
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
import { dispatchWorkbenchReadyEvent } from '@/utils/startup-ready';
import { consumeProgrammaticWindowCloseAllowance } from '@/utils/window-close';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
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
type TWorkbenchPrimaryMode = 'editor' | 'ai';

const SETTINGS_STATUS_MESSAGE_DURATION_MS = 2200;
const READY_PAINT_FALLBACK_TIMEOUT_MS = 96;
const MAX_DOCUMENT_NAV_HISTORY = 120;
const AI_PANEL_DEFAULT_WIDTH = 450;
const AI_PANEL_MIN_WIDTH = 350;
const AI_PANEL_MAX_WIDTH = 550;
const WIDE_SIDEBAR_VIEWS: readonly TWorkbenchSidebarView[] = [
  'source-control',
  'explorer',
  'search',
  'run',
  'extensions',
];

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
  const settingsOverlayRef = ref<TSettingsOverlayExpose | null>(null);
  const workbench = useWorkbench();
  const gitStore = useGitStore();

  const isTerminalVisible = ref(true);
  const isSidebarVisible = ref(true);
  const aiPanelWidth = ref(AI_PANEL_DEFAULT_WIDTH);
  const isDiagnosticsPanelVisible = ref(false);
  const activePrimaryMode = ref<TWorkbenchPrimaryMode>('editor');
  const activeSurfaceMode = ref<TWorkbenchSurfaceMode>('workbench');
  const terminalHeight = ref(236);
  const terminalHeightBeforeMaximize = ref(236);
  const isTerminalMaximized = ref(false);
  const activeSidebarView = ref<TWorkbenchSidebarView>('explorer');
  const statusbarMessage = ref<string | null>(null);
  const startupWorkspaceRoot = ref<IWorkspaceDirectoryPayload | null>(null);
  const hasEmittedReady = ref(false);
  const documentBackStack = ref<string[]>([]);
  const documentForwardStack = ref<string[]>([]);
  let isApplyingDocumentNavigation = false;

  let nativeCloseRequestedUnlisten: (() => void) | null = null;
  let isUnmounted = false;
  let statusbarMessageTimerId: number | null = null;
  let editorLayoutAfterSidebarFrameId: number | null = null;
  let focusBeforeSettingsOpen: HTMLElement | null = null;
  let globalKeydownCleanup: (() => void) | null = null;

  const sidebarWidth = computed(() =>
    WIDE_SIDEBAR_VIEWS.includes(activeSidebarView.value) ? 280 : 240,
  );

  const clampAiPanelWidth = (value: number): number =>
    Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, Math.round(value)));

  const clampTerminalPanelHeight = (value: number): number =>
    Math.max(140, Math.round(value));

  watch(
    () => workbench.appStore.aiPanelWidth,
    (nextWidth) => {
      const clampedWidth = clampAiPanelWidth(nextWidth);
      if (clampedWidth !== aiPanelWidth.value) {
        aiPanelWidth.value = clampedWidth;
      }

      if (clampedWidth !== nextWidth) {
        workbench.appStore.setAiPanelWidth(clampedWidth);
      }
    },
    { immediate: true },
  );

  watch(
    () => workbench.appStore.terminalPanelHeight,
    (nextHeight) => {
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
      pickNextNavigableDocumentId(documentBackStack, currentDocumentId)
      ?? resolveAdjacentDocumentId(currentDocumentId, 'back');
    if (!targetDocumentId) {
      return;
    }

    documentForwardStack.value = trimDocumentNavHistory([...documentForwardStack.value, currentDocumentId]);
    isApplyingDocumentNavigation = true;
    workbench.activateDocument(targetDocumentId);
  };

  const navigateDocumentForward = (): void => {
    const currentDocumentId = workbench.editorStore.activeDocumentId;
    if (!currentDocumentId) {
      return;
    }

    const targetDocumentId =
      pickNextNavigableDocumentId(documentForwardStack, currentDocumentId)
      ?? resolveAdjacentDocumentId(currentDocumentId, 'forward');
    if (!targetDocumentId) {
      return;
    }

    documentBackStack.value = trimDocumentNavHistory([...documentBackStack.value, currentDocumentId]);
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
  const isSettingsView = computed(() => activeSurfaceMode.value === 'settings');
  const isWorkbenchContentVisible = computed(() => activeSurfaceMode.value === 'workbench');
  const isEditorMode = computed(
    () => isWorkbenchContentVisible.value && activePrimaryMode.value === 'editor',
  );
  const isAiMode = computed(
    () => isWorkbenchContentVisible.value && activePrimaryMode.value === 'ai',
  );
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
      activePrimaryMode.value = 'editor';
      isDiagnosticsPanelVisible.value = true;
    });
  };

  const openTerminal = async (): Promise<void> => {
    await runAfterClosingSettings(() => {
      isTerminalVisible.value = true;
    });
  };

  const openEditorMode = (): void => {
    activePrimaryMode.value = 'editor';
  };

  const openAiMode = (): void => {
    activePrimaryMode.value = 'ai';
    closeDiagnosticsPanel();
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

  const saveActiveDocumentFromShortcut = async (): Promise<void> => {
    if (!isWorkbenchContentVisible.value || !workbench.isDesktopRuntime.value || !workbench.canSave.value) {
      return;
    }

    await workbench.saveDocument();
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

    if (isPrimaryModifierShortcut(event, 'KeyS', 's')) {
      event.preventDefault();
      event.stopPropagation();

      if (!event.repeat) {
        void saveActiveDocumentFromShortcut();
      }
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
    openEditorMode();
    activeSidebarView.value = view;
    isSidebarVisible.value = true;
    scheduleEditorLayoutAfterSidebarChange();
  };

  const handleSelectSidebarView = async (view: TWorkbenchSidebarView): Promise<void> => {
    if (view === 'ai') {
      await runAfterClosingSettings(() => {
        openAiMode();
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
    await waitForInitialWorkbenchPaint();

    if (isUnmounted || hasEmittedReady.value) {
      return;
    }

    hasEmittedReady.value = true;
    dispatchWorkbenchReadyEvent();
    onReady();
  };

  const restoreWorkbenchSession = async (): Promise<void> => {
    try {
      await workbench.restoreSession();
    } catch (error) {
      if (isUnmounted) {
        return;
      }

      workbench.editorStore.appendLog(
        'error',
        '恢复会话失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const initializeWorkbench = async (): Promise<void> => {
    const result = await workbench.initialize();
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
    await runAfterClosingSettings(async () => {
      openEditorMode();
      closeDiagnosticsPanel();
      isTerminalVisible.value = true;
      await workbench.runScript();
    });
  };

  const handleIntegratedTerminalRunCompleted = (payload: ITerminalRunCompletedPayload): void => {
    workbench.handleIntegratedTerminalRunCompleted(payload);
  };

  const {
    titlebarRef,
    runPanelRef,
    handleOpenCommandPalette,
    handleAiCodeAction,
    handleAiFixDiagnostic,
    handleOpenShellCheck,
  } = useShellWorkbenchAiBridge({
    editorRef,
    openTerminal,
    handleSelectDiagnostic,
  });

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

      openEditorMode();

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
      documentBackStack.value = documentBackStack.value.filter((documentId) => documentIdSet.has(documentId));
      documentForwardStack.value = documentForwardStack.value.filter((documentId) => documentIdSet.has(documentId));
    },
    { immediate: true },
  );

  onMounted(() => {
    isUnmounted = false;
    window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
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
    window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
    clearStatusbarMessageTimer();
    globalKeydownCleanup?.();
    nativeCloseRequestedUnlisten?.();
    nativeCloseRequestedUnlisten = null;
    cleanupViewportState();

    if (editorLayoutAfterSidebarFrameId !== null) {
      window.cancelAnimationFrame(editorLayoutAfterSidebarFrameId);
      editorLayoutAfterSidebarFrameId = null;
    }

  });

  return {
    ...workbench,
    gitStore,
    titlebarRef,
    runPanelRef,
    editorRef,
    editorViewportRef,
    settingsOverlayRef,
    isTerminalVisible,
    isSidebarVisible,
    aiPanelWidth,
    isEditorMode,
    isAiMode,
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
    closeSettingsView,
    toggleSettingsView,
    openEditorMode,
    openAiMode,
    handleSettingsSaved,
    handleRequestCloseApplication,
    toggleDiagnosticsPanel,
    handleSelectSidebarView,
    hideTerminal,
    openTerminal,
    clearTerminalLogs,
    handleRunScript,
    handleIntegratedTerminalRunCompleted,
    handleOpenCommandPalette,
    handleAiCodeAction,
    handleAiFixDiagnostic,
    handleOpenShellCheck,
  };
};
