<template>
  <AppShellLayout
:is-desktop-runtime="isDesktopRuntime" :sidebar-visible="isSidebarVisible"
    :terminal-visible="isTerminalVisible" :terminal-height="terminalHeight" :sidebar-width="sidebarWidth"
    :content-overlay-visible="isSettingsView"
    @update:terminal-height="handleTerminalHeightChange">
    <template #titlebar>
      <WindowTitleBar
:document-name="editorStore.document.name" :is-dirty="editorStore.document.isDirty"
        :has-active-document="editorStore.hasActiveDocument" :document-kind="editorStore.document.kind"
        :theme="appStore.theme" :is-running="editorStore.isRunning" :can-run="canRun" :can-save="canSave"
        :is-desktop-runtime="isDesktopRuntime" :is-terminal-visible="isTerminalVisible"
        :is-diagnostics-visible="isDiagnosticsPanelVisible" :can-toggle-diagnostics="canToggleDiagnosticsPanel"
        :diagnostic-issue-count="diagnosticIssueCount" :command-templates="commandTemplates"
        :comment-templates="commentTemplates" @new="createNewDocument" @open="openDocument" @open-folder="openFolder"
        @close-workspace="requestCloseWorkspace" @save="saveDocument" @save-as="saveDocumentAs"
        @close-request="handleRequestCloseApplication" @run="handleRunScript" @format-document="handleFormatDocument"
        @open-terminal="openTerminal" @hide-terminal="hideTerminal" @toggle-diagnostics="toggleDiagnosticsPanel"
        @toggle-theme="toggleTheme" @select-sidebar-view="handleSelectSidebarView"
        @insert-template="handleInsertTemplate" />
    </template>

    <template #activity>
      <ActivityRail
:active-view="activeSidebarView" :settings-active="isSettingsView"
        @select-view="handleSelectSidebarView" @toggle-settings="toggleSettingsView" />
    </template>

    <template #sidebar>
      <AppSidebar
v-show="isWorkbenchContentVisible" :document="editorStore.document" :view="activeSidebarView"
        :is-desktop-runtime="isDesktopRuntime"
        :workspace-root-path="editorStore.workspaceRootPath" :preloaded-workspace-root="startupWorkspaceRoot"
        @open-file="openDocumentByPath" />
    </template>

    <template #header>
      <WorkbenchHeader
v-show="isWorkbenchContentVisible" :documents="editorStore.documents"
        :active-document-id="editorStore.activeDocumentId"
        :file-path="editorStore.hasActiveDocument ? editorStore.document.path : null" @select-tab="activateDocument"
        @close-tab="requestCloseDocument" />
    </template>

    <div
v-show="isWorkbenchContentVisible" ref="editorViewportRef"
      class="workbench-editor-viewport relative h-full min-h-0 overflow-hidden bg-(--editor-bg)"
      :data-diagnostics-resizing="diagnosticsTransitionsEnabled ? 'false' : 'true'">
      <div class="h-full min-h-0">
        <EmptyEditorState
v-if="!editorStore.hasActiveDocument" :has-workspace="Boolean(editorStore.workspaceRootPath)"
          :is-desktop-runtime="isDesktopRuntime" @create="createNewDocument" @open="openDocument"
          @open-folder="openFolder" />

        <SmartScriptEditor
v-else-if="editorStore.document.kind === 'text'" ref="editorRef"
          :document-id="editorStore.document.id" :document-path="editorStore.document.path"
          :document-name="editorStore.document.name" :model-value="editorStore.document.content" :theme="appStore.theme"
          :editor-settings="appStore.settings.editor"
          @update:model-value="updateContent" @cursor-position-change="handleCursorPositionChange"
          @diagnostics-change="handleDiagnosticsChange" @format-request="handleFormatDocument" />

        <ImageAssetPreview
v-else-if="editorStore.document.path" :path="editorStore.document.path"
          :name="editorStore.document.name" />
      </div>

      <div
