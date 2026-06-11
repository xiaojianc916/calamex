<script setup lang="ts">
import PathFilterInput from '@/components/workbench/sidebar/search/PathFilterInput.vue';

const props = defineProps<{
  modelValue: string;
  label: string;
  ariaLabel: string;
  workspaceRootPath: string | null;
  isDesktopRuntime: boolean;
  matchCase: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();
</script>

<template>
  <PathFilterInput v-bind="props" @update:model-value="emit('update:modelValue', $event)" />
</template>
