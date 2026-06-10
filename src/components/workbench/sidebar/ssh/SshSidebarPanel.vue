<script setup lang="ts">
import LegacySshSidebarPanel from '@/components/workbench/SshSidebarPanel.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacySshSidebarPanel v-bind="$attrs" />
</template>
