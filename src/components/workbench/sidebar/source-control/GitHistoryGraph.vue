<script setup lang="ts">
import LegacyGitHistoryGraph from '@/components/workbench/GitHistoryGraph.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyGitHistoryGraph v-bind="$attrs" />
</template>
