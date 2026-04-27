<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AiChatThread from '@/components/business/ai/AiChatThread.vue';
import AiContextChips from '@/components/business/ai/AiContextChips.vue';
import AiPatchPreview from '@/components/business/ai/AiPatchPreview.vue';
import AiPromptInput from '@/components/business/ai/AiPromptInput.vue';
import AiProviderSettings from '@/components/business/ai/AiProviderSettings.vue';
import AiTaskPlan from '@/components/business/ai/AiTaskPlan.vue';
import { useAiAssistant } from '@/composables/useAiAssistant';
import { findAiProviderPreset } from '@/constants/ai-providers';
import type { IAiChatMessage, IAiConfigPayload } from '@/types/ai';
import type { IAiCodePathTarget } from '@/types/ai-code';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';

const props = defineProps<{
  document: IEditorDocument;
  activeRun: IActiveRunSummary | null;
  analysis: IAnalyzeScriptPayload;
  selection: IEditorSelectionSummary | null;
  gitStatus: IGitRepositoryStatusPayload;
  workspaceRootPath: string | null;
}>();

const emit = defineEmits<{
  openCodePath: [target: IAiCodePathTarget];
}>();

const documentRef = computed(() => props.document);
const activeRunRef = computed(() => props.activeRun);
const analysisRef = computed(() => props.analysis);
const selectionRef = computed(() => props.selection);
const gitStatusRef = computed(() => props.gitStatus);
const workspaceRootPathRef = computed(() => props.workspaceRootPath);
const assistant = useAiAssistant({
  document: documentRef,
  activeRun: activeRunRef,
  analysis: analysisRef,
  selection: selectionRef,
  gitStatus: gitStatusRef,
  workspaceRootPath: workspaceRootPathRef,
});
const settingsDraft = ref<IAiConfigPayload>({ ...assistant.config.value });
const settingsApiKey = ref('');
const isModeMenuOpen = ref(false);
const isHistoryOpen = ref(false);
const currentProviderPreset = computed(() =>
  findAiProviderPreset(assistant.config.value.providerType),
);
const aiAvatarUrl = computed(() =>
  assistant.config.value.isConfigured ? currentProviderPreset.value.iconUrl : null,
);
const aiAvatarAlt = computed(() => currentProviderPreset.value.label);
const recentMessages = computed(() => assistant.messages.value.slice(-8).reverse());

const openSettings = (): void => {
  settingsDraft.value = { ...assistant.config.value };
  assistant.isSettingsOpen.value = true;
};

const selectMode = (mode: 'chat' | 'agent'): void => {
  assistant.activeMode.value = mode;
  isModeMenuOpen.value = false;
};

const getMessageRoleLabel = (message: IAiChatMessage): string => {
  if (message.role === 'user') return '用户';
  if (message.role === 'tool') return '工具';
  if (message.role === 'system') return '系统';
  return 'AI';
};

const getMessageTimeLabel = (message: IAiChatMessage): string => {
  const timestamp = Date.parse(message.createdAt);
  if (!Number.isFinite(timestamp)) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
};

const getMessagePreview = (message: IAiChatMessage): string => {
  const normalized = message.content.replace(/\s+/g, ' ').trim();
  return normalized || '空消息';
};

const saveSettings = async (config: IAiConfigPayload): Promise<void> => {
  await assistant.saveConfig(config);
  if (settingsApiKey.value.trim()) {
    await assistant.saveCredentials(settingsApiKey.value, config.providerType);
    settingsApiKey.value = '';
  }
  settingsDraft.value = { ...assistant.config.value };
};

const saveCredentials = async (apiKey: string): Promise<void> => {
  await assistant.saveCredentials(apiKey, settingsDraft.value.providerType);
  settingsApiKey.value = '';
  settingsDraft.value = { ...assistant.config.value };
};

const testProvider = async (): Promise<string> => {
  await assistant.saveConfig(settingsDraft.value);
  if (settingsApiKey.value.trim()) {
    await assistant.saveCredentials(settingsApiKey.value, settingsDraft.value.providerType);
    settingsApiKey.value = '';
  }
  settingsDraft.value = { ...assistant.config.value };
  return assistant.testProvider();
};

onMounted(() => {
  assistant.loadConfig().then(() => {
    settingsDraft.value = { ...assistant.config.value };
  }).catch(() => undefined);
  assistant.loadTools().catch(() => undefined);
});
</script>

