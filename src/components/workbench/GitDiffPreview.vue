<template>
  <section class="git-diff-preview" aria-label="Git diff 预览">
    <header class="git-diff-preview__header">
      <div class="git-diff-preview__header-copy">
        <p class="git-diff-preview__eyebrow">Git Diff</p>

        <template v-if="entry">
          <div class="git-diff-preview__title-row">
            <span
              class="source-control-file-tag git-diff-preview__tag"
              :class="statusToneClass"
            >
              {{ statusTag }}
            </span>

            <div class="git-diff-preview__title-copy">
              <p class="git-diff-preview__title">{{ entry.fileName }}</p>
              <p class="git-diff-preview__meta">{{ headerMeta }}</p>
            </div>
          </div>
        </template>

        <template v-else>
          <p class="git-diff-preview__title">选择一个变更文件</p>
          <p class="git-diff-preview__meta">这里会显示逐行 Git diff 预览。</p>
        </template>
      </div>

      <div class="git-diff-preview__header-actions">
        <div v-if="diffSummary" class="git-diff-preview__metrics" aria-label="变更统计">
          <span class="git-diff-preview__metric is-added">+{{ diffSummary.addedLineCount }}</span>
          <span class="git-diff-preview__metric is-deleted">-{{ diffSummary.deletedLineCount }}</span>
        </div>

        <button
          v-if="entry"
          type="button"
          class="source-control-btn source-control-btn-ghost git-diff-preview__open-btn"
          @click="handleOpenFile"
        >
          打开
        </button>
      </div>
    </header>

    <div v-if="!entry" class="git-diff-preview__state">
      <p class="git-diff-preview__state-title">没有选中的文件</p>
      <p class="git-diff-preview__state-text">从上面的变更列表里选择一个文件，即可在这里查看统一 diff。</p>
    </div>

    <div v-else-if="isLoading" class="git-diff-preview__state">
      <p class="git-diff-preview__state-title">正在读取 diff</p>
      <p class="git-diff-preview__state-text">正在加载 Git 基线和当前文件内容。</p>
    </div>

    <div v-else-if="errorMessage" class="git-diff-preview__state is-error">
      <p class="git-diff-preview__state-title">暂时无法显示 diff</p>
      <p class="git-diff-preview__state-text">{{ errorMessage }}</p>
    </div>

    <div v-else-if="!hasPreviewableContent" class="git-diff-preview__state">
      <p class="git-diff-preview__state-title">当前文件不支持文本预览</p>
      <p class="git-diff-preview__state-text">这个变更目前没有可直接显示的文本内容。</p>
    </div>

    <div v-else-if="!diffSummary || diffSummary.hunks.length === 0" class="git-diff-preview__state">
      <p class="git-diff-preview__state-title">没有可显示的差异</p>
      <p class="git-diff-preview__state-text">当前文件与 Git 基线一致。</p>
    </div>

    <div v-else class="git-diff-preview__viewport">
      <div class="git-diff-preview__code-view">
        <template v-for="hunk in diffSummary.hunks" :key="hunk.key">
          <div class="git-diff-preview__hunk-sep">
            <span class="git-diff-preview__hunk-bar"></span>
            <span class="git-diff-preview__hunk-ln">…</span>
            <span class="git-diff-preview__hunk-gap"></span>
            <span class="git-diff-preview__hunk-range">{{ hunk.header }}</span>
          </div>

          <div
            v-for="line in hunk.lines"
            :key="line.key"
            class="git-diff-preview__line"
            :class="lineClass(line.type)"
          >
            <span class="git-diff-preview__line-bar"></span>
            <span class="git-diff-preview__line-number">
              {{ line.displayLineNumber ?? '' }}
            </span>
            <span class="git-diff-preview__line-gap"></span>
            <span class="git-diff-preview__line-source">{{ line.content || ' ' }}</span>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { IGitFileStatusPayload } from '@/types/git';
import { buildGitDiffPreview } from '@/utils/git-diff';
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    entry: IGitFileStatusPayload | null;
    sectionTitle?: string;
    statusTag?: string;
    statusTone?: string;
    baselineContent?: string | null;
    currentContent?: string | null;
    isLoading?: boolean;
    errorMessage?: string | null;
  }>(),
  {
    sectionTitle: '',
    statusTag: 'M',
    statusTone: 'modified',
    baselineContent: null,
    currentContent: null,
    isLoading: false,
    errorMessage: null,
  },
);

const emit = defineEmits<{
  'open-file': [path: string];
}>();

const hasPreviewableContent = computed(
  () => props.baselineContent !== null && props.currentContent !== null,
);

const diffSummary = computed(() => {
  if (!props.entry || props.isLoading || props.errorMessage || !hasPreviewableContent.value) {
    return null;
  }

  return buildGitDiffPreview(props.baselineContent ?? '', props.currentContent ?? '');
});

const headerMeta = computed(() => {
  if (!props.entry) {
    return '';
  }

  if (props.entry.previousRelativePath) {
    return `${props.sectionTitle} · ${props.entry.previousRelativePath} → ${props.entry.relativePath}`;
  }

  return `${props.sectionTitle} · ${props.entry.relativePath}`;
});

const statusToneClass = computed(() => `is-${props.statusTone}`);

