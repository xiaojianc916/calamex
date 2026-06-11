<script setup lang="ts">
import '@/assets/css/run-sidebar.css';
import type {
  IActiveRunSummary,
  ICommandTemplate,
  IEditorDocument,
  IRunHistoryEntry,
  TExecutorKind,
} from '@/types/editor';
import RunSidebarTemplatesSection from './RunSidebarTemplatesSection.vue';

defineProps<{
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
    <section class="run-sidebar-shell" aria-label="运行侧边栏">
        <RunSidebarTemplatesSection />
    </section>
</template>
