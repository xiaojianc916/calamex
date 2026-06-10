<script setup lang="ts">
import LegacyPathFilterInput from '@/components/workbench/PathFilterInput.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <LegacyPathFilterInput v-bind="$attrs" />
</template>
