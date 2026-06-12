<template>
  <div class="ai-web-preview-navigation" data-slot="web-preview-navigation">
    <slot />
  </div>
</template>

<style scoped>
.ai-web-preview-navigation {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: #ffffff;
}
</style>
