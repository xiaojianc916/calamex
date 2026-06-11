<script setup lang="ts">
// TODO(sidebar/ssh): migrate remote path create/rename/delete dialogs out of
// the legacy SshSidebarPanel. This skeleton fixes the public shape.
defineEmits<{
  'create-directory': [path: string];
  rename: [path: string];
  delete: [path: string];
}>();
</script>

<template>
  <div class="ssh-path-dialogs">
    <slot />
  </div>
</template>
