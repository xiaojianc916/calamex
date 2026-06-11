<template>
  <DeferredLinearContextMenu
    v-if="open"
    :open="open"
    :x="x"
    :y="y"
    :groups="groups"
    :theme="theme"
    :submenu-direction="submenuDirection"
    @select="(item) => emit('select', item)"
  />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import type { TThemeMode } from '@/types/app';

const DeferredLinearContextMenu = defineAsyncComponent({
  loader: () => import('@/components/common/LinearContextMenu.vue'),
  suspensible: false,
});

const props = defineProps<{
  open: boolean;
  x: number;
  y: number;
  groups: ILinearContextMenuGroup[];
  theme: TThemeMode;
}>();

const emit = defineEmits<{
  select: [item: ILinearContextMenuItem];
}>();

const submenuDirection = computed<'left' | 'right'>(() => (props.x > 280 ? 'left' : 'right'));
</script>
