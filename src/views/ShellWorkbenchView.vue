<template>
  <AppShellLayout :is-desktop-runtime="isDesktopRuntime" :sidebar-visible="isSidebarVisible"
    :terminal-visible="isTerminalVisible" :terminal-height="terminalHeight" :sidebar-width="sidebarWidth"
    :right-sidebar-visible="isAiPanelVisible" :right-sidebar-width="350"
    :content-overlay-visible="isSettingsView" @update:terminal-height="handleTerminalHeightChange">
    <template #titlebar>
      <WindowTitleBar ref="titlebarRef" :document-name="editorStore.document.name" :is-dirty="editorStore.document.isDirty"
        :has-active-document="editorStore.hasActiveDocument" :document-kind="editorStore.document.kind"
        :theme="appStore.theme" :is-running="editorStore.isRunning" :can-run="canRun" :can-save="canSave"
        :is-desktop-runtime="isDesktopRuntime" :is-terminal-visible="isTerminalVisible"
        :is-diagnostics-visible="isDiagnosticsPanelVisible" :can-toggle-diagnostics="canToggleDiagnosticsPanel"
        :diagnostic-issue-count="diagnosticIssueCount" :command-templates="commandTemplates"
        :comment-templates="commentTemplates" @new="createNewDocument" @open="openDocument" @open-folder="openFolder"
        @close-workspace="requestCloseWorkspace" @save="saveDocument" @save-as="saveDocumentAs"
        @close-request="handleRequestCloseApplication" @run="handleRunScript" @format-document="handleFormatDocument"
        @open-terminal="openTerminal" @hide-terminal="hideTerminal" @toggle-diagnostics="handleOpenShellCheck"
        @toggle-theme="toggleTheme" @select-sidebar-view="handleSelectSidebarView"
        @insert-template="handleInsertTemplate" @ai-code-action="handleAiCodeAction" />
    </template>

    <template #activity>
      <ActivityRail :active-view="activeSidebarView" :settings-active="isSettingsView"
        @select-view="handleSelectSidebarView" @toggle-settings="toggleSettingsView" />
    </template>

    <template #sidebar>
      <AppSidebar v-show="isWorkbenchContentVisible" :document="editorStore.document" :view="activeSidebarView"
        :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="editorStore.workspaceRootPath"
        :preloaded-workspace-root="startupWorkspaceRoot" :can-run="canRun" :is-running="editorStore.isRunning"
        :has-run-artifacts="editorStore.hasRunArtifacts" :active-run="editorStore.activeRunSummary"
        :run-history="editorStore.runHistory" :command-templates="commandTemplates"
        :executor="editorStore.selectedExecutor" @open-file="openDocumentByPath" @run="handleRunScript"
        @create-document="createNewDocument" @open-terminal="openTerminal" @insert-template="handleInsertTemplate"
        @clear-run-history="clearTerminalLogs" />
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
          :editor-settings="appStore.settings.editor" :can-run="canRun" @update:model-value="updateContent"
          @cursor-position-change="handleCursorPositionChange" @diagnostics-change="handleDiagnosticsChange"
          @selection-change="handleSelectionChange"
          @format-request="handleFormatDocument" @command-palette-request="handleOpenCommandPalette"
          @run-request="handleRunScript" />

        <ImageAssetPreview v-else-if="editorStore.document.path" :path="editorStore.document.path"
          :name="editorStore.document.name" />
      </div>

    </div>

    <template #terminal>
      <RunPanel v-show="isWorkbenchContentVisible" ref="runPanelRef" :terminal-output-length="editorStore.terminalOutputLength"
        :terminal-output-version="editorStore.terminalOutputVersion"
        :resolve-terminal-output="editorStore.getTerminalOutputSnapshot" :run-logs="editorStore.runLogs"
        :last-run-result="editorStore.lastRunResult" :is-running="editorStore.isRunning"
        :executor="editorStore.selectedExecutor" :document-name="editorStore.document.name"
        :document-content="editorStore.document.content" :document-path="editorStore.document.path"
        :script-analysis="editorStore.activeScriptAnalysis" :workspace-root-path="editorStore.workspaceRootPath"
        :theme="appStore.theme" :terminal-settings="appStore.settings.terminal"
        :visible="isTerminalVisible && isWorkbenchContentVisible" :is-maximized="isTerminalMaximized"
        @hide="hideTerminal" @toggle-maximize="toggleTerminalMaximize" @clear-logs="clearTerminalLogs"
        @terminal-run-completed="handleIntegratedTerminalRunCompleted"
        @select-diagnostic="handleSelectDiagnostic" @rerun-analysis="handleRerunDiagnostics"
        @ai-fix-diagnostic="handleAiFixDiagnostic" />
    </template>

    <template #right-sidebar>
      <AiAssistantPanel
        v-show="isWorkbenchContentVisible && isAiPanelVisible"
        :document="editorStore.document"
        :active-run="editorStore.activeRunSummary"
        :analysis="editorStore.activeScriptAnalysis"
        :selection="editorStore.activeSelectionSummary"
        :git-status="gitStore.status"
        :workspace-root-path="editorStore.workspaceRootPath"
        @open-code-path="handleOpenAiCodePath"
      />
    </template>

    <template #statusbar>
      <WorkbenchStatusBar :has-active-document="editorStore.hasActiveDocument"
        :document-kind="editorStore.document.kind" :status-message="statusbarMessage"
        :script-analysis="editorStore.activeScriptAnalysis" :encoding="editorStore.document.encoding"
        :executor="editorStore.selectedExecutor" :cursor-line="editorStore.cursorLine"
        :cursor-column="editorStore.cursorColumn" :char-count="editorStore.document.charCount"
        :git-branch-name="gitBranchName" :git-added-count="gitAddedCount" :git-removed-count="gitRemovedCount"
        @change-encoding="updateEncoding" @open-source-control="handleSelectSidebarView('source-control')"
        @open-diagnostics="handleOpenShellCheck" />
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
import AiAssistantPanel from '@/components/business/ai/AiAssistantPanel.vue';
import ActivityRail from '@/components/workbench/ActivityRail.vue';
import AppSidebar from '@/components/workbench/AppSidebar.vue';
import RunPanel from '@/components/workbench/RunPanel.vue';
import WorkbenchHeader from '@/components/workbench/WorkbenchHeader.vue';
import WorkbenchSettingsOverlay from '@/components/workbench/WorkbenchSettingsOverlay.vue';
import WorkbenchStatusBar from '@/components/workbench/WorkbenchStatusBar.vue';
import { useShellWorkbenchView } from '@/composables/useShellWorkbenchView';
import AppShellLayout from '@/layouts/AppShellLayout.vue';
import { nextTick, ref } from 'vue';
import type { IAiCodeActionRequest } from '@/types/ai';
import type { IAiCodePathTarget } from '@/types/ai-code';
import type { IScriptDiagnostic } from '@/types/editor';