v-if="shouldRenderDiagnosticsPanel"
        class="diagnostics-overlay-panel absolute inset-y-0 right-0 z-20 max-w-full overflow-hidden border-l border-(--shell-divider) bg-(--panel-bg) shadow-[-24px_0_48px_rgba(0,0,0,0.28)]"
        :style="diagnosticsPanelStyle" :class="[
          diagnosticsPanelMotionClass,
          isDiagnosticsPanelVisible
            ? 'pointer-events-auto translate-x-0 opacity-100'
            : 'pointer-events-none translate-x-3 opacity-0',
        ]">
        <div class="h-full">
          <DiagnosticsPanel
:analysis="editorStore.activeScriptAnalysis" :content="editorStore.document.content"
            :document-name="editorStore.document.name" @select-diagnostic="handleSelectDiagnostic"
            @rerun-analysis="handleRerunDiagnostics" />
        </div>
      </div>
    </div>

    <template #terminal>
      <RunPanel
v-show="isWorkbenchContentVisible" :terminal-output-length="editorStore.terminalOutputLength"
        :terminal-output-version="editorStore.terminalOutputVersion"
        :resolve-terminal-output="editorStore.getTerminalOutputSnapshot" :run-logs="editorStore.runLogs"
        :last-run-result="editorStore.lastRunResult" :is-running="editorStore.isRunning"
        :executor="editorStore.selectedExecutor" :document-name="editorStore.document.name"
        :document-path="editorStore.document.path" :workspace-root-path="editorStore.workspaceRootPath"
        :theme="appStore.theme" :terminal-settings="appStore.settings.terminal"
        :visible="isTerminalVisible && isWorkbenchContentVisible"
        :is-maximized="isTerminalMaximized" @hide="hideTerminal"
        @toggle-maximize="toggleTerminalMaximize" @clear-logs="clearTerminalLogs"
        @terminal-output="appendTerminalOutput" @terminal-run-complete="handleIntegratedTerminalRunComplete" />
    </template>

    <template #statusbar>
      <WorkbenchStatusBar
:has-active-document="editorStore.hasActiveDocument"
        :document-kind="editorStore.document.kind" :is-running="editorStore.isRunning"
        :status-message="statusbarMessage"
        :encoding="editorStore.document.encoding" :executor="editorStore.selectedExecutor"
        :cursor-line="editorStore.cursorLine" :cursor-column="editorStore.cursorColumn"
        :char-count="editorStore.document.charCount" @change-encoding="updateEncoding" />
    </template>

    <template #overlay>
      <WorkbenchSettingsOverlay
ref="settingsOverlayRef" :open="isSettingsView" @close="closeSettingsView"
        @saved="handleSettingsSaved" />
    </template>
  </AppShellLayout>
</template>

<script setup lang="ts">
import WindowTitleBar from '@/components/common/WindowTitleBar.vue';
import EmptyEditorState from '@/components/editor/EmptyEditorState.vue';
import ImageAssetPreview from '@/components/editor/ImageAssetPreview.vue';
import SmartScriptEditor from '@/components/editor/SmartScriptEditor.vue';
import ActivityRail from '@/components/workbench/ActivityRail.vue';
import AppSidebar from '@/components/workbench/AppSidebar.vue';
import DiagnosticsPanel from '@/components/workbench/DiagnosticsPanel.vue';
import RunPanel from '@/components/workbench/RunPanel.vue';
import WorkbenchHeader from '@/components/workbench/WorkbenchHeader.vue';
import WorkbenchSettingsOverlay from '@/components/workbench/WorkbenchSettingsOverlay.vue';
import WorkbenchStatusBar from '@/components/workbench/WorkbenchStatusBar.vue';
import { useWorkbench } from '@/composables/useWorkbench';
import AppShellLayout from '@/layouts/AppShellLayout.vue';
import type { TWorkbenchSidebarView } from '@/types/app';
import type {
    IAnalyzeScriptPayload,
    ICommandTemplate,
    IWorkspaceDirectoryPayload,
} from '@/types/editor';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { consumeProgrammaticWindowCloseAllowance } from '@/utils/window-close';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const emit = defineEmits<{
  ready: [];
}>();

type TEditorExpose = {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  rerunDiagnostics: () => void;
};

type TSettingsOverlayExpose = {
  focusSearch: () => void;
  requestClose: () => Promise<boolean>;
};

type TWorkbenchSurfaceMode = 'workbench' | 'settings';

const SETTINGS_STATUS_MESSAGE_DURATION_MS = 2200;

