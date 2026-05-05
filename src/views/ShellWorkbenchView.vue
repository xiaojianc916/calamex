<template>
    <AppShellLayout :is-desktop-runtime="isDesktopRuntime" :sidebar-visible="isSidebarVisible"
        :terminal-visible="isTerminalVisible" :terminal-height="terminalHeight" :sidebar-width="sidebarWidth"
        :content-overlay-visible="isSettingsView" @update:terminal-height="handleTerminalHeightChange">
        <template #titlebar>
            <WindowTitleBar :ref="titlebarRef" :document-name="editorStore.document.name"
                :is-dirty="editorStore.document.isDirty" :has-active-document="editorStore.hasActiveDocument"
                :document-kind="editorStore.document.kind" :theme="appStore.theme" :is-running="editorStore.isRunning"
                :can-run="canRun" :can-save="canSave" :is-desktop-runtime="isDesktopRuntime"
                :primary-mode="isAiMode ? 'ai' : 'editor'" :is-terminal-visible="isTerminalVisible"
                :is-diagnostics-visible="isDiagnosticsPanelVisible" :can-toggle-diagnostics="canToggleDiagnosticsPanel"
                :diagnostic-issue-count="diagnosticIssueCount" :command-templates="commandTemplates"
                :comment-templates="commentTemplates" @new="createNewDocument" @open="openDocument"
                @open-folder="openFolder" @close-workspace="requestCloseWorkspace" @save="saveDocument"
                @save-as="saveDocumentAs" @close-request="handleRequestCloseApplication" @run="handleRunScript"
                @format-document="handleFormatDocument" @open-terminal="openTerminal" @hide-terminal="hideTerminal"
                @toggle-diagnostics="handleOpenShellCheck" @toggle-theme="toggleTheme"
                @select-sidebar-view="handleSelectSidebarView" @insert-template="handleInsertTemplate"
                @ai-code-action="handleAiCodeAction" />
        </template>

        <template #sidebar>
            <WorkbenchDashboardSidebar :active-view="activeSidebarView" :documents="editorStore.documents"
                :active-document-id="editorStore.activeDocumentId" :is-ai-mode="isAiMode"
                @select-view="handleSelectSidebarView" @select-document="handleSidebarDocumentSelect"
                @create-document="createNewDocument" @toggle-settings="toggleSettingsView" />
        </template>

        <template #header>
            <WorkbenchSurfaceHeader title="Documents" :right-label="surfaceHeaderLabel" :show-back-to-editor="isAiMode"
                @back-to-editor="openEditorMode" />
        </template>

        <section v-show="isWorkbenchContentVisible" :ref="editorViewportRef" data-testid="workbench-root"
            class="workbench-editor-viewport relative h-full min-h-0 overflow-hidden bg-(--editor-bg) px-4 py-4 lg:px-6 lg:py-6"
            :data-diagnostics-resizing="diagnosticsTransitionsEnabled ? 'false' : 'true'">
            <AiWorkspaceSurface v-if="isAiMode" :document="editorStore.document"
                :active-run="editorStore.activeRunSummary" :analysis="editorStore.activeScriptAnalysis"
                :selection="editorStore.activeSelectionSummary" :git-status="gitStore.status"
                :workspace-root-path="editorStore.workspaceRootPath" @open-patch-diff="openGitDiffPreviewPayload" />

            <Card v-else
                class="h-full min-h-[calc(100vh-196px)] gap-0 overflow-hidden rounded-[22px] border-(--shell-divider) py-0 shadow-sm">
                <CardContent class="flex min-h-0 flex-1 px-0 pb-0 pt-0">
                    <div class="flex h-full min-h-0 flex-1 flex-col">
                        <EmptyEditorState v-if="!editorStore.hasActiveDocument"
                            :has-workspace="Boolean(editorStore.workspaceRootPath)"
                            :is-desktop-runtime="isDesktopRuntime" @create="createNewDocument" @open="openDocument"
                            @open-folder="openFolder" />

                        <DeferredSmartScriptEditor v-else-if="editorStore.document.kind === 'text'" :ref="editorRef"
                            :document-id="editorStore.document.id" :document-path="editorStore.document.path"
                            :document-name="editorStore.document.name" :model-value="editorStore.document.content"
                            :theme="appStore.theme" :editor-settings="appStore.settings.editor" :can-run="canRun"
                            @update:model-value="updateContent" @cursor-position-change="handleCursorPositionChange"
                            @diagnostics-change="handleDiagnosticsChange" @selection-change="handleSelectionChange"
                            @format-request="handleFormatDocument" @command-palette-request="handleOpenCommandPalette"
                            @run-request="handleRunScript" />

                        <AiDiffPreviewEditor
                            v-else-if="editorStore.document.kind === 'ai-diff' && editorStore.document.aiDiffPreview"
                            :preview="editorStore.document.aiDiffPreview" />

                        <GitDiffViewer
                            v-else-if="editorStore.document.kind === 'git-diff' && editorStore.document.gitDiffPreview"
                            :preview="editorStore.document.gitDiffPreview" :theme="appStore.theme"
                            :editor-settings="appStore.settings.editor" />

                        <ImageAssetPreview v-else-if="editorStore.document.path" :path="editorStore.document.path"
                            :name="editorStore.document.name" />
                    </div>
                </CardContent>
            </Card>
        </section>

        <template #terminal>
            <DeferredRunPanel v-show="isWorkbenchContentVisible" :ref="runPanelRef"
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
                @terminal-run-completed="handleIntegratedTerminalRunCompleted"
                @select-diagnostic="handleSelectDiagnostic" @rerun-analysis="handleRerunDiagnostics"
                @ai-fix-diagnostic="handleAiFixDiagnostic" />
        </template>

        <template #statusbar>
            <DeferredWorkbenchStatusBar :has-active-document="editorStore.hasActiveDocument"
                :document-kind="editorStore.document.kind" :status-message="statusbarMessage"
                :script-analysis="editorStore.activeScriptAnalysis" :encoding="editorStore.document.encoding"
                :executor="editorStore.selectedExecutor" :cursor-line="editorStore.cursorLine"
                :cursor-column="editorStore.cursorColumn" :char-count="editorStore.document.charCount"
                :git-branch-name="gitBranchName" :git-added-count="gitAddedCount" :git-removed-count="gitRemovedCount"
                @change-encoding="updateEncoding" @open-source-control="handleSelectSidebarView('source-control')"
                @open-diagnostics="handleOpenShellCheck" />
        </template>

        <template #overlay>
            <WorkbenchSettingsOverlay :ref="settingsOverlayRef" :open="isSettingsView" @close="closeSettingsView"
                @saved="handleSettingsSaved" />
        </template>
    </AppShellLayout>
