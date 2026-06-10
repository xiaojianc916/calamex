<script setup lang="ts">
withDefaults(
  defineProps<{
    ariaLabel: string;
    compact?: boolean;
  }>(),
  { compact: false },
);
</script>

<template>
  <section
    class="sidebar-panel-frame"
    :class="{ 'sidebar-panel-frame--compact': compact }"
    :aria-label="ariaLabel"
  >
    <header v-if="$slots.header" class="sidebar-panel-frame__header">
      <slot name="header" />
    </header>

    <div class="sidebar-panel-frame__body">
      <slot />
    </div>

    <footer v-if="$slots.footer" class="sidebar-panel-frame__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.sidebar-panel-frame {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-panel-frame__header,
.sidebar-panel-frame__footer {
  flex: 0 0 auto;
}

.sidebar-panel-frame__body {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.sidebar-panel-frame--compact .sidebar-panel-frame__body {
  padding-block: 0;
}
</style>
