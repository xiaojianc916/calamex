<script setup lang="ts">
defineProps<{
  text: string;
}>();
</script>

<template>
  <span v-if="text" class="ai-inline-ghost">{{ text }}</span>
</template>

<style scoped>
.ai-inline-ghost {
  color: var(--text-quaternary);
  font-style: italic;
}
</style>
