<template>
  <DropdownMenuRoot v-model:open="resolvedOpen">
    <DropdownMenuTrigger as-child>
      <slot name="trigger" :open="resolvedOpen" />
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
class="dropdown-menu-panel motion-dropdown-surface z-1250 overflow-hidden outline-none"
        :class="[{ 'is-menubar': props.variant === 'menubar' }, props.contentClass]" :align="contentAlign"
        :side-offset="8" :collision-padding="8" :style="{ minWidth: `${props.minWidth}px` }">
        <template v-for="item in props.items" :key="item.key">
          <DropdownMenuSeparator
v-if="item.separatorBefore" class="dropdown-menu-separator"
            :class="{ 'is-menubar': props.variant === 'menubar' }" />
          <DropdownMenuSub v-if="item.children?.length">
            <DropdownMenuSubTrigger
class="dropdown-menu-item dropdown-menu-sub-trigger w-full text-left outline-none"
              :class="{
                'is-danger': item.tone === 'danger',
                'is-disabled': item.disabled,
                'is-selected': item.selected,
                'is-menubar': props.variant === 'menubar',
              }" :disabled="item.disabled">
              <span class="dropdown-menu-item-body">
                <span v-if="item.icon" class="dropdown-menu-item-leading" aria-hidden="true">
                  <DropdownMenuItemIcon :icon="item.icon" />
                </span>
                <span class="dropdown-menu-item-main">
                  <span class="truncate text-[13px] font-medium">{{ item.label }}</span>
                  <span v-if="item.description" class="mt-1 text-[11px] leading-5 text-(--text-quaternary)">
                    {{ item.description }}
                  </span>
                </span>
              </span>
              <span class="dropdown-menu-item-trailing">
                <span v-if="item.shortcut" class="dropdown-menu-item-shortcut">{{ item.shortcut }}</span>

                <svg
class="dropdown-menu-item-submenu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="9 6 15 12 9 18" />
                </svg>
              </span>
            </DropdownMenuSubTrigger>

            <DropdownMenuPortal>
              <DropdownMenuSubContent
                class="dropdown-menu-panel dropdown-menu-sub-panel motion-dropdown-surface z-1250 overflow-hidden outline-none"
                :class="[{ 'is-menubar': props.variant === 'menubar' }, props.contentClass]" :side-offset="6"
                :collision-padding="8" :style="{ minWidth: `${props.minWidth}px` }">
                <template v-for="child in item.children" :key="child.key">
                  <DropdownMenuSeparator
v-if="child.separatorBefore" class="dropdown-menu-separator"
                    :class="{ 'is-menubar': props.variant === 'menubar' }" />
                  <DropdownMenuItem
class="dropdown-menu-item w-full text-left outline-none" :class="{
                    'is-danger': child.tone === 'danger',
                    'is-disabled': child.disabled,
                    'is-selected': child.selected,
                    'is-menubar': props.variant === 'menubar',
                  }" :disabled="child.disabled" @select="handleSelect(child.key)">
                    <span class="dropdown-menu-item-body">
                      <span v-if="child.icon" class="dropdown-menu-item-leading" aria-hidden="true">
                        <DropdownMenuItemIcon :icon="child.icon" />
                      </span>
                      <span class="dropdown-menu-item-main">
                        <span class="truncate text-[13px] font-medium">{{ child.label }}</span>
                        <span v-if="child.description" class="mt-1 text-[11px] leading-5 text-(--text-quaternary)">
                          {{ child.description }}
                        </span>
                      </span>
                    </span>
                    <span v-if="child.shortcut || child.selected" class="dropdown-menu-item-trailing">
                      <span v-if="child.shortcut" class="dropdown-menu-item-shortcut">{{ child.shortcut }}</span>

                      <span v-if="child.selected" class="dropdown-menu-item-check" aria-hidden="true">
                        <svg
viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor"
                          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                          <path d="m3.5 8.2 2.7 2.7 6.3-6.4" />
                        </svg>
                      </span>
                    </span>
                  </DropdownMenuItem>
                </template>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>

          <DropdownMenuItem
