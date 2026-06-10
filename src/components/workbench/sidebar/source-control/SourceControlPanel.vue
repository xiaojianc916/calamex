<script setup lang="ts">
import LegacySourceControlPanel from '@/components/workbench/SourceControlPanel.vue';
import type { TWorkbenchOpenFilePayload } from '@/types/editor';
import type { IGitDiffPreviewRequest } from '@/types/git';

const props = defineProps<{
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  activePath: string | null;
}>();

const emit = defineEmits<{
  'open-file': [payload: TWorkbenchOpenFilePayload];
  'open-diff': [payload: IGitDiffPreviewRequest];
}>();
</script>

<template>
  <LegacySourceControlPanel
    :is-desktop-runtime="props.isDesktopRuntime"
    :workspace-root-path="props.workspaceRootPath"
    :active-path="props.activePath"
    @open-file="emit('open-file', $event)"
    @open-diff="emit('open-diff', $event)"
  />
</template>
