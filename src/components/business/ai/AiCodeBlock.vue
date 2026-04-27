<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import AiCodeBlockBody from '@/components/business/ai/AiCodeBlockBody.vue';
import AiCodeBlockDiff from '@/components/business/ai/AiCodeBlockDiff.vue';
import AiCodeBlockHeader from '@/components/business/ai/AiCodeBlockHeader.vue';
import { useShikiHighlighter } from '@/composables/useShikiHighlighter';
import { useAiCodeBlockStore } from '@/store/aiCodeBlock';
import type { IAiCodeBlock, IAiCodePathTarget } from '@/types/ai-code';

const props = defineProps<{
  block: IAiCodeBlock;
  canApply: boolean;
}>();

const emit = defineEmits<{
  apply: [block: IAiCodeBlock];
  openPath: [target: IAiCodePathTarget];
}>();

const store = useAiCodeBlockStore();
const { foldedBlockIds, wrappedBlockIds, recentlyCopiedId, lineNumberMode } = storeToRefs(store);
const { highlightAiCode } = useShikiHighlighter();
const highlightedHtml = ref('<pre class="shiki ai-code-plain"><code></code></pre>');

const lineCount = computed(() => Math.max(1, props.block.content.split(/\r?\n/).length));
const lineNumbers = computed(() => Array.from({ length: lineCount.value }, (_, index) => index + 1));
const isFolded = computed(() => foldedBlockIds.value.has(props.block.id));
const isWrapped = computed(() => wrappedBlockIds.value.has(props.block.id));
const isCopied = computed(() => recentlyCopiedId.value === props.block.id);
const shouldHighlight = computed(() => props.block.closed && props.block.streamState === 'closed');
const canApplyBlock = computed(() =>
  props.canApply && shouldHighlight.value && Boolean(props.block.fence.meta.isApplyCandidate),
);
const showLineNumbers = computed(() => {
  if (lineNumberMode.value === 'always') return true;
  if (lineNumberMode.value === 'never') return false;
  return lineCount.value > 8;
});
const streamLabel = computed(() => (props.block.streamState === 'cancelled' ? '已取消' : '正在生成…'));

const refreshHighlight = async (): Promise<void> => {
  if (!shouldHighlight.value) {
    highlightedHtml.value = '<pre class="shiki ai-code-plain"><code></code></pre>';
    return;
  }
  highlightedHtml.value = await highlightAiCode(props.block.content, props.block.fence.lang);
};

const copyCode = async (): Promise<void> => {
  await navigator.clipboard.writeText(props.block.content);
  store.markCopied(props.block.id);
};

const openPath = (): void => {
  const path = props.block.fence.meta.filePath;
  if (!path) return;
  emit('openPath', {
    path,
    startLine: props.block.fence.meta.startLine ?? null,
    endLine: props.block.fence.meta.endLine ?? null,
  });
};

watch(
  () => [props.block.content, props.block.fence.lang, props.block.closed, props.block.streamState] as const,
  () => {
    void refreshHighlight();
  },
  { immediate: true },
);
</script>

<template>
  <section class="ai-code-block" :class="{ 'is-diff': block.fence.meta.isDiff, 'is-streaming': !block.closed }">
    <AiCodeBlockHeader
      :block="block"
      :is-copied="isCopied"
      :is-folded="isFolded"
      :is-wrapped="isWrapped"
      :can-apply="canApplyBlock"
      @copy="copyCode"
      @wrap="store.toggleWrap(block.id)"
      @fold="store.toggleFold(block.id)"
      @apply="emit('apply', block)"
      @open-path="openPath"
    />
    <div
      v-if="!block.closed"
      class="ai-code-stream-body"
      :class="{ 'is-folded': isFolded, 'is-wrapped': isWrapped, 'is-cancelled': block.streamState === 'cancelled' }"
    >
      <div v-if="showLineNumbers" class="ai-code-stream-lines" aria-hidden="true">
        <span v-for="line in lineNumbers" :key="line">{{ line }}</span>
      </div>
      <div class="ai-code-stream-scroll">
        <pre><code>{{ block.content || ' ' }}</code></pre>
      </div>
      <div class="ai-code-stream-status" aria-live="polite">
        <span class="ai-code-stream-dot" aria-hidden="true"></span>
        {{ streamLabel }}
      </div>
      <div v-if="block.truncated" class="ai-code-truncated">内容过大，已截断显示。</div>
    </div>
    <AiCodeBlockDiff
      v-else-if="block.fence.meta.isDiff"
      :block="block"
      :is-folded="isFolded"
    />
    <AiCodeBlockBody
      v-else
      :highlighted-html="highlightedHtml"
      :is-folded="isFolded"
      :is-wrapped="isWrapped"
      :show-line-numbers="showLineNumbers"
      :line-numbers="lineNumbers"
      :truncated="block.truncated"
    />
  </section>
</template>

<style scoped>
.ai-code-block {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 82%, #050608);
  box-shadow: inset 0 1px 0 color-mix(in srgb, white 3%, transparent);
}

.ai-code-block + .ai-code-block {
  margin-top: 10px;
}

.ai-code-block.is-diff {
  border-color: color-mix(in srgb, var(--accent-strong) 22%, var(--shell-divider));
}

.ai-code-block.is-streaming {
  border-color: color-mix(in srgb, var(--accent-strong) 14%, var(--shell-divider));
}

.ai-code-stream-body {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  max-height: 60vh;
  overflow: hidden;
}

.ai-code-stream-body.is-folded {
  max-height: 220px;
}

.ai-code-stream-lines {
  display: grid;
  align-content: start;
  min-width: 36px;
  user-select: none;
  border-right: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  color: var(--text-quaternary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 20px;
  padding: 10px 8px;
  text-align: right;
}

.ai-code-stream-scroll {
  min-width: 0;
  overflow: auto;
  scrollbar-color: color-mix(in srgb, var(--text-primary) 12%, transparent) transparent;
  scrollbar-width: thin;
}

.ai-code-stream-scroll pre {
  min-width: max-content;
  margin: 0;
  padding: 10px 12px;
  color: var(--text-secondary);
}

.ai-code-stream-scroll code {
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  white-space: pre;
}

.ai-code-stream-body.is-wrapped .ai-code-stream-scroll pre {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-code-stream-status,
.ai-code-truncated {
  grid-column: 1 / -1;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 90%, transparent);
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 28px;
  padding: 0 10px;
}

.ai-code-stream-status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-code-stream-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--accent-strong);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-strong) 14%, transparent);
}

.ai-code-stream-body.is-cancelled .ai-code-stream-dot {
  background: var(--text-quaternary);
  box-shadow: none;
}
</style>