const lineClass = (type: 'context' | 'added' | 'deleted'): string => {
  switch (type) {
    case 'added':
      return 'is-added';
    case 'deleted':
      return 'is-deleted';
    default:
      return 'is-context';
  }
};

const handleOpenFile = (): void => {
  if (!props.entry) {
    return;
  }

  emit('open-file', props.entry.path);
};
</script>

<style scoped>
.git-diff-preview {
  display: flex;
  height: clamp(220px, 34vh, 360px);
  min-height: 220px;
  flex-direction: column;
  border-top: 1px solid var(--scm-border);
  background:
    linear-gradient(180deg, rgba(18, 18, 20, 0.96) 0%, rgba(15, 15, 18, 0.98) 100%);
}

.git-diff-preview__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--scm-border);
  padding: 10px 12px;
}

.git-diff-preview__header-copy {
  min-width: 0;
  flex: 1;
}

.git-diff-preview__eyebrow {
  margin: 0 0 6px;
  color: var(--scm-text-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.git-diff-preview__title-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.git-diff-preview__tag {
  padding-top: 2px;
}

.git-diff-preview__title-copy {
  min-width: 0;
  flex: 1;
}

.git-diff-preview__title {
  margin: 0;
  overflow: hidden;
  color: var(--scm-text);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-diff-preview__meta {
  margin: 3px 0 0;
  overflow: hidden;
  color: var(--scm-text-faint);
  font-size: 11px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-diff-preview__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.git-diff-preview__metrics {
  display: flex;
  align-items: center;
  gap: 6px;
}

.git-diff-preview__metric {
  border-radius: 999px;
  padding: 2px 8px;
  font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', Consolas, Menlo, monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.git-diff-preview__metric.is-added {
  background: rgba(75, 156, 75, 0.15);
  color: #8fe18f;
}

.git-diff-preview__metric.is-deleted {
  background: rgba(188, 45, 42, 0.16);
  color: #ff9b96;
}

.git-diff-preview__open-btn {
  padding-right: 9px;
  padding-left: 9px;
  font-size: 11.5px;
}

.git-diff-preview__state {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  padding: 16px 14px;
}

.git-diff-preview__state.is-error {
  background: linear-gradient(180deg, rgba(74, 31, 31, 0.12) 0%, rgba(20, 20, 24, 0) 100%);
}

.git-diff-preview__state-title {
  margin: 0;
  color: var(--scm-text);
  font-size: 12.5px;
  font-weight: 600;
}

.git-diff-preview__state-text {
  margin: 6px 0 0;
  color: var(--scm-text-dim);
  font-size: 11.5px;
  line-height: 1.6;
}

.git-diff-preview__viewport {
  min-height: 0;
  flex: 1;
  overflow: auto;
  background: #1e1e1e;
}

.git-diff-preview__viewport::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.git-diff-preview__viewport::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
}

.git-diff-preview__viewport::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.22);
}

.git-diff-preview__code-view {
  min-width: max-content;
  padding: 8px 0;
  color: #d4d4d4;
  font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', Consolas, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.6;
}

.git-diff-preview__hunk-sep,
.git-diff-preview__line {
  display: grid;
  grid-template-columns: 4px 50px 4px minmax(0, 1fr);
  align-items: stretch;
  min-height: 1.6em;
}

.git-diff-preview__hunk-sep {
  background: #2a2a2a;
  border-top: 1px solid #3a3a3a;
  border-bottom: 1px solid #3a3a3a;
  color: #9aa0a6;
  font-size: 11.5px;
  user-select: none;
}

.git-diff-preview__hunk-bar,
.git-diff-preview__hunk-gap {
  background: transparent;
}

.git-diff-preview__hunk-ln {
  padding: 2px 6px 2px 0;
  color: #6e7681;
  text-align: right;
}

.git-diff-preview__hunk-range {
  padding: 2px 12px 2px 6px;
  color: #9aa0a6;
}

.git-diff-preview__line {
  background: #1e1e1e;
}

.git-diff-preview__line-bar {
  align-self: stretch;
}

.git-diff-preview__line-number {
  padding: 0 6px 0 0;
  background: #1e1e1e;
  color: #858585;
  font-variant-numeric: tabular-nums;
  text-align: right;
  user-select: none;
}

.git-diff-preview__line-gap {
  background: #1e1e1e;
}

.git-diff-preview__line-source {
  padding: 0 16px 0 4px;
  min-width: max-content;
  overflow: hidden;
  background: #1e1e1e;
  color: #d4d4d4;
  white-space: pre;
}

.git-diff-preview__line.is-context:hover .git-diff-preview__line-number,
.git-diff-preview__line.is-context:hover .git-diff-preview__line-source {
  background: #2a2d2e;
}

.git-diff-preview__line.is-added .git-diff-preview__line-bar {
  background: #4b9c4b;
}

.git-diff-preview__line.is-added .git-diff-preview__line-number,
.git-diff-preview__line.is-added .git-diff-preview__line-source {
  background: #1b3a24;
}

.git-diff-preview__line.is-deleted .git-diff-preview__line-bar {
  background: #bc2d2a;
}

.git-diff-preview__line.is-deleted .git-diff-preview__line-number,
.git-diff-preview__line.is-deleted .git-diff-preview__line-source {
  background: #4a1f1f;
}
</style>