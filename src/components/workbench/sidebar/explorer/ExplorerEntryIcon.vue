<template>
  <FileEntryIcon
    :kind="kind"
    :path="path"
    :expanded="expanded"
    class="explorer-entry-icon"
  />
</template>

<script setup lang="ts">
import FileEntryIcon from '@/components/common/FileEntryIcon.vue';
import type { TFileIconEntryKind } from '@/types/file-icon';

withDefaults(
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