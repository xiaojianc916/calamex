<script setup lang="ts">
import { computed } from 'vue';
import AiCodeBlock from '@/components/business/ai/AiCodeBlock.vue';
import { renderAiMarkdown } from '@/services/modules/ai-render';
import type { IAiCodeBlock, IAiCodePathTarget } from '@/types/ai-code';

const props = defineProps<{
  messageId: string;
  content: string;
  canApplyCode: boolean;
  stableContent?: string;
  openBlock?: IAiCodeBlock | null;
}>();

const emit = defineEmits<{
  applyCode: [block: IAiCodeBlock];
  openCodePath: [target: IAiCodePathTarget];
}>();

const markdownContent = computed(() => props.stableContent ?? props.content);
const segments = computed(() => renderAiMarkdown(props.messageId, markdownContent.value));
</script>

<template>
  <div class="ai-markdown">
    <template v-for="segment in segments" :key="segment.id">
      <!-- eslint-disable-next-line vue/no-v-html -- HTML 已由 markdown-it(html:false) 与 DOMPurify 白名单净化。 -->
      <div v-if="segment.kind === 'html'" class="ai-markdown-html" v-html="segment.html"></div>
      <AiCodeBlock
        v-else
        :block="segment.block"
        :can-apply="canApplyCode"
        @apply="emit('applyCode', $event)"
        @open-path="emit('openCodePath', $event)"
      />
    </template>
    <AiCodeBlock
      v-if="openBlock"
      :key="openBlock.id"
      :block="openBlock"
      :can-apply="false"
      @apply="emit('applyCode', $event)"
      @open-path="emit('openCodePath', $event)"
    />
  </div>
</template>

<style scoped>
.ai-markdown {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.ai-markdown-html {
  min-width: 0;
}

.ai-markdown-html :deep(p) {
  margin: 0;
}

.ai-markdown-html :deep(p + p),
.ai-markdown-html :deep(ul),
.ai-markdown-html :deep(ol),
.ai-markdown-html :deep(blockquote) {
  margin: 8px 0 0;
}

.ai-markdown-html :deep(code) {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 80%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--panel-bg) 72%, transparent);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.4;
  padding: 1px 4px;
}

.ai-markdown-html :deep(a) {
  color: var(--accent-strong);
  text-decoration: none;
}

.ai-markdown-html :deep(a:hover) {
  text-decoration: underline;
}
</style>
