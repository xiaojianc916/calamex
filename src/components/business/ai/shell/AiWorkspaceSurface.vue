<script setup lang="ts">
import { PanelRight, RotateCw } from '@lucide/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import AiAssistantPanel from '@/components/business/ai/shell/AiAssistantPanel.vue';
import AiWebPreviewSidebar from '@/components/business/ai/shell/AiWebPreviewSidebar.vue';
import { Card, CardContent } from '@/components/ui/card';
import { useMessage } from '@/composables/useMessage';
import { aiService } from '@/services/ipc/ai.service';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitRepositoryStatusPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error';

const DEFAULT_RIGHT_SIDEBAR_WIDTH = 480;
const RIGHT_SIDEBAR_MIN_WIDTH = 360;
const RIGHT_SIDEBAR_MAX_WIDTH = 720;

defineProps<{
  document: IEditorDocument;
  activeRun: IActiveRunSummary | null;
  analysis: IAnalyzeScriptPayload;
  selection: IEditorSelectionSummary | null;
  gitStatus: IGitRepositoryStatusPayload;
  workspaceRootPath: string | null;
}>();

const emit = defineEmits<{
  'open-patch-diff': [payload: IGitDiffPreviewPayload];
}>();

const isRightSidebarVisible = ref(false);
const rightSidebarWidth = ref(DEFAULT_RIGHT_SIDEBAR_WIDTH);
const isResizingSidebar = ref(false);
const isRestartingSidecar = ref(false);
const message = useMessage();
let removeSidebarResizeListeners: (() => void) | null = null;

const getViewportWidth = (): number => {
  if (typeof window === 'undefined') {
    return RIGHT_SIDEBAR_MAX_WIDTH;
  }

  return window.innerWidth || document.documentElement.clientWidth || RIGHT_SIDEBAR_MAX_WIDTH;
};

const clampRightSidebarWidth = (nextWidth: number): number => {
  const viewportWidth = getViewportWidth();
  const viewportLimitedMaxWidth = Math.round(viewportWidth * 0.8);
  const maxWidth = Math.max(
    RIGHT_SIDEBAR_MIN_WIDTH,
    Math.min(RIGHT_SIDEBAR_MAX_WIDTH, viewportLimitedMaxWidth),
  );

  return Math.min(maxWidth, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, Math.round(nextWidth)));
};

const rightSidebarStyle = computed(() => ({
  width: isRightSidebarVisible.value ? `${rightSidebarWidth.value}px` : '0px',
}));

const applySidebarResizeInteractionState = (active: boolean): void => {
  if (typeof document === 'undefined') {
    return;
  }

  if (active) {
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return;
  }

  document.body.style.removeProperty('cursor');
  document.body.style.removeProperty('user-select');
};

const clearSidebarResizeListeners = (): void => {
  removeSidebarResizeListeners?.();
  removeSidebarResizeListeners = null;
};

const stopRightSidebarResize = (): void => {
  isResizingSidebar.value = false;
  applySidebarResizeInteractionState(false);
  clearSidebarResizeListeners();
};

const updateRightSidebarWidthFromCursor = (clientX: number): void => {
  rightSidebarWidth.value = clampRightSidebarWidth(getViewportWidth() - clientX);
};

const toggleRightSidebar = (): void => {
  isRightSidebarVisible.value = !isRightSidebarVisible.value;

  if (isRightSidebarVisible.value) {
    rightSidebarWidth.value = clampRightSidebarWidth(rightSidebarWidth.value);
    return;
  }

  stopRightSidebarResize();
};

const handleRestartSidecar = async (): Promise<void> => {
  if (isRestartingSidecar.value) {
    return;
  }

  isRestartingSidecar.value = true;

  try {
    const health = await aiService.sidecarRestart();
    message.success('Agent sidecar 已重启', {
      description: `当前状态：${health.status}`,
    });
  } catch (error) {
    message.error(toErrorMessage(error, '重启 Agent sidecar 失败'));
  } finally {
    isRestartingSidecar.value = false;
  }
};

const startRightSidebarResize = (event: MouseEvent): void => {
  if (!isRightSidebarVisible.value || event.button !== 0 || typeof window === 'undefined') {
    return;
  }

  event.preventDefault();
  stopRightSidebarResize();
  isResizingSidebar.value = true;
  applySidebarResizeInteractionState(true);
  updateRightSidebarWidthFromCursor(event.clientX);

  const handleMouseMove = (moveEvent: MouseEvent): void => {
    updateRightSidebarWidthFromCursor(moveEvent.clientX);
  };

  const handleMouseUp = (): void => {
    stopRightSidebarResize();
  };

  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', handleMouseUp, { once: true });
  window.addEventListener('blur', handleMouseUp, { once: true });

  removeSidebarResizeListeners = () => {
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
    window.removeEventListener('blur', handleMouseUp);
  };
};

onBeforeUnmount(() => {
  stopRightSidebarResize();
});
</script>

