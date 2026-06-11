<script setup lang="ts">
// TODO(sidebar/ssh): migrate the SSH connection form and validation state out
// of the legacy SshSidebarPanel. This skeleton fixes the public shape so the
// coordinator can wire it before the full form UI is ported.
defineEmits<{
  connect: [];
}>();
</script>

<template>
  <form class="ssh-connect-form" @submit.prevent="$emit('connect')">
    <slot />
  </form>
</template>
