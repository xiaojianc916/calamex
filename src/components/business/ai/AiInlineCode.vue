<script setup lang="ts">
defineProps<{
  code: string;
}>();
</script>

<template>
  <code class="ai-inline-code">{{ code }}</code>
</template>

<style scoped>
.ai-inline-code {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 80%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--panel-bg) 72%, transparent);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  padding: 1px 4px;
}
</style>
