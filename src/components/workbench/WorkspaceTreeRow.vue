<script setup lang="ts">
import DomainWorkspaceTreeRow from '@/components/workbench/sidebar/explorer/WorkspaceTreeRow.vue';
import type { TWorkspaceTreeRow } from '@/components/workbench/sidebar/explorer/workspace-tree.types';
import type { IWorkspaceEntry } from '@/types/editor';

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
</script>

<template>
  <DomainWorkspaceTreeRow
    :row="props.row"
    :active-path="props.activePath"
    :active-dirty="props.activeDirty"
    :context-menu-path="props.contextMenuPath"
    :tabbable="props.tabbable"
    :inline-create-draft="props.inlineCreateDraft"
    :inline-rename-draft="props.inlineRenameDraft"
    @activate="emit('activate', $event)"
    @contextmenu="emit('contextmenu', $event)"
    @inline-create-input="emit('inline-create-input', $event)"
    @inline-create-blur="emit('inline-create-blur')"
    @inline-create-confirm="emit('inline-create-confirm')"
    @inline-create-cancel="emit('inline-create-cancel')"
    @inline-rename-input="emit('inline-rename-input', $event)"
    @inline-rename-confirm="emit('inline-rename-confirm')"
    @inline-rename-cancel="emit('inline-rename-cancel')"
  />
</template>
