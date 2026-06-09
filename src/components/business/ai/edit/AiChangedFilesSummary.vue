<script setup lang="ts">
import { ChevronDown, ExternalLink, Maximize2, Pin, PinOff, Undo2 } from '@lucide/vue';
import { computed, ref } from 'vue';
import CodeBlock from '@/components/ai-elements/code-block/CodeBlock.vue';
import {
  buildAiPatchPreviewFiles,
  formatAiPatchDisplayPath,
} from '@/components/business/ai/edit/patch-preview';
import type {
  IAiAgentChangedFile,
  IAiAgentPatchSummary,
  IAiDiffHunkPreview,
  IAiDiffPreviewLine,
  IAiPatchSet,
} from '@/types/ai';

interface IChangedFileViewModel {
  file: IAiAgentChangedFile;
  hunks: IAiDiffHunkPreview[];
}

const props = defineProps<{
  summary: IAiAgentPatchSummary;
  variant?: 'panel' | 'message';
  patches?: readonly IAiPatchSet[];
  workspaceRootPath?: string | null;
  isReverting?: boolean;
  isPinning?: boolean;
}>();

const emit = defineEmits<{
  viewDiff: [diffRef: string, filePath: string];
  undo: [summaryId: string];
  pin: [summaryId: string, pinned: boolean];
}>();

const isMessageVariant = computed(() => props.variant === 'message');
const changedFileCountLabel = computed(() => `${props.summary.files.length} 个文件已更改`);
const openFileKeys = ref<ReadonlySet<string>>(new Set());
const isReverted = computed(() => Boolean(props.summary.revertedAt));
const isPinned = computed(() => Boolean(props.summary.pinned));
const undoLabel = computed(() => {
  if (props.isReverting) {
    return '撤销中';
  }

  return isReverted.value ? '已撤销' : '撤销';
});
const pinLabel = computed(() => (isPinned.value ? '取消钉住' : '钉住'));

const getFileKey = (file: IAiAgentChangedFile): string =>
  `${props.summary.id}:${file.path}:${file.diffRef}`;

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

const changedFiles = computed<IChangedFileViewModel[]>(() =>
  props.summary.files.map((file) => ({
    file,
    hunks: patchHunksByPath.value.get(formatAiPatchDisplayPath(file.path)) ?? [],
  })),
);

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

const handleViewDiff = (file: IAiAgentChangedFile): void => {
  if (isMessageVariant.value) {
    return;
  }

  emit('viewDiff', file.diffRef, file.path);
};

const isFileOpen = (file: IAiAgentChangedFile): boolean => openFileKeys.value.has(getFileKey(file));

const toggleFile = (file: IAiAgentChangedFile): void => {
  const fileKey = getFileKey(file);
  const nextOpenKeys = new Set(openFileKeys.value);

  if (nextOpenKeys.has(fileKey)) {
    nextOpenKeys.delete(fileKey);
  } else {
    nextOpenKeys.add(fileKey);
  }

  openFileKeys.value = nextOpenKeys;
  handleViewDiff(file);
};

const handleUndo = (): void => {
  if (props.isReverting || isReverted.value) {
    return;
  }

  emit('undo', props.summary.id);
};

const handlePin = (): void => {
  if (props.isPinning) {
    return;
  }

  emit('pin', props.summary.id, !isPinned.value);
};
</script>

<template>
  <section class="ai-changed-files-summary" :class="{ 'is-message': isMessageVariant }" aria-label="已更改文件">
    <header class="ai-changed-files-header">
      <div class="ai-changed-files-title">
        <strong>{{ changedFileCountLabel }}</strong>
        <span class="ai-changed-files-stat is-add">+{{ summary.totalAdditions }}</span>
        <span class="ai-changed-files-stat is-delete">-{{ summary.totalDeletions }}</span>
      </div>
      <div class="ai-changed-files-actions">
        <button type="button" class="ai-changed-files-action is-icon-only" :class="{ 'is-active': isPinned }"
          :disabled="isPinning" :aria-label="pinLabel" :title="pinLabel" @click="handlePin">
          <PinOff v-if="isPinned" aria-hidden="true" />
          <Pin v-else aria-hidden="true" />
        </button>
        <button type="button" class="ai-changed-files-action" :disabled="isReverting || isReverted"
          :aria-label="undoLabel" @click="handleUndo">
          <span>{{ undoLabel }}</span>
          <Undo2 aria-hidden="true" />
        </button>
        <span class="ai-changed-files-action" aria-hidden="true">审核 <ExternalLink /></span>
        <span class="ai-changed-files-action is-icon-only"><Maximize2 /></span>
      </div>
    </header>

    <div class="ai-changed-file-list">
      <div v-for="{ file, hunks } in changedFiles" :key="getFileKey(file)" class="ai-changed-file-item"
        :class="{ 'is-open': isFileOpen(file) }">
        <button type="button" class="ai-changed-file-summary" @click="toggleFile(file)">
          <span class="ai-changed-file-copy">
            <span class="ai-changed-file-path" :title="file.path">{{ file.path }}</span>
            <span class="ai-changed-file-stat is-add">+{{ file.additions }}</span>
            <span class="ai-changed-file-stat is-delete">-{{ file.deletions }}</span>
          </span>
          <ChevronDown class="ai-changed-file-chevron" aria-hidden="true" />
        </button>

        <div v-if="isFileOpen(file) && hunks.length > 0" class="ai-changed-file-diff">
          <div v-for="hunk in hunks" :key="hunk.id" class="ai-changed-file-hunk">
            <div class="ai-changed-file-line-numbers" aria-hidden="true">
              <div class="ai-changed-file-line is-hunk">
                <span class="ai-changed-file-line-number"></span>
              </div>
              <div v-for="line in hunk.lines" :key="line.id" class="ai-changed-file-line" :class="`is-${line.kind}`">
                <span class="ai-changed-file-line-number">{{ getLineNumber(line) }}</span>
              </div>
            </div>
            <CodeBlock class="ai-changed-file-code" :code="getHunkCode(hunk)" language="diff" />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ai-changed-files-summary {
  width: min(100%, 640px);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--panel-bg) 96%, transparent);
}

