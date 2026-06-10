<script setup lang="ts">
import LegacyWorkbenchDashboardSidebar from '@/components/workbench/WorkbenchDashboardSidebar.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyWorkbenchDashboardSidebar v-bind="$attrs" />
</template>
