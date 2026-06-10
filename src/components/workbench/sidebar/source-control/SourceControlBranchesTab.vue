<script setup lang="ts">
import LegacySourceControlBranchesTab from '@/components/workbench/source-control/SourceControlBranchesTab.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacySourceControlBranchesTab v-bind="$attrs" />
</template>
