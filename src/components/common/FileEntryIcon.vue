<template>
  <span class="file-entry-icon" aria-hidden="true">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      :viewBox="iconGlyph.viewBox"
      :innerHTML="iconGlyph.body"
    />
  </span>
</template>

<script setup lang="ts">
import type { TFileIconEntryKind } from '@/types/file-icon';
import { resolveFileIconGlyph } from '@/utils/file-icons';
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    kind: TFileIconEntryKind;
    path?: string | null;
    expanded?: boolean;
  }>(),
  {
    path: null,
    expanded: false,
  },
);

const iconGlyph = computed(() =>
  resolveFileIconGlyph({
    kind: props.kind,
    path: props.path,
    expanded: props.expanded,
  }),
);
</script>

<style scoped>
.file-entry-icon {
  --file-icon-size: 16px;
  display: inline-flex;
  width: var(--file-icon-size);
  height: var(--file-icon-size);
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 0;
}

.file-entry-icon svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.file-entry-icon :deep([data-stroke]) {
  fill: none;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.file-entry-icon :deep(text) {
  font-family: var(--font-sans);
  font-weight: 700;
  text-anchor: middle;
}
</style>