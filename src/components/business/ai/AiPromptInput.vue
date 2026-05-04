<script setup lang="ts">
import AppDropdownMenu from '@/components/common/AppDropdownMenu.vue';
import { computed } from 'vue';

type TAiPromptInputMode = 'chat' | 'agent' | 'plan';
type TAiPromptMenuIcon = 'message' | 'sparkles' | 'list';
type IAiPromptMenuItem = {
  key: TAiPromptInputMode;
  label: string;
  icon: TAiPromptMenuIcon;
  selected: boolean;
};

const modelValue = defineModel<string>({ required: true });

const props = defineProps<{
  disabled: boolean;
  errorMessage: string;
  submitLabel: string;
  activeMode: TAiPromptInputMode;
  providerLabel: string;
  attachments: readonly {
    id: string;
    name: string;
    sizeLabel: string;
    kind: 'text' | 'image';
    detailLabel?: string;
  }[];
  hasAttachments: boolean;
}>();

const emit = defineEmits<{
  submit: [];
  stop: [];
  fileSelected: [file: File];
  removeFile: [id: string];
  selectMode: [mode: TAiPromptInputMode];
}>();

const modeLabel = computed(() => {
  switch (props.activeMode) {
    case 'chat':
      return 'Chat';
    case 'plan':
      return 'Plan';
    default:
      return 'Agent';
  }
});

const modeMenuItems = computed<IAiPromptMenuItem[]>(() => [
  {
    key: 'chat',
    label: 'Chat',
    icon: 'message',
    selected: props.activeMode === 'chat',
  },
  {
    key: 'agent',
    label: 'Agent',
    icon: 'sparkles',
    selected: props.activeMode === 'agent',
  },
  {
    key: 'plan',
    label: 'Plan',
    icon: 'list',
    selected: props.activeMode === 'plan',
  },
]);

const handleKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if ((!modelValue.value.trim() && !props.hasAttachments) || props.disabled) return;
  emit('submit');
};

const handleFileChange = (event: Event): void => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files?.[0];
  target.value = '';
  if (!file) return;
  emit('fileSelected', file);
};

const handlePaste = (event: ClipboardEvent): void => {
  if (props.disabled) return;
  const imageFiles = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  if (imageFiles.length === 0) return;

  event.preventDefault();
  for (const file of imageFiles) {
    emit('fileSelected', file);
  }
};

const handleModeSelect = (key: string): void => {
  if (key === 'chat' || key === 'agent' || key === 'plan') {
    emit('selectMode', key);
  }
};
</script>

<template>
  <footer class="ai-composer">
    <p v-if="errorMessage" class="ai-error">{{ errorMessage }}</p>
    <div class="ai-composer-surface" :class="{ 'is-disabled': disabled, 'has-attachments': attachments.length > 0 }">
      <div v-if="attachments.length" class="ai-attachment-strip" aria-label="已添加附件">
        <span v-for="attachment in attachments" :key="attachment.id" class="ai-attachment-chip">
          <svg
v-if="attachment.kind === 'image'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="m21 15-4.5-4.5L7 20" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
          <span class="ai-attachment-name">{{ attachment.name }}</span>
          <span v-if="attachment.kind !== 'image' && attachment.detailLabel" class="ai-attachment-detail">{{
            attachment.detailLabel }}</span>
          <button type="button" aria-label="移除附件" title="移除附件" @click="emit('removeFile', attachment.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </span>
      </div>

      <div class="ai-textarea-shell">
        <textarea
ref="textareaRef" v-model="modelValue" rows="4" placeholder="输入消息…" aria-label="输入消息"
          :disabled="disabled" @keydown="handleKeydown" @paste="handlePaste" />
      </div>

      <div class="ai-toolbar-row">
        <div class="ai-toolbar-group">
          <label class="ai-attach-button" :class="{ disabled }" aria-label="添加附件" title="添加附件">
            <input class="ai-file-input" type="file" :disabled="disabled" @change="handleFileChange" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path
                d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </label>
        </div>

        <div class="ai-toolbar-group is-end">
          <AppDropdownMenu
:items="modeMenuItems" align="right" :min-width="136"
            content-class="ai-prompt-mode-menu-panel" @select="handleModeSelect">
            <template #trigger="{ open }">
              <button type="button" class="ai-mode-button" :aria-label="modeLabel" :title="providerLabel">
                <span class="ai-mode-button-copy">
                  <span class="ai-mode-button-mode">{{ modeLabel }}</span>
                </span>
                <svg
