<script setup lang="ts">
import { computed } from 'vue';
import type { IAiCodeBlock } from '@/types/ai-code';

const props = defineProps<{
  block: IAiCodeBlock;
  isFolded: boolean;
}>();

const diffLines = computed(() =>
  props.block.content.split('\n').map((content, index) => {
    let kind: 'add' | 'del' | 'hunk' | 'context' = 'context';
    if (content.startsWith('+++') || content.startsWith('---')) {
      kind = 'context';
    } else if (content.startsWith('+')) {
      kind = 'add';
    } else if (content.startsWith('-')) {
      kind = 'del';
    } else if (content.startsWith('@@')) {
      kind = 'hunk';
    }
    return {
      id: `${props.block.id}:diff:${index}`,
      content: content || ' ',
      kind,
      number: index + 1,
    };
  }),
);
</script>

<template>
  <div class="ai-code-diff" :class="{ 'is-folded': isFolded }">
    <div v-for="line in diffLines" :key="line.id" class="ai-diff-line" :class="`is-${line.kind}`">
      <span class="ai-diff-number" aria-hidden="true">{{ line.number }}</span>
      <span class="ai-diff-sign" aria-hidden="true">{{ line.content.slice(0, 1) }}</span>
      <code>{{ line.content }}</code>
    </div>
  </div>
</template>

<style scoped>
.ai-code-diff {
  max-height: 60vh;
  overflow: auto;
  padding: 6px 0;
  scrollbar-color: color-mix(in srgb, var(--text-primary) 12%, transparent) transparent;
  scrollbar-width: thin;
}

.ai-code-diff.is-folded {
  max-height: 220px;
}

.ai-diff-line {
  display: grid;
  grid-template-columns: 36px 18px minmax(0, 1fr);
  min-width: max-content;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 20px;
}

.ai-diff-line.is-add {
  background: color-mix(in srgb, var(--success) 13%, transparent);
}

.ai-diff-line.is-del {
  background: color-mix(in srgb, var(--danger) 13%, transparent);
}

.ai-diff-line.is-hunk {
  background: color-mix(in srgb, var(--accent-strong) 12%, transparent);
  color: var(--accent-strong);
}

.ai-diff-number {
  user-select: none;
  border-right: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  color: var(--text-quaternary);
  padding-right: 8px;
  text-align: right;
}

.ai-diff-sign {
  user-select: none;
  color: var(--text-quaternary);
  text-align: center;
}

.ai-diff-line.is-add .ai-diff-sign {
  color: var(--success);
}

.ai-diff-line.is-del .ai-diff-sign {
  color: var(--danger);
}

.ai-diff-line code {
  padding-right: 12px;
  white-space: pre;
}
</style>
