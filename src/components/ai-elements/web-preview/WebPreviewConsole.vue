<script setup lang="ts">
import { ChevronDownIcon } from '@lucide/vue';
import { computed, ref, type HTMLAttributes } from 'vue';
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

const collapsed = ref(false);

const toggleCollapsed = (): void => {
  collapsed.value = !collapsed.value;
};

const toggleLabel = computed<string>(() => (collapsed.value ? '展开控制台' : '收起控制台'));

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
  <section
    :class="cn('ai-web-preview-console', collapsed && 'ai-web-preview-console--collapsed', props.class)"
    data-testid="web-preview-console"
  >
    <header class="ai-web-preview-console__header">
      <span class="ai-web-preview-console__title">Console</span>
      <button
        type="button"
        class="ai-web-preview-console__toggle"
        :title="toggleLabel"
        :aria-label="toggleLabel"
        :aria-expanded="!collapsed"
        data-testid="web-preview-console-toggle"
        @click="toggleCollapsed"
      >
        <ChevronDownIcon class="ai-web-preview-console__chevron" />
      </button>
    </header>
    <template v-if="!collapsed">
      <ul v-if="props.logs.length" class="ai-web-preview-console__list">
        <li
          v-for="(log, index) in props.logs"
          :key="`${index}-${log.message}`"
          class="ai-web-preview-console__item"
        >
          <span
            class="ai-web-preview-console__level"
            :data-level="log.level"
            v-text="levelLabelMap[log.level]"
          />
          <div class="ai-web-preview-console__message-group">
            <p class="ai-web-preview-console__message" v-text="log.message" />
            <time class="ai-web-preview-console__time" v-text="formatTimestamp(log.timestamp)" />
          </div>
        </li>
      </ul>
      <div v-else class="ai-web-preview-console__empty">No console output yet</div>
    </template>
  </section>
</template>

<style scoped>
.ai-web-preview-console {
  display: flex;
  min-height: 168px;
  flex: 0 0 168px;
  flex-direction: column;
  border-top: 1px solid var(--border-subtle);
  background: #f9f9fa;
}

.ai-web-preview-console--collapsed {
  min-height: 0;
  flex: 0 0 auto;
}

.ai-web-preview-console__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: #f9f9fa;
}

.ai-web-preview-console__title {
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ai-web-preview-console__toggle {
  display: inline-flex;
  width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  transition:
    color 120ms ease,
    background-color 120ms ease;
}

.ai-web-preview-console__toggle:hover {
  background: #f1f1f3;
  color: var(--text-primary);
}

.ai-web-preview-console__chevron {
  width: 14px;
  height: 14px;
  stroke-width: 1.8;
  transition: transform 140ms ease;
}

.ai-web-preview-console--collapsed .ai-web-preview-console__chevron {
  transform: rotate(180deg);
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
  background: #f9f9fa;
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
  background: #f9f9fa;
}
</style>
