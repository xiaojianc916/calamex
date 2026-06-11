<template>
  <div class="search-panel-path-filter-row">
    <PathFilterInput
      :model-value="includePattern"
      label="包含"
      aria-label="包含的路径或文件"
      :workspace-root-path="workspaceRootPath"
      :is-desktop-runtime="isDesktopRuntime"
      :match-case="matchCase"
      @update:model-value="emit('update:includePattern', $event)"
    />

    <PathFilterInput
      :model-value="excludePattern"
      label="排除"
      aria-label="排除的路径或文件"
      :workspace-root-path="workspaceRootPath"
      :is-desktop-runtime="isDesktopRuntime"
      :match-case="matchCase"
      @update:model-value="emit('update:excludePattern', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import PathFilterInput from './PathFilterInput.vue';

defineProps<{
  includePattern: string;
  excludePattern: string;
  workspaceRootPath: string | null;
  isDesktopRuntime: boolean;
  matchCase: boolean;
}>();

const emit = defineEmits<{
  'update:includePattern': [value: string];
  'update:excludePattern': [value: string];
}>();
</script>
