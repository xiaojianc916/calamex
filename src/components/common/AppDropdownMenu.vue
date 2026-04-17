<template>
  <div ref="rootRef" class="relative">
    <slot name="trigger" :open="isOpen" :toggle="toggle" />

    <div
      v-if="isOpen"
      class="dropdown-menu-panel absolute z-50 mt-2 overflow-hidden"
      :class="align === 'right' ? 'right-0' : 'left-0'"
      :style="{ minWidth: `${minWidth}px` }"
      @click.stop
    >
      <template v-for="item in items" :key="item.key">
        <div v-if="item.separatorBefore" class="mx-2 border-t border-white/[0.08]" />
        <button
          type="button"
          class="dropdown-menu-item w-full text-left"
          :class="{
            'is-danger': item.tone === 'danger',
            'is-disabled': item.disabled,
            'is-selected': item.selected,
          }"
          :disabled="item.disabled"
          @click="handleSelect(item.key, item.disabled)"
        >
          <span class="dropdown-menu-item-main">
            <span class="truncate text-[13px] font-medium">{{ item.label }}</span>
            <span
              v-if="item.description"
              class="mt-1 text-[11px] leading-5 text-[var(--text-quaternary)]"
            >
              {{ item.description }}
            </span>
          </span>
          <span v-if="item.selected" class="dropdown-menu-item-check" aria-hidden="true">
            <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="m3.5 8.2 2.7 2.7 6.3-6.4" />
            </svg>
          </span>
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

interface IDropdownMenuItem {
  key: string;
  label: string;
  description?: string;
  disabled?: boolean;
  selected?: boolean;
  separatorBefore?: boolean;
  tone?: 'default' | 'danger';
}

const props = withDefaults(
  defineProps<{
    items: IDropdownMenuItem[];
    align?: 'left' | 'right';
    minWidth?: number;
  }>(),
  {
    align: 'left',
    minWidth: 160,
  },
);

const emit = defineEmits<{
  select: [key: string];
}>();

const rootRef = ref<HTMLElement | null>(null);
const isOpen = ref(false);

const close = (): void => {
  isOpen.value = false;
};

const toggle = (): void => {
  isOpen.value = !isOpen.value;
};

const handleSelect = (key: string, disabled = false): void => {
  if (disabled) {
    return;
  }

  emit('select', key);
  close();
};

const handleClickOutside = (event: MouseEvent): void => {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }

  if (!rootRef.value?.contains(target)) {
    close();
  }
};

const handleEscape = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    close();
  }
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
  window.addEventListener('keydown', handleEscape);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  window.removeEventListener('keydown', handleEscape);
});
</script>
