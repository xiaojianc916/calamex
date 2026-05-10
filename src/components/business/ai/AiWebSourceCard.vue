<script setup lang="ts">
import { computed } from 'vue';

import InlineError from '@/components/common/InlineError.vue';
import type { IAiWebSourceEntry } from '@/types/ai';

const props = defineProps<{
  source: IAiWebSourceEntry;
}>();

const emit = defineEmits<{
  fetchSource: [sourceId: string];
}>();

const hostname = computed(() => {
  try {
    return new URL(props.source.result.url).hostname;
  } catch {
    return props.source.result.url;
  }
});

const canFetch = computed(() =>
  props.source.status === 'search-result' || props.source.status === 'failed',
);

const fetchLabel = computed(() => {
  switch (props.source.status) {
    case 'fetching':
      return '读取中…';
    case 'fetched':
      return '已读取';
    case 'failed':
      return '重试读取';
    default:
      return '读取网页';
  }
});

const excerpt = computed(() =>
  props.source.fetchedSource?.excerpt.trim() || props.source.result.snippet.trim(),
);

const stepLabel = computed(() => props.source.stepTitle ?? props.source.stepId ?? '');

const handleFetch = (): void => {
  if (canFetch.value) {
    emit('fetchSource', props.source.id);
  }
};
</script>

<template>
  <article class="ai-web-source-card" :class="`is-${source.status}`">
    <header class="ai-web-source-header">
      <div class="ai-web-source-title-group">
        <span class="ai-web-source-chip">{{ source.result.sourceType }}</span>
        <strong>{{ source.result.title }}</strong>
      </div>
      <button
        type="button"
        class="ai-web-source-action"
        :disabled="!canFetch"
        @click="handleFetch"
      >
        {{ fetchLabel }}
      </button>
    </header>

    <p class="ai-web-source-url">{{ hostname }}</p>
    <p v-if="stepLabel" class="ai-web-source-step">关联步骤：{{ stepLabel }}</p>
    <p v-if="excerpt" class="ai-web-source-excerpt">{{ excerpt }}</p>
    <p v-if="source.fetchedSource" class="ai-web-source-ref">
      textRef: {{ source.fetchedSource.textRef }}
    </p>
    <InlineError
      v-if="source.errorMessage"
      class="ai-web-source-error"
      title="网页读取失败"
      :message="source.errorMessage"
    />
  </article>
</template>

<style scoped>
.ai-web-source-card {
  display: grid;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 78%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-soft) 62%, transparent);
  padding: 9px;
}

.ai-web-source-card.is-fetched {
  border-color: color-mix(in srgb, var(--success) 24%, var(--shell-divider));
}

.ai-web-source-card.is-failed {
  border-color: color-mix(in srgb, var(--danger) 32%, var(--shell-divider));
}

.ai-web-source-header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.ai-web-source-title-group {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.ai-web-source-title-group strong {
  min-width: 0;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  overflow-wrap: anywhere;
}

.ai-web-source-chip {
  width: fit-content;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  border-radius: 999px;
  color: var(--text-quaternary);
  font-size: 10px;
  line-height: 14px;
  padding: 0 6px;
}

.ai-web-source-action {
  height: 24px;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 84%, transparent);
  border-radius: 6px;
  color: var(--text-tertiary);
  font-size: 11px;
  padding: 0 8px;
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-web-source-action:hover:not(:disabled) {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-web-source-action:active:not(:disabled) {
  transform: scale(0.97);
}

.ai-web-source-action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ai-web-source-url,
.ai-web-source-step,
.ai-web-source-excerpt,
.ai-web-source-ref {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
}

.ai-web-source-url {
  color: var(--text-quaternary);
  overflow-wrap: anywhere;
}

.ai-web-source-step {
  color: var(--text-quaternary);
}

.ai-web-source-excerpt {
  color: var(--text-tertiary);
}

.ai-web-source-ref {
  color: var(--text-quaternary);
}

.ai-web-source-error {
  margin-top: 2px;
}
</style>
