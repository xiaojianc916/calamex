<script setup lang="ts">
import LegacyWorkspaceTreeRow from '@/components/workbench/WorkspaceTreeRow.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyWorkspaceTreeRow v-bind="$attrs" />
</template>
