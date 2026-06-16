<script setup lang="ts">
import { Check, CircleAlert } from '@lucide/vue';
import { useTimeoutFn } from '@vueuse/core';
import { computed, ref } from 'vue';
import { tryWriteClipboardText } from '@/utils/platform/clipboard';

const props = defineProps<{
  message: string;
}>();

const normalizedMessage = computed(() => props.message.trim());
const copied = ref(false);

const copyHint = computed(() => (copied.value ? '已复制完整错误信息' : '点击复制完整错误信息'));

// immediate: false —— 仅在复制成功后手动 start()；到期复位 copied，
// 组件卸载时 vueuse 自动 stop。
const { start: scheduleCopiedReset } = useTimeoutFn(
  () => {
    copied.value = false;
  },
  1600,
  { immediate: false },
);

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
  scheduleCopiedReset();
};
</script>

<template>
  <div v-if="normalizedMessage" class="ai-error-notice" role="alert">
    <span class="ai-error-notice__line" aria-hidden="true"></span>
    <button type="button" class="ai-error-notice__body" :title="copyHint" :aria-label="copyHint" @click="handleCopy">
      <Check class="ai-error-notice__icon is-copied" v-if="copied" aria-hidden="true" />
      <CircleAlert class="ai-error-notice__icon" v-else aria-hidden="true" />
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

/*
 * 分隔线：中性灰（随主题自适应，浅色下为柔和的灰）。
 * 使用线性渐变，靠近文字端最清晰，向两侧外缘逐渐消失，视觉更克制优雅。
 */
.ai-error-notice__line {
  height: 1px;
  min-width: 18px;
  flex: 1 1 auto;
  border: 0;
  border-radius: 1px;
}

.ai-error-notice__line:first-child {
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--border-strong) 55%, transparent)
  );
}

.ai-error-notice__line:last-child {
  background: linear-gradient(
    to left,
    transparent,
    color-mix(in srgb, var(--border-strong) 55%, transparent)
  );
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
