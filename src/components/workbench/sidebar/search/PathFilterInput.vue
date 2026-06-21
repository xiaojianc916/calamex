<template>
  <div class="path-filter-input" :class="{ 'is-focused': isFocused }">
    <label class="path-filter-label" v-text="label" />
    <div class="path-filter-control">
      <input
        ref="inputRef"
        v-model="draft"
        type="text"
        class="path-filter-field"
        :placeholder="placeholder"
        :aria-label="ariaLabel"
        autocomplete="off"
        spellcheck="false"
        @focus="handleFocus"
        @blur="handleBlur"
        @input="handleInput"
        @keydown.down.prevent="moveActive(1)"
        @keydown.up.prevent="moveActive(-1)"
        @keydown.enter.prevent="applyActiveSuggestion"
        @keydown.escape="close"
      />
      <ul v-if="open" class="path-filter-suggestions" role="listbox">
        <li
          v-for="(suggestion, index) in suggestions"
          :key="suggestion.insertValue"
          class="path-filter-suggestion"
          :class="{ 'is-active': index === activeIndex }"
          role="option"
          :aria-selected="index === activeIndex"
          @mousedown.prevent="acceptSuggestion(index)"
          @mouseenter="activeIndex = index"
        >
          <span class="path-filter-suggestion-icon" aria-hidden="true">
            <ExplorerEntryIcon :kind="suggestion.kind" :path="suggestion.insertValue" />
          </span>
          <span class="path-filter-suggestion-name" v-text="suggestion.label" />
          <span class="path-filter-suggestion-path" v-text="suggestion.detail" />
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import ExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';
import { useWorkspacePathSuggestions } from '@/composables/useWorkspacePathSuggestions';

const props = defineProps<{
  modelValue: string;
  label: string;
  ariaLabel: string;
  workspaceRootPath: string | null;
  isDesktopRuntime: boolean;
  matchCase: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const SUGGESTION_LIMIT = 8;
const SUGGESTION_DEBOUNCE_MS = 120;

const inputRef = ref<HTMLInputElement | null>(null);
const draft = ref(props.modelValue);
const isFocused = ref(false);

// 复用仓库内既有、基于真实 IPC（list_workspace_entries + search_workspace）的补全能力：
// 目录前缀逐级下钻 + 全局 nucleo 模糊文件名兜底，内置防抖、竞态丢弃与有界 LRU 缓存。
const { suggestions, open, activeIndex, request, close, moveActive, accept } =
  useWorkspacePathSuggestions({
    workspaceRootPath: () => props.workspaceRootPath,
    isDesktopRuntime: () => props.isDesktopRuntime,
    matchCase: () => props.matchCase,
    debounceMs: SUGGESTION_DEBOUNCE_MS,
    limit: SUGGESTION_LIMIT,
  });

const placeholder = computed(() =>
  props.matchCase ? `${props.ariaLabel}（区分大小写）` : props.ariaLabel,
);

const currentCaret = (): number => inputRef.value?.selectionStart ?? draft.value.length;

const handleFocus = (): void => {
  isFocused.value = true;
  // 重新聚焦时若已有内容，立即按光标所在 token 复算建议，避免空着一片。
  request(draft.value, currentCaret());
};

const handleBlur = (): void => {
  isFocused.value = false;
  // 延迟关闭，给候选项的 mousedown 选中留出时间窗口。
  window.setTimeout(close, 120);
};

const handleInput = (): void => {
  request(draft.value, currentCaret());
};

const applyAccepted = (result: { value: string; caret: number } | null): void => {
  if (!result) return;
  draft.value = result.value;
  close();
  void nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.setSelectionRange(result.caret, result.caret);
  });
};

const acceptSuggestion = (index: number): void => {
  applyAccepted(accept(index, draft.value, currentCaret()));
};

const applyActiveSuggestion = (): void => {
  if (!open.value || suggestions.value.length === 0) return;
  acceptSuggestion(activeIndex.value);
};

watch(draft, (value) => {
  emit('update:modelValue', value);
});

watch(
  () => props.modelValue,
  (value) => {
    if (value !== draft.value) draft.value = value;
  },
);
</script>
