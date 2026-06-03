<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { tryWriteClipboardText } from '@/utils/clipboard';

const props = defineProps<{
  message: string;
}>();

const normalizedMessage = computed(() => props.message.trim());
const copied = ref(false);
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;

const copyHint = computed(() => (copied.value ? '已复制完整错误信息' : '点击复制完整错误信息'));

const handleCopy = async (): Promise<void> => {
  const message = normalizedMessage.value;

  if (!message) {
    return;
  }

  const succeeded = await tryWriteClipboardText(message);

  if (!succeeded) {
    return;
  }

  copied.value = true;

  if (copiedResetTimer) {
    clearTimeout(copiedResetTimer);
  }

  copiedResetTimer = setTimeout(() => {
    copied.value = false;
    copiedResetTimer = null;
  }, 1600);
};

onBeforeUnmount(() => {
  if (copiedResetTimer) {
    clearTimeout(copiedResetTimer);
    copiedResetTimer = null;
  }
});
</script>

<template>
  <div v-if="normalizedMessage" class="ai-error-notice" role="alert">
    <span class="ai-error-notice__line" aria-hidden="true"></span>
    <button type="button" class="ai-error-notice__body" :title="copyHint" :aria-label="copyHint" @click="handleCopy">
      <span v-if="copied" class="icon-[lucide--check] ai-error-notice__icon is-copied" aria-hidden="true"></span>
      <span v-else class="icon-[lucide--circle-alert] ai-error-notice__icon" aria-hidden="true"></span>
      <span class="ai-error-notice__text" v-text="normalizedMessage"></span>
    </button>
    <span class="ai-error-notice__line" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.ai-error-notice {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 0 2px;
}

.ai-error-notice__line {
  height: 1px;
  min-width: 18px;
  flex: 1 1 auto;
  background: color-mix(in srgb, var(--danger) 24%, transparent);
}

.ai-error-notice__body {
  display: inline-flex;
  min-width: 0;
  max-width: min(100%, 460px);
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  padding: 0;
  transition: color 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-error-notice__body:hover {
  color: var(--text-secondary);
}

.ai-error-notice__body:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--danger) 50%, transparent);
  outline-offset: 4px;
}

.ai-error-notice__icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--danger);
  stroke-width: 1.8;
}

.ai-error-notice__icon.is-copied {
  color: var(--success);
}

.ai-error-notice__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
