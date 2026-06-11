<script setup lang="ts">
import DomainExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';
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
  <DomainExplorerEntryIcon
    :kind="props.kind"
    :path="props.path"
    :expanded="props.expanded"
  />
</template>
