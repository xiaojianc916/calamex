<template>
  <span class="file-entry-icon" aria-hidden="true">
    <img class="file-entry-icon__image" :src="iconSrc" alt="" draggable="false" decoding="async">
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAppStore } from '@/store/app';
import type { TFileIconEntryKind } from '@/types/file-icon';
import { resolveFileIconAsset } from '@/utils/file/file-icons';

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

const appStore = useAppStore();

const iconAsset = computed(() =>
  resolveFileIconAsset({
    kind: props.kind,
    path: props.path,
    expanded: props.expanded,
  }),
);

const iconSrc = computed(() =>
  appStore.theme === 'light' ? iconAsset.value.lightSrc : iconAsset.value.darkSrc,
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

.file-entry-icon__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