class="ai-mode-button-chevron" :class="{ 'is-open': open }" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </template>
          </AppDropdownMenu>

          <button
v-if="disabled" type="button" class="ai-send-button is-stop" aria-label="停止" title="停止"
            @click="emit('stop')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="1" />
            </svg>
          </button>
          <button
v-else type="button" class="ai-send-button" :aria-label="submitLabel" :title="submitLabel"
            :disabled="!modelValue.trim() && !hasAttachments" @click="emit('submit')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M21.5 2.5L11 13" />
              <path d="M21.5 2.5l-6.5 19-4-8.5-8.5-4 19-6.5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.ai-composer {
  flex: 0 0 auto;
  display: grid;
  align-self: stretch;
  gap: 6px;
  min-width: 0;
  width: auto;
  max-width: none;
  box-sizing: border-box;
  margin-inline: 16px;
  padding: 0 10px 10px;
}

.ai-error {
  margin: 0 4px;
  color: var(--danger);
  font-size: 12px;
  line-height: 18px;
}

.ai-composer-surface {
  display: grid;
  gap: 8px;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel-bg) 94%, var(--surface-soft));
  padding: 0 10px 8px;
  transition:
    background-color 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-composer-surface.has-attachments {
  padding-top: 8px;
}

.ai-composer-surface.is-disabled {
  opacity: 0.94;
}

.ai-attachment-strip {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-attachment-chip {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  height: 24px;
  align-items: center;
  gap: 5px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 6px;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 22px;
  padding: 0 5px 0 7px;
}

.ai-attachment-chip>svg {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-attachment-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-attachment-detail {
  flex: 0 0 auto;
  color: var(--text-quaternary);
}

.ai-attachment-chip button {
  display: grid;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 5px;
  color: var(--text-quaternary);
}

.ai-attachment-chip button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-attachment-chip button svg {
  width: 12px;
  height: 12px;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-textarea-shell {
  display: flex;
  min-width: 0;
  min-height: 44px;
}

.ai-textarea-shell textarea {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  min-height: 44px;
  max-height: 44px;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  letter-spacing: -0.01em;
  outline: 0;
  overflow-y: auto;
  padding: 6px 0 0;
  resize: none;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--shell-divider) 72%, transparent) transparent;
}

.ai-textarea-shell textarea::placeholder {
  color: var(--text-quaternary);
}

.ai-textarea-shell textarea::-webkit-scrollbar {
  width: 8px;
}

.ai-textarea-shell textarea::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
  background-color: color-mix(in srgb, var(--shell-divider) 72%, transparent);
}

.ai-toolbar-row {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ai-toolbar-group {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.ai-toolbar-group.is-end {
  margin-left: auto;
}

.ai-attach-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: auto;
  width: auto;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  padding: 0 2px;
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-attach-button:hover {
  color: var(--text-primary);
}

.ai-attach-button:active {
  transform: scale(0.98);
}

.ai-attach-button.disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.ai-attach-button svg {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-mode-button {
  display: inline-flex;
  min-width: 0;
  max-width: none;
  height: auto;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  padding: 0 2px;
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-mode-button:hover {
  color: var(--text-primary);
}

.ai-mode-button:active {
  transform: scale(0.985);
}

.ai-mode-button-copy {
  display: grid;
  min-width: 0;
  flex: 1;
  text-align: left;
}

.ai-mode-button-mode {
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  line-height: 14px;
  text-transform: uppercase;
}

.ai-mode-button-chevron {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--text-quaternary);
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-mode-button-chevron.is-open {
  transform: rotate(180deg);
}

.ai-send-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: auto;
  height: auto;
  flex: 0 0 auto;
  background: transparent;
  color: var(--text-quaternary);
  padding: 0 2px;
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-send-button:hover:not(:disabled) {
  color: var(--text-primary);
}

.ai-send-button:active:not(:disabled) {
  transform: scale(0.97);
}

.ai-send-button.is-stop {
  color: var(--text-primary);
}

.ai-send-button:disabled {
  cursor: default;
  color: var(--text-quaternary);
}

.ai-send-button svg {
  width: 16px;
  height: 16px;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-send-button.is-stop:hover,
.ai-attach-button:hover,
.ai-mode-button:hover {
  color: var(--text-primary);
}

.ai-file-input {
  display: none;
}

:global(.dropdown-menu-panel.ai-prompt-mode-menu-panel) {
  box-shadow: none;
}
</style>
