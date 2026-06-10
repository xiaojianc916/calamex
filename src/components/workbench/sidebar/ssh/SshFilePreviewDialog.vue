<script setup lang="ts">
import LegacySshFilePreviewDialog from '@/components/workbench/SshFilePreviewDialog.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacySshFilePreviewDialog v-bind="$attrs" />
</template>
