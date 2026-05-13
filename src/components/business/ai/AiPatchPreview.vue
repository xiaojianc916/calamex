<script setup lang="ts">
import { CopyIcon } from 'lucide-vue-next';
import { computed } from 'vue';

import AiDiffHunkViewer from '@/components/business/ai/AiDiffHunkViewer.vue';
import type {
  IAiDiffHunkPreview,
  IAiPatchSet,
} from '@/types/ai';
import type { IGitDiffPreviewPayload } from '@/types/git';
import { buildAiPatchPreviewFiles, type IAiPatchPreviewFile } from '@/utils/ai-patch-preview';
import { tryWriteClipboardText } from '@/utils/clipboard';

interface IPatchFileStats {
  additions: number;
  deletions: number;
}

const props = defineProps<{
  patch: IAiPatchSet | null;
  isApplying?: boolean;
  isApplied?: boolean;
  variant?: 'review' | 'message';
  workspaceRootPath?: string | null;
}>();

const emit = defineEmits<{
  apply: [];
  close: [];
  'open-diff': [payload: IGitDiffPreviewPayload];
}>();

const previewFiles = computed<IAiPatchPreviewFile[]>(() =>
  props.patch ? buildAiPatchPreviewFiles(props.patch, props.workspaceRootPath) : [],
);

const patchStats = computed(() =>
  previewFiles.value.reduce<IPatchFileStats>(
    (total, file) => {
      const stats = getFileStats(file);

      return {
        additions: total.additions + stats.additions,
        deletions: total.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  ),
);

const isMessageVariant = computed(() => props.variant === 'message');

const getFileName = (path: string): string => {
  const normalized = path.replace(/\\/gu, '/');
  const fileName = normalized.split('/').filter((part) => part.length > 0).at(-1);

  return fileName ?? path;
};

const getFileStats = (file: IAiPatchPreviewFile): IPatchFileStats => {
  let additions = 0;
  let deletions = 0;

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        additions += 1;
      } else if (line.kind === 'delete') {
        deletions += 1;
      }
    }
  }

  return { additions, deletions };
};

const getLineSign = (line: IAiDiffHunkPreview['lines'][number]): string => {
  if (line.kind === 'add') {
    return '+';
  }

  if (line.kind === 'delete') {
    return '-';
  }

  return ' ';
};

const buildFileDiffText = (file: IAiPatchPreviewFile): string =>
  file.hunks
    .flatMap((hunk) => [
      hunk.header,
      ...hunk.lines.map((line) => `${getLineSign(line)}${line.content}`),
    ])
    .join('\n');

const copyFileDiff = async (event: MouseEvent, file: IAiPatchPreviewFile): Promise<void> => {
  event.preventDefault();
  event.stopPropagation();

  await tryWriteClipboardText(buildFileDiffText(file));
};
</script>

<template>
  <section
    v-if="patch"
    class="ai-patch-preview"
    :class="{ 'is-message': isMessageVariant }"
    aria-label="AI Patch 预览"
  >
    <div v-if="!isMessageVariant" class="ai-patch-review-head">
      <span>{{ previewFiles.length }} 文件</span>
      <span class="is-add">+{{ patchStats.additions }}</span>
      <span class="is-delete">-{{ patchStats.deletions }}</span>
      <button type="button" class="ai-patch-review-close" aria-label="关闭 Patch 预览" @click="emit('close')">
        ×
      </button>
    </div>

    <details v-for="file in previewFiles" :key="file.path" class="ai-patch-file">
      <summary class="ai-patch-file-summary">
        <span class="ai-patch-file-name" :title="file.displayPath">{{ getFileName(file.displayPath) }}</span>
        <span class="ai-patch-file-stat is-add">+{{ getFileStats(file).additions }}</span>
        <span class="ai-patch-file-stat is-delete">-{{ getFileStats(file).deletions }}</span>
        <button
          type="button"
          class="ai-patch-copy-button"
          aria-label="复制 Diff"
          title="复制 Diff"
          @click="copyFileDiff($event, file)"
        >
          <CopyIcon aria-hidden="true" />
        </button>
      </summary>
      <div class="ai-patch-file-body">
        <AiDiffHunkViewer v-for="hunk in file.hunks" :key="hunk.id" :hunk="hunk" />
      </div>
      <div v-if="!isMessageVariant" class="ai-patch-file-footer">
        <button type="button" class="ai-patch-diff-button" @click="emit('open-diff', file.gitDiffPreview)">
          打开 Diff 面板
        </button>
      </div>
    </details>

    <div v-if="!isMessageVariant" class="ai-patch-actions">
      <button type="button" class="ai-button is-ghost" @click="emit('close')">
        {{ isApplied ? '关闭预览' : '暂不应用' }}
      </button>
      <button
        v-if="!isApplied"
        type="button"
        class="ai-button is-primary"
        :disabled="isApplying"
        @click="emit('apply')"
      >
        {{ isApplying ? '应用中…' : '确认应用' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ai-patch-preview {
  display: grid;
  width: min(100%, 680px);
  gap: 8px;
  margin: 0;
}

.ai-patch-preview:not(.is-message) {
  margin: 8px 12px;
}

.ai-patch-review-head,
.ai-patch-actions,
.ai-patch-file-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-patch-review-head {
  color: var(--text-tertiary);
  font-size: 12px;
}

.ai-patch-review-head .is-add,
.ai-patch-file-stat.is-add {
  color: var(--success);
}

.ai-patch-review-head .is-delete,
.ai-patch-file-stat.is-delete {
  color: var(--danger);
}

.ai-patch-review-close {
  width: 22px;
  height: 22px;
  margin-left: auto;
  border-radius: 5px;
  color: var(--text-quaternary);
}

.ai-patch-review-close:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-patch-file {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 92%, transparent);
}

.ai-patch-file-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto 28px;
  min-height: 40px;
  cursor: pointer;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid transparent;
  padding: 0 10px 0 14px;
  color: var(--text-secondary);
  list-style: none;
}

.ai-patch-file[open] > .ai-patch-file-summary {
  border-bottom-color: color-mix(in srgb, var(--shell-divider) 76%, transparent);
}

.ai-patch-file-summary::-webkit-details-marker {
  display: none;
}

.ai-patch-file-name {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-patch-file-stat {
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
}

.ai-patch-copy-button {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-quaternary);
}

.ai-patch-copy-button:hover,
.ai-patch-copy-button:focus-visible {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-patch-copy-button svg {
  width: 15px;
  height: 15px;
}

.ai-patch-file-body {
  max-height: 320px;
  overflow: auto;
  padding: 8px 0;
  scrollbar-color: color-mix(in srgb, var(--text-primary) 12%, transparent) transparent;
  scrollbar-width: thin;
}

.ai-patch-file-footer {
  justify-content: flex-end;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  padding: 6px 10px;
}

.ai-patch-diff-button {
  height: 24px;
  border-radius: 6px;
  color: var(--text-quaternary);
  font-size: 11px;
  padding: 0 7px;
}

.ai-patch-diff-button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-patch-actions {
  justify-content: flex-end;
}

.ai-button {
  height: 28px;
  border-radius: 6px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
}

.ai-button.is-ghost {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  background: transparent;
  color: var(--text-tertiary);
}

.ai-button.is-primary {
  border: 0;
  background: var(--accent-strong);
  color: #fff;
}

.ai-button:disabled {
  opacity: 0.55;
}
</style>
