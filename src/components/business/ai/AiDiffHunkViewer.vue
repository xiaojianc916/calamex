<script setup lang="ts">
import CodeBlock from '@/components/ai-elements/code-block/CodeBlock.vue';
import type { IAiDiffHunkPreview, TAiDiffPreviewLineKind } from '@/types/ai';
import { computed } from 'vue';

const props = defineProps<{
  hunk: IAiDiffHunkPreview;
}>();

const LINE_KIND_LABELS: Record<TAiDiffPreviewLineKind, string> = {
  add: '+',
  delete: '-',
  hunk: '@',
  context: ' ',
};

const getLineSign = (kind: TAiDiffPreviewLineKind): string => LINE_KIND_LABELS[kind];

const getLineNumber = (lineNumber?: number): string =>
  typeof lineNumber === 'number' ? String(lineNumber) : '';

const diffCode = computed(() =>
  [
    props.hunk.header,
    ...props.hunk.lines.map((line) => `${getLineSign(line.kind)}${line.content}`),
  ].join('\n'),
);
</script>

<template>
  <div class="ai-diff-hunk-viewer" aria-label="Diff hunk preview">
    <div class="ai-diff-hunk-numbers" aria-hidden="true">
      <div class="ai-diff-hunk-line ai-diff-hunk-number-line is-hunk">
        <span></span>
        <span></span>
      </div>
      <div
        v-for="line in props.hunk.lines"
        :key="line.id"
        class="ai-diff-hunk-line ai-diff-hunk-number-line"
        :class="`is-${line.kind}`"
      >
        <span>{{ getLineNumber(line.oldLineNumber) }}</span>
        <span>{{ getLineNumber(line.newLineNumber) }}</span>
      </div>
    </div>
    <CodeBlock class="ai-diff-hunk-code" :code="diffCode" language="diff" />
  </div>
</template>

<style scoped>
.ai-diff-hunk-viewer {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr);
  min-width: max-content;
  background: #ffffff;
}

.ai-diff-hunk-numbers {
  z-index: 1;
  border-right: 1px solid color-mix(in srgb, var(--shell-divider) 70%, transparent);
  background: color-mix(in srgb, var(--surface-soft) 40%, #ffffff);
}

.ai-diff-hunk-number-line {
  display: grid;
  grid-template-columns: 52px 52px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 20px;
  min-height: 20px;
}

.ai-diff-hunk-number-line.is-add {
  background: color-mix(in srgb, var(--success) 12%, transparent);
}

.ai-diff-hunk-number-line.is-delete {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.ai-diff-hunk-number-line.is-hunk {
  color: var(--text-tertiary);
}

.ai-diff-hunk-number-line.is-add > span:first-child,
.ai-diff-hunk-number-line.is-delete > span:first-child {
  border-left: 3px solid transparent;
}

.ai-diff-hunk-number-line.is-add > span:first-child {
  border-left-color: var(--success);
}

.ai-diff-hunk-number-line.is-delete > span:first-child {
  border-left-color: var(--danger);
}

.ai-diff-hunk-number-line > span {
  user-select: none;
  color: var(--text-quaternary);
  padding-right: 8px;
  text-align: right;
}

.ai-diff-hunk-code {
  border: 0;
  border-radius: 0;
  background: #ffffff;
}

.ai-diff-hunk-code :deep(pre) {
  padding: 0 16px 0 0;
}

.ai-diff-hunk-code :deep(code) {
  font-size: 12px;
  line-height: 20px;
}
</style>