<template>
  <section class="ai-assistant-panel" aria-label="AI 助手面板">
    <header class="ai-panel-header">
      <img
        v-if="aiAvatarUrl"
        class="ai-provider-avatar"
        :src="aiAvatarUrl"
        :alt="aiAvatarAlt"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
      <span v-else class="ai-status-dot" aria-hidden="true"></span>
      <div class="ai-model-switch">
        <button
          type="button"
          class="ai-model-button"
          :aria-expanded="isModeMenuOpen"
          aria-haspopup="menu"
          aria-label="切换 AI 模式"
          @click="isModeMenuOpen = !isModeMenuOpen"
        >
          <span>{{ assistant.config.value.selectedModel ?? 'AI Assistant' }}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="isModeMenuOpen" class="ai-mode-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            :aria-checked="assistant.activeMode.value === 'chat'"
            :class="{ active: assistant.activeMode.value === 'chat' }"
            @click="selectMode('chat')"
          >
            Chat
          </button>
          <button
            type="button"
            role="menuitemradio"
            :aria-checked="assistant.activeMode.value === 'agent'"
            :class="{ active: assistant.activeMode.value === 'agent' }"
            @click="selectMode('agent')"
          >
            Agent
          </button>
        </div>
      </div>
      <button type="button" class="ai-icon-button" aria-label="AI 设置" @click="openSettings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M20 7h-7" />
          <path d="M14 17H4" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </svg>
      </button>
      <div class="ai-history-anchor">
        <button
          type="button"
          class="ai-icon-button"
          aria-label="对话记录"
          aria-haspopup="dialog"
          :aria-expanded="isHistoryOpen"
          @click="isHistoryOpen = !isHistoryOpen"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M3 3v5h5" />
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
            <path d="M12 7v5l4 2" />
          </svg>
        </button>
        <section v-if="isHistoryOpen" class="ai-history-popover" role="dialog" aria-label="最近对话">
          <header class="ai-history-header">最近对话</header>
          <div v-if="recentMessages.length" class="ai-history-list">
            <article
              v-for="message in recentMessages"
              :key="message.id"
              class="ai-history-item"
            >
              <div class="ai-history-meta">
                <span>{{ getMessageRoleLabel(message) }}</span>
                <time>{{ getMessageTimeLabel(message) }}</time>
              </div>
              <p>{{ getMessagePreview(message) }}</p>
            </article>
          </div>
          <div v-else class="ai-history-empty">暂无对话记录</div>
          <footer v-if="assistant.messages.value.length" class="ai-history-footer">
            <button
              type="button"
              @click="assistant.isClearDialogOpen.value = true; isHistoryOpen = false"
            >
              清空当前对话
            </button>
          </footer>
        </section>
      </div>
    </header>

    <AiContextChips :references="assistant.currentReferences.value" />
    <AiTaskPlan :steps="assistant.agentSteps.value" />
    <AiChatThread
      :messages="assistant.messages.value"
      :is-typing="assistant.isSending.value"
      :avatar-url="aiAvatarUrl"
      :avatar-alt="aiAvatarAlt"
      @apply-code="assistant.previewPatchFromCodeBlock"
      @open-code-path="emit('openCodePath', $event)"
    />
    <div v-if="assistant.canPreviewPatch.value" class="ai-patch-entry">
      <button type="button" class="ai-quick-action" @click="assistant.previewPatchFromLastAnswer">
        预览为 Patch
      </button>
    </div>
    <AiPatchPreview
      :patch="assistant.proposedPatch.value"
      :is-applying="assistant.isApplyingPatch.value"
      @apply="assistant.applyProposedPatch"
      @close="assistant.proposedPatch.value = null"
    />
    <AiPromptInput
      v-model="assistant.draft.value"
      :disabled="assistant.isSending.value"
      :error-message="assistant.errorMessage.value"
      :submit-label="assistant.activeMode.value === 'agent' ? '规划任务' : assistant.sendButtonLabel.value"
      :attachments="assistant.attachedFiles.value"
      :has-attachments="assistant.attachedFiles.value.length > 0"
      @submit="assistant.sendMessage"
      @stop="assistant.stopCurrentRequest"
      @file-selected="assistant.attachFile"
      @remove-file="assistant.removeAttachedFile"
    />

    <AiProviderSettings
      v-model:draft="settingsDraft"
      v-model:api-key="settingsApiKey"
      :open="assistant.isSettingsOpen.value"
      :config="assistant.config.value"
      @close="assistant.isSettingsOpen.value = false"
      @save="saveSettings"
      @save-credentials="saveCredentials"
      @test-provider="testProvider"
    />

    <Teleport to="body">
      <div v-if="assistant.isClearDialogOpen.value" class="ai-dialog-backdrop" @click.self="assistant.isClearDialogOpen.value = false">
        <section class="ai-dialog is-compact" role="alertdialog" aria-modal="true">
          <div class="ai-dialog-copy">
            <h3>清空当前对话？</h3>
            <p>这只会清空面板里的临时对话记录，不会删除任何文件。</p>
          </div>
          <div class="ai-dialog-actions">
            <button type="button" class="ai-button is-ghost" @click="assistant.isClearDialogOpen.value = false">取消</button>
            <button type="button" class="ai-button is-danger" @click="assistant.clearConversation">清空</button>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.ai-assistant-panel {
  display: flex;
  width: 350px;
  min-width: 350px;
  max-width: 350px;
  height: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--sidebar-bg);
  color: var(--text-primary);
}

