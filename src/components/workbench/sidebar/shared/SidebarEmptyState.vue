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
  <div class="sidebar-empty-state">
    <div v-if="$slots.media" class="sidebar-empty-state__media" aria-hidden="true">
      <slot name="media" />
    </div>
    <p class="sidebar-empty-state__title" v-text="title" />
    <p v-if="description" class="sidebar-empty-state__description" v-text="description" />
    <div v-if="$slots.actions" class="sidebar-empty-state__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.sidebar-empty-state {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 18px;
  text-align: center;
  color: var(--text-secondary);
}

.sidebar-empty-state__media {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-quaternary);
}

.sidebar-empty-state__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.sidebar-empty-state__description {
  max-width: 240px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-tertiary);
}

.sidebar-empty-state__actions {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}
</style>