const editorRef = ref<TEditorExpose | null>(null);
const editorViewportRef = ref<HTMLElement | null>(null);
const settingsOverlayRef = ref<TSettingsOverlayExpose | null>(null);
const isTerminalVisible = ref(true);
const isSidebarVisible = ref(true);
const isDiagnosticsPanelVisible = ref(false);
const activeSurfaceMode = ref<TWorkbenchSurfaceMode>('workbench');
const terminalVisibilityBeforeDiagnostics = ref(false);
const terminalHeight = ref(236);
const terminalHeightBeforeMaximize = ref(236);
const isTerminalMaximized = ref(false);
const activeSidebarView = ref<TWorkbenchSidebarView>('explorer');
const statusbarMessage = ref<string | null>(null);
const sidebarWidth = computed(() =>
  activeSidebarView.value === 'source-control'
    || activeSidebarView.value === 'explorer'
    || activeSidebarView.value === 'search'
    ? 280
    : 240,
);
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
let statusbarMessageTimerId: number | null = null;
let focusBeforeSettingsOpen: HTMLElement | null = null;
let globalKeydownCleanup: (() => void) | null = null;

const {
  appStore,
  editorStore,
  isDesktopRuntime,
  canRun,
  canSave,
  commandTemplates,
  commentTemplates,
  initialize,
  createNewDocument,
  openDocument,
  openFolder,
  openDocumentByPath,
  saveDocument,
  saveDocumentAs,
  requestCloseDocument,
  requestCloseWorkspace,
  requestCloseApplication,
  activateDocument,
  runScript,
  formatDocumentWithShfmt,
  updateContent,
  appendTerminalOutput,
  handleIntegratedTerminalRunComplete,
  updateEncoding,
  toggleTheme,
  notifyTemplateInserted,
} = useWorkbench();

const shouldRenderDiagnosticsPanel = computed(
  () => editorStore.hasActiveDocument && editorStore.document.kind === 'text',
);
const isSettingsView = computed(() => activeSurfaceMode.value === 'settings');
const isWorkbenchContentVisible = computed(() => activeSurfaceMode.value === 'workbench');

const canToggleDiagnosticsPanel = computed(() => shouldRenderDiagnosticsPanel.value);
const diagnosticIssueCount = computed(() => editorStore.activeDiagnostics.length);
const diagnosticsPanelMotionClass = computed(() =>
  diagnosticsTransitionsEnabled.value
    ? 'transition-[opacity,transform,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
    : 'transition-none',
);

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

  if (editorViewportResizeFrameId !== null) {
    return;
  }

  editorViewportResizeFrameId = window.requestAnimationFrame(flushEditorViewportResize);
};

const handleInsertTemplate = (template: ICommandTemplate): void => {
  editorRef.value?.insertSnippet(template.snippet);
  editorRef.value?.focusEditor();
  notifyTemplateInserted(template);
};

const handleFormatDocument = async (): Promise<void> => {
  await formatDocumentWithShfmt();
};

const handleCursorPositionChange = (line: number, column: number): void => {
  editorStore.setCursorPosition(line, column);
};

const handleDiagnosticsChange = (documentId: string, payload: IAnalyzeScriptPayload): void => {
  editorStore.setDocumentAnalysis(documentId, payload);
};

const handleSelectDiagnostic = (line: number, column: number): void => {
  editorRef.value?.revealPosition(line, column);
  editorRef.value?.focusEditor();
};

const handleRerunDiagnostics = (): void => {
  editorRef.value?.rerunDiagnostics();
};

