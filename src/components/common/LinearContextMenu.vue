<template>
  <Teleport to="body">
    <ContextMenu v-if="props.open" :modal="false">
      <ContextMenuTrigger as-child>
        <span
ref="triggerRef" aria-hidden="true" class="linear-context-menu-trigger fixed size-px opacity-0"
          :style="anchorStyle" />
      </ContextMenuTrigger>

      <ContextMenuContent class="linear-context-menu-root w-52 border border-[#e8e8e8] bg-[#ffffff] text-[#1f1f1f]">
        <template v-for="(group, groupIndex) in props.groups" :key="group.key">
          <ContextMenuLabel v-if="group.title" class="text-[#4a4a4a]">
            {{ group.title }}
          </ContextMenuLabel>

          <template v-for="item in group.items" :key="item.key">
            <ContextMenuSub v-if="item.children?.length">
              <ContextMenuSubTrigger
:disabled="item.disabled" :inset="resolveItemInset(item)"
                class="text-[#1f1f1f] focus:bg-[#f5f5f5] focus:text-[#1f1f1f] data-[highlighted]:bg-[#f5f5f5] data-[highlighted]:text-[#1f1f1f] data-[state=open]:bg-[#f5f5f5] data-[state=open]:text-[#1f1f1f]">
                <LinearContextMenuIcon v-if="item.icon" :icon="item.icon" class="size-4" />
                <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                <ContextMenuShortcut v-if="item.shortcut?.length" class="text-[#666666]">
                  {{ formatShortcut(item.shortcut) }}
                </ContextMenuShortcut>
              </ContextMenuSubTrigger>

              <ContextMenuSubContent
:side="submenuSide" :side-offset="4"
                class="linear-context-menu-root w-44 border border-[#e8e8e8] bg-[#ffffff] text-[#1f1f1f]">
                <ContextMenuItem
v-for="child in item.children" :key="child.key" :disabled="child.disabled"
                  :inset="resolveItemInset(child)" :variant="child.variant ?? 'default'"
                  class="text-[#1f1f1f] focus:bg-[#f5f5f5] focus:text-[#1f1f1f] data-[highlighted]:bg-[#f5f5f5] data-[highlighted]:text-[#1f1f1f]"
                  @select.prevent="handleItemSelect(child)" @pointerdown.prevent.stop="handleItemPointerDown(child)">
                  <LinearContextMenuIcon v-if="child.icon" :icon="child.icon" class="size-4" />
                  <span class="min-w-0 flex-1 truncate">{{ child.label }}</span>
                  <ContextMenuShortcut v-if="child.shortcut?.length" class="text-[#666666]">
                    {{ formatShortcut(child.shortcut) }}
                  </ContextMenuShortcut>
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>

            <ContextMenuItem
v-else :disabled="item.disabled" :inset="resolveItemInset(item)"
              :variant="item.variant ?? 'default'"
              class="text-[#1f1f1f] focus:bg-[#f5f5f5] focus:text-[#1f1f1f] data-[highlighted]:bg-[#f5f5f5] data-[highlighted]:text-[#1f1f1f]"
              @select.prevent="handleItemSelect(item)" @pointerdown.prevent.stop="handleItemPointerDown(item)">
              <LinearContextMenuIcon v-if="item.icon" :icon="item.icon" class="size-4" />
              <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
              <ContextMenuShortcut v-if="item.shortcut?.length" class="text-[#666666]">
                {{ formatShortcut(item.shortcut) }}
              </ContextMenuShortcut>
            </ContextMenuItem>
          </template>

          <ContextMenuSeparator v-if="groupIndex < props.groups.length - 1" class="bg-[#eeeeee]" />
        </template>
      </ContextMenuContent>
    </ContextMenu>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import LinearContextMenuIcon from '@/components/common/LinearContextMenuIcon.vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
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
const triggerRef = ref<HTMLElement | null>(null);

const anchorStyle = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
}));

const submenuSide = computed(() => (props.submenuDirection === 'left' ? 'left' : 'right'));

const createOpenEvent = (): MouseEvent | PointerEvent => {
  const ContextMenuEvent = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;

  return new ContextMenuEvent('contextmenu', {
    bubbles: false,
    cancelable: true,
    button: 2,
    clientX: props.x,
    clientY: props.y,
  });
};

const dispatchOpenEvent = (): void => {
  const trigger = triggerRef.value;
  if (!trigger) {
    return;
  }

  trigger.dispatchEvent(createOpenEvent());
};

watch(
  () => [props.open, props.x, props.y] as const,
  async ([open]) => {
    if (!open) {
      return;
    }

    await nextTick();
    dispatchOpenEvent();
  },
  { flush: 'post' },
);

onMounted(async () => {
  if (!props.open) {
    return;
  }

  await nextTick();
  dispatchOpenEvent();
});

const resetPendingPointerKey = (): void => {
  // pointerdown 会先于 reka-ui 的 select 事件触发。
  // 这里不能用 queueMicrotask 清理，否则后续 pointerup/click 阶段的 select
  // 可能已经看不到 pendingPointerKey，导致同一个菜单项重复 emit select。
  window.setTimeout(() => {
    pendingPointerKey.value = null;
  }, 0);
};

const emitSelection = (item: ILinearContextMenuItem): void => {
  if (item.disabled || item.children?.length) {
    return;
  }

  emit('select', item);
};

const resolveItemInset = (item: ILinearContextMenuItem): boolean => item.inset ?? !item.icon;

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
