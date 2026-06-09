<script setup lang="ts">
import { computed } from 'vue';
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
} from '@/components/ai-elements/terminal';
import { ThreadEntryDisclosure, ThreadToolStatusIcon } from '@/components/ai-elements/thread-entry';
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
const primaryTag = computed(() => props.entry.tags[0] ?? '');
// 行首：折叠箭头（▶/▼）+ 工具专属图标；执行状态移到行尾（对齐 Zed 工具调用行）。
const toolIconClass = computed(() => TASK_ICON_MAP[props.entry.icon] ?? TASK_ICON_MAP.system);
const webSourceCount = computed(() => props.entry.webSearchSources?.length ?? 0);

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
  <ThreadEntryDisclosure
    class="ai-thread-tool-call"
    :open="open"
    :disabled="!hasContent"
    leading-chevron
    @update:open="emit('update:open', $event)"
  >
    <template #leading>
      <span :class="cn('ai-thread-tool-call__tool-icon size-4', toolIconClass)" aria-hidden="true" />
    </template>
    <template #title>
      <span class="ai-thread-tool-call__title">
        <span class="ai-thread-tool-call__action" v-text="entry.title" />
        <span
          v-if="primaryTag"
          class="ai-thread-tool-call__target"
          :title="primaryTag"
          v-text="primaryTag"
        />
      </span>
    </template>
    <template #meta>
      <span
        v-if="webSourceCount > 0"
        class="ai-thread-tool-call__web-pill"
        :aria-label="`${webSourceCount} 个网络来源`"
      >
        <span class="ai-thread-tool-call__web-icon icon-[lucide--globe] size-3" aria-hidden="true" />
        <span v-text="`${webSourceCount} 个来源`" />
      </span>
      <span v-if="entry.tail" class="ai-thread-tool-call__meta-item" v-text="entry.tail" />
      <ThreadToolStatusIcon class="ai-thread-tool-call__status" :status="entry.status" />
    </template>
    <template #content>
      <div class="ai-thread-tool-call__content">
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
    </template>
  </ThreadEntryDisclosure>
</template>

<style scoped>
.ai-thread-tool-call__tool-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary, #6b7280);
}

.ai-thread-tool-call__title {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.ai-thread-tool-call__action {
  flex: 0 0 auto;
  color: var(--text-primary);
  font-weight: 500;
}

.ai-thread-tool-call__target {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary, #6b7280);
  font-family: var(--font-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-thread-tool-call__web-pill {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 70%, transparent);
  border-radius: 999px;
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

.ai-thread-tool-call__status {
  flex: 0 0 auto;
}

.ai-thread-tool-call__content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.ai-thread-tool-call__text {
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.ai-thread-tool-call__diff {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 8px;
}

.ai-thread-tool-call__diff-head {
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  padding: 6px 12px;
}

.ai-thread-tool-call__diff-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 12px;
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
  background: #ffffff;
}

.ai-thread-tool-call__diff-body > * + * {
  border-top: 4px solid color-mix(in srgb, var(--shell-divider) 50%, transparent);
}
</style>
