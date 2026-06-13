<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    description?: string;
  }>(),
  { description: '' },
);
</script>

<template>
  <div class="sidebar-section-header">
    <p class="sidebar-section-header__title" v-text="title" />
    <p v-if="description" class="sidebar-section-header__description" v-text="description" />
    <div v-if="$slots.actions" class="sidebar-section-header__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.sidebar-section-header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
}

.sidebar-section-header__title {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-quaternary);
}

.sidebar-section-header__description {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-tertiary);
}

.sidebar-section-header__actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
</style>
