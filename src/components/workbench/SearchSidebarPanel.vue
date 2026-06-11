<template>
  <SearchSidebarPanel v-bind="props" @open-file="emit('open-file', $event)" />
</template>

<script setup lang="ts">
import SearchSidebarPanel from '@/components/workbench/sidebar/search/SearchSidebarPanel.vue';
import type { IWorkbenchOpenFileRequest, IWorkspaceDirectoryPayload } from '@/types/editor';

const props = defineProps<{
  documentPath: string | null;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
}>();

const emit = defineEmits<{
  'open-file': [payload: IWorkbenchOpenFileRequest];
}>();
</script>
