<template>
  <Teleport to="body">
    <div v-if="props.open" class="fixed inset-0 z-[1600] pointer-events-none" @contextmenu.prevent>
      <ContextMenu :open="props.open" :modal="false">
        <ContextMenuTrigger as-child>
          <span aria-hidden="true" class="pointer-events-none fixed size-px opacity-0" :style="anchorStyle" />
        </ContextMenuTrigger>

        <ContextMenuContent align="start" side="bottom" :side-offset="0" :collision-padding="12"
          class="linear-context-menu-root pointer-events-auto w-56">
          <template v-for="(group, groupIndex) in props.groups" :key="group.key">
            <ContextMenuLabel v-if="group.title" class="px-2 py-1.5 text-xs font-medium text-muted-foreground/80">
              {{ group.title }}
            </ContextMenuLabel>

            <template v-for="item in group.items" :key="item.key">
              <ContextMenuSub v-if="item.children?.length">
                <ContextMenuSubTrigger :disabled="item.disabled">
                  <LinearContextMenuIcon :icon="item.icon" class="size-4 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                </ContextMenuSubTrigger>

                <ContextMenuSubContent :side="submenuSide" :side-offset="4" class="linear-context-menu-root w-56">
                  <ContextMenuItem v-for="child in item.children" :key="child.key" :disabled="child.disabled"
                    class="linear-context-menu-item" :variant="child.variant ?? 'default'"
                    @select.prevent="handleItemSelect(child)" @pointerdown.prevent.stop="handleItemPointerDown(child)">
                    <LinearContextMenuIcon :icon="child.icon" class="size-4 text-muted-foreground" />
                    <span class="min-w-0 flex-1 truncate">{{ child.label }}</span>
                    <ContextMenuShortcut v-if="child.shortcut?.length">
                      {{ formatShortcut(child.shortcut) }}
                    </ContextMenuShortcut>
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>

              <ContextMenuItem v-else :disabled="item.disabled" class="linear-context-menu-item"
                :variant="item.variant ?? 'default'" @select.prevent="handleItemSelect(item)"
                @pointerdown.prevent.stop="handleItemPointerDown(item)">
                <LinearContextMenuIcon :icon="item.icon" class="size-4 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                <ContextMenuShortcut v-if="item.shortcut?.length">
                  {{ formatShortcut(item.shortcut) }}
                </ContextMenuShortcut>
              </ContextMenuItem>
            </template>

            <ContextMenuSeparator v-if="groupIndex < props.groups.length - 1" />
          </template>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import LinearContextMenuIcon from '@/components/common/LinearContextMenuIcon.vue';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { TThemeMode } from '@/types/app';
import { computed, ref } from 'vue';

const props = defineProps<{
  open: boolean;
  x: number;
  y: number;
  groups: ILinearContextMenuGroup[];
  theme: TThemeMode;
  submenuDirection: 'left' | 'right';
}>();

const emit = defineEmits<{
  select: [item: ILinearContextMenuItem];
}>();

const pendingPointerKey = ref<string | null>(null);

const anchorStyle = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
}));

const submenuSide = computed(() =>
  props.submenuDirection === 'left' ? 'left' : 'right',
);

const resetPendingPointerKey = (): void => {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(() => {
      pendingPointerKey.value = null;
    });
    return;
  }

  Promise.resolve().then(() => {
    pendingPointerKey.value = null;
  });
};

const emitSelection = (item: ILinearContextMenuItem): void => {
  if (item.disabled || item.children?.length) {
    return;
  }

  emit('select', item);
};

const handleItemPointerDown = (item: ILinearContextMenuItem): void => {
  pendingPointerKey.value = item.key;
  emitSelection(item);
  resetPendingPointerKey();
};

const handleItemSelect = (item: ILinearContextMenuItem): void => {
  if (pendingPointerKey.value === item.key) {
    return;
  }

  emitSelection(item);
};

const formatShortcut = (shortcut: string[]): string => shortcut.join(' ');
</script>
