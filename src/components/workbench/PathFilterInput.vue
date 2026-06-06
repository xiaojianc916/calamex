<template>
  <div class="search-panel-path-filter">
    <span v-text="label" />

    <div class="search-path-filter-control" @click="focusInput">
      <span
        v-for="(chip, index) in chips"
        :key="`${chip.value}:${index}`"
        class="search-path-filter-chip"
        :class="{ 'is-directory': chip.isDirectory, 'is-invalid': !chip.valid }"
        :title="chip.valid ? chip.value : `非法的模式：${chip.value}`"
      >
        <span class="search-path-filter-chip-label" v-text="chip.value" />
        <button
          type="button"
          class="search-path-filter-chip-remove"
          tabindex="-1"
          aria-label="移除"
          @mousedown.prevent
          @click.stop="removeChip(index)"
        >
          <span class="icon-[lucide--x]" aria-hidden="true" />
        </button>
      </span>

      <input
        ref="inputRef"
        class="search-path-filter-input"
        type="text"
        :value="draft"
        :placeholder="chips.length === 0 ? placeholder : ''"
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
          @mouseenter="onOptionHover(index)"
        >
          <span class="search-path-filter-option-icon" aria-hidden="true">
            <ExplorerEntryIcon :kind="item.kind" :path="item.insertValue" />
          </span>
          <span class="search-path-filter-option-label" v-text="item.label" />
          <span v-if="item.detail" class="search-path-filter-option-detail" v-text="item.detail" />
          <button
            v-if="item.kind === 'directory'"
            type="button"
            class="search-path-filter-option-enter"
            tabindex="-1"
            aria-label="进入目录"
            title="进入目录浏览子项"
            @mousedown.prevent.stop="drillIntoSuggestion(index)"
          >
            <span class="icon-[lucide--chevron-right]" aria-hidden="true" />
          </button>
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
const draft = ref('');
// 仅当用户用方向键/悬停「主动选中」某条建议时才为 true：回车此时才接受建议，
// 否则回车一律把草稿文本「定型」成 chip——避免抢走手输的 glob 模式（如 *.sh）。
const userNavigated = ref(false);

const { suggestions, open, activeIndex, request, close, moveActive, accept, dispose } =
  useWorkspacePathSuggestions({
    workspaceRootPath: () => props.workspaceRootPath,
    isDesktopRuntime: () => props.isDesktopRuntime,
    matchCase: () => props.matchCase,
  });

const isMenuOpen = computed(() => open.value && suggestions.value.length > 0);
const resolvedAriaLabel = computed(() => props.ariaLabel ?? props.label);

// 把以逗号/换行分隔的模式串解析成去空白的非空片段；与父组件 splitPatternList 保持一致，
// 因此 modelValue 仍以逗号拼接存储，后端下发逻辑无需改动。
const parsePatterns = (value: string): string[] =>
  value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);

// 轻量 glob 合法性校验（仅作视觉提示，不阻止提交）：非空、方括号/花括号配对。
const isValidGlobPattern = (value: string): boolean => {
  if (!value) {
    return false;
  }

  let squareDepth = 0;
  let braceDepth = 0;
  for (const character of value) {
    if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{') {
      braceDepth += 1;
    } else if (character === '}') {
      braceDepth -= 1;
    }

    if (squareDepth < 0 || braceDepth < 0) {
      return false;
    }
  }

  return squareDepth === 0 && braceDepth === 0;
};

// chip 是否代表目录：以 '/' 结尾视为目录（选目录时 insertValue 就是这样），其余视为文件/通配符。
const chips = computed(() =>
  parsePatterns(props.modelValue).map((value) => ({
    value,
    valid: isValidGlobPattern(value),
    isDirectory: value.endsWith('/'),
  })),
);

const focusInput = (): void => {
  inputRef.value?.focus();
};

// 追加一个模式：去空白、去重后拼回 modelValue。空片段忽略，避免产生空 chip。
const commitPattern = (pattern: string): void => {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return;
  }

  const existing = parsePatterns(props.modelValue);
  if (existing.includes(trimmed)) {
    return;
  }

  emit('update:modelValue', [...existing, trimmed].join(','));
};

const commitDraft = (): void => {
  const pattern = draft.value;
  draft.value = '';
  commitPattern(pattern);
  close();
};

const removeChip = (index: number): void => {
  const existing = parsePatterns(props.modelValue);
  if (index < 0 || index >= existing.length) {
    return;
  }

  existing.splice(index, 1);
  emit('update:modelValue', existing.join(','));
  void nextTick(() => inputRef.value?.focus());
};

const removeLastChip = (): void => {
  const existing = parsePatterns(props.modelValue);
  if (existing.length === 0) {
    return;
  }

  existing.pop();
  emit('update:modelValue', existing.join(','));
};

const handleInput = (event: Event): void => {
  const element = event.target as HTMLInputElement;
  const raw = element.value;
  userNavigated.value = false;

  // 输入或粘贴中出现分隔符：把已完整的片段逐个定型成 chip，最后一段留作草稿继续编辑。
  if (/[,\n]/u.test(raw)) {
    const segments = raw.split(/[\n,]+/u);
    const tail = segments.pop() ?? '';
    for (const segment of segments) {
      commitPattern(segment);
    }
    draft.value = tail;
    request(tail, tail.length);
    return;
  }

  draft.value = raw;
  request(raw, element.selectionStart ?? raw.length);
};

const handleFocus = (): void => {
  userNavigated.value = false;
  request(draft.value, draft.value.length);
};

let blurTimer: ReturnType<typeof setTimeout> | null = null;

const clearBlurTimer = (): void => {
  if (blurTimer) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }
};

