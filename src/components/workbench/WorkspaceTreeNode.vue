<template>
  <div class="explorer-node" :class="{ 'is-open': shouldShowChildren }">
    <button
type="button" class="explorer-tree-row w-full text-left" :class="{ 'is-active': isActive }"
      :style="rowStyle" @click="handleClick" @contextmenu.prevent.stop="handleContextMenu">
      <span class="explorer-chevron" :class="{ 'is-placeholder': !showChevron }">
        <svg
v-if="showChevron" viewBox="0 0 12 12" class="h-3 w-3 transition-transform"
          :class="shouldShowChildren ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 2.5 8 6 4 9.5" />
        </svg>
      </span>

      <ExplorerEntryIcon
:kind="entry.kind" :path="entry.path" :expanded="shouldShowChildren"
        class="h-4 w-4 shrink-0" />

      <span class="explorer-tree-name">{{ entry.name }}</span>
      <span v-if="showDirtyMarker" class="explorer-tree-meta">M</span>
    </button>

    <div v-if="shouldShowChildren" class="explorer-tree-children">
      <div v-if="isLoading" class="explorer-helper-text explorer-helper-text-padded" :style="childStateStyle">
        正在读取目录...
      </div>
      <div
v-else-if="visibleChildEntries.length === 0 && !hasActiveSearch"
        class="explorer-helper-text explorer-helper-text-padded" :style="childStateStyle">
        空文件夹
      </div>

      <WorkspaceTreeNode
v-for="child in visibleChildEntries" :key="child.path" :entry="child" :level="level + 1"
        :children-map="childrenMap" :expanded-paths="expandedPaths" :loading-paths="loadingPaths"
        :active-path="activePath" :active-dirty="activeDirty" :search-query="searchQuery"
        :inline-create-draft="inlineCreateDraft" :root-path="rootPath"
        @toggle-directory="$emit('toggle-directory', $event)" @open-file="$emit('open-file', $event)"
        @context-menu="$emit('context-menu', $event)" @inline-create-input="$emit('inline-create-input', $event)"
        @inline-create-blur="$emit('inline-create-blur')" @inline-create-confirm="$emit('inline-create-confirm')"
        @inline-create-cancel="$emit('inline-create-cancel')" />

      <div
v-if="showInlineCreateDraft" class="explorer-tree-row explorer-tree-inline-create"
        :style="inlineCreateRowStyle">
        <span class="explorer-chevron is-placeholder"></span>

        <ExplorerEntryIcon
:kind="inlineCreateDraft?.kind === 'directory' ? 'directory' : 'file'" :path="entry.path"
          class="h-4 w-4 shrink-0" />

        <input
class="explorer-inline-create-input" :value="inlineCreateDraft?.value ?? ''"
          :placeholder="inlineCreateDraft?.placeholder ?? ''" @input="handleInlineCreateInput"
          @blur="$emit('inline-create-confirm')" @keydown.enter.prevent.stop="$emit('inline-create-confirm')"
          @keydown.esc.prevent.stop="$emit('inline-create-cancel')" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import type { IWorkspaceEntry } from '@/types/editor';
import { areFileSystemPathsEqual } from '@/utils/path';
import { filterWorkspaceEntriesByQuery } from '@/utils/workspace';
import type { CSSProperties } from 'vue';
import { computed } from 'vue';

defineOptions({
  name: 'WorkspaceTreeNode',
});

const props = defineProps<{
  entry: IWorkspaceEntry;
  level: number;
  childrenMap: Record<string, IWorkspaceEntry[]>;
  expandedPaths: Record<string, boolean>;
  loadingPaths: Record<string, boolean>;
  activePath: string | null;
  activeDirty: boolean;
  searchQuery?: string;
  rootPath: string;
  inlineCreateDraft?: {
    open: boolean;
    parentPath: string | null;
    kind: 'file' | 'directory';
    value: string;
    placeholder: string;
  };
}>();

const emit = defineEmits<{
  'toggle-directory': [path: string];
  'open-file': [path: string];
  'context-menu': [payload: { event: MouseEvent; entry: IWorkspaceEntry }];
  'inline-create-input': [value: string];
  'inline-create-blur': [];
  'inline-create-confirm': [];
  'inline-create-cancel': [];
}>();

const isDirectory = computed(() => props.entry.kind === 'directory');
const isExpanded = computed(() => Boolean(props.expandedPaths[props.entry.path]));
const isLoading = computed(() => Boolean(props.loadingPaths[props.entry.path]));
const childEntries = computed(() => props.childrenMap[props.entry.path] ?? []);
const isActive = computed(
  () => areFileSystemPathsEqual(props.entry.path, props.activePath),
);
const normalizedSearchQuery = computed(() => (props.searchQuery ?? '').trim().toLowerCase());
const hasActiveSearch = computed(() => normalizedSearchQuery.value.length > 0);
const showChevron = computed(() => isDirectory.value && props.entry.hasChildren);
const showDirtyMarker = computed(
  () => props.entry.kind === 'file' && isActive.value && props.activeDirty,
);
const rowStyle = computed<CSSProperties>(() => ({
  '--explorer-indent': `${18 + props.level * 18}px`,
}));
const childStateStyle = computed<CSSProperties>(() => ({
  paddingLeft: `${44 + props.level * 18}px`,
}));
const inlineCreateRowStyle = computed<CSSProperties>(() => ({
  paddingLeft: `${18 + (props.level + 1) * 18}px`,
}));
const showInlineCreateDraft = computed(
  () =>
    Boolean(props.inlineCreateDraft?.open) &&
    props.inlineCreateDraft?.parentPath === props.entry.path &&
    props.entry.kind === 'directory',
);

const visibleChildEntries = computed(() => {
  return filterWorkspaceEntriesByQuery(
    childEntries.value,
    normalizedSearchQuery.value,
    props.childrenMap,
  );
});

const shouldShowChildren = computed(
  () =>
    isDirectory.value &&
    (isExpanded.value || (hasActiveSearch.value && visibleChildEntries.value.length > 0)),
);

const handleClick = (): void => {
  if (isDirectory.value) {
    emit('toggle-directory', props.entry.path);
    return;
  }

  emit('open-file', props.entry.path);
};

const handleContextMenu = (event: MouseEvent): void => {
  emit('context-menu', { event, entry: props.entry });
};

const handleInlineCreateInput = (event: Event): void => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  emit('inline-create-input', target.value);
};
</script>

<style scoped>
.explorer-inline-create-input {
  width: 100%;
  min-width: 0;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg-3) 96%, transparent);
  color: var(--text-primary);
  font-size: 12.5px;
  padding: 0 10px;
  outline: none;
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease,
    background-color 120ms ease;
}

.explorer-inline-create-input:hover {
  border-color: color-mix(in srgb, var(--accent-strong) 38%, var(--shell-divider));
}

.explorer-inline-create-input:focus {
  border-color: color-mix(in srgb, var(--accent-strong) 70%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-strong) 28%, transparent);
}
</style>
