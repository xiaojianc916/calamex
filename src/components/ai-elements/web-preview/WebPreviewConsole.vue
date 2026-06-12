<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';
import type { IWebPreviewConsoleLog } from './context';

const props = withDefaults(
  defineProps<{
    logs?: IWebPreviewConsoleLog[];
    class?: HTMLAttributes['class'];
  }>(),
  {
    logs: () => [],
    class: undefined,
  },
);

const levelLabelMap: Record<IWebPreviewConsoleLog['level'], string> = {
  log: 'LOG',
  warn: 'WARN',
  error: 'ERROR',
};

const formatTimestamp = (value: IWebPreviewConsoleLog['timestamp']): string => {
  const timestamp = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return '--:--:--';
  }

  return timestamp.toLocaleTimeString('zh-CN', { hour12: false });
};
</script>

<template>
  <section :class="cn('ai-web-preview-console', props.class)" data-testid="web-preview-console">
    <header class="ai-web-preview-console__header">Console</header>
    <ul v-if="props.logs.length" class="ai-web-preview-console__list">
      <li
        v-for="(log, index) in props.logs"
        :key="`${index}-${log.message}`"
        class="ai-web-preview-console__item"
      >
        <span class="ai-web-preview-console__level" :data-level="log.level">
           levelLabelMap[log.level] 
        </span>
        <div class="ai-web-preview-console__message-group">
          <p class="ai-web-preview-console__message"> log.message </p>
          <time class="ai-web-preview-console__time"> formatTimestamp(log.timestamp) </time>
        </div>
      </li>
    </ul>
    <div v-else class="ai-web-preview-console__empty">No console output yet</div>
  </section>
</template>

<style scoped>
.ai-web-preview-console {
  display: flex;
  min-height: 168px;
  flex: 0 0 168px;
  flex-direction: column;
  border-top: 1px solid var(--border-subtle);
  background: #fafafa;
}

.ai-web-preview-console__header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ai-web-preview-console__list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  overflow: auto;
  list-style: none;
  padding: 10px 12px 12px;
}

.ai-web-preview-console__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}

.ai-web-preview-console__level {
  display: inline-flex;
  min-width: 44px;
  justify-content: center;
  border-radius: 999px;
  background: #f1f5f9;
  color: var(--text-tertiary);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.8;
  padding: 0 8px;
}

.ai-web-preview-console__level[data-level='warn'] {
  background: #fef3c7;
  color: #b45309;
}

.ai-web-preview-console__level[data-level='error'] {
  background: #fee2e2;
  color: #b91c1c;
}

.ai-web-preview-console__message-group {
  min-width: 0;
}

.ai-web-preview-console__message {
  margin: 0;
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.ai-web-preview-console__time {
  display: inline-block;
  margin-top: 2px;
  color: var(--text-quaternary);
  font-size: 11px;
}

.ai-web-preview-console__empty {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 16px;
  text-align: center;
}
</style>
