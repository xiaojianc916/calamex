<script setup lang="ts">
import LegacyAppSidebar from '@/components/workbench/AppSidebar.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyAppSidebar v-bind="$attrs" />
</template>
