<template>
  <AppShellLayout
:is-desktop-runtime="isDesktopRuntime" :sidebar-visible="isSidebarVisible"
    :terminal-visible="isTerminalVisible" :terminal-height="terminalHeight" :sidebar-width="sidebarWidth"
    :right-sidebar-visible="isAiPanelVisible" :right-sidebar-width="aiPanelWidth" :right-sidebar-min-width="350"
    :right-sidebar-max-width="550" :content-overlay-visible="isSettingsView"
    @update:terminal-height="handleTerminalHeightChange" @update:right-sidebar-width="handleAiPanelWidthChange">
    <template #titlebar>
      <WindowTitleBar
ref="titlebarRef" :document-name="editorStore.document.name"
        :is-dirty="editorStore.document.isDirty" :has-active-document="editorStore.hasActiveDocument"
        :document-kind="editorStore.document.kind" :theme="appStore.theme" :is-running="editorStore.isRunning"
        :can-run="canRun" :can-save="canSave" :is-desktop-runtime="isDesktopRuntime"
        :is-terminal-visible="isTerminalVisible" :is-diagnostics-visible="isDiagnosticsPanelVisible"
        :can-toggle-diagnostics="canToggleDiagnosticsPanel" :diagnostic-issue-count="diagnosticIssueCount"
        :command-templates="commandTemplates" :comment-templates="commentTemplates" @new="createNewDocument"
        @open="openDocument" @open-folder="openFolder" @close-workspace="requestCloseWorkspace" @save="saveDocument"
        @save-as="saveDocumentAs" @close-request="handleRequestCloseApplication" @run="handleRunScript"
        @format-document="handleFormatDocument" @open-terminal="openTerminal" @hide-terminal="hideTerminal"
        @toggle-diagnostics="handleOpenShellCheck" @toggle-theme="toggleTheme"
        @select-sidebar-view="handleSelectSidebarView" @insert-template="handleInsertTemplate"
        @ai-code-action="handleAiCodeAction" />
    </template>

    <template #activity>
      <ActivityRail
:active-view="activeSidebarView" :settings-active="isSettingsView"
        @select-view="handleSelectSidebarView" @toggle-settings="toggleSettingsView" />
    </template>

    <template #sidebar>
      <DeferredAppSidebar
v-show="isWorkbenchContentVisible" :document="editorStore.document" :view="activeSidebarView"
        :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="editorStore.workspaceRootPath"
        :preloaded-workspace-root="startupWorkspaceRoot" :can-run="canRun" :is-running="editorStore.isRunning"
        :has-run-artifacts="editorStore.hasRunArtifacts" :active-run="editorStore.activeRunSummary"
        :run-history="editorStore.runHistory" :command-templates="commandTemplates"
        :executor="editorStore.selectedExecutor" @open-file="openDocumentByPath" @run="handleRunScript"
        @open-git-diff="openGitDiffPreview" @create-document="createNewDocument" @open-terminal="openTerminal"
        @insert-template="handleInsertTemplate" @clear-run-history="clearTerminalLogs" />
    </template>

    <template #header>
      <WorkbenchHeader
v-show="isWorkbenchContentVisible" :documents="editorStore.documents"
        :active-document-id="editorStore.activeDocumentId"
        :file-path="editorStore.hasActiveDocument ? editorStore.document.path : null"
        :show-breadcrumb="editorStore.document.kind !== 'git-diff'" :can-navigate-back="canNavigateDocumentBack"
        :can-navigate-forward="canNavigateDocumentForward" @select-tab="activateDocument"
        @close-tab="requestCloseDocument" @navigate-back="navigateDocumentBack"
        @navigate-forward="navigateDocumentForward" />
    </template>

    <div
v-show="isWorkbenchContentVisible" ref="editorViewportRef" data-testid="workbench-root"
      class="workbench-editor-viewport relative h-full min-h-0 overflow-hidden bg-(--editor-bg)"
      :data-diagnostics-resizing="diagnosticsTransitionsEnabled ? 'false' : 'true'">
      <div class="h-full min-h-0">
        <EmptyEditorState
v-if="!editorStore.hasActiveDocument" :has-workspace="Boolean(editorStore.workspaceRootPath)"
          :is-desktop-runtime="isDesktopRuntime" @create="createNewDocument" @open="openDocument"
          @open-folder="openFolder" />

        <DeferredSmartScriptEditor
v-else-if="editorStore.document.kind === 'text'" ref="editorRef"
          :document-id="editorStore.document.id" :document-path="editorStore.document.path"
          :document-name="editorStore.document.name" :model-value="editorStore.document.content" :theme="appStore.theme"
          :editor-settings="appStore.settings.editor" :can-run="canRun" @update:model-value="updateContent"
          @cursor-position-change="handleCursorPositionChange" @diagnostics-change="handleDiagnosticsChange"
          @selection-change="handleSelectionChange" @format-request="handleFormatDocument"
          @command-palette-request="handleOpenCommandPalette" @run-request="handleRunScript" />

        <AiDiffPreviewEditor
v-else-if="editorStore.document.kind === 'ai-diff' && editorStore.document.aiDiffPreview"
          :preview="editorStore.document.aiDiffPreview" />

        <GitDiffViewer
v-else-if="editorStore.document.kind === 'git-diff' && editorStore.document.gitDiffPreview"
          :preview="editorStore.document.gitDiffPreview" :theme="appStore.theme"
          :editor-settings="appStore.settings.editor" />

        <ImageAssetPreview
