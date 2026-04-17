<template>
  <div>
    <button
      type="button"
      class="explorer-tree-row w-full text-left"
      :class="{ 'is-active': isActive }"
      :style="rowStyle"
      @click="handleClick"
    >
      <span
        class="explorer-chevron"
        :class="{ 'is-placeholder': !isDirectory || (!entry.hasChildren && !isExpanded) }"
      >
        <svg
          v-if="isDirectory"
          viewBox="0 0 12 12"
          class="h-3 w-3 transition-transform"
          :class="isExpanded ? 'rotate-90' : ''"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 2.5 8 6 4 9.5" />
        </svg>
      </span>

      <svg
        v-if="isDirectory"
        viewBox="0 0 24 24"
        class="h-4 w-4 shrink-0 text-[var(--warning)]"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M3.5 7.5h6l1.8 2H20v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
        <path d="M3.5 9.5V7a2 2 0 0 1 2-2h4" />
      </svg>

      <svg
        v-else
        viewBox="0 0 24 24"
        class="h-4 w-4 shrink-0 text-[var(--accent-strong)]"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>

      <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
      <span v-if="isActive && activeDirty" class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]" />
    </button>

    <div v-if="isDirectory && isExpanded">
      <div v-if="isLoading" class="explorer-helper-text" :style="childStateStyle">正在读取目录...</div>
      <div v-else-if="childEntries.length === 0" class="explorer-helper-text" :style="childStateStyle">空文件夹</div>

      <WorkspaceTreeNode
        v-for="child in childEntries"
        :key="child.path"
        :entry="child"
        :level="level + 1"
        :children-map="childrenMap"
        :expanded-paths="expandedPaths"
        :loading-paths="loadingPaths"
        :active-path="activePath"
        :active-dirty="activeDirty"
        @toggle-directory="$emit('toggle-directory', $event)"
        @open-file="$emit('open-file', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CSSProperties } from 'vue';
import type { IWorkspaceEntry } from '@/types/editor';

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
const rowStyle = computed<CSSProperties>(() => ({
  paddingLeft: `${12 + props.level * 14}px`,
}));
const childStateStyle = computed<CSSProperties>(() => ({
  paddingLeft: `${40 + props.level * 14}px`,
}));

const handleClick = (): void => {
  if (isDirectory.value) {
    emit('toggle-directory', props.entry.path);
    return;
  }

  emit('open-file', props.entry.path);
};
</script>