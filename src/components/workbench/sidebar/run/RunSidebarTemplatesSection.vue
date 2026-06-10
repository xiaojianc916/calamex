<script setup lang="ts">
import LegacyRunSidebarTemplatesSection from '@/components/workbench/run-sidebar/RunSidebarTemplatesSection.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyRunSidebarTemplatesSection v-bind="$attrs" />
</template>
