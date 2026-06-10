<script setup lang="ts">
import LegacySourceControlPullRequestsTab from '@/components/workbench/source-control/SourceControlPullRequestsTab.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacySourceControlPullRequestsTab v-bind="$attrs" />
</template>
