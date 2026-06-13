<template>
  <div class="explorer-file-tree font-mono text-sm" role="tree" aria-label="文件资源树">
    <WorkspaceTreeNode
      :entry="entry"
      :level="0"
      :children-map="childrenMap"
      :expanded-paths="expandedPaths"
      :loading-paths="loadingPaths"
      :active-path="activePath"
      :active-dirty="activeDirty"
      :context-menu-path="contextMenuPath"
      :inline-create-draft="inlineCreateDraft"
      :root-path="rootPath"
      :inline-rename-draft="inlineRenameDraft"
      @toggle-directory="(path) => emit('toggle-directory', path)"
      @open-file="(path) => emit('open-file', path)"
      @context-menu="(payload) => emit('context-menu', payload)"
      @inline-create-input="(value) => emit('inline-create-input', value)"
      @inline-create-blur="emit('inline-create-blur')"
      @inline-create-confirm="emit('inline-create-confirm')"
      @inline-create-cancel="emit('inline-create-cancel')"
      @inline-rename-input="(value) => emit('inline-rename-input', value)"
      @inline-rename-confirm="emit('inline-rename-confirm')"
      @inline-rename-cancel="emit('inline-rename-cancel')"
    />
  </div>
</template>

<script setup lang="ts">
import WorkspaceTreeNode from '@/components/workbench/sidebar/explorer/WorkspaceTreeNode.vue';
import type { IWorkspaceEntry } from '@/types/editor';

defineProps<{
  entry: IWorkspaceEntry;
  childrenMap: Record<string, IWorkspaceEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Record<string, boolean>;
  activePath: string | null;
  activeDirty: boolean;
  contextMenuPath?: string | null;
  rootPath: string;
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
