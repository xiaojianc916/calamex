<template>
  <AppShellLayout :is-desktop-runtime="isDesktopRuntime" :sidebar-visible="isSidebarVisible"
    :sidebar-width="sidebarWidth" @close-request="handleRequestCloseApplication">
    <template #sidebar>
      <WorkbenchDashboardSidebar :active-view="activeSidebarView" :document="editorStore.document"
        :is-ai-mode="isAiMode" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="visibleWorkspaceRootPath"
        :preloaded-workspace-root="startupWorkspaceRoot"
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
          <div class="workbench-content-frame flex min-h-0 flex-1 flex-col workbench-content-card">
            <DeferredAiWorkspaceSurface v-if="isAiMode || hasPinnedAiWorkspace" v-show="isAiMode" class="min-w-0 flex-1"
              :aria-hidden="!isAiMode" :document="editorStore.document" :active-run="editorStore.activeRunSummary"
              :analysis="editorStore.activeScriptAnalysis" :selection="editorStore.activeSelectionSummary"
              :git-status="gitStore.status" :workspace-root-path="editorStore.workspaceRootPath"
              @open-patch-diff="openGitDiffPreviewPayload" />

            <Card v-show="!isAiMode"
              class="flex h-full min-h-0 flex-1 flex-col gap-0 rounded-none border-0 py-0 shadow-none bg-transparent">
              <StartupWorkbenchShell v-if="isStartupShellVisible && startupShellState" :state="startupShellState"
                :show-terminal="isTerminalPanelVisible" :terminal-height="terminalHeight" />

              <ResizablePanelGroup v-else-if="isTerminalSplitVisible" direction="vertical"
                class="h-full min-h-0 w-full">
                <ResizablePanel class="min-h-0" :min-size="220" size-unit="px">
                  <CardContent class="flex h-full min-h-0 flex-1 px-0 pb-0 pt-0">
                    <div class="flex h-full min-h-0 flex-1 flex-col">
                      <EmptyEditorState v-if="!editorStore.hasActiveDocument"
                        :has-workspace="Boolean(editorStore.workspaceRootPath)" :is-desktop-runtime="isDesktopRuntime"
                        @create="createNewDocument" @open="openDocument" @open-folder="openFolder" />

                      <DeferredSmartScriptEditor v-else-if="editorStore.document.kind === 'text'" :ref="bindEditorRef"
                        :document-id="editorStore.document.id" :document-path="editorStore.document.path"
                        :document-name="editorStore.document.name" :model-value="editorStore.document.content"
                        theme="light" :editor-settings="appStore.settings.editor" :can-run="canRun"
                        @update:model-value="updateContent" @cursor-position-change="handleCursorPositionChange"
                        @diagnostics-change="handleDiagnosticsChange" @selection-change="handleSelectionChange"
                        @format-request="handleFormatDocument" @command-palette-request="handleOpenCommandPalette"
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

                      <DeferredImageAssetPreview v-else-if="editorStore.document.path" :path="editorStore.document.path"
                        :name="editorStore.document.name" />
                    </div>
                  </CardContent>
                </ResizablePanel>

                <ResizableHandle class="terminal-resize-handle" />

                <ResizablePanel class="min-h-0 overflow-hidden" :default-size="terminalHeight" :min-size="140"
                  size-unit="px" @resize="handleTerminalHeightChange">
                  <DeferredRunPanel theme="light" :terminal-settings="appStore.settings.terminal"
                    :visible="isTerminalPanelVisible" :is-maximized="false" @hide="hideTerminal"
                    @toggle-maximize="toggleTerminalMaximize"
                    @terminal-run-completed="handleIntegratedTerminalRunCompleted" />
                </ResizablePanel>
              </ResizablePanelGroup>

              <div v-else-if="isTerminalPanelVisible" class="flex min-h-0 flex-1 flex-col overflow-hidden">
                <DeferredRunPanel theme="light" :terminal-settings="appStore.settings.terminal"
                  :visible="isTerminalPanelVisible" :is-maximized="true" @hide="hideTerminal"
                  @toggle-maximize="toggleTerminalMaximize"
                  @terminal-run-completed="handleIntegratedTerminalRunCompleted" />
              </div>

              <CardContent v-else class="flex min-h-0 flex-1 px-0 pb-0 pt-0">
                <div class="flex h-full min-h-0 flex-1 flex-col">
                  <EmptyEditorState v-if="!editorStore.hasActiveDocument"
                    :has-workspace="Boolean(editorStore.workspaceRootPath)" :is-desktop-runtime="isDesktopRuntime"
                    @create="createNewDocument" @open="openDocument" @open-folder="openFolder" />

                  <DeferredSmartScriptEditor v-else-if="editorStore.document.kind === 'text'" :ref="bindEditorRef"
                    :document-id="editorStore.document.id" :document-path="editorStore.document.path"
                    :document-name="editorStore.document.name" :model-value="editorStore.document.content" theme="light"
                    :editor-settings="appStore.settings.editor" :can-run="canRun" @update:model-value="updateContent"
                    @cursor-position-change="handleCursorPositionChange" @diagnostics-change="handleDiagnosticsChange"
                    @selection-change="handleSelectionChange" @format-request="handleFormatDocument"
                    @command-palette-request="handleOpenCommandPalette" @open-terminal-request="openTerminal"
                    @run-request="handleRunScript" />

                  <DeferredAiDiffPreviewEditor v-else-if="
                    editorStore.document.kind === 'ai-diff' && editorStore.document.aiDiffPreview
                  " :preview="editorStore.document.aiDiffPreview" />

                  <DeferredGitDiffViewer v-else-if="
                    editorStore.document.kind === 'git-diff' &&
                    editorStore.document.gitDiffPreview
                  " :preview="editorStore.document.gitDiffPreview" theme="light"
                    :editor-settings="appStore.settings.editor" />

                  <DeferredImageAssetPreview v-else-if="editorStore.document.path" :path="editorStore.document.path"
                    :name="editorStore.document.name" />
                </div>
              </CardContent>
            </Card>

            <LspStatusBar v-show="!isAiMode" :status="lspStatus" :server-name="lspServerName" :error="lspError"
              :is-running="lspIsRunning" :is-starting="lspIsStarting" :has-error="lspHasError" @restart="restartLsp" />
          </div>
        </div>
      </div>
    </section>

  </AppShellLayout>