v-else class="dropdown-menu-item w-full text-left outline-none" :class="{
            'is-danger': item.tone === 'danger',
            'is-disabled': item.disabled,
            'is-selected': item.selected,
            'is-menubar': props.variant === 'menubar',
          }" :disabled="item.disabled" @select="handleSelect(item.key)">
            <span class="dropdown-menu-item-body">
              <span v-if="item.icon" class="dropdown-menu-item-leading" aria-hidden="true">
                <DropdownMenuItemIcon :icon="item.icon" />
              </span>
              <span class="dropdown-menu-item-main">
                <span class="truncate text-[13px] font-medium">{{ item.label }}</span>
                <span v-if="item.description" class="mt-1 text-[11px] leading-5 text-(--text-quaternary)">
                  {{ item.description }}
                </span>
              </span>
            </span>
            <span v-if="item.shortcut || item.hasSubmenu || item.selected" class="dropdown-menu-item-trailing">
              <span v-if="item.shortcut" class="dropdown-menu-item-shortcut">{{ item.shortcut }}</span>

              <span v-if="item.selected" class="dropdown-menu-item-check" aria-hidden="true">
                <svg
viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round">
                  <path d="m3.5 8.2 2.7 2.7 6.3-6.4" />
                </svg>
              </span>

              <svg
v-if="item.hasSubmenu" class="dropdown-menu-item-submenu-arrow" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                aria-hidden="true">
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </span>
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<script setup lang="ts">
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { computed, defineComponent, h, ref, type PropType } from 'vue';

type TDropdownMenuIcon = 'message' | 'sparkles' | 'list';

interface IDropdownMenuItem {
  key: string;
  label: string;
  icon?: TDropdownMenuIcon;
  description?: string;
  shortcut?: string;
  disabled?: boolean;
  selected?: boolean;
  separatorBefore?: boolean;
  hasSubmenu?: boolean;
  children?: IDropdownMenuItem[];
  tone?: 'default' | 'danger';
}

const DropdownMenuItemIcon = defineComponent({
  name: 'DropdownMenuItemIcon',
  props: {
    icon: {
      type: String as PropType<TDropdownMenuIcon>,
      required: true,
    },
  },
  setup(props) {
    return () => {
      switch (props.icon) {
        case 'message':
          return h(
            'svg',
            {
              class: 'dropdown-menu-item-icon',
              viewBox: '0 0 20 20',
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': '1.7',
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
              'aria-hidden': 'true',
            },
            [
              h('path', { d: 'M4.5 5.5h11a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 2.5V14.5h-1a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z' }),
            ],
          );
        case 'sparkles':
          return h(
            'svg',
            {
              class: 'dropdown-menu-item-icon',
              viewBox: '0 0 20 20',
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': '1.7',
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
              'aria-hidden': 'true',
            },
            [
              h('path', { d: 'M9.75 3.25 11.35 7 15.1 8.6 11.35 10.2 9.75 13.95 8.15 10.2 4.4 8.6 8.15 7 9.75 3.25Z' }),
              h('path', { d: 'M15.75 3.75v1.5' }),
              h('path', { d: 'M16.5 4.5H15' }),
              h('path', { d: 'M15.2 13.7v1.1' }),
              h('path', { d: 'M15.75 14.25h-1.1' }),
            ],
          );
        case 'list':
          return h(
            'svg',
            {
              class: 'dropdown-menu-item-icon',
              viewBox: '0 0 20 20',
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': '1.7',
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
              'aria-hidden': 'true',
            },
            [
              h('path', { d: 'M7.5 5.5h8' }),
              h('path', { d: 'M7.5 10h8' }),
              h('path', { d: 'M7.5 14.5h8' }),
              h('circle', { cx: '4.5', cy: '5.5', r: '0.7', fill: 'currentColor', stroke: 'none' }),
              h('circle', { cx: '4.5', cy: '10', r: '0.7', fill: 'currentColor', stroke: 'none' }),
              h('circle', { cx: '4.5', cy: '14.5', r: '0.7', fill: 'currentColor', stroke: 'none' }),
            ],
          );
      }
    };
  },
});

const props = withDefaults(
  defineProps<{
    items: IDropdownMenuItem[];
    align?: 'left' | 'right';
    minWidth?: number;
    contentClass?: string;
    variant?: 'default' | 'menubar';
    open?: boolean;
  }>(),
  {
    align: 'left',
    contentClass: '',
    minWidth: 160,
    variant: 'default',
    open: undefined,
  },
);

const emit = defineEmits<{
  select: [key: string];
  'update:open': [value: boolean];
}>();

const isOpen = ref(false);
const contentAlign = computed(() => (props.align === 'right' ? 'end' : 'start'));

const resolvedOpen = computed({
  get: () => props.open ?? isOpen.value,
  set: (value: boolean) => {
    if (props.open === undefined) {
      isOpen.value = value;
    }

    emit('update:open', value);
  },
});

const handleSelect = (key: string): void => {
  emit('select', key);
  resolvedOpen.value = false;
};
</script>
