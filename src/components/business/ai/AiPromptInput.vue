<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';

const modelValue = defineModel<string>({ required: true });

const props = defineProps<{
  disabled: boolean;
  errorMessage: string;
  submitLabel: string;
  attachments: readonly {
    id: string;
    name: string;
    sizeLabel: string;
  }[];
  hasAttachments: boolean;
}>();

const emit = defineEmits<{
  submit: [];
  stop: [];
  fileSelected: [file: File];
  removeFile: [id: string];
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);

const resizeTextarea = async (): Promise<void> => {
  await nextTick();
  const textarea = textareaRef.value;
  if (!textarea) return;
  textarea.style.height = 'auto';
  const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
  const minHeight = Number.parseFloat(window.getComputedStyle(textarea).minHeight);
  const nextHeight = Number.isFinite(maxHeight)
    ? Math.min(textarea.scrollHeight, maxHeight)
    : textarea.scrollHeight;
  textarea.style.height = `${Math.max(nextHeight, Number.isFinite(minHeight) ? minHeight : 32)}px`;
  textarea.style.overflowY = Number.isFinite(maxHeight) && textarea.scrollHeight > maxHeight
    ? 'auto'
    : 'hidden';
};

const handleKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if ((!modelValue.value.trim() && !props.hasAttachments) || props.disabled) return;
  emit('submit');
};

const insertContextToken = async (token: string): Promise<void> => {
  if (props.disabled) return;
  const nextToken = `@${token}`;
  const current = modelValue.value.trimEnd();
  modelValue.value = current ? `${current} ${nextToken} ` : `${nextToken} `;
  await nextTick();
  textareaRef.value?.focus();
  await resizeTextarea();
};

const handleFileChange = (event: Event): void => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files?.[0];
  target.value = '';
  if (!file) return;
  emit('fileSelected', file);
};

watch(modelValue, () => {
  void resizeTextarea();
});

onMounted(() => {
  void resizeTextarea();
});
</script>

<template>
  <footer class="ai-composer">
    <p v-if="errorMessage" class="ai-error">{{ errorMessage }}</p>
    <div class="ai-context-toolbar" aria-label="添加上下文">
      <button type="button" @click="insertContextToken('file')">@file</button>
      <button type="button" @click="insertContextToken('selection')">@selection</button>
      <button type="button" @click="insertContextToken('diagnostics')">@diagnostics</button>
      <button type="button" @click="insertContextToken('terminal')">@terminal</button>
      <button type="button" @click="insertContextToken('git')">@git</button>
      <button type="button" @click="insertContextToken('project')">@project</button>
    </div>
    <div v-if="attachments.length" class="ai-attachment-strip" aria-label="已添加附件">
      <span v-for="attachment in attachments" :key="attachment.id" class="ai-attachment-chip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span class="ai-attachment-name">{{ attachment.name }}</span>
        <span class="ai-attachment-size">{{ attachment.sizeLabel }}</span>
        <button
          type="button"
          aria-label="移除附件"
          title="移除附件"
          @click="emit('removeFile', attachment.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </span>
    </div>
    <div class="ai-input-row">
      <label
        class="ai-icon-button ai-file-button"
        :class="{ disabled }"
        aria-label="上传文件"
        title="上传文件"
      >
        <input class="ai-file-input" type="file" :disabled="disabled" @change="handleFileChange" />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path
            d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
          />
        </svg>
      </label>
      <textarea
        ref="textareaRef"
        v-model="modelValue"
        rows="1"
        placeholder="输入消息…"
        aria-label="输入消息"
        :disabled="disabled"
        @input="resizeTextarea"
        @keydown="handleKeydown"
      />
      <button
        v-if="disabled"
        type="button"
        class="ai-icon-button"
        aria-label="停止"
        title="停止"
        @click="emit('stop')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="7" y="7" width="10" height="10" rx="1" />
        </svg>
      </button>
      <button
        v-else
        type="button"
        class="ai-icon-button"
        :aria-label="submitLabel"
        :title="submitLabel"
        :disabled="!modelValue.trim() && !hasAttachments"
        @click="emit('submit')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M21.5 2.5L11 13" />
          <path d="M21.5 2.5l-6.5 19-4-8.5-8.5-4 19-6.5z" />
        </svg>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.ai-composer {
  flex: 0 0 auto;
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px;
}

.ai-error {
  margin: 0 2px;
  color: var(--danger);
  font-size: 12px;
  line-height: 18px;
}

.ai-input-row {
  display: flex;
  min-width: 0;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-soft) 78%, transparent);
  padding: 0 6px;
  transition:
    border-color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    background-color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    box-shadow 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-context-toolbar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.ai-context-toolbar button {
  min-width: 0;
  height: 22px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 78%, transparent);
  border-radius: 5px;
  color: var(--text-quaternary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 20px;
  padding: 0 7px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-context-toolbar button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
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

.ai-attachment-chip > svg {
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

.ai-attachment-size {
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

.ai-input-row:focus-within {
  border-color: color-mix(in srgb, var(--accent-strong) 55%, transparent);
  background: color-mix(in srgb, var(--surface-soft) 100%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-strong) 18%, transparent);
}

.ai-input-row textarea {
  min-width: 0;
  min-height: 32px;
  max-height: 72px;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  outline: 0;
  overflow-y: hidden;
  padding: 6px 0;
  resize: none;
  scrollbar-width: none;
}

.ai-input-row textarea::placeholder {
  color: var(--text-quaternary);
}

.ai-input-row textarea::-webkit-scrollbar {
  display: none;
}

.ai-icon-button {
  display: grid;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 6px;
  color: var(--text-quaternary);
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-icon-button:hover:not(:disabled) {
  color: var(--text-primary);
}

.ai-icon-button:active:not(:disabled) {
  transform: scale(0.97);
}

.ai-icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.ai-file-button {
  cursor: pointer;
}

.ai-file-button.disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.ai-file-input {
  display: none;
}

.ai-icon-button svg {
  width: 15px;
  height: 15px;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
