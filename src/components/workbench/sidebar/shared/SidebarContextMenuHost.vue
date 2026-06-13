<script setup lang="ts">
import { computed } from 'vue';

// TODO(sidebar/shared): consolidate the per-domain context-menu hosts (source
// control, explorer, ssh) onto this shared positioned host. This skeleton fixes
// the public shape; visual styling and behavior are ported incrementally.
const props = defineProps<{
  open: boolean;
  x: number;
  y: number;
  width?: number;
}>();

defineEmits<{
  close: [];
}>();

const positionStyle = computed<Record<string, string | undefined>>(() => ({
  left: props.x + 'px',
  top: props.y + 'px',
  width: props.width === undefined ? undefined : props.width + 'px',
}));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sidebar-context-menu-host" role="menu" :style="positionStyle">
      <slot />
    </div>
  </Teleport>
</template>
