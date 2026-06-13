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
        autocomplete="off"
        spellcheck="false"
        @focus="handleFocus"
        @blur="handleBlur"
        @keydown.down.prevent="moveActiveSuggestion(1)"
        @keydown.up.prevent="moveActiveSuggestion(-1)"
        @keydown.enter.prevent="applyActiveSuggestion"
        @keydown.escape="closeSuggestions"
      />
      <ul v-if="isSuggestionsOpen" class="path-filter-suggestions" role="listbox">
        <li
          v-for="(suggestion, index) in suggestions"
          :key="suggestion.path"
          class="path-filter-suggestion"
          :class="{ 'is-active': index === activeSuggestionIndex }"
          role="option"
          :aria-selected="index === activeSuggestionIndex"
          @mousedown.prevent="applySuggestion(suggestion)"
          @mouseenter="activeSuggestionIndex = index"
        >
          <span class="path-filter-suggestion-icon" aria-hidden="true">
            <ExplorerEntryIcon :kind="suggestion.kind" :path="suggestion.path" />
          </span>
          <span class="path-filter-suggestion-name" v-text="suggestion.name" />
          <span class="path-filter-suggestion-path" v-text="suggestion.parentPath" />
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import ExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';
import { tauriService } from '@/services/tauri';
import type { IWorkspaceEntrySuggestion } from '@/types/editor';
import { getFileName, getParentPath } from './search-sidebar-text';

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
const isSuggestionsOpen = ref(false);
const suggestions = ref<IWorkspaceEntrySuggestion[]>([]);
const activeSuggestionIndex = ref(0);
let suggestionTimer: ReturnType<typeof setTimeout> | null = null;
let suggestionRequestId = 0;

const placeholder = computed(() =>
  props.matchCase ? `${props.ariaLabel}（区分大小写）` : props.ariaLabel,
);

const lastSegment = computed(() => {
  const segments = draft.value.split(',');
  return segments.at(-1)?.trim() ?? '';
});

const closeSuggestions = (): void => {
  isSuggestionsOpen.value = false;
  suggestions.value = [];
  activeSuggestionIndex.value = 0;
};

const handleFocus = (): void => {
  isFocused.value = true;
};

const handleBlur = (): void => {
  isFocused.value = false;
  window.setTimeout(closeSuggestions, 120);
};

const moveActiveSuggestion = (delta: number): void => {
  if (!isSuggestionsOpen.value || suggestions.value.length === 0) return;
  const count = suggestions.value.length;
  activeSuggestionIndex.value = (activeSuggestionIndex.value + delta + count) % count;
};

const applySuggestion = (suggestion: IWorkspaceEntrySuggestion): void => {
  const segments = draft.value.split(',');
  segments[segments.length - 1] = suggestion.path;
  draft.value = segments
    .map((segment, index) => (index === segments.length - 1 ? segment : segment.trim()))
    .join(', ');
  closeSuggestions();
  void nextTick(() => inputRef.value?.focus());
};

const applyActiveSuggestion = (): void => {
  if (!isSuggestionsOpen.value || suggestions.value.length === 0) return;
  const suggestion = suggestions.value[activeSuggestionIndex.value];
  if (suggestion) applySuggestion(suggestion);
};

const fetchSuggestions = async (fragment: string): Promise<void> => {
  if (!props.isDesktopRuntime || !props.workspaceRootPath) {
    closeSuggestions();
    return;
  }
  const requestId = suggestionRequestId + 1;
  suggestionRequestId = requestId;
  try {
    const matches = await tauriService.suggestWorkspaceEntries({
      workspaceRootPath: props.workspaceRootPath,
      query: fragment,
      limit: SUGGESTION_LIMIT,
    });
    if (requestId !== suggestionRequestId) return;
    suggestions.value = matches.map((match) => ({
      ...match,
      name: getFileName(match.relativePath),
      parentPath: getParentPath(match.relativePath),
    }));
    isSuggestionsOpen.value = suggestions.value.length > 0;
    activeSuggestionIndex.value = 0;
  } catch {
    closeSuggestions();
  }
};

const scheduleSuggestions = (fragment: string): void => {
  if (suggestionTimer) clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(() => {
    suggestionTimer = null;
    void fetchSuggestions(fragment);
  }, SUGGESTION_DEBOUNCE_MS);
};

watch(draft, (value) => {
  emit('update:modelValue', value);
  const fragment = lastSegment.value;
  if (fragment.length === 0) {
    closeSuggestions();
    return;
  }
  scheduleSuggestions(fragment);
});

watch(
  () => props.modelValue,
  (value) => {
    if (value !== draft.value) draft.value = value;
  },
);
</script>
