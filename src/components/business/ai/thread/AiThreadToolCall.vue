<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from '@/components/ai-elements/code-block/CodeBlock.vue';
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
} from '@/components/ai-elements/terminal';
import { ThreadEntryDisclosure, ThreadToolStatusIcon } from '@/components/ai-elements/thread-entry';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import {
  buildAiPatchPreviewFiles,
  formatAiPatchDisplayPath,
} from '@/components/business/ai/edit/patch-preview';
import type { IAiDiffHunkPreview, IAiDiffPreviewLine, IAiPatchSet } from '@/types/ai';
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
const webSourceLabel = computed(() => {
  const count = props.entry.webSearchSources?.length ?? 0;

  return count > 0 ? `${count} 个来源` : '';
});

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

const getLineNumber = (line: IAiDiffPreviewLine): string => {
  if (typeof line.newLineNumber === 'number') {
    return String(line.newLineNumber);
  }

  if (typeof line.oldLineNumber === 'number') {
    return String(line.oldLineNumber);
  }

  return '';
};

const getLineSign = (line: IAiDiffPreviewLine): string => {
  if (line.kind === 'add') {
    return '+';
  }

  if (line.kind === 'delete') {
    return '-';
  }

  return ' ';
};

const getHunkCode = (hunk: IAiDiffHunkPreview): string =>
  [hunk.header, ...hunk.lines.map((line) => `${getLineSign(line)}${line.content}`)].join('\n');
</script>

<template>
  <ThreadEntryDisclosure
    class="ai-thread-tool-call"
    :open="open"
    :disabled="!hasContent"
    @update:open="emit('update:open', $event)"
  >
    <template #leading>
      <ThreadToolStatusIcon :status="entry.status" />
    </template>
    <template #title>
      <span class="ai-thread-tool-call__title">
        <span class="ai-thread-tool-call__action"> entry.title </span>
        <span
          v-if="primaryTag"
          class="ai-thread-tool-call__target"
          :title="primaryTag"
        > primaryTag </span>
      </span>
    </template>
    <template #meta>
      <span v-if="webSourceLabel" class="ai-thread-tool-call__meta-item"> webSourceLabel </span>
      <span v-if="entry.tail" class="ai-thread-tool-call__meta-item"> entry.tail </span>
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
              <TerminalTitle> item.title </TerminalTitle>
            </TerminalHeader>
            <TerminalContent />
          </Terminal>
          <div v-if="item.type === 'diff'" class="ai-thread-tool-call__diff">
            <div class="ai-thread-tool-call__diff-head">
              <span class="ai-thread-tool-call__diff-path" :title="item.file.path"> item.file.path </span>
              <span class="ai-thread-tool-call__diff-stat is-add">+ item.file.additions </span>
              <span class="ai-thread-tool-call__diff-stat is-delete">- item.file.deletions </span>
            </div>
            <div
              v-for="hunk in resolveHunks(item.file.path)"
              :key="hunk.id"
              class="ai-thread-tool-call__hunk"
            >
              <div class="ai-thread-tool-call__line-numbers" aria-hidden="true">
                <div class="ai-thread-tool-call__line is-hunk">
                  <span class="ai-thread-tool-call__line-number" />
                </div>
                <div
                  v-for="line in hunk.lines"
                  :key="line.id"
                  class="ai-thread-tool-call__line"
                  :class="`is-${line.kind}`"
                >
                  <span class="ai-thread-tool-call__line-number"> getLineNumber(line) </span>
                </div>
              </div>
              <CodeBlock
                class="ai-thread-tool-call__code"
                :code="getHunkCode(hunk)"
                language="diff"
              />
            </div>
          </div>
        </template>
      </div>
    </template>
  </ThreadEntryDisclosure>
</template>

<style scoped>
.ai-thread-tool-call__title {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ai-thread-tool-call__action {
  flex: 0 0 auto;
  color: var(--text-primary);
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

.ai-thread-tool-call__hunk {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  min-width: max-content;
  border-bottom: 4px solid color-mix(in srgb, var(--shell-divider) 50%, transparent);
  background: #ffffff;
}

.ai-thread-tool-call__hunk:last-child {
  border-bottom: 0;
}

.ai-thread-tool-call__line {
  display: grid;
  grid-template-columns: 44px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 20px;
  min-height: 20px;
}

.ai-thread-tool-call__line.is-add {
  background: color-mix(in srgb, var(--success) 12%, transparent);
}

.ai-thread-tool-call__line.is-delete {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.ai-thread-tool-call__line-number {
  user-select: none;
  border-left: 3px solid transparent;
  color: var(--text-quaternary);
  font-variant-numeric: tabular-nums;
  padding-right: 6px;
  text-align: right;
}

.ai-thread-tool-call__line.is-add .ai-thread-tool-call__line-number {
  border-left-color: var(--success);
  color: var(--success);
}

.ai-thread-tool-call__line.is-delete .ai-thread-tool-call__line-number {
  border-left-color: var(--danger);
  color: var(--danger);
}

.ai-thread-tool-call__code {
  border: 0;
  border-radius: 0;
  background: #ffffff;
  overflow: visible;
}

.ai-thread-tool-call__code :deep(pre) {
  padding: 0 12px 0 0;
}

.ai-thread-tool-call__code :deep(code) {
  font-size: 11px;
  line-height: 20px;
}
</style>
