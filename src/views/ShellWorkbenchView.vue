<template>
  <AppShellLayout :is-desktop-runtime="isDesktopRuntime" :sidebar-visible="isSidebarVisible"
    :terminal-visible="isTerminalVisible" :terminal-height="terminalHeight" :sidebar-width="sidebarWidth"
    :content-overlay-visible="isSettingsView" @update:terminal-height="handleTerminalHeightChange">
    <template #titlebar>
      <WindowTitleBar :document-name="editorStore.document.name" :is-dirty="editorStore.document.isDirty"
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
      <ActivityRail :active-view="activeSidebarView" :settings-active="isSettingsView"
        @select-view="handleSelectSidebarView" @toggle-settings="toggleSettingsView" />
    </template>

    <template #sidebar>
      <AppSidebar v-show="isWorkbenchContentVisible" :document="editorStore.document" :view="activeSidebarView"
        :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="editorStore.workspaceRootPath"
        :preloaded-workspace-root="startupWorkspaceRoot" :can-run="canRun" :is-running="editorStore.isRunning"
        :active-run="editorStore.activeRunSummary" :run-history="editorStore.runHistory"
        :command-templates="commandTemplates" :executor="editorStore.selectedExecutor" @open-file="openDocumentByPath"
        @run="handleRunScript" @create-document="createNewDocument" @open-terminal="openTerminal"
        @insert-template="handleInsertTemplate" @clear-run-history="clearTerminalLogs" />
    </template>

    <template #header>
      <WorkbenchHeader v-show="isWorkbenchContentVisible" :documents="editorStore.documents"
        :active-document-id="editorStore.activeDocumentId"
        :file-path="editorStore.hasActiveDocument ? editorStore.document.path : null" @select-tab="activateDocument"
        @close-tab="requestCloseDocument" />
    </template>

    <div v-show="isWorkbenchContentVisible" ref="editorViewportRef" data-testid="workbench-root"
      class="workbench-editor-viewport relative h-full min-h-0 overflow-hidden bg-(--editor-bg)"
      :data-diagnostics-resizing="diagnosticsTransitionsEnabled ? 'false' : 'true'">
      <div class="h-full min-h-0">
        <EmptyEditorState v-if="!editorStore.hasActiveDocument" :has-workspace="Boolean(editorStore.workspaceRootPath)"
          :is-desktop-runtime="isDesktopRuntime" @create="createNewDocument" @open="openDocument"
          @open-folder="openFolder" />

        <SmartScriptEditor v-else-if="editorStore.document.kind === 'text'" ref="editorRef"
          :document-id="editorStore.document.id" :document-path="editorStore.document.path"
          :document-name="editorStore.document.name" :model-value="editorStore.document.content" :theme="appStore.theme"
          :editor-settings="appStore.settings.editor" @update:model-value="updateContent"
          @cursor-position-change="handleCursorPositionChange" @diagnostics-change="handleDiagnosticsChange"
          @format-request="handleFormatDocument" />

        <ImageAssetPreview v-else-if="editorStore.document.path" :path="editorStore.document.path"
          :name="editorStore.document.name" />
      </div>

      <div v-if="shouldRenderDiagnosticsPanel"
        class="diagnostics-overlay-panel absolute inset-y-0 right-0 z-20 max-w-full overflow-hidden border-l border-(--shell-divider) bg-(--panel-bg) shadow-[-24px_0_48px_rgba(0,0,0,0.28)]"
        :style="diagnosticsPanelStyle" :class="[
          diagnosticsPanelMotionClass,
          isDiagnosticsPanelVisible
            ? 'pointer-events-auto translate-x-0 opacity-100'
            : 'pointer-events-none translate-x-3 opacity-0',
        ]">
        <div class="h-full">
          <DiagnosticsPanel :analysis="editorStore.activeScriptAnalysis" :content="editorStore.document.content"
            :document-name="editorStore.document.name" @select-diagnostic="handleSelectDiagnostic"
            @rerun-analysis="handleRerunDiagnostics" />
        </div>
      </div>
    </div>

    <template #terminal>
      <RunPanel v-show="isWorkbenchContentVisible" :terminal-output-length="editorStore.terminalOutputLength"
        :terminal-output-version="editorStore.terminalOutputVersion"
        :resolve-terminal-output="editorStore.getTerminalOutputSnapshot" :run-logs="editorStore.runLogs"
        :last-run-result="editorStore.lastRunResult" :is-running="editorStore.isRunning"
        :executor="editorStore.selectedExecutor" :document-name="editorStore.document.name"
        :document-path="editorStore.document.path" :workspace-root-path="editorStore.workspaceRootPath"
        :theme="appStore.theme" :terminal-settings="appStore.settings.terminal"
        :visible="isTerminalVisible && isWorkbenchContentVisible" :is-maximized="isTerminalMaximized"
        @hide="hideTerminal" @toggle-maximize="toggleTerminalMaximize" @clear-logs="clearTerminalLogs"
        @terminal-output="appendTerminalOutput" @terminal-run-complete="handleIntegratedTerminalRunComplete" />
    </template>

    <template #statusbar>
      <WorkbenchStatusBar :has-active-document="editorStore.hasActiveDocument"
        :document-kind="editorStore.document.kind" :status-message="statusbarMessage"
        :encoding="editorStore.document.encoding" :executor="editorStore.selectedExecutor"
        :cursor-line="editorStore.cursorLine" :cursor-column="editorStore.cursorColumn"
        :char-count="editorStore.document.charCount" :git-branch-name="gitBranchName" :git-added-count="gitAddedCount"
        :git-removed-count="gitRemovedCount" @change-encoding="updateEncoding"
        @open-source-control="handleSelectSidebarView('source-control')" />
    </template>

    <template #overlay>
      <WorkbenchSettingsOverlay ref="settingsOverlayRef" :open="isSettingsView" @close="closeSettingsView"
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
import { useShellWorkbenchView } from '@/composables/useShellWorkbenchView';
import AppShellLayout from '@/layouts/AppShellLayout.vue';

const emit = defineEmits<{
  ready: [];
}>();

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
  editorRef,
  editorViewportRef,
  settingsOverlayRef,
  isTerminalVisible,
  isSidebarVisible,
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
  handleDiagnosticsChange,
  handleSelectDiagnostic,
  handleRerunDiagnostics,
  handleTerminalHeightChange,
  toggleTerminalMaximize,
  closeSettingsView,
  handleSettingsSaved,
  handleRequestCloseApplication,
  toggleDiagnosticsPanel,
  handleSelectSidebarView,
  hideTerminal,
  openTerminal,
  clearTerminalLogs,
  handleRunScript,
} = useShellWorkbenchView(() => emit('ready'));
</script>
