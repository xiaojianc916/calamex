<template>
  <button
    v-if="row.type === 'entry' && !isRenaming"
    type="button"
    class="explorer-tree-row w-full text-left"
    :class="{ 'is-active': isActive, 'is-context-target': isContextTarget }"
    :style="rowStyle"
    role="treeitem"
    :tabindex="tabbable ? 0 : -1"
    :data-tree-path="row.entry.path"
    :aria-level="row.level + 1"
    :aria-selected="isActive"
    :aria-expanded="isDirectory ? row.expanded : undefined"
    @click="emit('activate', row.entry)"
    @contextmenu.prevent.stop="emit('contextmenu', { event: $event, entry: row.entry })"
  >
    <span class="explorer-chevron" :class="{ 'is-placeholder': !row.showChevron }">
      <svg
        v-if="row.showChevron"
        viewBox="0 0 12 12"
        class="h-3 w-3 transition-transform"
        :class="row.expanded ? 'rotate-90' : ''"
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
      :kind="row.entry.kind"
      :path="row.entry.path"
      :expanded="row.expanded"
      class="h-4 w-4 shrink-0"
    />

    <span class="explorer-tree-name" v-text="row.entry.name"></span>
    <span v-if="showDirtyMarker" class="explorer-tree-meta">M</span>
  </button>

  <div
    v-else-if="row.type === 'entry'"
    class="explorer-tree-row w-full text-left"
    :class="{ 'is-active': isActive, 'is-context-target': isContextTarget }"
    :style="rowStyle"
    role="treeitem"
    :data-tree-path="row.entry.path"
    :aria-level="row.level + 1"
    :aria-selected="isActive"
    @contextmenu.prevent.stop="emit('contextmenu', { event: $event, entry: row.entry })"
  >
    <span class="explorer-chevron" :class="{ 'is-placeholder': !row.showChevron }">
      <svg
        v-if="row.showChevron"
        viewBox="0 0 12 12"
        class="h-3 w-3 transition-transform"
        :class="row.expanded ? 'rotate-90' : ''"
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
      :kind="row.entry.kind"
      :path="row.entry.path"
      :expanded="row.expanded"
      class="h-4 w-4 shrink-0"
    />

    <WorkspaceInlineRenameInput
      :value="inlineRenameDraft?.value ?? row.entry.name"
      @input="onRenameInput"
      @confirm="emit('inline-rename-confirm')"
      @cancel="emit('inline-rename-cancel')"
    />
    <span v-if="showDirtyMarker" class="explorer-tree-meta">M</span>
  </div>

  <div
    v-else-if="row.type === 'loading'"
    class="explorer-helper-text explorer-helper-text-padded"
    :style="helperStyle"
  >
    正在读取目录...
  </div>

  <div
    v-else-if="row.type === 'empty'"
    class="explorer-helper-text explorer-helper-text-padded"
    :style="helperStyle"
  >
    空文件夹
  </div>

  <div
    v-else-if="row.type === 'inline-create'"
    class="explorer-tree-row explorer-tree-inline-create"
    :style="inlineCreateStyle"
    @contextmenu.stop
  >
    <span class="explorer-chevron is-placeholder"></span>

    <ExplorerEntryIcon
      :kind="inlineCreateDraft?.kind === 'directory' ? 'directory' : 'file'"
      :path="row.parentPath"
      class="h-4 w-4 shrink-0"
    />

    <WorkspaceInlineCreateInput
      :value="inlineCreateDraft?.value ?? ''"
      :placeholder="inlineCreateDraft?.placeholder ?? ''"
      @input="onCreateInput"
      @blur="emit('inline-create-blur')"
      @confirm="emit('inline-create-confirm')"
      @cancel="emit('inline-create-cancel')"
    />
  </div>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import { computed } from 'vue';
import ExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';
import WorkspaceInlineCreateInput from '@/components/workbench/sidebar/explorer/WorkspaceInlineCreateInput.vue';
import WorkspaceInlineRenameInput from '@/components/workbench/sidebar/explorer/WorkspaceInlineRenameInput.vue';
import type { TWorkspaceTreeRow } from '@/components/workbench/sidebar/explorer/workspace-tree.types';
import type { IWorkspaceEntry } from '@/types/editor';
import { areFileSystemPathsEqual } from '@/utils/path';

const props = defineProps<{
  row: TWorkspaceTreeRow;
  activePath: string | null;
  activeDirty: boolean;
  contextMenuPath?: string | null;
  tabbable?: boolean;
  inlineCreateDraft?: {
    open: boolean;
    parentPath: string | null;
    kind: 'file' | 'directory';
    value: string;
    placeholder: string;
  };
  inlineRenameDraft?: {
    path: string | null;
    value: string;
  };
}>();

const emit = defineEmits<{
  activate: [entry: IWorkspaceEntry];
  contextmenu: [payload: { event: MouseEvent; entry: IWorkspaceEntry }];
  'inline-create-input': [value: string];
  'inline-create-blur': [];
  'inline-create-confirm': [];
  'inline-create-cancel': [];
  'inline-rename-input': [value: string];
  'inline-rename-confirm': [];
  'inline-rename-cancel': [];
}>();

const isDirectory = computed(
  () => props.row.type === 'entry' && props.row.entry.kind === 'directory',
);
const isActive = computed(
  () =>
    props.row.type === 'entry' && areFileSystemPathsEqual(props.row.entry.path, props.activePath),
);
const isContextTarget = computed(
  () =>
    props.row.type === 'entry' &&
    !isActive.value &&
    areFileSystemPathsEqual(props.row.entry.path, props.contextMenuPath ?? null),
);
const isRenaming = computed(
  () => props.row.type === 'entry' && props.inlineRenameDraft?.path === props.row.entry.path,
);
const showDirtyMarker = computed(
  () =>
    props.row.type === 'entry' &&
    props.row.entry.kind === 'file' &&
    isActive.value &&
    props.activeDirty,
);
const rowStyle = computed<CSSProperties>(() => ({
  '--explorer-indent': `${18 + props.row.level * 18}px`,
}));
const helperStyle = computed<CSSProperties>(() => ({
  paddingLeft: `${44 + props.row.level * 18}px`,
}));
const inlineCreateStyle = computed<CSSProperties>(() => ({
  paddingLeft: `${18 + (props.row.level + 1) * 18}px`,
}));

const onCreateInput = (value: string): void => {
  emit('inline-create-input', value);
};

const onRenameInput = (value: string): void => {
  emit('inline-rename-input', value);
};
</script>
