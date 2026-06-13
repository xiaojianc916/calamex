<script setup lang="ts">
import { ChevronDownIcon } from '@lucide/vue';
import { computed, type HTMLAttributes, ref } from 'vue';
import { cn } from '@/lib/utils';
import type { IWebPreviewConsoleLog, TWebPreviewLogSource } from './context';

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

// Start collapsed so the preview shows the page first; the user expands it from the toggle.
const collapsed = ref(true);

const toggleCollapsed = (): void => {
  collapsed.value = !collapsed.value;
};

const toggleLabel = computed<string>(() => (collapsed.value ? '展开控制台' : '收起控制台'));

// Which stream the panel is showing. Defaults to our own shell diagnostics; the toggle
// flips to logs forwarded from the inspected page (its console.log, CSP report-only, etc.).
const activeSource = ref<TWebPreviewLogSource>('app');

const sourceLabelMap: Record<TWebPreviewLogSource, string> = {
  app: '应用',
  page: '网页',
};

const sourceLabel = computed<string>(() => sourceLabelMap[activeSource.value]);

const sourceToggleLabel = computed<string>(() =>
  activeSource.value === 'app' ? '当前：应用日志（点击查看网页日志）' : '当前：网页日志（点击查看应用日志）',
);

const toggleSource = (): void => {
  activeSource.value = activeSource.value === 'app' ? 'page' : 'app';
};

const visibleLogs = computed<IWebPreviewConsoleLog[]>(() =>
  props.logs.filter((log) => (log.source ?? 'app') === activeSource.value),
);

const emptyLabel = computed<string>(() =>
  activeSource.value === 'app' ? '暂无应用日志' : '暂无网页日志',
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
  <section
    :class="cn('ai-web-preview-console', collapsed && 'ai-web-preview-console--collapsed', props.class)"
    data-testid="web-preview-console"
  >
    <header class="ai-web-preview-console__header">
      <span class="ai-web-preview-console__title">Console</span>
      <div class="ai-web-preview-console__actions">
        <button
          type="button"
          class="ai-web-preview-console__source"
          :title="sourceToggleLabel"
          :aria-label="sourceToggleLabel"
          data-testid="web-preview-console-source-toggle"
          @click="toggleSource"
        >
          <span class="ai-web-preview-console__source-text" v-text="sourceLabel" />
        </button>
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
      </div>
    </header>
    <template v-if="!collapsed">
      <ul v-if="visibleLogs.length" class="ai-web-preview-console__list">
        <li
          v-for="(log, index) in visibleLogs"
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
      <div v-else class="ai-web-preview-console__empty" v-text="emptyLabel" />
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

.ai-web-preview-console__actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ai-web-preview-console__source {
  display: inline-flex;
  height: 22px;
  align-items: center;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: #ffffff;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition:
    color 120ms ease,
    background-color 120ms ease,
    border-color 120ms ease;
}

.ai-web-preview-console__source:hover {
  border-color: var(--border-strong);
  background: #f1f1f3;
  color: var(--text-primary);
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
