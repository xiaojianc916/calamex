<script setup lang="ts">
import { computed } from 'vue';
import type { IAiCodeBlock } from '@/types/ai-code';

const props = defineProps<{
  block: IAiCodeBlock;
  isCopied: boolean;
  isFolded: boolean;
  isWrapped: boolean;
  canApply: boolean;
}>();

const emit = defineEmits<{
  copy: [];
  wrap: [];
  fold: [];
  apply: [];
  openPath: [];
}>();

const detectionLabel = computed(() => {
  if (props.block.fence.detection.source === 'fallback') return '未识别';
  if (props.block.fence.detection.source === 'context') return '上下文';
  return '自动';
});
</script>

<template>
  <header class="ai-code-header">
    <div class="ai-code-title">
      <span class="ai-code-lang">{{ block.fence.lang }}</span>
      <span v-if="block.fence.detection.source !== 'fence'" class="ai-code-detection">
        {{ detectionLabel }}
      </span>
      <button
        v-if="block.fence.meta.filePath"
        type="button"
        class="ai-code-path"
        @click="emit('openPath')"
      >
        {{ block.fence.meta.filePath }}<template v-if="block.fence.meta.startLine">:{{ block.fence.meta.startLine }}</template>
      </button>
    </div>
    <div class="ai-code-actions">
      <button type="button" @click="emit('copy')">{{ isCopied ? '已复制' : '复制' }}</button>
      <button type="button" @click="emit('wrap')">{{ isWrapped ? '不换行' : '换行' }}</button>
      <button type="button" @click="emit('fold')">{{ isFolded ? '展开' : '折叠' }}</button>
      <button v-if="canApply" type="button" class="is-accent" @click="emit('apply')">预览 Patch</button>
    </div>
  </header>
</template>

<style scoped>
.ai-code-header {
  display: flex;
  min-width: 0;
  height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 90%, transparent);
  padding: 0 8px 0 10px;
}

.ai-code-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.ai-code-lang,
.ai-code-detection {
  flex: 0 0 auto;
  border-radius: 5px;
  background: color-mix(in srgb, var(--surface-soft) 84%, transparent);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 20px;
  padding: 0 6px;
}

.ai-code-detection {
  color: var(--text-quaternary);
}

.ai-code-path {
  min-width: 0;
  overflow: hidden;
  border-radius: 5px;
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 20px;
  padding: 0 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-code-path:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-code-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  opacity: 0.72;
  transition: opacity 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-code-header:hover .ai-code-actions,
.ai-code-actions:focus-within {
  opacity: 1;
}

.ai-code-actions button {
  height: 22px;
  border-radius: 5px;
  color: var(--text-quaternary);
  font-size: 11px;
  padding: 0 6px;
}

.ai-code-actions button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-code-actions button.is-accent {
  color: var(--accent-strong);
}
</style>
