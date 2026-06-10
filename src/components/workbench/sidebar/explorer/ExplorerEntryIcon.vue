<script setup lang="ts">
import LegacyExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyExplorerEntryIcon v-bind="$attrs" />
</template>
