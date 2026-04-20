<template>
  <DropdownMenuRoot v-model:open="resolvedOpen">
    <DropdownMenuTrigger as-child>
      <slot name="trigger" :open="resolvedOpen" />
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        class="dropdown-menu-panel z-1250 overflow-hidden outline-none"
        :class="{ 'is-menubar': props.variant === 'menubar' }"
        :align="contentAlign"
        :side-offset="8" :collision-padding="8" :style="{ minWidth: `${props.minWidth}px` }">
        <template v-for="item in props.items" :key="item.key">
          <DropdownMenuSeparator
            v-if="item.separatorBefore"
            class="dropdown-menu-separator"
            :class="{ 'is-menubar': props.variant === 'menubar' }"
          />
          <DropdownMenuSub v-if="item.children?.length">
            <DropdownMenuSubTrigger
              class="dropdown-menu-item dropdown-menu-sub-trigger w-full text-left outline-none"
              :class="{
                'is-danger': item.tone === 'danger',
                'is-disabled': item.disabled,
                'is-selected': item.selected,
                'is-menubar': props.variant === 'menubar',
              }"
              :disabled="item.disabled"
            >
              <span class="dropdown-menu-item-main">
                <span class="truncate text-[13px] font-medium">{{ item.label }}</span>
                <span v-if="item.description" class="mt-1 text-[11px] leading-5 text-(--text-quaternary)">
                  {{ item.description }}
                </span>
              </span>
              <span class="dropdown-menu-item-trailing">
                <span v-if="item.shortcut" class="dropdown-menu-item-shortcut">{{ item.shortcut }}</span>

                <svg
                  class="dropdown-menu-item-submenu-arrow"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="9 6 15 12 9 18" />
                </svg>
              </span>
            </DropdownMenuSubTrigger>

            <DropdownMenuPortal>
              <DropdownMenuSubContent
                class="dropdown-menu-panel dropdown-menu-sub-panel z-1250 overflow-hidden outline-none"
                :class="{ 'is-menubar': props.variant === 'menubar' }"
                :side-offset="6"
                :collision-padding="8"
                :style="{ minWidth: `${props.minWidth}px` }"
              >
                <template v-for="child in item.children" :key="child.key">
                  <DropdownMenuSeparator
                    v-if="child.separatorBefore"
                    class="dropdown-menu-separator"
                    :class="{ 'is-menubar': props.variant === 'menubar' }"
                  />
                  <DropdownMenuItem
                    class="dropdown-menu-item w-full text-left outline-none"
                    :class="{
                      'is-danger': child.tone === 'danger',
                      'is-disabled': child.disabled,
                      'is-selected': child.selected,
                      'is-menubar': props.variant === 'menubar',
                    }"
                    :disabled="child.disabled"
                    @select="handleSelect(child.key)"
                  >
                    <span class="dropdown-menu-item-main">
                      <span class="truncate text-[13px] font-medium">{{ child.label }}</span>
                      <span v-if="child.description" class="mt-1 text-[11px] leading-5 text-(--text-quaternary)">
                        {{ child.description }}
                      </span>
                    </span>
                    <span
                      v-if="child.shortcut || child.selected"
                      class="dropdown-menu-item-trailing"
                    >
                      <span v-if="child.shortcut" class="dropdown-menu-item-shortcut">{{ child.shortcut }}</span>

                      <span v-if="child.selected" class="dropdown-menu-item-check" aria-hidden="true">
                        <svg
                          viewBox="0 0 16 16"
                          class="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
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
            v-else
            class="dropdown-menu-item w-full text-left outline-none"
            :class="{
              'is-danger': item.tone === 'danger',
              'is-disabled': item.disabled,
              'is-selected': item.selected,
              'is-menubar': props.variant === 'menubar',
            }"
            :disabled="item.disabled"
            @select="handleSelect(item.key)"
          >
            <span class="dropdown-menu-item-main">
              <span class="truncate text-[13px] font-medium">{{ item.label }}</span>
              <span v-if="item.description" class="mt-1 text-[11px] leading-5 text-(--text-quaternary)">
                {{ item.description }}
              </span>
            </span>
            <span
              v-if="item.shortcut || item.hasSubmenu || item.selected"
              class="dropdown-menu-item-trailing"
            >
              <span v-if="item.shortcut" class="dropdown-menu-item-shortcut">{{ item.shortcut }}</span>

              <span v-if="item.selected" class="dropdown-menu-item-check" aria-hidden="true">
                <svg
                  viewBox="0 0 16 16"
                  class="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m3.5 8.2 2.7 2.7 6.3-6.4" />
                </svg>
              </span>

              <svg
                v-if="item.hasSubmenu"
                class="dropdown-menu-item-submenu-arrow"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
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
import { computed, ref } from 'vue';

interface IDropdownMenuItem {
  key: string;
  label: string;
  description?: string;
  shortcut?: string;
  disabled?: boolean;
  selected?: boolean;
  separatorBefore?: boolean;
  hasSubmenu?: boolean;
  children?: IDropdownMenuItem[];
  tone?: 'default' | 'danger';
}

const props = withDefaults(
  defineProps<{
    items: IDropdownMenuItem[];
    align?: 'left' | 'right';
    minWidth?: number;
    variant?: 'default' | 'menubar';
    open?: boolean;
  }>(),
  {
    align: 'left',
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
