<script setup lang="ts">
import LegacySearchSidebarPanel from '@/components/workbench/SearchSidebarPanel.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacySearchSidebarPanel v-bind="$attrs" />
</template>