interface ITitlebarExpose {
  openCommandPalette: () => void;
}

interface IRunPanelExpose {
  openShellCheck: () => void;
}

const titlebarRef = ref<ITitlebarExpose | null>(null);
const runPanelRef = ref<IRunPanelExpose | null>(null);

const handleOpenCommandPalette = (): void => {
  titlebarRef.value?.openCommandPalette();
};

const handleAiCodeAction = (kind: IAiCodeActionRequest['kind']): void => {
  void editorRef.value?.runAiCodeAction(kind);
};

const handleAiFixDiagnostic = (diagnostic: IScriptDiagnostic): void => {
  handleSelectDiagnostic(diagnostic.line, diagnostic.column);
  void editorRef.value?.runAiCodeAction('fix_diagnostic');
};

const handleOpenShellCheck = async (): Promise<void> => {
  await openTerminal();
  runPanelRef.value?.openShellCheck();
};

const resolveAiCodePath = (path: string): string => {
  if (/^(?:[a-zA-Z]:[\\/]|[/\\])/.test(path) || !editorStore.workspaceRootPath) {
    return path;
  }
  const separator = editorStore.workspaceRootPath.includes('/') ? '/' : '\\';
  return `${editorStore.workspaceRootPath.replace(/[\\/]+$/, '')}${separator}${path.replace(/^[\\/]+/, '')}`;
};

const handleOpenAiCodePath = async (target: IAiCodePathTarget): Promise<void> => {
  await openDocumentByPath(resolveAiCodePath(target.path));
  if (target.startLine) {
    await nextTick();
    handleSelectDiagnostic(target.startLine, 1);
  }
};

const emit = defineEmits<{
  ready: [];
}>();

const {
  appStore,
  editorStore,
  gitStore,
  isDesktopRuntime,
  canRun,
  canSave,
  commandTemplates,
  commentTemplates,
  createNewDocument,
  openDocument,
  openFolder,
  openDocumentByPath,
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
} = useShellWorkbenchView(() => emit('ready'));
</script>
