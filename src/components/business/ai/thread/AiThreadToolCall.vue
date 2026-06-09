<script setup lang="ts">
import { computed } from 'vue';
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
} from '@/components/ai-elements/terminal';
import { ThreadToolStatusIcon } from '@/components/ai-elements/thread-entry';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import { AiDiffHunkViewer } from '@/components/business/ai/edit';
import {
  buildAiPatchPreviewFiles,
  formatAiPatchDisplayPath,
} from '@/components/business/ai/edit/patch-preview';
import { TASK_ICON_MAP } from '@/components/business/ai/plan/runtime-timeline';
import { cn } from '@/lib/utils';
import type { IAiDiffHunkPreview, IAiPatchSet } from '@/types/ai';
import type { IAiThreadToolCallEntry } from './projection';

const props = defineProps<{
  entry: IAiThreadToolCallEntry;
  open: boolean;
  patches?: readonly IAiPatchSet[];
  workspaceRootPath?: string | null;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const hasContent = computed(() => props.entry.content.length > 0);
const isExpanded = computed(() => hasContent.value && props.open);
const primaryTag = computed(() => props.entry.tags[0] ?? '');
const toolIconClass = computed(() => TASK_ICON_MAP[props.entry.icon] ?? TASK_ICON_MAP.system);
const webSourceCount = computed(() => props.entry.webSearchSources?.length ?? 0);

const toggleOpen = (): void => {
  if (!hasContent.value) {
    return;
  }

  emit('update:open', !props.open);
};

// 复用「已更改文件」汇总完全一致的 hunk 解析：按多种路径键归一化后匹配，避免内联
// diff 与汇总卡片出现行为差异（不另造一套解析逻辑）。
const patchHunksByPath = computed(() => {
  const entries = new Map<string, IAiDiffHunkPreview[]>();

  for (const patch of props.patches ?? []) {
    for (const previewFile of buildAiPatchPreviewFiles(patch, props.workspaceRootPath)) {
      const keys = new Set([
        previewFile.path,
        previewFile.displayPath,
        formatAiPatchDisplayPath(previewFile.path),
      ]);

      for (const key of keys) {
        const normalizedKey = formatAiPatchDisplayPath(key);
        const existing = entries.get(normalizedKey) ?? [];

        entries.set(normalizedKey, [...existing, ...previewFile.hunks]);
      }
    }
  }

  return entries;
});

const resolveHunks = (filePath: string): IAiDiffHunkPreview[] =>
  patchHunksByPath.value.get(formatAiPatchDisplayPath(filePath)) ?? [];
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
      @click="toggleOpen"
    >
      <span
        v-if="hasContent"
        class="ai-thread-tool-call__chevron icon-[lucide--chevron-right] size-4"
        aria-hidden="true"
      />
      <span v-else class="ai-thread-tool-call__chevron-spacer" aria-hidden="true" />
      <span :class="cn('ai-thread-tool-call__tool-icon size-4', toolIconClass)" aria-hidden="true" />
      <span class="ai-thread-tool-call__label">
        <span class="ai-thread-tool-call__action" v-text="entry.title" />
        <span
          v-if="primaryTag"
          class="ai-thread-tool-call__target"
          :title="primaryTag"
          v-text="primaryTag"
        />
      </span>
      <span class="ai-thread-tool-call__meta">
        <span
          v-if="webSourceCount > 0"
          class="ai-thread-tool-call__web-pill"
          :aria-label="`${webSourceCount} 个网络来源`"
        >
          <span class="ai-thread-tool-call__web-icon icon-[lucide--globe] size-3" aria-hidden="true" />
          <span v-text="`${webSourceCount} 个来源`" />
        </span>
        <span v-if="entry.tail" class="ai-thread-tool-call__tail" v-text="entry.tail" />
        <ThreadToolStatusIcon class="ai-thread-tool-call__status" :status="entry.status" />
      </span>
    </button>

    <div v-if="isExpanded" class="ai-thread-tool-call__panel">
      <template v-for="item in entry.content" :key="item.id">
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
            <span class="ai-thread-tool-call__diff-icon icon-[lucide--file-code] size-3.5" aria-hidden="true" />
            <span
              class="ai-thread-tool-call__diff-path"
              :title="item.file.path"
              v-text="item.file.path"
            />
            <span class="ai-thread-tool-call__diff-stat is-add">+<span v-text="item.file.additions" /></span>
            <span class="ai-thread-tool-call__diff-stat is-delete">-<span v-text="item.file.deletions" /></span>
          </div>
          <div class="ai-thread-tool-call__diff-body">
            <AiDiffHunkViewer
              v-for="hunk in resolveHunks(item.file.path)"
              :key="hunk.id"
              :hunk="hunk"
            />
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
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-base, #ffffff) 92%, transparent);
  overflow: hidden;
}

.ai-thread-tool-call__header {
  display: grid;
  grid-template-columns: 16px 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  border: 0;
  background: color-mix(in srgb, var(--surface-soft, #f6f6f6) 68%, transparent);
  padding: 7px 10px;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}

.ai-thread-tool-call__header:hover:not(:disabled) {
  background: color-mix(in srgb, var(--shell-divider) 42%, transparent);
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
  transform: rotate(90deg);
}

.ai-thread-tool-call__chevron-spacer {
  width: 16px;
  height: 16px;
}

.ai-thread-tool-call__label {
  display: inline-flex;
  min-width: 0;
  align-items: baseline;
  gap: 7px;
}

.ai-thread-tool-call__action {
  flex: 0 0 auto;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

.ai-thread-tool-call__target {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary, #6b7280);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 18px;
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

.ai-thread-tool-call__web-pill {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 70%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, #ffffff 76%, transparent);
  padding: 1px 8px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

.ai-thread-tool-call__web-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary, #6b7280);
}

.ai-thread-tool-call__tail {
  color: var(--text-tertiary, #6b7280);
  font-size: 11px;
  white-space: nowrap;
}

.ai-thread-tool-call__status {
  flex: 0 0 auto;
}

.ai-thread-tool-call__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  padding: 8px 10px 10px 40px;
  background: color-mix(in srgb, #ffffff 92%, transparent);
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
