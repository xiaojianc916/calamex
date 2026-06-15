<script setup lang="ts">
import DomainAppSidebar from '@/components/workbench/sidebar/AppSidebar.vue';
import type { TWorkbenchSidebarView } from '@/types/app';
import type {
  IActiveRunSummary,
  ICommandTemplate,
  IEditorDocument,
  IRunHistoryEntry,
  IWorkspaceDirectoryPayload,
  TExecutorKind,
  TWorkbenchOpenFilePayload,
} from '@/types/editor';
import type { IGitDiffPreviewRequest } from '@/types/git';

const props = defineProps<{
  document: IEditorDocument;
  view: TWorkbenchSidebarView;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
  initialExplorerExpandedPaths: string[];
  initialExplorerSelectedPath: string | null;
  canRun: boolean;
  isRunning: boolean;
  hasRunArtifacts: boolean;
  activeRun: IActiveRunSummary | null;
  runHistory: IRunHistoryEntry[];
  commandTemplates: ICommandTemplate[];
  executor: TExecutorKind;
}>();

const emit = defineEmits<{
  'open-file': [payload: TWorkbenchOpenFilePayload];
  'open-folder': [];
  'open-git-diff': [payload: IGitDiffPreviewRequest];
  run: [];
  'create-document': [];
  'open-terminal': [];
  'insert-template': [template: ICommandTemplate];
  'clear-run-history': [];
  'explorer-state-change': [payload: { expandedPaths: string[]; selectedPath: string | null }];
}>();
</script>

<template>
  <DomainAppSidebar
    :document="props.document"
    :view="props.view"
    :is-desktop-runtime="props.isDesktopRuntime"
    :workspace-root-path="props.workspaceRootPath"
    :preloaded-workspace-root="props.preloadedWorkspaceRoot"
    :initial-explorer-expanded-paths="props.initialExplorerExpandedPaths"
    :initial-explorer-selected-path="props.initialExplorerSelectedPath"
    :can-run="props.canRun"
    :is-running="props.isRunning"
    :has-run-artifacts="props.hasRunArtifacts"
    :active-run="props.activeRun"
    :run-history="props.runHistory"
    :command-templates="props.commandTemplates"
    :executor="props.executor"
    @open-file="emit('open-file', $event)"
    @open-folder="emit('open-folder')"
    @open-git-diff="emit('open-git-diff', $event)"
    @run="emit('run')"
    @create-document="emit('create-document')"
    @open-terminal="emit('open-terminal')"
    @insert-template="emit('insert-template', $event)"
    @clear-run-history="emit('clear-run-history')"
    @explorer-state-change="emit('explorer-state-change', $event)"
  />
</template>
