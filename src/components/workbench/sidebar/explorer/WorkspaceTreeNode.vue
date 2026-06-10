<script setup lang="ts">
import LegacyWorkspaceTreeNode from '@/components/workbench/WorkspaceTreeNode.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyWorkspaceTreeNode v-bind="$attrs" />
</template>
