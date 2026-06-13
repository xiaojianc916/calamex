<script setup lang="ts">
import { XIcon } from '@lucide/vue';
import { computed, ref } from 'vue';

const props = defineProps<{
  label: string;
  url: string;
  outerHtml: string;
  screenshotBase64: string;
}>();

const emit = defineEmits<{
  submit: [comment: string];
  cancel: [];
}>();

const comment = ref('');

const screenshotSrc = computed(() =>
  props.screenshotBase64 ? `data:image/png;base64,${props.screenshotBase64}` : '',
);

const handleSubmit = (): void => {
  emit('submit', comment.value.trim());
};

const handleCancel = (): void => {
  emit('cancel');
};

const handleKeydown = (event: KeyboardEvent): void => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    handleSubmit();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    handleCancel();
  }
};
</script>

<template>
  <aside class="select-bubble" data-testid="ai-web-preview-select-bubble">
    <header class="select-bubble__header">
      <span class="select-bubble__badge" :title="label"> label </span>
      <button
        type="button"
        class="select-bubble__close"
        aria-label="Cancel selection"
        @click="handleCancel"
      >
        <XIcon class="size-4" />
      </button>
    </header>

    <figure v-if="screenshotSrc" class="select-bubble__figure">
      <img class="select-bubble__thumb" :src="screenshotSrc" :alt="label" />
    </figure>

    <pre class="select-bubble__html"><code> outerHtml </code></pre>

    <p class="select-bubble__url" :title="url"> url </p>

    <textarea
      v-model="comment"
      class="select-bubble__input"
      rows="3"
      placeholder="Add a comment for the AI…"
      @keydown="handleKeydown"
    />

    <footer class="select-bubble__actions">
      <button
        type="button"
        class="select-bubble__btn select-bubble__btn--ghost"
        @click="handleCancel"
      >
        Cancel
      </button>
      <button
        type="button"
        class="select-bubble__btn select-bubble__btn--primary"
        @click="handleSubmit"
      >
        Send to AI
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.select-bubble {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 14px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
  color: #0f172a;
}

.select-bubble__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.select-bubble__badge {
  overflow: hidden;
  max-width: 240px;
  padding: 2px 8px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #334155;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.select-bubble__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}

.select-bubble__close:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.select-bubble__figure {
  margin: 0;
  overflow: hidden;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 10px;
}

.select-bubble__thumb {
  display: block;
  width: 100%;
  max-height: 160px;
  object-fit: cover;
}

.select-bubble__html {
  overflow: auto;
  max-height: 96px;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f8fafc;
  color: #475569;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  word-break: break-all;
}

.select-bubble__url {
  overflow: hidden;
  margin: 0;
  color: #94a3b8;
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.select-bubble__input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 8px;
  background: #ffffff;
  color: #0f172a;
  font-size: 13px;
  line-height: 18px;
  resize: vertical;
}

.select-bubble__input:focus {
  border-color: #6366f1;
  outline: none;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18);
}

.select-bubble__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.select-bubble__btn {
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.select-bubble__btn--ghost {
  border-color: rgba(15, 23, 42, 0.12);
  background: #ffffff;
  color: #475569;
}

.select-bubble__btn--ghost:hover {
  background: #f8fafc;
}

.select-bubble__btn--primary {
  background: #6366f1;
  color: #ffffff;
}

.select-bubble__btn--primary:hover {
  background: #4f46e5;
}
</style>
