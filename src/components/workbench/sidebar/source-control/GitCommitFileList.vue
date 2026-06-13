<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import type { IGitCommitDetailPayload, IGitCommitFileChangePayload } from '@/types/git';

defineProps<{
  loading: boolean;
  detail: IGitCommitDetailPayload | null;
}>();

const emit = defineEmits<{
  'open-file': [file: IGitCommitFileChangePayload];
}>();

const resolveFileIcon = (status: string): string => {
  switch (status) {
    case 'added':
      return 'file-plus';
    case 'deleted':
      return 'file-minus';
    case 'renamed':
      return 'file-symlink';
    case 'binary':
      return 'file-digit';
    default:
      return 'file-pen-line';
  }
};

const resolveFileDir = (file: IGitCommitFileChangePayload): string => {
  const path = file.relativePath;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
};
</script>

<template>
  <div class="git-history-graph-filelist">
    <div v-if="loading && !detail" class="git-history-graph-filelist-loading">
      <LoaderCircle class="git-history-graph-filelist-spinner" aria-hidden="true" />
      <span v-text="'正在读取文件列表…'" />
    </div>
    <template v-else-if="detail && detail.files.length > 0">
      <div
        v-for="file in detail.files"
        :key="file.relativePath"
        class="git-history-graph-filelist-item"
      >
        <div
          class="git-history-graph-filelist-row"
          role="button"
          tabindex="0"
          @click="emit('open-file', file)"
          @keydown.enter.prevent="emit('open-file', file)"
        >
          <span
            class="git-history-graph-filelist-icon"
            :class="'is-' + file.status"
            aria-hidden="true"
          >
            <LucideIcon :name="resolveFileIcon(file.status)" />
          </span>
          <span class="git-history-graph-filelist-name" v-text="file.fileName" />
          <span
            v-if="file.previousRelativePath"
            class="git-history-graph-filelist-renamed"
            v-text="'← ' + file.previousRelativePath"
          />
          <span class="git-history-graph-filelist-path" v-text="resolveFileDir(file)" />
          <span
            v-if="file.additions > 0"
            class="git-history-graph-filelist-stat git-history-graph-filelist-stat-add"
            v-text="'+' + file.additions"
          />
          <span
            v-if="file.deletions > 0"
            class="git-history-graph-filelist-stat git-history-graph-filelist-stat-del"
            v-text="'-' + file.deletions"
          />
        </div>
      </div>
    </template>
    <div v-else-if="detail" class="git-history-graph-filelist-empty">
      <span v-text="'该提交没有文件变更'" />
    </div>
  </div>
</template>

<style scoped>
.git-history-graph-filelist {
  margin: 0 0 4px;
  border: 1px solid #ebedf0;
  border-top: none;
  border-radius: 0 0 6px 6px;
  background: #fbfcfd;
  overflow: hidden;
}

.git-history-graph-filelist-loading,
.git-history-graph-filelist-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 11px;
  color: #818b98;
}

.git-history-graph-filelist-spinner {
  width: 12px;
  height: 12px;
  animation: git-history-graph-spin 1s linear infinite;
}

@keyframes git-history-graph-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.git-history-graph-filelist-item {
  border-bottom: 1px solid rgba(208, 215, 222, 0.4);
}

.git-history-graph-filelist-item:last-child {
  border-bottom: none;
}

.git-history-graph-filelist-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11.5px;
  color: #1f2328;
  min-height: 24px;
  box-sizing: border-box;
  cursor: pointer;
  transition: background 0.12s ease;
}

.git-history-graph-filelist-row:hover {
  background: rgba(9, 105, 218, 0.06);
}

.git-history-graph-filelist-icon {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #818b98;
}

.git-history-graph-filelist-icon.is-added {
  color: #1a7f37;
}

.git-history-graph-filelist-icon.is-deleted {
  color: #cf222e;
}

.git-history-graph-filelist-icon.is-renamed {
  color: #6e40c9;
}

.git-history-graph-filelist-icon.is-binary {
  color: #818b98;
}

.git-history-graph-filelist-icon.is-modified {
  color: #0550ae;
}

.git-history-graph-filelist-name {
  flex: 0 0 auto;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.git-history-graph-filelist-renamed {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: #818b98;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-history-graph-filelist-path {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: #818b98;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-history-graph-filelist-stat {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.git-history-graph-filelist-stat-add {
  color: #1a7f37;
}

.git-history-graph-filelist-stat-del {
  color: #cf222e;
}
</style>
