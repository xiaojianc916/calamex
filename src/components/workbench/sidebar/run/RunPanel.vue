<script setup lang="ts">
import LegacyRunPanel from '@/components/workbench/RunPanel.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyRunPanel v-bind="$attrs" />
</template>
