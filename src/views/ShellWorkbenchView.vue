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
        @run="handleRunScript" @create-document="createNewDocument" @open-terminal="handleOpenTerminal"
        @insert-template="handleInsertTemplate" @clear-run-history="handleClearRunHistory"
        @explorer-state-change="handleExplorerSessionStateChange" />
    </template>

    <section :ref="bindEditorViewportRef" data-testid="workbench-root"
      class="workbench-editor-viewport relative flex h-full min-h-0 flex-col overflow-hidden bg-(--app-bg)"
      :data-diagnostics-resizing="diagnosticsTransitionsEnabled ? 'false' : 'true'">
      <div class="@container/main workbench-content-stage">
        <div class="workbench-content-dock">
          <div class="workbench-content-frame flex min-h-0 flex-1 flex-col workbench-content-card">
            <template v-if="isStartupShellVisible && startupShellState">
              <StartupAiWorkbenchShell v-if="isAiMode" />

              <StartupWorkbenchShell v-else :state="startupShellState" :show-terminal="isTerminalPanelVisible"
                :terminal-height="terminalHeight" />
            </template>

            <template v-else>
              <DeferredAiWorkspaceSurface v-if="isAiMode || hasPinnedAiWorkspace" v-show="isAiMode" class="min-w-0 flex-1"
                :aria-hidden="!isAiMode" :document="editorStore.document" :active-run="editorStore.activeRunSummary"
                :analysis="editorStore.activeScriptAnalysis" :selection="editorStore.activeSelectionSummary"
                :git-status="gitStore.status" :workspace-root-path="editorStore.workspaceRootPath"
                @open-patch-diff="openGitDiffPreviewPayload" />

              <Card v-show="!isAiMode"
                class="flex h-full min-h-0 flex-1 flex-col gap-0 rounded-none border-0 py-0 shadow-none bg-transparent">
                <ResizablePanelGroup direction="vertical" auto-save-id="workbench-terminal-split"
                  class="min-h-0 flex-1">
                  <ResizablePanel id="workbench-editor-panel" :order="1" :ref="bindEditorPanel" :min-size="20"
                    collapsible :collapsed-size="0" :default-size="68" class="min-h-0"
                    @collapse="handleEditorCollapse" @expand="handleEditorExpand">
                    <CardContent class="flex h-full min-h-0 flex-1 px-0 pb-0 pt-0">
                      <div class="flex h-full min-h-0 flex-1 flex-col">
                        <EmptyEditorState v-if="!editorStore.hasActiveDocument"
                          :has-workspace="Boolean(editorStore.workspaceRootPath)" :is-desktop-runtime="isDesktopRuntime"
                          @create="createNewDocument" @open="openDocument" @open-folder="openFolder" />

                        <DeferredSmartScriptEditor v-else-if="editorStore.document.kind === 'text'" :ref="bindEditorRef"
                          :key="editorStore.document.id"
                          :document-id="editorStore.document.id" :document-path="editorStore.document.path"
                          :document-name="editorStore.document.name" :model-value="editorStore.document.content"
                          theme="light" :editor-settings="appStore.settings.editor" :can-run="canRun"
                          @update:model-value="updateContent" @cursor-position-change="handleCursorPositionChange"
                          @diagnostics-change="handleDiagnosticsChange" @selection-change="handleSelectionChange"
                          @format-request="handleFormatDocument" @command-palette-request="handleOpenCommandPalette"
                          @open-terminal-request="handleOpenTerminal" @run-request="handleRunScript" />

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

                  <template v-if="isTerminalPanelVisible">
                    <ResizableHandle with-handle />

                    <ResizablePanel id="workbench-terminal-panel" :order="2" :min-size="12" collapsible
                      :collapsed-size="0" :default-size="32" class="min-h-0 overflow-hidden"
                      @collapse="handleHideTerminal">
                      <DeferredRunPanel theme="light" :terminal-settings="appStore.settings.terminal"
                        :visible="isTerminalPanelVisible" :is-maximized="isEditorCollapsed" @hide="handleHideTerminal"
                        @toggle-maximize="toggleTerminalFullscreen"
                        @terminal-run-completed="handleIntegratedTerminalRunCompleted" />
                    </ResizablePanel>
                  </template>
                </ResizablePanelGroup>
              </Card>
            </template>
          </div>
        </div>
      </div>
    </section>

  </AppShellLayout>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref } from 'vue';
