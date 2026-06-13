<script setup lang="ts">
import type { ISshFileItem } from '@/types/ssh';

defineProps<{
  items: ISshFileItem[];
  selectedFileId: string;
  loading: boolean;
}>();

const emit = defineEmits<{
  select: [fileId: string];
  open: [fileId: string];
  contextmenu: [event: MouseEvent, fileId: string];
}>();
</script>

<template>
  <div class="ssh-file-list" role="list" aria-label="远端文件列表">
    <div v-if="loading" class="ssh-file-list-state" aria-live="polite">
      正在读取远端目录…
    </div>
    <div v-else-if="items.length === 0" class="ssh-file-list-state">
      当前目录为空
    </div>
    <template v-else>
      <button v-for="item in items" :key="item.id" type="button" class="ssh-file-item" :class="{
        'is-folder': item.kind === 'folder',
        'is-selected': selectedFileId === item.id,
      }" :aria-label="`${item.name}，${item.metaLabel}`" @click="emit('select', item.id)"
        @dblclick="emit('open', item.id)" @contextmenu.prevent="emit('contextmenu', $event, item.id)">
        <span class="ssh-file-icon" :class="`is-${item.kind}`" aria-hidden="true">
          <svg v-if="item.kind === 'folder'" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" />
          </svg>
          <span v-else-if="item.kind === 'rust'">⚙</span>
          <svg v-else-if="item.kind === 'lock'" width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </span>

        <span class="ssh-file-name" v-text="item.name" />
        <span class="ssh-file-meta" v-text="item.metaLabel" />
      </button>
    </template>
  </div>
</template>