const handleBlur = (): void => {
  // 失焦后延迟处理：给下拉项的 mousedown 选择留出时间（mousedown 已 preventDefault 防抢焦）。
  // 真正离开输入框时，把未提交的草稿也定型成 chip，避免「输了没生效」。
  clearBlurTimer();
  blurTimer = setTimeout(() => {
    blurTimer = null;
    if (draft.value.trim()) {
      commitPattern(draft.value);
      draft.value = '';
    }
    close();
  }, 120);
};

// 选中任意建议（文件或目录）→ 直接定型为 chip。目录的 insertValue 以 '/' 结尾，
// gitignore 风格下代表该目录及其子项，适作包含/排除模式。
const selectSuggestion = (index: number): void => {
  const element = inputRef.value;
  if (!element) {
    return;
  }

  const caret = element.selectionStart ?? draft.value.length;
  const result = accept(index, draft.value, caret);
  if (!result) {
    return;
  }

  clearBlurTimer();
  commitPattern(result.value);
  draft.value = '';
  close();
  void nextTick(() => inputRef.value?.focus());
};

// 进入目录浏览：把目录路径填入草稿（以 '/' 结尾）并重新拉取该目录下的建议，不提交 chip。
const drillIntoSuggestion = (index: number): void => {
  const element = inputRef.value;
  if (!element) {
    return;
  }

  const caret = element.selectionStart ?? draft.value.length;
  const result = accept(index, draft.value, caret);
  if (!result) {
    return;
  }

  clearBlurTimer();
  draft.value = result.value;
  void nextTick(() => {
    const nextElement = inputRef.value;
    if (!nextElement) {
      return;
    }

    nextElement.focus();
    nextElement.setSelectionRange(result.caret, result.caret);
    userNavigated.value = false;
    request(result.value, result.caret);
  });
};

const onOptionHover = (index: number): void => {
  activeIndex.value = index;
  userNavigated.value = true;
};

const handleKeydown = (event: KeyboardEvent): void => {
  // 输入法组字过程中（如中文拼音）放行所有按键，尤其是空格选词，绝不在此时提交 chip。
  if (event.isComposing) {
    return;
  }

  // 草稿为空时按退格：删除最后一个 chip，符合标签输入框的直觉。
  if (event.key === 'Backspace' && draft.value.length === 0) {
    if (chips.value.length > 0) {
      event.preventDefault();
      removeLastChip();
    }
    return;
  }

  if (isMenuOpen.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      userNavigated.value = true;
      moveActive(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      userNavigated.value = true;
      moveActive(-1);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    // 右方向键/Tab 在高亮为目录时进入目录浏览；文件则直接定型成 chip。
    const activeSuggestion =
      activeIndex.value >= 0 ? suggestions.value[activeIndex.value] : undefined;

    if (event.key === 'ArrowRight' && activeSuggestion?.kind === 'directory') {
      event.preventDefault();
      drillIntoSuggestion(activeIndex.value);
      return;
    }

    if (event.key === 'Tab' && activeSuggestion) {
      event.preventDefault();
      if (activeSuggestion.kind === 'directory') {
        drillIntoSuggestion(activeIndex.value);
      } else {
        selectSuggestion(activeIndex.value);
      }
      return;
    }

    // Enter 仅在用户主动选中后才接受建议（目录也直接定型成 chip）。
    if (event.key === 'Enter' && userNavigated.value && activeIndex.value >= 0) {
      event.preventDefault();
      selectSuggestion(activeIndex.value);
      return;
    }
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    commitDraft();
    return;
  }

  // 空格定型为 chip；草稿为空时仅吞掉按键，避免产生纯空白片段。
  if (event.key === ' ') {
    event.preventDefault();
    if (draft.value.trim()) {
      commitDraft();
    }
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
   这里只补充标签 chip、补全下拉所需的相对定位容器与浮层菜单样式，不改动全局样式表。 */
.search-panel-path-filter {
  align-items: center;
  min-height: 30px;
  padding: 3px 8px;
}

.search-path-filter-control {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.search-path-filter-input {
  flex: 1 1 64px;
  min-width: 64px;
  height: 22px;
}

/* 胶囊默认（文件/通配符）：蓝色背景。 */
.search-path-filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  height: 22px;
  padding: 0 2px 0 7px;
  border-radius: var(--search-radius-sm);
  background: rgb(37 99 235 / 12%);
  color: var(--search-text);
  font-size: 11px;
}

/* 目录胶囊（以 '/' 结尾）：琴珀色背景，呼应橙色文件夹图标。 */
.search-path-filter-chip.is-directory {
  background: rgb(245 158 11 / 20%);
}

/* 非法模式：红色背景，优先级高于目录/文件配色。 */
.search-path-filter-chip.is-invalid {
  background: rgb(220 38 38 / 14%);
  color: #b91c1c;
  box-shadow: inset 0 0 0 1px rgb(220 38 38 / 38%);
}

.search-path-filter-chip-label {
  overflow: hidden;
  color: var(--search-text);
  font-size: 11px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-path-filter-chip.is-invalid .search-path-filter-chip-label {
  color: #b91c1c;
}

.search-path-filter-chip-remove {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.65;
}

.search-path-filter-chip-remove:hover {
  background: rgb(0 0 0 / 10%);
  opacity: 1;
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

.search-path-filter-option-enter {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: var(--search-radius-sm);
  background: transparent;
  color: var(--search-text-subtle);
  font-size: 13px;
  cursor: pointer;
}

.search-path-filter-option-enter:hover {
  background: rgb(0 0 0 / 8%);
  color: var(--search-text);
}
</style>
