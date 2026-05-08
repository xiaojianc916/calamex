<template>
    <AppShellLayout :is-desktop-runtime="isDesktopRuntime" :sidebar-visible="isSidebarVisible"
        :sidebar-width="sidebarWidth" @close-request="handleRequestCloseApplication">
        <template #sidebar>
            <WorkbenchDashboardSidebar :active-view="activeSidebarView" :document="editorStore.document"
                :is-ai-mode="isAiMode" :is-desktop-runtime="isDesktopRuntime"
                :workspace-root-path="visibleWorkspaceRootPath" :preloaded-workspace-root="startupWorkspaceRoot"
                :startup-explorer-expanded-paths="startupShellState?.explorerExpandedPaths ?? []"
                :startup-explorer-selected-path="startupShellState?.explorerSelectedPath ?? null" :can-run="canRun"
                :is-running="editorStore.isRunning" :has-run-artifacts="editorStore.hasRunArtifacts"
                :active-run="editorStore.activeRunSummary" :run-history="editorStore.runHistory"
                :command-templates="commandTemplates" :executor="editorStore.selectedExecutor"
                @select-view="handleSelectSidebarView" @toggle-primary-mode="handleTogglePrimaryMode"
                @open-file="handleSidebarOpenFile" @open-folder="openFolder" @open-git-diff="handleSidebarOpenGitDiff"
                @run="handleRunScript" @create-document="createNewDocument" @open-terminal="openTerminal"
                @insert-template="handleInsertTemplate" @clear-run-history="handleClearRunHistory"
                @explorer-state-change="handleExplorerSessionStateChange" />
        </template>

        <section :ref="bindEditorViewportRef" data-testid="workbench-root"
            class="workbench-editor-viewport relative flex h-full min-h-0 flex-col overflow-hidden bg-(--app-bg)"
            :data-diagnostics-resizing="diagnosticsTransitionsEnabled ? 'false' : 'true'">
            <div class="@container/main workbench-content-stage">
                <div class="workbench-content-dock">
                    <DeferredAiWorkspaceSurface v-if="isAiMode" class="min-w-0 flex-1" :document="editorStore.document"
                        :active-run="editorStore.activeRunSummary" :analysis="editorStore.activeScriptAnalysis"
                        :selection="editorStore.activeSelectionSummary" :git-status="gitStore.status"
                        :workspace-root-path="editorStore.workspaceRootPath"
                        @open-patch-diff="openGitDiffPreviewPayload" />

                    <Card v-else class="workbench-content-card flex h-full min-h-0 flex-1 flex-col gap-0 py-0">
                        <StartupWorkbenchShell v-if="isStartupShellVisible && startupShellState"
                            :state="startupShellState" :show-terminal="isTerminalPanelVisible"
                            :terminal-height="terminalHeight" />

                        <ResizablePanelGroup v-else-if="isTerminalSplitVisible" direction="vertical"
                            class="h-full min-h-0 w-full">
                            <ResizablePanel class="min-h-0" :min-size="220" size-unit="px">
                                <CardContent class="flex h-full min-h-0 flex-1 px-0 pb-0 pt-0">
                                    <div class="flex h-full min-h-0 flex-1 flex-col">
                                        <EmptyEditorState v-if="!editorStore.hasActiveDocument"
                                            :has-workspace="Boolean(editorStore.workspaceRootPath)"
                                            :is-desktop-runtime="isDesktopRuntime" @create="createNewDocument"
                                            @open="openDocument" @open-folder="openFolder" />

                                        <DeferredSmartScriptEditor v-else-if="editorStore.document.kind === 'text'"
                                            :ref="bindEditorRef" :document-id="editorStore.document.id"
                                            :document-path="editorStore.document.path"
                                            :document-name="editorStore.document.name"
                                            :model-value="editorStore.document.content" theme="light"
                                            :editor-settings="appStore.settings.editor" :can-run="canRun"
                                            @update:model-value="updateContent"
                                            @cursor-position-change="handleCursorPositionChange"
                                            @diagnostics-change="handleDiagnosticsChange"
                                            @selection-change="handleSelectionChange"
                                            @format-request="handleFormatDocument"
                                            @command-palette-request="handleOpenCommandPalette"
                                            @open-terminal-request="openTerminal" @run-request="handleRunScript" />

                                        <DeferredAiDiffPreviewEditor v-else-if="
                                            editorStore.document.kind === 'ai-diff' &&
                                            editorStore.document.aiDiffPreview
                                        " :preview="editorStore.document.aiDiffPreview" />

                                        <DeferredGitDiffViewer v-else-if="
                                            editorStore.document.kind === 'git-diff' &&
                                            editorStore.document.gitDiffPreview
                                        " :preview="editorStore.document.gitDiffPreview" theme="light"
                                            :editor-settings="appStore.settings.editor" />

                                        <DeferredImageAssetPreview v-else-if="editorStore.document.path"
                                            :path="editorStore.document.path" :name="editorStore.document.name" />
                                    </div>
                                </CardContent>
                            </ResizablePanel>

                            <ResizableHandle
                                class="bg-transparent after:rounded-full after:bg-(--shell-divider) data-[panel-group-direction=vertical]:after:h-[4px]" />

                            <ResizablePanel class="min-h-0 overflow-hidden" :default-size="terminalHeight"
                                :min-size="140" size-unit="px" @resize="handleTerminalHeightChange">
                                <DeferredRunPanel :ref="bindRunPanelRef"
                                    :terminal-output-length="editorStore.terminalOutputLength"
                                    :terminal-output-version="editorStore.terminalOutputVersion"
                                    :resolve-terminal-output="editorStore.getTerminalOutputSnapshot"
                                    :run-logs="editorStore.runLogs" :last-run-result="editorStore.lastRunResult"
                                    :is-running="editorStore.isRunning" :executor="editorStore.selectedExecutor"
                                    :document-name="editorStore.document.name"
                                    :document-content="editorStore.document.content"
                                    :document-path="editorStore.document.path"
                                    :script-analysis="editorStore.activeScriptAnalysis"
                                    :workspace-root-path="editorStore.workspaceRootPath" theme="light"
                                    :terminal-settings="appStore.settings.terminal" :visible="isTerminalPanelVisible"
                                    :is-maximized="false" @hide="hideTerminal" @toggle-maximize="toggleTerminalMaximize"
                                    @clear-logs="clearTerminalLogs"
                                    @terminal-run-completed="handleIntegratedTerminalRunCompleted"
                                    @select-diagnostic="handleSelectDiagnostic" @rerun-analysis="handleRerunDiagnostics"
                                    @ai-fix-diagnostic="handleAiFixDiagnostic" />
                            </ResizablePanel>
                        </ResizablePanelGroup>

                        <div v-else-if="isTerminalPanelVisible" class="flex min-h-0 flex-1 flex-col overflow-hidden">
                            <DeferredRunPanel :ref="bindRunPanelRef"
                                :terminal-output-length="editorStore.terminalOutputLength"
                                :terminal-output-version="editorStore.terminalOutputVersion"
                                :resolve-terminal-output="editorStore.getTerminalOutputSnapshot"
                                :run-logs="editorStore.runLogs" :last-run-result="editorStore.lastRunResult"
                                :is-running="editorStore.isRunning" :executor="editorStore.selectedExecutor"
                                :document-name="editorStore.document.name"
                                :document-content="editorStore.document.content"
                                :document-path="editorStore.document.path"
                                :script-analysis="editorStore.activeScriptAnalysis"
                                :workspace-root-path="editorStore.workspaceRootPath" theme="light"
                                :terminal-settings="appStore.settings.terminal" :visible="isTerminalPanelVisible"
                                :is-maximized="true" @hide="hideTerminal" @toggle-maximize="toggleTerminalMaximize"
                                @clear-logs="clearTerminalLogs"
                                @terminal-run-completed="handleIntegratedTerminalRunCompleted"
                                @select-diagnostic="handleSelectDiagnostic" @rerun-analysis="handleRerunDiagnostics"
                                @ai-fix-diagnostic="handleAiFixDiagnostic" />
                        </div>

                        <CardContent v-else class="flex min-h-0 flex-1 px-0 pb-0 pt-0">
                            <div class="flex h-full min-h-0 flex-1 flex-col">
                                <EmptyEditorState v-if="!editorStore.hasActiveDocument"
                                    :has-workspace="Boolean(editorStore.workspaceRootPath)"
                                    :is-desktop-runtime="isDesktopRuntime" @create="createNewDocument"
                                    @open="openDocument" @open-folder="openFolder" />

                                <DeferredSmartScriptEditor v-else-if="editorStore.document.kind === 'text'"
                                    :ref="bindEditorRef" :document-id="editorStore.document.id"
                                    :document-path="editorStore.document.path"
                                    :document-name="editorStore.document.name"
                                    :model-value="editorStore.document.content" theme="light"
                                    :editor-settings="appStore.settings.editor" :can-run="canRun"
                                    @update:model-value="updateContent"
                                    @cursor-position-change="handleCursorPositionChange"
                                    @diagnostics-change="handleDiagnosticsChange"
                                    @selection-change="handleSelectionChange" @format-request="handleFormatDocument"
                                    @command-palette-request="handleOpenCommandPalette"
                                    @open-terminal-request="openTerminal" @run-request="handleRunScript" />

                                <DeferredAiDiffPreviewEditor v-else-if="
                                    editorStore.document.kind === 'ai-diff' && editorStore.document.aiDiffPreview
                                " :preview="editorStore.document.aiDiffPreview" />

                                <DeferredGitDiffViewer v-else-if="
                                    editorStore.document.kind === 'git-diff' &&
                                    editorStore.document.gitDiffPreview
                                " :preview="editorStore.document.gitDiffPreview" theme="light"
                                    :editor-settings="appStore.settings.editor" />

                                <DeferredImageAssetPreview v-else-if="editorStore.document.path"
                                    :path="editorStore.document.path" :name="editorStore.document.name" />
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </section>

    </AppShellLayout>
