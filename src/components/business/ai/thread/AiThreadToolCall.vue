<script setup lang="ts">
import { ChevronDown, FileCode, Globe } from '@lucide/vue';
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
import {
  buildAiPatchPreviewFiles,
  formatAiPatchDisplayPath,
} from '@/components/business/ai/edit/patch-preview';
import { TASK_ICON_MAP } from '@/components/business/ai/plan/runtime-timeline';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
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
const toolIconClass = computed(() => TASK_ICON_MAP[props.entry.icon] ?? TASK_ICON_MAP.system);
const webSourceCount = computed(() => props.entry.webSearchSources?.length ?? 0);

// Zed 风格两段式标题:动词(verb)与参数(argument)分开展示;缺省结构化字段时
// 回退到整段 title 字符串,保证向后兼容。
const labelVerb = computed(() => props.entry.titleVerb ?? props.entry.title);
const labelArgument = computed(() => props.entry.titleArgument);

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

// 复用「已更改文件」汇总完全一致的 hunk 解析:按多种路径键归一化后匹配,避免内联
// diff 与汇总卡片出现行为差异(不另造一套解析逻辑)。仅用于无内联 hunk 的
// Mastra 路径回退;ACP 路径的 diff 自带 `hunks`,不走这里。
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
      :title="entry.title"
      @click="toggleOpen"
    >
      <LucideIcon :name="toolIconClass" class="ai-thread-tool-call__tool-icon size-4" aria-hidden="true" />
      <span class="ai-thread-tool-call__label">
        <span class="ai-thread-tool-call__action" v-text="labelVerb" />
        <code
          v-if="labelArgument"
          class="ai-thread-tool-call__argument"
          :title="labelArgument"
          v-text="labelArgument"
        />
      </span>
      <span class="ai-thread-tool-call__meta">
        <span
          v-if="webSourceCount > 0"
          class="ai-thread-tool-call__web-pill"
          :aria-label="`${webSourceCount} 个网络来源`"
        >
          <Globe class="ai-thread-tool-call__web-icon size-3" aria-hidden="true" />
          <span v-text="`${webSourceCount} 个来源`" />
        </span>
        <span v-if="entry.tail" class="ai-thread-tool-call__tail" v-text="entry.tail" />
        <ThreadToolStatusIcon class="ai-thread-tool-call__status" :status="entry.status" />
      </span>
      <ChevronDown class="ai-thread-tool-call__chevron size-4" v-if="hasContent" aria-hidden="true" />
      <span v-else class="ai-thread-tool-call__chevron-spacer" aria-hidden="true" />
    </button>

    <div v-if="isExpanded" class="ai-thread-tool-call__panel">
      <template v-for="item in entry.content" :key="item.id">
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
              :title="item.file.path"
              v-text="item.file.path"
            />
            <span class="ai-thread-tool-call__diff-stat is-add">+<span v-text="item.file.additions" /></span>
            <span class="ai-thread-tool-call__diff-stat is-delete">-<span v-text="item.file.deletions" /></span>
          </div>
          <div class="ai-thread-tool-call__diff-body">
            <AiDiffHunkViewer
              v-for="hunk in (item.hunks ?? resolveHunks(item.file.path))"
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

/* Zed 风格:工具参数(路径 / 命令 / 正则)以浅灰圆角 code chip 呈现,与动词区分。 */
.ai-thread-tool-call__argument {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface-soft, #f6f6f6) 80%, transparent);
  padding: 0 6px;
  color: var(--text-primary);
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
