<script setup lang="ts">
import LegacySshSidebarPanel from '@/components/workbench/SshSidebarPanel.vue';

const emit = defineEmits<{
  'open-terminal': [];
}>();
</script>

<template>
  <LegacySshSidebarPanel @open-terminal="emit('open-terminal')" />
</template>
