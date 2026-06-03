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
                <div v-if="isTerminalSplitVisible" ref="terminalSplitRef"
                  class="flex h-full min-h-0 w-full flex-col">
                  <div class="min-h-0 flex-1">
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
                  </div>

                  <div class="terminal-resize-handle" :class="{
                    'is-dragging': isTerminalDragging,
                    'is-snap-maximize': terminalDragIntent === 'maximize',
                    'is-snap-close': terminalDragIntent === 'close',
                  }" role="separator" aria-orientation="horizontal" @pointerdown="startTerminalDrag">
                    <span v-if="isTerminalDragging && terminalDragIntent !== 'resize'" class="terminal-resize-hint">
                       terminalDragIntent === 'maximize' ? '松开即可全屏' : '松开即可关闭终端' 
                    </span>
                  </div>

                  <div class="min-h-0 overflow-hidden" :style="{ height: terminalHeight + 'px' }">
                    <DeferredRunPanel theme="light" :terminal-settings="appStore.settings.terminal"
                      :visible="isTerminalPanelVisible" :is-maximized="false" @hide="hideTerminal"
                      @toggle-maximize="toggleTerminalMaximize"
                      @terminal-run-completed="handleIntegratedTerminalRunCompleted" />
                  </div>
                </div>

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
                      :key="editorStore.document.id"
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

// 保留 LSP 生命周期管理（启动 / 停止 bash-language-server），仅移除底部状态栏 UI。
useLsp(visibleWorkspaceRootPath);

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

// 终端面板：自定义指针拖拽调整高度（像素），替代 reka-ui 百分比分割器
const terminalSplitRef = ref<HTMLElement | null>(null);
const isTerminalDragging = ref(false);

// 拖拽手势意图：resize 普通调整 / maximize 即将全屏 / close 即将关闭
// 在“还差一点距离”时即触发，贴近常见软件的吸附式交互
type TTerminalDragIntent = 'resize' | 'maximize' | 'close';
const TERMINAL_SNAP_MAXIMIZE_OVERSHOOT = 64; // 向上越过最大高度再多拉这么多像素 → 全屏
const TERMINAL_SNAP_CLOSE_HEIGHT = 100; // 向下拉到意图高度低于此值 → 关闭终端
const terminalDragIntent = ref<TTerminalDragIntent>('resize');

const startTerminalDrag = (event: PointerEvent): void => {
  event.preventDefault();
  const startY = event.clientY;
  const startHeight = terminalHeight.value;
  isTerminalDragging.value = true;
  terminalDragIntent.value = 'resize';
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'row-resize';

  const handleMove = (moveEvent: PointerEvent): void => {
    const delta = startY - moveEvent.clientY;
    const rawHeight = startHeight + delta;
    const container = terminalSplitRef.value;
    const maxHeight = container ? Math.max(140, container.clientHeight - 220) : rawHeight;

    if (rawHeight >= maxHeight + TERMINAL_SNAP_MAXIMIZE_OVERSHOOT) {
      terminalDragIntent.value = 'maximize';
    } else if (rawHeight <= TERMINAL_SNAP_CLOSE_HEIGHT) {
      terminalDragIntent.value = 'close';
    } else {
      terminalDragIntent.value = 'resize';
    }

    handleTerminalHeightChange(Math.min(rawHeight, maxHeight));
  };

  const handleUp = (): void => {
    isTerminalDragging.value = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);

    const intent = terminalDragIntent.value;
    terminalDragIntent.value = 'resize';

    if (intent === 'maximize') {
      if (!isTerminalMaximized.value) {
        toggleTerminalMaximize();
      }
      return;
    }

    if (intent === 'close') {
      // 关闭前恢复拖拽起始高度，避免“记忆高度”被压缩成最小值
      handleTerminalHeightChange(startHeight);
      hideTerminal();
    }
  };

  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp);
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

/* 终端面板顶部：可拖拽分隔条 —— 常态 1px #ededed 细线，11px 不可见热区便于抓取，悬停/拖拽平滑变粗高亮 */
.terminal-resize-handle {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  height: 1px;
  background-color: #ededed;
  cursor: row-resize;
  touch-action: none;
  transition: background-color 160ms ease;
}

/* 加宽不可见抓取热区，方便鼠标对准 */
.terminal-resize-handle::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 11px;
  transform: translateY(-50%);
}

/* 悬停 / 拖拽：平滑浮现 3px 品牌强调色高亮 */
.terminal-resize-handle::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 3px;
  transform: translateY(-50%);
  background-color: var(--accent-strong);
  border-radius: 999px;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 160ms ease,
    height 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.terminal-resize-handle:hover::after,
.terminal-resize-handle.is-dragging::after {
  opacity: 1;
}

/* 拖拽到全屏阈值：高亮条变为强调绿并加粗，提示“即将全屏” */
.terminal-resize-handle.is-snap-maximize::after {
  opacity: 1;
  height: 5px;
  background-color: #16a34a;
}

/* 拖拽到关闭阈值：高亮条变为警示红并加粗，提示“即将关闭” */
.terminal-resize-handle.is-snap-close::after {
  opacity: 1;
  height: 5px;
  background-color: #ef4444;
}

/* 拖拽手势提示气泡：悬浮在分隔条上方居中 */
.terminal-resize-hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, calc(-100% - 8px));
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  color: #ffffff;
  background-color: rgba(31, 35, 40, 0.92);
  pointer-events: none;
  z-index: 2;
}

.terminal-resize-handle.is-snap-maximize .terminal-resize-hint {
  background-color: #16a34a;
}

.terminal-resize-handle.is-snap-close .terminal-resize-hint {
  background-color: #ef4444;
}

@media (prefers-reduced-motion: reduce) {
  .terminal-resize-handle,
  .terminal-resize-handle::after {
    transition: none;
  }
}
</style>
