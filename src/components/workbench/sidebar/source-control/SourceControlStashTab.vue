<script setup lang="ts">
import LegacySourceControlStashTab from '@/components/workbench/source-control/SourceControlStashTab.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacySourceControlStashTab v-bind="$attrs" />
</template>