.ai-changed-files-header {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  padding: 0 14px;
}

.ai-changed-files-title,
.ai-changed-files-actions,
.ai-changed-files-action,
.ai-changed-file-copy,
.ai-changed-file-summary {
  display: flex;
  min-width: 0;
  align-items: center;
}

.ai-changed-files-title {
  flex: 1 1 auto;
  gap: 6px;
}

.ai-changed-files-title strong {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-changed-files-stat,
.ai-changed-file-stat {
  flex: 0 0 auto;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 18px;
}

.is-add {
  color: var(--success);
}

.is-delete {
  color: var(--danger);
}

.ai-changed-files-actions {
  flex: 0 0 auto;
  gap: 12px;
  color: var(--text-quaternary);
}

.ai-changed-files-action {
  flex: 0 0 auto;
  gap: 4px;
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
}

.ai-changed-files-action.is-active {
  color: var(--text-primary);
}

button.ai-changed-files-action {
  cursor: pointer;
}

button.ai-changed-files-action:disabled {
  cursor: default;
  opacity: 0.62;
}

.ai-changed-files-action svg {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.ai-changed-file-list {
  display: grid;
}

.ai-changed-file-item {
  min-width: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
}

.ai-changed-file-item:last-child {
  border-bottom: 0;
}

.ai-changed-file-summary {
  width: 100%;
  min-height: 38px;
  cursor: pointer;
  justify-content: space-between;
  gap: 10px;
  padding: 0 14px;
  color: var(--text-secondary);
  text-align: left;
}

.ai-changed-file-copy {
  flex: 1 1 auto;
  gap: 6px;
}

.ai-changed-file-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 400;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-changed-file-chevron {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--text-quaternary);
}

.ai-changed-file-item.is-open .ai-changed-file-chevron {
  transform: rotate(180deg);
}

.ai-changed-file-diff {
  max-height: 260px;
  overflow: auto;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  scrollbar-color: color-mix(in srgb, var(--text-primary) 12%, transparent) transparent;
  scrollbar-width: thin;
}

.ai-changed-file-hunk {
  display: grid;
  grid-template-columns: 50px minmax(0, 1fr);
  min-width: max-content;
  border-bottom: 4px solid color-mix(in srgb, var(--shell-divider) 50%, transparent);
  background: #ffffff;
}

.ai-changed-file-hunk:last-child {
  border-bottom: 0;
}

.ai-changed-file-line {
  display: grid;
  grid-template-columns: 50px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 20px;
  min-height: 20px;
}

.ai-changed-file-line.is-add {
  background: color-mix(in srgb, var(--success) 12%, transparent);
}

.ai-changed-file-line.is-delete {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.ai-changed-file-line-number {
  user-select: none;
  border-left: 3px solid transparent;
  color: var(--text-quaternary);
  font-variant-numeric: tabular-nums;
  padding-right: 8px;
  text-align: right;
}

.ai-changed-file-line.is-add .ai-changed-file-line-number {
  border-left-color: var(--success);
  color: var(--success);
}

.ai-changed-file-line.is-delete .ai-changed-file-line-number {
  border-left-color: var(--danger);
  color: var(--danger);
}

.ai-changed-file-code {
  border: 0;
  border-radius: 0;
  background: #ffffff;
  overflow: visible;
}

.ai-changed-file-code :deep(.overflow-auto) {
  overflow: visible;
}

.ai-changed-file-code :deep(pre) {
  padding: 0 12px 0 0;
}

.ai-changed-file-code :deep(code) {
  font-size: 11px;
  line-height: 20px;
}

@media (max-width: 760px) {
  .ai-changed-files-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
    padding: 10px 14px;
  }

  .ai-changed-files-actions {
    justify-content: flex-end;
  }

  .ai-changed-files-title strong,
  .ai-changed-file-path {
    font-size: 13px;
  }
}
</style>