.ai-panel-header {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  height: 40px;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--shell-divider);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.ai-status-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent);
}

.ai-provider-avatar {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  border-radius: 5px;
  object-fit: contain;
}

.ai-model-switch {
  position: relative;
  min-width: 0;
  flex: 1;
}

.ai-model-button {
  display: inline-flex;
  max-width: 100%;
  height: 26px;
  min-width: 0;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  padding: 0 5px 0 0;
}

.ai-model-button:hover {
  color: var(--text-primary);
}

.ai-model-button span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-model-button svg {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  color: var(--text-quaternary);
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-mode-menu {
  position: absolute;
  top: 31px;
  left: 0;
  z-index: 5;
  display: grid;
  width: 104px;
  gap: 2px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  padding: 5px;
}

.ai-mode-menu button {
  height: 26px;
  border-radius: 5px;
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: left;
  padding: 0 8px;
}

.ai-mode-menu button:hover,
.ai-mode-menu button.active {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-icon-button {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 6px;
  color: var(--text-tertiary);
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-icon-button:hover {
  color: var(--text-primary);
}

.ai-icon-button:active {
  transform: scale(0.97);
}

.ai-icon-button svg {
  width: 15px;
  height: 15px;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-history-anchor {
  position: relative;
  display: grid;
  place-items: center;
}

.ai-history-popover {
  position: absolute;
  top: 32px;
  right: 0;
  z-index: 10;
  display: grid;
  width: 260px;
  max-height: 320px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
}

.ai-history-header {
  height: 34px;
  border-bottom: 1px solid var(--shell-divider);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  line-height: 33px;
  padding: 0 10px;
}

.ai-history-list {
  display: grid;
  max-height: 234px;
  overflow-y: auto;
  padding: 5px;
}

.ai-history-item {
  display: grid;
  gap: 3px;
  min-width: 0;
  border-radius: 7px;
  padding: 7px 8px;
}

.ai-history-item:hover {
  background: var(--surface-soft);
}

.ai-history-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 14px;
}

.ai-history-item p {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
  -webkit-line-clamp: 2;
}

.ai-history-empty {
  color: var(--text-quaternary);
  font-size: 12px;
  line-height: 18px;
  padding: 16px 10px;
  text-align: center;
}

.ai-history-footer {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--shell-divider);
  padding: 6px;
}

.ai-history-footer button {
  height: 24px;
  border-radius: 6px;
  color: var(--text-tertiary);
  font-size: 12px;
  padding: 0 7px;
}

.ai-history-footer button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-patch-entry {
  padding: 8px 12px 0;
}

.ai-quick-action,
.ai-button {
  height: 28px;
  border-radius: 6px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
}

.ai-quick-action {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  background: color-mix(in srgb, var(--surface-soft) 80%, transparent);
  color: var(--text-secondary);
}

.ai-quick-action:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.28);
}

.ai-dialog {
  display: grid;
  width: min(340px, calc(100vw - 32px));
  gap: 12px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  padding: 16px;
}

.ai-dialog-copy h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}

.ai-dialog-copy p {
  margin: 4px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.55;
}

.ai-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.ai-button.is-ghost {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  background: transparent;
  color: var(--text-tertiary);
}

.ai-button.is-danger {
  border: 0;
  background: var(--danger);
  color: #fff;
}
</style>
