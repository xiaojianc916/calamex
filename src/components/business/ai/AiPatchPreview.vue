<script setup lang="ts">
import type { IAiPatchSet } from '@/types/ai';

defineProps<{
  patch: IAiPatchSet | null;
  isApplying?: boolean;
}>();

const emit = defineEmits<{
  apply: [];
  close: [];
}>();
</script>

<template>
  <section v-if="patch" class="ai-patch-preview" aria-label="AI Patch 预览">
    <div class="ai-patch-head">
      <div>
        <div class="ai-patch-title">Patch Preview</div>
        <p>{{ patch.summary }}</p>
      </div>
      <button type="button" class="ai-patch-close" aria-label="关闭 Patch 预览" @click="emit('close')">
        ×
      </button>
    </div>
    <div v-for="file in patch.files" :key="file.path" class="ai-patch-file">
      <div class="ai-patch-file-meta">
        <span>{{ file.path }}</span>
        <em>{{ file.hunks.length }} hunks</em>
      </div>
      <pre v-for="hunk in file.hunks" :key="`${file.path}-${hunk.oldStart}-${hunk.newStart}`"><code>{{ hunk.lines.join('\n') }}</code></pre>
    </div>
    <div class="ai-patch-actions">
      <button type="button" class="ai-button is-ghost" @click="emit('close')">暂不应用</button>
      <button type="button" class="ai-button is-primary" :disabled="isApplying" @click="emit('apply')">
        {{ isApplying ? '应用中…' : '确认应用' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ai-patch-preview {
  display: grid;
  gap: 8px;
  margin: 8px 12px;
  border: 1px solid var(--shell-divider);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-soft) 70%, transparent);
  padding: 10px;
}

.ai-patch-head,
.ai-patch-file-meta,
.ai-patch-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ai-patch-title {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}

.ai-patch-preview p,
.ai-patch-file,
.ai-patch-file-meta em {
  color: var(--text-tertiary);
  font-size: 12px;
}

.ai-patch-preview p {
  margin: 2px 0 0;
}

.ai-patch-close {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--text-quaternary);
}

.ai-patch-close:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-patch-file {
  display: grid;
  gap: 6px;
}

.ai-patch-file-meta span {
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-patch-file pre {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 78%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--panel-bg) 86%, transparent);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.55;
  padding: 8px;
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