<script setup lang="ts">
defineProps<{
  highlightedHtml: string;
  isFolded: boolean;
  isWrapped: boolean;
  showLineNumbers: boolean;
  lineNumbers: number[];
  truncated: boolean;
}>();
</script>

<template>
  <div class="ai-code-body" :class="{ 'is-folded': isFolded, 'is-wrapped': isWrapped }">
    <div v-if="showLineNumbers" class="ai-code-lines" aria-hidden="true">
      <span v-for="line in lineNumbers" :key="line">{{ line }}</span>
    </div>
    <!-- eslint-disable-next-line vue/no-v-html -- Shiki 输出仅消费已转义代码，高亮失败时走 escapeHtml 降级。 -->
    <div class="ai-code-scroll" v-html="highlightedHtml"></div>
    <div v-if="truncated" class="ai-code-truncated">内容过大，已截断显示。</div>
  </div>
</template>

<style scoped>
.ai-code-body {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  max-height: 60vh;
  overflow: hidden;
}

.ai-code-body.is-folded {
  max-height: 220px;
}

.ai-code-lines {
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

.ai-code-scroll {
  min-width: 0;
  overflow: auto;
  scrollbar-color: color-mix(in srgb, var(--text-primary) 12%, transparent) transparent;
  scrollbar-width: thin;
}

.ai-code-scroll::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.ai-code-scroll::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-primary) 12%, transparent);
  background-clip: content-box;
}

.ai-code-body :deep(pre) {
  margin: 0;
  min-width: max-content;
  background: transparent !important;
  padding: 10px 12px;
}

.ai-code-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
}

.ai-code-body.is-wrapped :deep(pre) {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-code-truncated {
  grid-column: 1 / -1;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 90%, transparent);
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 28px;
  padding: 0 10px;
}
</style>
