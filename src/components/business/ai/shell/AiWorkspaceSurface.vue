<script setup lang="ts">
import { ref } from 'vue';
import AiAssistantPanel from '@/components/business/ai/shell/AiAssistantPanel.vue';
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
const isRestartingSidecar = ref(false);
const message = useMessage();

const toggleRightSidebar = (): void => {
  isRightSidebarVisible.value = !isRightSidebarVisible.value;
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
</script>

<template>
  <Card
    data-shell-resize-responder
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
                data-shell-resize-fixed-layer
                class="ai-icon-button ai-right-sidebar-toggle-btn"
                :aria-label="isRightSidebarVisible ? '收起右侧面板' : '展开右侧面板'"
                :aria-expanded="isRightSidebarVisible"
                @click="toggleRightSidebar"
              >
                <span aria-hidden="true" class="icon-[lucide--panel-right]" />
              </button>
              <button
                type="button"
                data-shell-resize-fixed-layer
                class="ai-icon-button ai-right-sidebar-toggle-btn ai-sidecar-restart-btn"
                title="重启 Agent sidecar"
                aria-label="重启 Agent sidecar"
                :disabled="isRestartingSidecar"
                @click="void handleRestartSidecar()"
              >
                <span
                  :class="{ 'ai-sidecar-restart-btn__icon--spinning': isRestartingSidecar }"
                  aria-hidden="true"
                  class="icon-[lucide--rotate-cw]"
                />
              </button>
            </template>
          </AiAssistantPanel>
        </section>

        <aside
          class="ai-workspace-right-sidebar shrink-0 overflow-hidden border-l transition-[width] duration-300 ease-out"
          :class="isRightSidebarVisible ? 'w-[320px]' : 'w-0'"
        >
          <div v-if="isRightSidebarVisible" class="ai-workspace-right-sidebar__inner">
            <div class="ai-workspace-right-sidebar__header" data-shell-resize-fixed-layer>
              <button
                type="button"
                data-shell-resize-fixed-layer
                class="ai-icon-button ai-right-sidebar-toggle-btn"
                aria-label="收起右侧面板"
                aria-expanded="true"
                @click="toggleRightSidebar"
              >
                <span aria-hidden="true" class="icon-[lucide--panel-right]" />
              </button>
              <button
                type="button"
                data-shell-resize-fixed-layer
                class="ai-icon-button ai-right-sidebar-toggle-btn ai-sidecar-restart-btn"
                title="重启 Agent sidecar"
                aria-label="重启 Agent sidecar"
                :disabled="isRestartingSidecar"
                @click="void handleRestartSidecar()"
              >
                <span
                  :class="{ 'ai-sidecar-restart-btn__icon--spinning': isRestartingSidecar }"
                  aria-hidden="true"
                  class="icon-[lucide--rotate-cw]"
                />
              </button>
            </div>
            <p class="ai-workspace-right-sidebar__empty">这里还没有内容</p>
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
  min-width: 0;
  border-left-color: var(--border-subtle);
}

.ai-workspace-right-sidebar__inner {
  display: flex;
  position: relative;
  flex-direction: column;
  width: 320px;
  height: 100%;
  align-items: stretch;
  justify-content: flex-start;
  padding: 0;
}

.ai-workspace-right-sidebar__header {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding: 12px 18px 10px;
  contain: layout paint;
  transform: translateZ(0);
  backface-visibility: hidden;
}

.ai-workspace-right-sidebar__empty {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 20px;
  margin: 0;
  padding: 24px;
  text-align: center;
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
  contain: layout paint;
  transform: translateZ(0);
  backface-visibility: hidden;
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
:global(html.is-resizing) .ai-workspace-right-sidebar__header,
:global(html.is-resizing) .ai-right-sidebar-toggle-btn,
:global(html.is-resizing) [data-shell-resize-fixed-layer] {
  animation: none !important;
  transition: none !important;
}

:global(html.is-resizing) .ai-workspace-right-sidebar__header,
:global(html.is-resizing) .ai-right-sidebar-toggle-btn,
:global(html.is-resizing) [data-shell-resize-fixed-layer] {
  contain: layout paint;
  transform: translateZ(0);
  backface-visibility: hidden;
  will-change: transform;
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