</template>

<script setup lang="ts">
import AiWorkspaceSurface from '@/components/business/ai/AiWorkspaceSurface.vue';
import WindowTitleBar from '@/components/common/WindowTitleBar.vue';
import AiDiffPreviewEditor from '@/components/editor/AiDiffPreviewEditor.vue';
import EmptyEditorState from '@/components/editor/EmptyEditorState.vue';
import GitDiffViewer from '@/components/editor/GitDiffViewer.vue';
import ImageAssetPreview from '@/components/editor/ImageAssetPreview.vue';
import { Card, CardContent } from '@/components/ui/card';
import WorkbenchDashboardSidebar from '@/components/workbench/WorkbenchDashboardSidebar.vue';
import WorkbenchSettingsOverlay from '@/components/workbench/WorkbenchSettingsOverlay.vue';
import WorkbenchSurfaceHeader from '@/components/workbench/WorkbenchSurfaceHeader.vue';
import { useShellWorkbenchView } from '@/composables/useShellWorkbenchView';
import AppShellLayout from '@/layouts/AppShellLayout.vue';
import { computed, defineAsyncComponent } from 'vue';

const DeferredSmartScriptEditor = defineAsyncComponent({
    loader: () => import('@/components/editor/SmartScriptEditor.vue'),
    suspensible: false,
});

const DeferredRunPanel = defineAsyncComponent({
    loader: () => import('@/components/workbench/RunPanel.vue'),
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
    openGitDiffPreviewPayload,
    saveDocument,
    saveDocumentAs,
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
    openEditorMode,
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

const surfaceHeaderLabel = computed(() => {
    if (isAiMode.value) {
        return 'Word Assistant';
    }

    if (editorStore.hasActiveDocument) {
        return editorStore.document.name;
    }

    return null;
});

const handleSidebarDocumentSelect = (documentId: string): void => {
    openEditorMode();
    activateDocument(documentId);
};
</script>
