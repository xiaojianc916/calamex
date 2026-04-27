<script setup lang="ts">
import { computed, watch } from 'vue';
import { AI_PROVIDER_PRESETS, findAiProviderPreset } from '@/constants/ai-providers';
import type { IAiConfigPayload } from '@/types/ai';

const props = defineProps<{
  open: boolean;
  config: IAiConfigPayload;
}>();

const emit = defineEmits<{
  close: [];
  save: [config: IAiConfigPayload];
  saveCredentials: [apiKey: string];
  testProvider: [];
}>();

const nextConfig = defineModel<IAiConfigPayload>('draft', { required: true });
const apiKey = defineModel<string>('apiKey', { required: true });

const activePreset = computed(() => findAiProviderPreset(nextConfig.value.providerType));
const providerStatusLabel = computed(() => {
  if (!activePreset.value.isAvailable) return '规划中';
  if (nextConfig.value.providerType === 'mock') return '本地可用';
  return props.config.hasCredentials ? 'Key 已保存' : '未保存 Key';
});
const canSaveCurrentProvider = computed(() => activePreset.value.isAvailable);

watch(
  () => nextConfig.value.providerType,
  (providerType) => {
    const preset = findAiProviderPreset(providerType);
    nextConfig.value.baseUrl = preset.baseUrl;
    nextConfig.value.selectedModel = preset.defaultModel;
    if (!preset.isAvailable) {
      nextConfig.value.chatEnabled = false;
      nextConfig.value.inlineCompletionEnabled = false;
      nextConfig.value.agentEnabled = false;
    }
  },
);

const save = (): void => {
  if (!canSaveCurrentProvider.value) return;
  emit('save', nextConfig.value);
};
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="ai-dialog-backdrop" @click.self="emit('close')">
      <form class="ai-dialog" @submit.prevent="save">
        <div class="ai-dialog-copy">
          <h3>AI 服务配置</h3>
          <p>选择厂商后自动填入兼容端点。API Key 只发送到 Rust 凭证存储，不进入前端 store。</p>
        </div>

        <div class="ai-provider-grid" aria-label="AI Provider">
          <button
            v-for="preset in AI_PROVIDER_PRESETS"
            :key="preset.id"
            type="button"
            class="ai-provider-card"
            :class="{
              active: nextConfig.providerType === preset.id,
              disabled: !preset.isAvailable,
            }"
            @click="nextConfig.providerType = preset.id"
          >
            <span class="ai-provider-name">{{ preset.label }}</span>
            <span class="ai-provider-desc">{{ preset.description }}</span>
          </button>
        </div>

        <div class="ai-provider-summary">
          <span>{{ activePreset.label }}</span>
          <strong>{{ providerStatusLabel }}</strong>
        </div>

        <label v-if="nextConfig.providerType !== 'mock'" class="ai-field">
          <span>API 地址</span>
          <input
            v-model="nextConfig.baseUrl"
            :readonly="!activePreset.isEndpointEditable"
            :placeholder="activePreset.baseUrl ?? 'https://api.example.com/v1'"
            autocomplete="off"
          />
        </label>

        <label class="ai-field">
          <span>模型</span>
          <input v-model="nextConfig.selectedModel" :placeholder="activePreset.defaultModel" autocomplete="off" />
        </label>

        <label v-if="nextConfig.providerType !== 'mock' && activePreset.isAvailable" class="ai-field">
          <span>API Key</span>
          <input v-model="apiKey" type="password" autocomplete="off" :placeholder="activePreset.apiKeyHint" />
        </label>

        <label class="ai-field is-check">
          <span>Chat</span>
          <input v-model="nextConfig.chatEnabled" type="checkbox" :disabled="!activePreset.isAvailable" />
        </label>
        <label class="ai-field is-check">
          <span>Inline Completion</span>
          <input
            v-model="nextConfig.inlineCompletionEnabled"
            type="checkbox"
            :disabled="!activePreset.isAvailable"
          />
        </label>
        <label class="ai-field is-check">
          <span>Agent</span>
          <input v-model="nextConfig.agentEnabled" type="checkbox" :disabled="!activePreset.isAvailable" />
        </label>

        <div class="ai-dialog-actions">
          <button type="button" class="ai-button is-ghost" @click="emit('close')">取消</button>
          <button
            v-if="nextConfig.providerType !== 'mock' && activePreset.isAvailable"
            type="button"
            class="ai-button is-ghost"
            @click="emit('testProvider')"
          >
            测试
          </button>
          <button
            v-if="nextConfig.providerType !== 'mock' && activePreset.isAvailable"
            type="button"
            class="ai-button is-ghost"
            :disabled="!apiKey.trim()"
            @click="emit('saveCredentials', apiKey)"
          >
            保存 Key
          </button>
          <button type="submit" class="ai-button is-primary" :disabled="!canSaveCurrentProvider">保存</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
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
  width: min(520px, calc(100vw - 32px));
  gap: 12px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  box-shadow:
    0 14px 36px rgba(0, 0, 0, 0.46),
    inset 0 1px 0 color-mix(in srgb, var(--text-primary) 5%, transparent);
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

.ai-provider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  max-height: 256px;
  overflow-y: auto;
  padding-right: 2px;
}

.ai-provider-card {
  display: grid;
  min-height: 62px;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-soft) 54%, transparent);
  padding: 9px;
  text-align: left;
}

.ai-provider-card:hover:not(.disabled),
.ai-provider-card.active {
  border-color: color-mix(in srgb, var(--accent-strong) 45%, transparent);
  background: color-mix(in srgb, var(--accent-strong) 12%, var(--surface-soft));
}

.ai-provider-card.disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.ai-provider-name {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}

.ai-provider-desc {
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 1.35;
}

.ai-provider-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 70%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface-soft) 48%, transparent);
  color: var(--text-tertiary);
  font-size: 11px;
  padding: 7px 9px;
}

.ai-provider-summary strong {
  color: var(--text-primary);
  font-weight: 500;
}

.ai-field {
  display: grid;
  gap: 6px;
}

.ai-field.is-check {
  grid-template-columns: 1fr auto;
  align-items: center;
}

.ai-field span {
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 500;
}

.ai-field input {
  width: 100%;
  height: 30px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface-soft) 80%, transparent);
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  outline: none;
  padding: 0 9px;
}

.ai-field input[readonly] {
  color: var(--text-tertiary);
}

.ai-field.is-check input {
  width: 14px;
  height: 14px;
  padding: 0;
}

.ai-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.ai-button {
  height: 28px;
  border-radius: 6px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
}

.ai-button.is-ghost {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  background: transparent;
  color: var(--text-tertiary);
}

.ai-button.is-primary {
  border: 0;
  background: var(--accent-strong);
  color: #fff;
}

.ai-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
</style>