<template>
  <Card
    class="ai-assistant-card flex h-full min-h-0 w-full flex-1 gap-0 rounded-none border-0 bg-transparent py-0 shadow-none"
  >
    <CardContent class="ai-workspace-shell flex min-h-0 flex-1 px-0 pb-0 pt-0">
      <div class="ai-workspace-main flex min-h-0 flex-1">
        <section class="ai-workspace-primary min-w-0 flex-1">
          <AiAssistantPanel
            class="flex-1"
            :document="document"
            :active-run="activeRun"
            :analysis="analysis"
            :selection="selection"
            :git-status="gitStatus"
            :workspace-root-path="workspaceRootPath"
            @open-patch-diff="emit('open-patch-diff', $event)"
          >
            <template #header-actions-after>
              <button
                v-if="!isRightSidebarVisible"
                type="button"
                class="ai-icon-button ai-right-sidebar-toggle-btn"
                :aria-label="isRightSidebarVisible ? '收起右侧面板' : '展开右侧面板'"
                :aria-expanded="isRightSidebarVisible"
                @click="toggleRightSidebar"
              >
                <PanelRight aria-hidden="true" />
              </button>
              <button
                type="button"
                class="ai-icon-button ai-right-sidebar-toggle-btn ai-sidecar-restart-btn"
                title="重启 Agent sidecar"
                aria-label="重启 Agent sidecar"
                :disabled="isRestartingSidecar"
                @click="void handleRestartSidecar()"
              >
                <RotateCw
                  :class="{ 'ai-sidecar-restart-btn__icon--spinning': isRestartingSidecar }"
                  aria-hidden="true"
                />
              </button>
            </template>
          </AiAssistantPanel>
        </section>

        <aside
          class="ai-workspace-right-sidebar shrink-0 overflow-hidden border-l bg-white"
          :class="{ 'ai-workspace-right-sidebar--resizing': isResizingSidebar }"
          :style="rightSidebarStyle"
        >
          <div
            v-if="isRightSidebarVisible"
            class="ai-workspace-right-sidebar__resize-handle"
            data-testid="ai-right-sidebar-resize-handle"
            @mousedown="startRightSidebarResize"
          />
          <div v-if="isRightSidebarVisible" class="ai-workspace-right-sidebar__inner">
            <AiWebPreviewSidebar class="min-h-0 flex-1" @close-sidebar="toggleRightSidebar" />
          </div>
        </aside>
      </div>
    </CardContent>
  </Card>
</template>

<style scoped>
.ai-assistant-card {
  box-shadow: none;
}

.ai-workspace-shell {
  position: relative;
}

.ai-workspace-main {
  min-width: 0;
}

.ai-workspace-primary {
  display: flex;
  min-width: 0;
  min-height: 0;
}

.ai-workspace-right-sidebar {
  position: relative;
  min-width: 0;
  border-left-color: var(--border-subtle);
  transition: width 160ms ease;
}

.ai-workspace-right-sidebar--resizing {
  transition: none;
}

.ai-workspace-right-sidebar__resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -6px;
  z-index: 3;
  width: 14px;
  cursor: col-resize;
}

.ai-workspace-right-sidebar__resize-handle::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: var(--border-subtle);
  transform: translateX(-50%);
  transition: background-color 120ms ease, width 120ms ease;
}

.ai-workspace-right-sidebar__resize-handle:hover::before,
.ai-workspace-right-sidebar--resizing .ai-workspace-right-sidebar__resize-handle::before {
  width: 3px;
  background: color-mix(in srgb, var(--accent-strong) 70%, var(--border-subtle));
}

.ai-workspace-right-sidebar--resizing :deep(iframe) {
  pointer-events: none;
}

.ai-workspace-right-sidebar__inner {
  display: flex;
  position: relative;
  flex-direction: column;
  width: 100%;
  height: 100%;
  align-items: stretch;
  justify-content: flex-start;
  padding: 0;
  background: #ffffff;
}

.ai-right-sidebar-toggle-btn {
  display: inline-flex;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
}

.ai-right-sidebar-toggle-btn:hover {
  color: var(--text-primary);
}

.ai-right-sidebar-toggle-btn:disabled {
  cursor: wait;
  color: var(--text-tertiary);
  opacity: 0.65;
}

.ai-right-sidebar-toggle-btn svg {
  width: 15px;
  height: 15px;
  stroke-width: 1.75;
}

.ai-sidecar-restart-btn__icon--spinning {
  animation: ai-sidecar-restart-spin 0.8s linear infinite;
}

@keyframes ai-sidecar-restart-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

:global(html.is-resizing) .ai-workspace-right-sidebar,
:global(html.is-resizing) .ai-right-sidebar-toggle-btn {
  animation: none !important;
  transition: none !important;
}

:global(html.is-resizing) .ai-right-sidebar-toggle-btn {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
}

:deep(.ai-assistant-panel) {
  height: 100%;
  background: #ffffff;
}

:deep(.ai-composer-shell) {
  background: #ffffff;
}
</style>
