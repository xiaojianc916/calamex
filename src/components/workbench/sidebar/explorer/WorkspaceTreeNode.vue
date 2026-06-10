<script setup lang="ts">
import LegacyWorkspaceTreeNode from '@/components/workbench/WorkspaceTreeNode.vue';
import type { IWorkspaceEntry } from '@/types/editor';

type TInlineCreateDraft = {
  open: boolean;
  parentPath: string | null;
  kind: 'file' | 'directory';
  value: string;
  placeholder: string;
};

type TInlineRenameDraft = {
  path: string | null;
  value: string;
};

const props = defineProps<{
  entry: IWorkspaceEntry;
  level: number;
  childrenMap: Record<string, IWorkspaceEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Record<string, boolean>;
  activePath: string | null;
  activeDirty: boolean;
  contextMenuPath?: string | null;
  rootPath: string;
  inlineCreateDraft?: TInlineCreateDraft;
  inlineRenameDraft?: TInlineRenameDraft;
}>();

const emit = defineEmits<{
  'toggle-directory': [path: string];
  'open-file': [path: string];
  'context-menu': [payload: { event: MouseEvent; entry: IWorkspaceEntry }];
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
  <LegacyWorkspaceTreeNode
    :entry="props.entry"
    :level="props.level"
    :children-map="props.childrenMap"
    :expanded-paths="props.expandedPaths"
    :loading-paths="props.loadingPaths"
    :active-path="props.activePath"
    :active-dirty="props.activeDirty"
    :context-menu-path="props.contextMenuPath"
    :root-path="props.rootPath"
    :inline-create-draft="props.inlineCreateDraft"
    :inline-rename-draft="props.inlineRenameDraft"
    @toggle-directory="emit('toggle-directory', $event)"
    @open-file="emit('open-file', $event)"
    @context-menu="emit('context-menu', $event)"
    @inline-create-input="emit('inline-create-input', $event)"
    @inline-create-blur="emit('inline-create-blur')"
    @inline-create-confirm="emit('inline-create-confirm')"
    @inline-create-cancel="emit('inline-create-cancel')"
    @inline-rename-input="emit('inline-rename-input', $event)"
    @inline-rename-confirm="emit('inline-rename-confirm')"
    @inline-rename-cancel="emit('inline-rename-cancel')"
  />
</template>
