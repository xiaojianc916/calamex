<script setup lang="ts">
import RunSidebarPanel from '@/components/workbench/sidebar/run/RunSidebarPanel.vue';
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

defineEmits<{
  run: [];
  'create-document': [];
  'open-terminal': [];
  'insert-template': [template: ICommandTemplate];
  'clear-run-history': [];
}>();
</script>

<template>
  <RunSidebarPanel v-bind="props" />
</template>