v-else-if="editorStore.document.path" :path="editorStore.document.path"
          :name="editorStore.document.name" />
      </div>
    </div>

    <template #terminal>
      <DeferredRunPanel
v-show="isWorkbenchContentVisible" ref="runPanelRef"
        :terminal-output-length="editorStore.terminalOutputLength"
        :terminal-output-version="editorStore.terminalOutputVersion"
        :resolve-terminal-output="editorStore.getTerminalOutputSnapshot" :run-logs="editorStore.runLogs"
        :last-run-result="editorStore.lastRunResult" :is-running="editorStore.isRunning"
        :executor="editorStore.selectedExecutor" :document-name="editorStore.document.name"
        :document-content="editorStore.document.content" :document-path="editorStore.document.path"
        :script-analysis="editorStore.activeScriptAnalysis" :workspace-root-path="editorStore.workspaceRootPath"
        :theme="appStore.theme" :terminal-settings="appStore.settings.terminal"
        :visible="isTerminalVisible && isWorkbenchContentVisible" :is-maximized="isTerminalMaximized"
        @hide="hideTerminal" @toggle-maximize="toggleTerminalMaximize" @clear-logs="clearTerminalLogs"
        @terminal-run-completed="handleIntegratedTerminalRunCompleted" @select-diagnostic="handleSelectDiagnostic"
        @rerun-analysis="handleRerunDiagnostics" @ai-fix-diagnostic="handleAiFixDiagnostic" />
    </template>

    <template #right-sidebar>
      <DeferredAiAssistantPanel
v-show="isWorkbenchContentVisible" :document="editorStore.document"
        :active-run="editorStore.activeRunSummary" :analysis="editorStore.activeScriptAnalysis"
        :selection="editorStore.activeSelectionSummary" :git-status="gitStore.status"
        :workspace-root-path="editorStore.workspaceRootPath" @open-patch-diff="openGitDiffPreviewPayload" />
    </template>

    <template #statusbar>
      <DeferredWorkbenchStatusBar
:has-active-document="editorStore.hasActiveDocument"
        :document-kind="editorStore.document.kind" :status-message="statusbarMessage"
        :script-analysis="editorStore.activeScriptAnalysis" :encoding="editorStore.document.encoding"
        :executor="editorStore.selectedExecutor" :cursor-line="editorStore.cursorLine"
        :cursor-column="editorStore.cursorColumn" :char-count="editorStore.document.charCount"
        :git-branch-name="gitBranchName" :git-added-count="gitAddedCount" :git-removed-count="gitRemovedCount"
        @change-encoding="updateEncoding" @open-source-control="handleSelectSidebarView('source-control')"
        @open-diagnostics="handleOpenShellCheck" />
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
import AiDiffPreviewEditor from '@/components/editor/AiDiffPreviewEditor.vue';
import EmptyEditorState from '@/components/editor/EmptyEditorState.vue';
import GitDiffViewer from '@/components/editor/GitDiffViewer.vue';
import ImageAssetPreview from '@/components/editor/ImageAssetPreview.vue';
import ActivityRail from '@/components/workbench/ActivityRail.vue';
import WorkbenchHeader from '@/components/workbench/WorkbenchHeader.vue';
import WorkbenchSettingsOverlay from '@/components/workbench/WorkbenchSettingsOverlay.vue';
import { useShellWorkbenchView } from '@/composables/useShellWorkbenchView';
import AppShellLayout from '@/layouts/AppShellLayout.vue';
import { defineAsyncComponent } from 'vue';

const DeferredAppSidebar = defineAsyncComponent({
  loader: () => import('@/components/workbench/AppSidebar.vue'),
  suspensible: false,
});

const DeferredSmartScriptEditor = defineAsyncComponent({
  loader: () => import('@/components/editor/SmartScriptEditor.vue'),
  suspensible: false,
});

const DeferredRunPanel = defineAsyncComponent({
  loader: () => import('@/components/workbench/RunPanel.vue'),
  suspensible: false,
});

const DeferredAiAssistantPanel = defineAsyncComponent({
  loader: () => import('@/components/business/ai/AiAssistantPanel.vue'),
  suspensible: false,
});

const DeferredWorkbenchStatusBar = defineAsyncComponent({
  loader: () => import('@/components/workbench/WorkbenchStatusBar.vue'),
  suspensible: false,
});

const emit = defineEmits<{
  ready: [];
}>();

const {
  appStore,
  editorStore,
  gitStore,
  titlebarRef,
  runPanelRef,
  isDesktopRuntime,
  canRun,
  canSave,
  commandTemplates,
  commentTemplates,
  createNewDocument,
  openDocument,
  openFolder,
  openDocumentByPath,
  openGitDiffPreview,
  openGitDiffPreviewPayload,
  saveDocument,
  saveDocumentAs,
  requestCloseDocument,
  requestCloseWorkspace,
  activateDocument,
  updateContent,
  updateEncoding,
  toggleTheme,
  editorRef,
  editorViewportRef,
  settingsOverlayRef,
  isTerminalVisible,
  isSidebarVisible,
  isAiPanelVisible,
  aiPanelWidth,
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
  canToggleDiagnosticsPanel,
  diagnosticIssueCount,
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
  handleSettingsSaved,
  handleRequestCloseApplication,
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
} = useShellWorkbenchView(() => emit('ready'));

</script>