</template>

<script setup lang="ts">
import EmptyEditorState from '@/components/editor/EmptyEditorState.vue';
import { Card, CardContent } from '@/components/ui/card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import StartupWorkbenchShell from '@/components/workbench/StartupWorkbenchShell.vue';
import WorkbenchDashboardSidebar from '@/components/workbench/WorkbenchDashboardSidebar.vue';
import { useShellWorkbenchView } from '@/composables/useShellWorkbenchView';
import AppShellLayout from '@/layouts/AppShellLayout.vue';
import type { IGitDiffPreviewRequest } from '@/types/git';
import { computed, defineAsyncComponent } from 'vue';

const DeferredAiWorkspaceSurface = defineAsyncComponent({
    loader: () => import('@/components/business/ai/AiWorkspaceSurface.vue'),
    suspensible: false,
});

const DeferredAiDiffPreviewEditor = defineAsyncComponent({
    loader: () => import('@/components/editor/AiDiffPreviewEditor.vue'),
    suspensible: false,
});

const DeferredGitDiffViewer = defineAsyncComponent({
    loader: () => import('@/components/editor/GitDiffViewer.vue'),
    suspensible: false,
});

const DeferredImageAssetPreview = defineAsyncComponent({
    loader: () => import('@/components/editor/ImageAssetPreview.vue'),
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

const emit = defineEmits<{
    ready: [];
}>();

const {
    appStore,
    editorStore,
    gitStore,
    runPanelRef,
    isDesktopRuntime,
    canRun,
    commandTemplates,
    createNewDocument,
    openDocument,
    openDocumentByPath,
    openFolder,
    openGitDiffPreview,
    openGitDiffPreviewPayload,
    updateContent,
    editorRef,
    editorViewportRef,
    isTerminalVisible,
    isSidebarVisible,
    isAiMode,
    terminalHeight,
    isTerminalMaximized,
    activeSidebarView,
    sidebarWidth,
    startupShellState,
    isStartupShellVisible,
    visibleWorkspaceRootPath,
    diagnosticsTransitionsEnabled,
    startupWorkspaceRoot,
    handleFormatDocument,
    handleCursorPositionChange,
    handleSelectionChange,
    handleDiagnosticsChange,
    handleSelectDiagnostic,
    handleRerunDiagnostics,
    handleTerminalHeightChange,
    toggleTerminalMaximize,
    openAiMode,
    openEditorMode,
    handleSelectSidebarView,
    handleExplorerSessionStateChange,
    handleRequestCloseApplication,
    hideTerminal,
    openTerminal,
    clearTerminalLogs,
    handleRunScript,
    handleInsertTemplate,
    handleIntegratedTerminalRunCompleted,
    handleOpenCommandPalette,
    handleAiFixDiagnostic,
} = useShellWorkbenchView(() => emit('ready'));

const isTerminalAllowed = computed(() => !isAiMode.value);
const isTerminalPanelVisible = computed(() => isTerminalAllowed.value && isTerminalVisible.value);
const isTerminalSplitVisible = computed(
    () => isTerminalPanelVisible.value && !isTerminalMaximized.value,
);

const handleSidebarOpenFile = async (path: string): Promise<void> => {
    openEditorMode();
    await openDocumentByPath(path);
};

const handleSidebarOpenGitDiff = async (payload: IGitDiffPreviewRequest): Promise<void> => {
    openEditorMode();
    await openGitDiffPreview(payload);
};

const handleClearRunHistory = (): void => {
    editorStore.clearLogs();
};

const handleTogglePrimaryMode = (): void => {
    if (isAiMode.value) {
        openEditorMode();
        return;
    }

    openAiMode();
};

const isRunPanelExpose = (value: unknown): value is NonNullable<typeof runPanelRef.value> => {
    return (
        typeof value === 'object' &&
        value !== null &&
        'openShellCheck' in value &&
        typeof value.openShellCheck === 'function'
    );
};

const isEditorExpose = (value: unknown): value is NonNullable<typeof editorRef.value> => {
    return (
        typeof value === 'object' &&
        value !== null &&
        'focusEditor' in value &&
        typeof value.focusEditor === 'function' &&
        'insertSnippet' in value &&
        typeof value.insertSnippet === 'function' &&
        'revealPosition' in value &&
        typeof value.revealPosition === 'function' &&
        'rerunDiagnostics' in value &&
        typeof value.rerunDiagnostics === 'function' &&
        'layoutEditor' in value &&
        typeof value.layoutEditor === 'function'
    );
};

const bindRunPanelRef = (value: unknown): void => {
    runPanelRef.value = isRunPanelExpose(value) ? value : null;
};

const bindEditorRef = (value: unknown): void => {
    editorRef.value = isEditorExpose(value) ? value : null;
};

const bindEditorViewportRef = (value: unknown): void => {
    editorViewportRef.value = value instanceof HTMLElement ? value : null;
};
</script>
