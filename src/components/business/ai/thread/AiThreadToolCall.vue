<script setup lang="ts">
import { ChevronDown, FileCode } from '@lucide/vue';
import { computed } from 'vue';
import CodeBlock from '@/components/ai-elements/code-block/CodeBlock.vue';
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
} from '@/components/ai-elements/terminal';
import { ThreadToolStatusIcon } from '@/components/ai-elements/thread-entry';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import { AiDiffHunkViewer } from '@/components/business/ai/edit';
import { TASK_ICON_MAP } from '@/components/business/ai/plan/runtime-timeline';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { toAiThreadToolView, type IAiThreadToolCallEntry } from './projection';

const props = defineProps<{
  entry: IAiThreadToolCallEntry;
  open: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

// 统一渲染入口:协议 VM 经 toAiThreadToolView 派生渲染视图(图标 / 标题 / 展示态 /
// 内容 / 受影响文件)。终端与等待确认依赖本条目的运行期快照(terminals / awaiting),
// 经依赖注入回灌,协议 VM 自身保持纯净不被污染。
const view = computed(() =>
  toAiThreadToolView(props.entry.toolCall, {
    resolveTerminal: (terminalId) => props.entry.terminals[terminalId],
    isAwaitingApproval: () => props.entry.awaiting,
  }),
);

const hasContent = computed(() => view.value.content.length > 0);
const hasLocations = computed(() => view.value.locations.length > 0);
const isExpanded = computed(() => hasContent.value && props.open);
const toolIconClass = computed(() => TASK_ICON_MAP[view.value.icon] ?? TASK_ICON_MAP.system);

const toggleOpen = (): void => {
  if (!hasContent.value) {
    return;
  }

  emit('update:open', !props.open);
};

const rawLanguage = (code: string): string => {
  const trimmed = code.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return 'json';
  }
  return 'text';
};
</script>

<template>
  <section
    class="ai-thread-tool-call"
    :class="{ 'is-open': isExpanded, 'is-static': !hasContent }"
    :data-state="isExpanded ? 'open' : 'closed'"
  >
    <button
      type="button"
      class="ai-thread-tool-call__header"
      :disabled="!hasContent"
      :aria-expanded="isExpanded"
      :title="view.title"
      @click="toggleOpen"
    >
      <LucideIcon :name="toolIconClass" class="ai-thread-tool-call__tool-icon size-4" aria-hidden="true" />
      <span class="ai-thread-tool-call__label">
        <span class="ai-thread-tool-call__action" v-text="view.title" />
      </span>
      <span class="ai-thread-tool-call__meta">
        <ThreadToolStatusIcon class="ai-thread-tool-call__status" :status="view.status" />
      </span>
      <ChevronDown class="ai-thread-tool-call__chevron size-4" v-if="hasContent" aria-hidden="true" />
      <span v-else class="ai-thread-tool-call__chevron-spacer" aria-hidden="true" />
    </button>

    <ul v-if="hasLocations" class="ai-thread-tool-call__locations">
      <li
        v-for="loc in view.locations"
        :key="`${loc.path}:${loc.line ?? ''}`"
        class="ai-thread-tool-call__location"
      >
        <FileCode class="ai-thread-tool-call__location-icon size-3.5" aria-hidden="true" />
        <span
          class="ai-thread-tool-call__location-path"
          :title="loc.path"
          v-text="loc.line === undefined ? loc.path : `${loc.path}:${loc.line}`"
        />
      </li>
    </ul>

    <div v-if="isExpanded" class="ai-thread-tool-call__panel">
      <template v-for="item in view.content" :key="item.id">
        <div v-if="item.type === 'raw'" class="ai-thread-tool-call__raw">
          <div class="ai-thread-tool-call__raw-label"><span v-text="`${item.title}:`" /></div>
          <CodeBlock
            class="ai-thread-tool-call__raw-code"
            :code="item.code"
            :language="rawLanguage(item.code)"
          />
        </div>
        <AiMarkdown
          v-if="item.type === 'text'"
          class="ai-thread-tool-call__text"
          :message-id="`${entry.id}:${item.id}`"
          :content="item.markdown"
        />
        <Terminal
          v-if="item.type === 'terminal'"
          class="ai-thread-tool-call__terminal"
          :output="item.output"
          :is-streaming="item.streaming"
        >
          <TerminalHeader>
            <TerminalTitle><span v-text="item.title" /></TerminalTitle>
          </TerminalHeader>
          <TerminalContent />
        </Terminal>
        <div v-if="item.type === 'diff'" class="ai-thread-tool-call__diff">
          <div class="ai-thread-tool-call__diff-head">
            <FileCode class="ai-thread-tool-call__diff-icon size-3.5" aria-hidden="true" />
            <span
              class="ai-thread-tool-call__diff-path"
              :title="item.filePath"
              v-text="item.filePath"
            />
            <span class="ai-thread-tool-call__diff-stat is-add">+<span v-text="item.additions" /></span>
            <span class="ai-thread-tool-call__diff-stat is-delete">-<span v-text="item.deletions" /></span>
          </div>
          <div class="ai-thread-tool-call__diff-body">
            <AiDiffHunkViewer v-for="hunk in item.hunks" :key="hunk.id" :hunk="hunk" />
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.ai-thread-tool-call {
  display: flex;
  min-width: 0;
  flex-direction: column;
  background: transparent;
}

