<script setup lang="ts">
// TODO(sidebar/ssh): migrate recent-connection selection out of the legacy
// SshSidebarPanel. This skeleton fixes the public shape.
defineEmits<{
  select: [connectionId: string];
}>();
</script>

<template>
  <section class="ssh-recent-connections" aria-label="最近的 SSH 连接">
    <slot />
  </section>
</template>
