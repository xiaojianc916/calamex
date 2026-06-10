<script setup lang="ts">
import LegacyRunSidebarPanel from '@/components/workbench/RunSidebarPanel.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyRunSidebarPanel v-bind="$attrs" />
</template>
