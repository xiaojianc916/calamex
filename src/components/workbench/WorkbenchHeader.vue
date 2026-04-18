<template>
  <header class="editor-tabbar flex h-10 items-center justify-between border-b border-[var(--shell-divider)] px-1">
    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden pr-2">
      <button
        v-for="item in documents"
        :key="item.id"
        type="button"
        class="editor-file-tab app-tooltip-target"
        :class="{
          'is-active': item.id === activeDocumentId,
          'is-dirty': item.isDirty,
        }"
        :data-tooltip="item.name"
        data-tooltip-placement="bottom"
        @click="$emit('select-tab', item.id)"
      >
        <svg
          v-if="item.kind === 'image'"
          viewBox="0 0 24 24"
          class="editor-file-tab-icon"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="m7.5 15 3.4-3.4a1 1 0 0 1 1.4 0L16.5 16" />
          <path d="m14.5 14 1.5-1.5a1 1 0 0 1 1.4 0L19 14" />
          <circle cx="9" cy="9" r="1.2" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          class="editor-file-tab-icon"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M14 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9z" />
          <path d="M14 3v6h6" />
        </svg>
        <span class="editor-file-tab-name truncate">{{ item.name }}</span>
        <span class="editor-file-tab-action" aria-hidden="true">
          <span class="editor-file-tab-indicator" />
          <span
            class="editor-file-tab-close"
            @click.stop="$emit('close-tab', item.id)"
          >
            ×
          </span>
        </span>
      </button>
    </div>

    <div class="flex min-w-0 items-center gap-3 px-3 text-[11px] text-[var(--text-quaternary)]">
      <span class="truncate">{{ breadcrumbText }}</span>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { IEditorDocument } from '@/types/editor';

const props = defineProps<{
  documents: IEditorDocument[];
  activeDocumentId: string;
  filePath: string | null;
}>();

defineEmits<{
  'select-tab': [documentId: string];
  'close-tab': [documentId: string];
}>();

const breadcrumbText = computed(() => {
  if (!props.filePath) {
    return '未保存到本地文件';
  }

  const normalizedPath = props.filePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');
  return segments.slice(Math.max(0, segments.length - 4)).join(' / ');
});
</script>
