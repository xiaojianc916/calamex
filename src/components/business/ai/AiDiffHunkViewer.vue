<script setup lang="ts">
import type { IAiDiffHunkPreview, TAiDiffPreviewLineKind } from '@/types/ai';

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
</script>

<template>
  <div class="ai-diff-hunk-viewer" aria-label="Diff hunk preview">
    <div class="ai-diff-hunk-line is-hunk">
      <span aria-hidden="true"></span>
      <span aria-hidden="true"></span>
      <code>{{ props.hunk.header }}</code>
    </div>
    <div
      v-for="line in props.hunk.lines"
      :key="line.id"
      class="ai-diff-hunk-line"
      :class="`is-${line.kind}`"
    >
      <span aria-label="old line">{{ getLineNumber(line.oldLineNumber) }}</span>
      <span aria-label="new line">{{ getLineNumber(line.newLineNumber) }}</span>
      <code>
        <span class="ai-diff-hunk-sign" aria-hidden="true">{{ getLineSign(line.kind) }}</span>{{ line.content }}
      </code>
    </div>
  </div>
</template>

<style scoped>
.ai-diff-hunk-viewer {
  min-width: max-content;
}

.ai-diff-hunk-line {
  display: grid;
  grid-template-columns: 52px 52px minmax(0, 1fr);
  min-width: max-content;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 24px;
}

.ai-diff-hunk-line.is-add {
  background: color-mix(in srgb, var(--success) 12%, transparent);
}

.ai-diff-hunk-line.is-delete {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.ai-diff-hunk-line.is-hunk {
  color: var(--text-tertiary);
}

.ai-diff-hunk-line.is-add > span:first-child,
.ai-diff-hunk-line.is-delete > span:first-child {
  border-left: 3px solid transparent;
}

.ai-diff-hunk-line.is-add > span:first-child {
  border-left-color: var(--success);
}

.ai-diff-hunk-line.is-delete > span:first-child {
  border-left-color: var(--danger);
}

.ai-diff-hunk-line > span {
  user-select: none;
  color: var(--text-quaternary);
  padding-right: 8px;
  text-align: right;
}

.ai-diff-hunk-line code {
  min-width: 0;
  padding-right: 16px;
  white-space: pre;
}

.ai-diff-hunk-sign {
  display: inline-block;
  width: 18px;
  color: var(--text-quaternary);
}

.ai-diff-hunk-line.is-add .ai-diff-hunk-sign {
  color: var(--success);
}

.ai-diff-hunk-line.is-delete .ai-diff-hunk-sign {
  color: var(--danger);
}
</style>
