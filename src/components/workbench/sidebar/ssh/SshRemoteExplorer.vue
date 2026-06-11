<script setup lang="ts">
// TODO(sidebar/ssh): migrate remote directory listing, breadcrumb, and the
// file/folder context menu out of the legacy SshSidebarPanel.
defineEmits<{
  'open-entry': [path: string];
}>();
</script>

<template>
  <section class="ssh-remote-explorer" aria-label="远程文件">
    <slot />
  </section>
</template>
