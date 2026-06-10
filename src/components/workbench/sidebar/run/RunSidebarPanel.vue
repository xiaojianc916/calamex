<script setup lang="ts">
import LegacyRunSidebarPanel from '@/components/workbench/RunSidebarPanel.vue';
import type {
  IActiveRunSummary,
  ICommandTemplate,
  IEditorDocument,
  IRunHistoryEntry,
  TExecutorKind,
} from '@/types/editor';

const props = defineProps<{
  document: IEditorDocument;
  hasActiveDocument: boolean;
  isDesktopRuntime: boolean;
  canRun: boolean;
  isRunning: boolean;
  hasRunArtifacts: boolean;
  activeRun: IActiveRunSummary | null;
  runHistory: IRunHistoryEntry[];
  commandTemplates: ICommandTemplate[];
  executor: TExecutorKind;
}>();

const emit = defineEmits<{
  run: [];
  'create-document': [];
  'open-terminal': [];
  'insert-template': [template: ICommandTemplate];
  'clear-run-history': [];
}>();
</script>

<template>
  <LegacyRunSidebarPanel
    :document="props.document"
    :has-active-document="props.hasActiveDocument"
    :is-desktop-runtime="props.isDesktopRuntime"
    :can-run="props.canRun"
    :is-running="props.isRunning"
    :has-run-artifacts="props.hasRunArtifacts"
    :active-run="props.activeRun"
    :run-history="props.runHistory"
    :command-templates="props.commandTemplates"
    :executor="props.executor"
    @run="emit('run')"
    @create-document="emit('create-document')"
    @open-terminal="emit('open-terminal')"
    @insert-template="emit('insert-template', $event)"
    @clear-run-history="emit('clear-run-history')"
  />
</template>
