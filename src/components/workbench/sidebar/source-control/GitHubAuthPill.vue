<script setup lang="ts">
import LegacyGitHubAuthPill from '@/components/workbench/GitHubAuthPill.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyGitHubAuthPill v-bind="$attrs" />
</template>
