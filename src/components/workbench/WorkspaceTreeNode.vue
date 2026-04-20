<template>
  <div class="explorer-node" :class="{ 'is-open': shouldShowChildren }">
    <button
      type="button"
      class="explorer-tree-row w-full text-left"
      :class="{ 'is-active': isActive }"
      :style="rowStyle"
      @click="handleClick"
    >
      <span class="explorer-chevron" :class="{ 'is-placeholder': !showChevron }">
        <svg
          v-if="showChevron"
          viewBox="0 0 12 12"
          class="h-3 w-3 transition-transform"
          :class="shouldShowChildren ? 'rotate-90' : ''"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 2.5 8 6 4 9.5" />
        </svg>
      </span>

      <ExplorerEntryIcon
        :kind="entry.kind"
        :path="entry.path"
        :expanded="shouldShowChildren"
        class="h-4 w-4 shrink-0"
      />

      <span class="explorer-tree-name">{{ entry.name }}</span>
      <span v-if="showDirtyMarker" class="explorer-tree-meta">M</span>
    </button>

    <div v-if="shouldShowChildren" class="explorer-tree-children">
      <div v-if="isLoading" class="explorer-helper-text explorer-helper-text-padded" :style="childStateStyle">
        正在读取目录...
      </div>
      <div
        v-else-if="visibleChildEntries.length === 0 && !hasActiveSearch"
        class="explorer-helper-text explorer-helper-text-padded"
        :style="childStateStyle"
      >
        空文件夹
      </div>

      <WorkspaceTreeNode
        v-for="child in visibleChildEntries"
        :key="child.path"
        :entry="child"
        :level="level + 1"
        :children-map="childrenMap"
        :expanded-paths="expandedPaths"
        :loading-paths="loadingPaths"
        :active-path="activePath"
        :active-dirty="activeDirty"
        :search-query="searchQuery"
        @toggle-directory="$emit('toggle-directory', $event)"
        @open-file="$emit('open-file', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import type { IWorkspaceEntry } from '@/types/editor';
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
}>();

const emit = defineEmits<{
  'toggle-directory': [path: string];
  'open-file': [path: string];
}>();

const normalizePath = (value: string | null | undefined): string =>
  value ? value.replace(/\\/g, '/').toLowerCase() : '';

const isDirectory = computed(() => props.entry.kind === 'directory');
const isExpanded = computed(() => Boolean(props.expandedPaths[props.entry.path]));
const isLoading = computed(() => Boolean(props.loadingPaths[props.entry.path]));
const childEntries = computed(() => props.childrenMap[props.entry.path] ?? []);
const isActive = computed(
  () => normalizePath(props.entry.path) === normalizePath(props.activePath),
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

const entryMatchesSearch = (entry: IWorkspaceEntry, query: string): boolean => {
  if (!query) {
    return true;
  }

  return (
    entry.name.toLowerCase().includes(query) ||
    normalizePath(entry.path).includes(query)
  );
};

const entryMatchesTree = (entry: IWorkspaceEntry, query: string): boolean => {
  if (!query || entryMatchesSearch(entry, query)) {
    return true;
  }

  if (entry.kind !== 'directory') {
    return false;
  }

  const descendants = props.childrenMap[entry.path] ?? [];
  return descendants.some((child) => entryMatchesTree(child, query));
};

const visibleChildEntries = computed(() => {
  if (!hasActiveSearch.value) {
    return childEntries.value;
  }

  return childEntries.value.filter((child) => entryMatchesTree(child, normalizedSearchQuery.value));
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
</script>
