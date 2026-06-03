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

    <input
      class="explorer-inline-create-input explorer-inline-rename-input"
      type="text"
      aria-label="重命名文件"
      :value="inlineRenameDraft?.value ?? row.entry.name"
      @input="onRenameInput"
      @blur="emit('inline-rename-confirm')"
      @pointerdown.stop
      @click.stop
      @keydown.enter.prevent.stop="emit('inline-rename-confirm')"
      @keydown.esc.prevent.stop="emit('inline-rename-cancel')"
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
  >
    <span class="explorer-chevron is-placeholder"></span>

    <ExplorerEntryIcon
      :kind="inlineCreateDraft?.kind === 'directory' ? 'directory' : 'file'"
      :path="row.parentPath"
      class="h-4 w-4 shrink-0"
    />

    <input
      class="explorer-inline-create-input"
      :value="inlineCreateDraft?.value ?? ''"
      :placeholder="inlineCreateDraft?.placeholder ?? ''"
      @input="onCreateInput"
      @blur="emit('inline-create-blur')"
      @keydown.enter.prevent.stop="emit('inline-create-confirm')"
      @keydown.esc.prevent.stop="emit('inline-create-cancel')"
    />
  </div>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import { computed } from 'vue';
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import type { TWorkspaceTreeRow } from '@/components/workbench/workspace-tree.types';
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
    props.row.type === 'entry' &&
    areFileSystemPathsEqual(props.row.entry.path, props.activePath),
);
const isContextTarget = computed(
  () =>
    props.row.type === 'entry' &&
    !isActive.value &&
    areFileSystemPathsEqual(props.row.entry.path, props.contextMenuPath ?? null),
);
const isRenaming = computed(
  () =>
    props.row.type === 'entry' &&
    props.inlineRenameDraft?.path === props.row.entry.path,
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

const onCreateInput = (event: Event): void => {
  if (event.target instanceof HTMLInputElement) {
    emit('inline-create-input', event.target.value);
  }
};

const onRenameInput = (event: Event): void => {
  if (event.target instanceof HTMLInputElement) {
    emit('inline-rename-input', event.target.value);
  }
};
</script>

<style scoped>
/*
 * 内联“新建文件/文件夹”输入框：与重命名输入框保持一致的轻量样式。
 * 高度固定 20px（原 28px），去掉撑大的实心边框盒，改用 1px 描边 box-shadow，
 * flex 自适应宽度，避免新建时把整行撑高。
 */
.explorer-inline-create-input {
  flex: 1;
  width: auto;
  min-width: 0;
  height: 20px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: #ffffff;
  color: #1f2328;
  font-size: 13px;
  line-height: 20px;
  outline: none;
  box-shadow: 0 0 0 1px rgba(31, 35, 40, 0.18);
  transition: box-shadow 120ms ease;
}

.explorer-inline-create-input:hover {
  box-shadow: 0 0 0 1px rgba(31, 35, 40, 0.32);
}

.explorer-inline-create-input:focus {
  box-shadow:
    0 0 0 1px #4493f8,
    0 0 0 3px rgba(68, 147, 248, 0.2);
}

/*
 * 重命名输入框：白色主题（按用户要求保留硬编码颜色）。
 * 重命名行内没有文件名文字 span（被输入框替换），所以行高由输入框决定。
 * 高度固定为一行文字的行盒高度 20px，与普通文件行严格一致，重命名前后不跳也不偏高。
 */
.explorer-inline-rename-input {
  flex: 1;
  width: auto;
  min-width: 0;
  height: 20px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: #ffffff;
  color: #1f2328;
  font-size: 13px;
  line-height: 20px;
  box-shadow: 0 0 0 1px rgba(31, 35, 40, 0.18);
}

.explorer-inline-rename-input:hover {
  box-shadow: 0 0 0 1px rgba(31, 35, 40, 0.32);
}

.explorer-inline-rename-input:focus {
  box-shadow:
    0 0 0 1px #4493f8,
    0 0 0 3px rgba(68, 147, 248, 0.2);
}
</style>