import EmptyEditorState from '@/components/editor/EmptyEditorState.vue';
import { Card, CardContent } from '@/components/ui/card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import StartupAiWorkbenchShell from '@/components/workbench/StartupAiWorkbenchShell.vue';
import StartupWorkbenchShell from '@/components/workbench/StartupWorkbenchShell.vue';
import WorkbenchDashboardSidebar from '@/components/workbench/WorkbenchDashboardSidebar.vue';
import { useLsp } from '@/composables/useLsp';
import { useShellWorkbenchView } from '@/composables/useShellWorkbenchView';
import AppShellLayout from '@/layouts/AppShellLayout.vue';
import { useAiAgentStore } from '@/store/aiAgent';
import type { TWorkbenchOpenFilePayload } from '@/types/editor';
import type { IGitDiffPreviewRequest } from '@/types/git';

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

// 保留 LSP 生命周期管理（启动 / 停止 bash-language-server），仅移除底部状态栏 UI。
useLsp(visibleWorkspaceRootPath);

const isTerminalAllowed = computed(() => !isAiMode.value);
const isTerminalPanelVisible = computed(() => isTerminalAllowed.value && isTerminalVisible.value);
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

// 终端分栏：使用官方 reka-ui Splitter（ResizablePanelGroup）实现磁吸折叠/全屏，
// 不再手写指针拖拽。编辑器面板折叠=终端全屏，终端面板折叠=关闭终端。
type TResizablePanelHandle = {
  collapse: () => void;
  expand: () => void;
};

const isResizablePanelHandle = (value: unknown): value is TResizablePanelHandle =>
  typeof value === 'object' &&
  value !== null &&
  'collapse' in value &&
  typeof (value as { collapse: unknown }).collapse === 'function' &&
  'expand' in value &&
  typeof (value as { expand: unknown }).expand === 'function';

const editorPanelRef = ref<TResizablePanelHandle | null>(null);
// 终端是否处于全屏（即编辑器面板被折叠）。由面板的 collapse/expand 事件驱动。
const isEditorCollapsed = ref(false);

const bindEditorPanel = (value: unknown): void => {
  editorPanelRef.value = isResizablePanelHandle(value) ? value : null;
};

const handleEditorCollapse = (): void => {
  isEditorCollapsed.value = true;
};

const handleEditorExpand = (): void => {
  isEditorCollapsed.value = false;
};

const handleOpenTerminal = async (): Promise<void> => {
  isEditorCollapsed.value = false;
  await openTerminal();
};

const handleHideTerminal = (): void => {
  isEditorCollapsed.value = false;
  hideTerminal();
};

// 终端全屏切换：折叠/展开编辑器面板（reka-ui 原生），状态由事件回写 isEditorCollapsed。
const toggleTerminalFullscreen = (): void => {
  const panel = editorPanelRef.value;
  if (!panel) {
    return;
  }

  if (isEditorCollapsed.value) {
    panel.expand();
  } else {
    panel.collapse();
  }
};

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

<style scoped>
/* 主界面内容卡片：右/下边缘贴合窗口（Codex 风格布局）。
   基础规则在 src/styles.css 的 .workbench-content-card；此处只针对主工作台界面局部覆盖：
   去掉右、下边框，并仅保留左上 + 左下两个圆角（右上/右下为直角），使左侧上下都圆、右与下贴合窗口。 */
.workbench-content-card {
  border-right: 0;
  border-bottom: 0;
  border-radius: var(--workbench-content-left-radius) 0 0 var(--workbench-content-left-radius);
}
</style>
