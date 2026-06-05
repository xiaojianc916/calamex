<template>
  <div class="search-panel-path-filter">
    <span v-text="label" />

    <div class="search-path-filter-control">
      <input
        ref="inputRef"
        class="search-path-filter-input"
        type="text"
        :value="modelValue"
        :placeholder="placeholder"
        :aria-label="resolvedAriaLabel"
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="isMenuOpen"
        @input="handleInput"
        @focus="handleFocus"
        @blur="handleBlur"
        @keydown="handleKeydown"
      >

      <ul v-if="isMenuOpen" ref="menuRef" class="search-path-filter-menu" role="listbox">
        <li
          v-for="(item, index) in suggestions"
          :key="`${item.kind}:${item.insertValue}`"
          class="search-path-filter-option"
          :class="{ 'is-active': index === activeIndex }"
          role="option"
          :aria-selected="index === activeIndex"
          @mousedown.prevent="selectSuggestion(index)"
          @mouseenter="activeIndex = index"
        >
          <span class="search-path-filter-option-icon" aria-hidden="true">
            <ExplorerEntryIcon :kind="item.kind" :path="item.insertValue" />
          </span>
          <span class="search-path-filter-option-label" v-text="item.label" />
          <span v-if="item.detail" class="search-path-filter-option-detail" v-text="item.detail" />
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import { useWorkspacePathSuggestions } from '@/composables/useWorkspacePathSuggestions';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    workspaceRootPath: string | null;
    isDesktopRuntime: boolean;
    matchCase: boolean;
    placeholder?: string;
    ariaLabel?: string;
  }>(),
  {
    placeholder: '',
    ariaLabel: undefined,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

const { suggestions, open, activeIndex, request, close, moveActive, accept, dispose } =
  useWorkspacePathSuggestions({
    workspaceRootPath: () => props.workspaceRootPath,
    isDesktopRuntime: () => props.isDesktopRuntime,
    matchCase: () => props.matchCase,
  });

const isMenuOpen = computed(() => open.value && suggestions.value.length > 0);
const resolvedAriaLabel = computed(() => props.ariaLabel ?? props.label);

const requestForElement = (element: HTMLInputElement): void => {
  request(element.value, element.selectionStart ?? element.value.length);
};

const handleInput = (event: Event): void => {
  const element = event.target as HTMLInputElement;
  emit('update:modelValue', element.value);
  requestForElement(element);
};

const handleFocus = (event: FocusEvent): void => {
  requestForElement(event.target as HTMLInputElement);
};

let blurTimer: ReturnType<typeof setTimeout> | null = null;

const clearBlurTimer = (): void => {
  if (blurTimer) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }
};

const handleBlur = (): void => {
  // 失焦后延迟关闭：给下拉项的 mousedown 选择留出时间（mousedown 已 preventDefault
  // 防止抢焦，这里再加一道延时关闭以兼容不同浏览器的事件时序）。
  clearBlurTimer();
  blurTimer = setTimeout(() => {
    blurTimer = null;
    close();
  }, 120);
};

const selectSuggestion = (index: number): void => {
  const element = inputRef.value;
  if (!element) {
    return;
  }

  const result = accept(index, element.value, element.selectionStart ?? element.value.length);
  if (!result) {
    return;
  }

  clearBlurTimer();
  emit('update:modelValue', result.value);

  // 下一帧再定位光标：等 v-model 回流后输入框的值已更新。选中目录（insertValue 以 '/'
  // 结尾）则继续弹出该目录下的建议以支持逐级下钻；选中文件则收起下拉。
  void nextTick(() => {
    const nextElement = inputRef.value;
    if (!nextElement) {
      return;
    }

    nextElement.focus();
    nextElement.setSelectionRange(result.caret, result.caret);

    if (result.suggestion.kind === 'directory') {
      request(nextElement.value, result.caret);
    } else {
      close();
    }
  });
};

const handleKeydown = (event: KeyboardEvent): void => {
  if (!isMenuOpen.value) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveActive(1);
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(-1);
    return;
  }

  if (event.key === 'Enter' || event.key === 'Tab') {
    if (activeIndex.value < 0) {
      return;
    }

    event.preventDefault();
    selectSuggestion(activeIndex.value);
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
};

watch(activeIndex, (index) => {
  if (index < 0) {
    return;
  }

  void nextTick(() => {
    const optionElement = menuRef.value?.children[index] as HTMLElement | undefined;
    optionElement?.scrollIntoView({ block: 'nearest' });
  });
});

onBeforeUnmount(() => {
  clearBlurTimer();
  dispose();
});
</script>

<style scoped>
/* 复用全局 sidebar-search.css 中 .search-panel-path-filter 的栅格、边框与 input 外观，
   这里只补充补全下拉所需的相对定位容器与浮层菜单样式，不改动全局样式表。 */
.search-path-filter-control {
  position: relative;
  display: flex;
  min-width: 0;
}

.search-path-filter-input {
  flex: 1;
  min-width: 0;
}

.search-path-filter-menu {
  position: absolute;
  z-index: 40;
  top: calc(100% + 6px);
  right: 0;
  left: 0;
  max-height: 240px;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--search-border);
  border-radius: var(--search-radius);
  background: var(--search-bg-panel);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  /* 强制浅色配色方案，避免 WebView2/Chromium 跟随系统暗色主题渲染出深色原生滚动条。 */
  color-scheme: light;
  /* Firefox：细滚动条 + 浅灰滑块 / 透明轨道。 */
  scrollbar-width: thin;
  scrollbar-color: rgb(15 23 42 / 22%) transparent;
}

/* WebKit / Chromium（含 Windows WebView2）：自定义浅色滚动条，与面板背景融合。 */
.search-path-filter-menu::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.search-path-filter-menu::-webkit-scrollbar-track {
  background: transparent;
}

.search-path-filter-menu::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 8px;
  background-color: rgb(15 23 42 / 22%);
  background-clip: padding-box;
}

.search-path-filter-menu::-webkit-scrollbar-thumb:hover {
  background-color: rgb(15 23 42 / 36%);
}

.search-path-filter-option {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px;
  border-radius: var(--search-radius-sm);
  color: var(--search-text);
  cursor: pointer;
}

.search-path-filter-option.is-active {
  background: var(--search-bg-selected);
}

.search-path-filter-option-icon {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--search-icon);
}

.search-path-filter-option-icon .explorer-entry-icon {
  --file-icon-size: 14px;
  width: 14px;
  height: 14px;
}

.search-path-filter-option-label {
  flex-shrink: 0;
  max-width: 58%;
  overflow: hidden;
  color: var(--search-text);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-path-filter-option-detail {
  min-width: 0;
  overflow: hidden;
  color: var(--search-text-subtle);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
