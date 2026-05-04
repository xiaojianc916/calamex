<template>
  <header class="editor-tabbar flex flex-col border-b border-(--shell-divider)">
    <!-- Row 1: Tabs + right action buttons -->
    <div class="flex h-9 items-stretch pr-0">
      <div class="flex min-w-0 flex-1 items-stretch gap-0 overflow-x-auto overflow-y-hidden">
        <button
v-for="item in documents" :key="item.id" type="button" class="editor-file-tab app-tooltip-target"
          :class="{
            'is-active': item.id === activeDocumentId,
            'is-dirty': item.isDirty,
          }" :data-tooltip="item.name" data-tooltip-placement="bottom" @click="$emit('select-tab', item.id)">
          <FileEntryIcon kind="file" :path="item.path ?? item.name" class="editor-file-tab-icon" />
          <span class="editor-file-tab-name truncate">{{ item.name }}</span>
          <!-- 未保存圆点：与叉叉同尺寸，避免宽度抖动 -->
          <span class="editor-file-tab-dirty" aria-hidden="true" />
          <!-- 关闭按钮 -->
          <span class="editor-file-tab-close" aria-hidden="true" @click.stop="$emit('close-tab', item.id)">
            <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
              stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
        </button>
      </div>

      <!-- Right action buttons -->
      <div class="tabbar-actions flex items-center gap-0.5 px-1.5">
        <button
type="button" class="tabbar-action-btn" title="导航后退" aria-label="导航后退" :disabled="!canNavigateBack"
          @click="$emit('navigate-back')">
          <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
type="button" class="tabbar-action-btn" title="导航前进" aria-label="导航前进" :disabled="!canNavigateForward"
          @click="$emit('navigate-forward')">
          <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button type="button" class="tabbar-action-btn" title="拆分编辑器" aria-label="拆分编辑器">
          <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="12" y1="3" x2="12" y2="21" />
          </svg>
        </button>
        <button type="button" class="tabbar-action-btn" title="更多操作" aria-label="更多操作">
          <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round">
            <circle cx="5" cy="12" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Row 2: Breadcrumb -->
    <div v-if="showBreadcrumb" class="editor-breadcrumb flex items-center gap-1.5 overflow-hidden px-3.5">
      <span class="truncate text-[12px] text-(--text-tertiary)">{{ breadcrumbText }}</span>
    </div>
  </header>
</template>

<script setup lang="ts">
import FileEntryIcon from '@/components/common/FileEntryIcon.vue';
import type { IEditorDocument } from '@/types/editor';
import { normalizeFileSystemPath } from '@/utils/path';
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  documents: IEditorDocument[];
  activeDocumentId: string;
  filePath: string | null;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  showBreadcrumb?: boolean;
}>(), {
  showBreadcrumb: true,
});

defineEmits<{
  'select-tab': [documentId: string];
  'close-tab': [documentId: string];
  'navigate-back': [];
  'navigate-forward': [];
}>();

const breadcrumbText = computed(() => {
  if (props.documents.length === 0) {
    return '未打开文件';
  }

  if (!props.filePath) {
    return '未保存到本地文件';
  }

  const normalizedPath = normalizeFileSystemPath(props.filePath);
  const segments = normalizedPath.split('/');
  return segments.slice(Math.max(0, segments.length - 4)).join(' / ');
});
</script>
