<script setup lang="ts">
import LegacySearchSidebarPanel from '@/components/workbench/SearchSidebarPanel.vue';
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

<template>
  <LegacySearchSidebarPanel
    :document-path="props.documentPath"
    :is-desktop-runtime="props.isDesktopRuntime"
    :workspace-root-path="props.workspaceRootPath"
    :preloaded-workspace-root="props.preloadedWorkspaceRoot"
    @open-file="emit('open-file', $event)"
  />
</template>
