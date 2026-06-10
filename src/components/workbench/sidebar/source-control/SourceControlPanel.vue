<script setup lang="ts">
import LegacySourceControlPanel from '@/components/workbench/SourceControlPanel.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacySourceControlPanel v-bind="$attrs" />
</template>
