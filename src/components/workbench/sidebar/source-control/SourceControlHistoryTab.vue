<script setup lang="ts">
import LegacySourceControlHistoryTab from '@/components/workbench/source-control/SourceControlHistoryTab.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacySourceControlHistoryTab v-bind="$attrs" />
</template>
