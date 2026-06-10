<script setup lang="ts">
import LegacyExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import type { TFileIconEntryKind } from '@/types/file-icon';

const props = withDefaults(
  defineProps<{
    kind: TFileIconEntryKind;
    path?: string | null;
    expanded?: boolean;
  }>(),
  {
    path: null,
    expanded: false,
  },
);
</script>

<template>
  <LegacyExplorerEntryIcon
    :kind="props.kind"
    :path="props.path"
    :expanded="props.expanded"
  />
</template>