.ai-thread-tool-call__header {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 2px 0;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}

.ai-thread-tool-call__header:hover:not(:disabled) .ai-thread-tool-call__action {
  color: var(--text-primary);
}

.ai-thread-tool-call__header:disabled {
  cursor: default;
}

.ai-thread-tool-call__chevron,
.ai-thread-tool-call__tool-icon,
.ai-thread-tool-call__diff-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary, #6b7280);
}

.ai-thread-tool-call__chevron {
  transition: transform 120ms ease;
}

.ai-thread-tool-call.is-open .ai-thread-tool-call__chevron {
  transform: rotate(180deg);
}

.ai-thread-tool-call__chevron-spacer {
  width: 16px;
  height: 16px;
}

.ai-thread-tool-call__label {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.ai-thread-tool-call__action {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-thread-tool-call__meta {
  display: inline-flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.ai-thread-tool-call__status {
  flex: 0 0 auto;
}

.ai-thread-tool-call__locations {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  margin: 0;
  padding: 0 0 2px 24px;
  list-style: none;
}

.ai-thread-tool-call__location {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 4px;
  color: var(--text-tertiary, #6b7280);
}

.ai-thread-tool-call__location-icon {
  flex: 0 0 auto;
}

.ai-thread-tool-call__location-path {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-thread-tool-call__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  border-left: 1px solid color-mix(in srgb, var(--shell-divider) 80%, transparent);
  margin-left: 7px;
  padding: 6px 0 10px 17px;
}

.ai-thread-tool-call__raw {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.ai-thread-tool-call__raw-label {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 16px;
}

.ai-thread-tool-call__raw-code {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 70%, transparent);
  border-radius: 8px;
  background: #ffffff;
}

.ai-thread-tool-call__raw-code :deep(pre) {
  padding: 10px 12px;
}

.ai-thread-tool-call__raw-code :deep(code) {
  font-size: 12px;
  line-height: 18px;
}

.ai-thread-tool-call__text {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.ai-thread-tool-call__terminal {
  height: 220px;
  border-radius: 8px;
}

.ai-thread-tool-call__diff {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 8px;
  background: #ffffff;
}

.ai-thread-tool-call__diff-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  background: color-mix(in srgb, var(--surface-soft, #f6f6f6) 76%, transparent);
  padding: 6px 10px;
}

.ai-thread-tool-call__diff-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-thread-tool-call__diff-stat {
  flex: 0 0 auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.ai-thread-tool-call__diff-stat.is-add {
  color: var(--success);
}

.ai-thread-tool-call__diff-stat.is-delete {
  color: var(--danger);
}

.ai-thread-tool-call__diff-body {
  display: flex;
  flex-direction: column;
  overflow-x: auto;
}

.ai-thread-tool-call__diff-body > * + * {
  border-top: 4px solid color-mix(in srgb, var(--shell-divider) 50%, transparent);
}
</style>