const resetDiagnosticsTerminalLink = (): void => {
  terminalVisibilityBeforeDiagnostics.value = false;
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

const openDiagnosticsPanel = async (): Promise<void> => {
  if (!canToggleDiagnosticsPanel.value || isDiagnosticsPanelVisible.value) {
    return;
  }

  if (isSettingsView.value) {
    const didCloseSettings = await requestCloseSettingsView();
    if (!didCloseSettings) {
      return;
    }
  }

  terminalVisibilityBeforeDiagnostics.value = isTerminalVisible.value;
  isDiagnosticsPanelVisible.value = true;

  if (isTerminalVisible.value) {
    isTerminalVisible.value = false;
  }
};

const closeDiagnosticsPanel = (restoreTerminal = true): void => {
  if (!isDiagnosticsPanelVisible.value) {
    resetDiagnosticsTerminalLink();
    return;
  }

  const shouldRestoreTerminal = terminalVisibilityBeforeDiagnostics.value;
  isDiagnosticsPanelVisible.value = false;
  resetDiagnosticsTerminalLink();

  if (restoreTerminal && shouldRestoreTerminal) {
    isTerminalVisible.value = true;
  }
};

const openTerminal = async (): Promise<void> => {
  if (isSettingsView.value) {
    const didCloseSettings = await requestCloseSettingsView();
    if (!didCloseSettings) {
      return;
    }
  }

  if (isDiagnosticsPanelVisible.value) {
    closeDiagnosticsPanel(false);
  }

  resetDiagnosticsTerminalLink();
  isTerminalVisible.value = true;
};

const handleTerminalHeightChange = (value: number): void => {
  terminalHeight.value = value;
  if (!isTerminalMaximized.value) {
    terminalHeightBeforeMaximize.value = value;
  }
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

const focusSettingsSearch = async (): Promise<void> => {
  await nextTick();
  settingsOverlayRef.value?.focusSearch();
};

const restoreWorkbenchFocus = async (): Promise<void> => {
  await nextTick();

  if (focusBeforeSettingsOpen && document.contains(focusBeforeSettingsOpen)) {
    focusBeforeSettingsOpen.focus();
    focusBeforeSettingsOpen = null;
    return;
  }

  focusBeforeSettingsOpen = null;
  editorRef.value?.focusEditor();
};

const openSettingsView = async (): Promise<void> => {
  if (isSettingsView.value) {
    return;
  }

  focusBeforeSettingsOpen = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  activeSurfaceMode.value = 'settings';
  await focusSettingsSearch();
};

const closeSettingsView = async (): Promise<void> => {
  if (!isSettingsView.value) {
    return;
  }

  activeSurfaceMode.value = 'workbench';
  await restoreWorkbenchFocus();
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
  if (isSettingsView.value) {
    const didCloseSettings = await requestCloseSettingsView();
    if (!didCloseSettings) {
      return;
    }
  }

  await requestCloseApplication();
};

const handleGlobalKeydownCapture = (event: KeyboardEvent): void => {
  if (event.defaultPrevented || event.isComposing) {
    return;
  }

  const isSettingsShortcut =
    (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey
    && (event.key === ',' || event.code === 'Comma');

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

const handleSelectSidebarView = async (view: TWorkbenchSidebarView): Promise<void> => {
  if (isSettingsView.value) {
    const didCloseSettings = await requestCloseSettingsView();
    if (!didCloseSettings) {
      return;
    }

    activeSidebarView.value = view;
    isSidebarVisible.value = true;
    return;
  }

  if (activeSidebarView.value === view) {
    toggleSidebar();
    return;
  }

  activeSidebarView.value = view;
  isSidebarVisible.value = true;
};

const hideTerminal = (): void => {
  resetDiagnosticsTerminalLink();
  isTerminalVisible.value = false;
};

const clearTerminalLogs = (): void => {
  editorStore.clearLogs();
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
  emit('ready');
};

const initializeWorkbench = async (): Promise<void> => {
  const result = await initialize();
  if (isUnmounted) {
    return;
  }

  startupWorkspaceRoot.value = result.startupWorkspaceDirectory;
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
  if (isSettingsView.value) {
    const didCloseSettings = await requestCloseSettingsView();
    if (!didCloseSettings) {
      return;
    }
  }

  if (isDiagnosticsPanelVisible.value) {
    closeDiagnosticsPanel(false);
  }

  resetDiagnosticsTerminalLink();
  isTerminalVisible.value = true;
  await runScript();
};

watch(
  () => [editorStore.hasActiveDocument, editorStore.document.kind],
  () => {
    if (!shouldRenderDiagnosticsPanel.value && isDiagnosticsPanelVisible.value) {
      closeDiagnosticsPanel();
    }
  },
  { immediate: true },
);

onMounted(() => {
  isUnmounted = false;

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

  if (diagnosticsResizeSettleTimerId !== null) {
    window.clearTimeout(diagnosticsResizeSettleTimerId);
    diagnosticsResizeSettleTimerId = null;
  }
});
</script>