</template>

<script setup lang="ts">
import EmptyEditorState from '@/components/editor/EmptyEditorState.vue';
import { Card, CardContent } from '@/components/ui/card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import LspStatusBar from '@/components/workbench/LspStatusBar.vue';
import StartupWorkbenchShell from '@/components/workbench/StartupWorkbenchShell.vue';
import WorkbenchDashboardSidebar from '@/components/workbench/WorkbenchDashboardSidebar.vue';
import { useLsp } from '@/composables/useLsp';
import { useShellWorkbenchView } from '@/composables/useShellWorkbenchView';
import AppShellLayout from '@/layouts/AppShellLayout.vue';
import { useAiAgentStore } from '@/store/aiAgent';
import type { TWorkbenchOpenFilePayload } from '@/types/editor';
import type { IGitDiffPreviewRequest } from '@/types/git';
import { computed, defineAsyncComponent, nextTick } from 'vue';

const DeferredAiWorkspaceSurface = defineAsyncComponent({
  loader: () => import('@/components/business/ai/shell/AiWorkspaceSurface.vue'),
  suspensible: false,
});

const DeferredAiDiffPreviewEditor = defineAsyncComponent({
  loader: () => import('@/components/business/ai/edit/AiDiffPreviewEditor.vue'),
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

// 预加载 AI 工作区组件，避免首次切换时出现空白帧
import('@/components/business/ai/shell/AiWorkspaceSurface.vue');
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
  handleTerminalHeightChange,
  toggleTerminalMaximize,
  openAiMode,
  openEditorMode,
  handleSelectSidebarView,
  handleExplorerSessionStateChange,
  handleRequestCloseApplication,
  hideTerminal,
  openTerminal,
  handleRunScript,
  handleInsertTemplate,
  handleIntegratedTerminalRunCompleted,
  handleOpenCommandPalette,
} = useShellWorkbenchView(() => emit('ready'));

const lsp = useLsp(visibleWorkspaceRootPath);
const {
  status: lspStatus,
  error: lspError,
  serverName: lspServerName,
  isRunning: lspIsRunning,
  isStarting: lspIsStarting,
  hasError: lspHasError,
  restartLsp,
} = lsp;

const isTerminalAllowed = computed(() => !isAiMode.value);
const isTerminalPanelVisible = computed(() => isTerminalAllowed.value && isTerminalVisible.value);
const isTerminalSplitVisible = computed(
  () => isTerminalPanelVisible.value && !isTerminalMaximized.value,
);
const aiAgentStore = useAiAgentStore();
const terminalAgentRunStatuses = new Set(['completed', 'failed', 'cancelled']);
const terminalPlanStatuses = new Set(['completed', 'failed', 'rejected']);
const hasPinnedAiWorkspace = computed(() => {
  const activeRun = aiAgentStore.activeRun;

  if (activeRun && !terminalAgentRunStatuses.has(activeRun.status)) {
    return true;
  }

  if (aiAgentStore.isClassifying || aiAgentStore.isPlanning) {
    return true;
  }

  if (aiAgentStore.hasPlan && !aiAgentStore.planStatus) {
    return true;
  }

  return Boolean(
    aiAgentStore.planId &&
    aiAgentStore.planStatus &&
    !terminalPlanStatuses.has(aiAgentStore.planStatus),
  );
});

const handleSidebarOpenFile = async (payload: TWorkbenchOpenFilePayload): Promise<void> => {
  const request = typeof payload === 'string' ? { path: payload } : payload;

  openEditorMode();
  await openDocumentByPath(request.path);

  if (typeof request.lineNumber === 'number') {
    await nextTick();
    editorRef.value?.revealPosition(request.lineNumber, request.column ?? 1);
  }
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

const bindEditorRef = (value: unknown): void => {
  editorRef.value = isEditorExpose(value) ? value : null;
};

const bindEditorViewportRef = (value: unknown): void => {
  editorViewportRef.value = value instanceof HTMLElement ? value : null;
};
</script>

<style>
/* 终端面板顶部：可拖拽分隔条 —— 常态 1px #ededed 细线，10px 不可见热区便于抓取，悬停/拖拽平滑变粗高亮 */
.terminal-resize-handle {
  background-color: transparent !important;
  cursor: row-resize;
  touch-action: none;
}

/* 加宽抓取热区（覆盖基础 after 的 h-1 / inset-y-0），保持透明 */
.terminal-resize-handle::after {
  top: 50% !important;
  bottom: auto !important;
  height: 10px !important;
  border-radius: 0 !important;
  background-color: transparent !important;
}

/* 可见细线：默认 1px #ededed，绝对定位居中，不占布局高度 */
.terminal-resize-handle::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  transform: translateY(-50%);
  background-color: #ededed;
  border-radius: 999px;
  pointer-events: none;
  z-index: 1;
  transition:
    height 160ms cubic-bezier(0.22, 1, 0.36, 1),
    background-color 160ms ease;
}

/* 悬停 / 拖拽：平滑变粗 3px 并高亮为品牌强调色 */
.terminal-resize-handle:hover::before,
.terminal-resize-handle:active::before {
  height: 3px;
  background-color: var(--accent-strong);
}

@media (prefers-reduced-motion: reduce) {
  .terminal-resize-handle::before {
    transition: none;
  }
}
</style>
