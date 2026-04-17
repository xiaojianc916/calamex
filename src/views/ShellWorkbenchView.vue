<template>
  <AppShellLayout
    :is-desktop-runtime="isDesktopRuntime"
    :terminal-visible="isTerminalVisible"
    :terminal-height="terminalHeight"
    @update:terminal-height="terminalHeight = $event"
  >
    <template #titlebar>
      <WindowTitleBar
        :document-name="editorStore.document.name"
        :is-dirty="editorStore.document.isDirty"
        :theme="appStore.theme"
        :is-running="editorStore.isRunning"
        :is-desktop-runtime="isDesktopRuntime"
        :is-terminal-visible="isTerminalVisible"
        :command-templates="commandTemplates"
        :comment-templates="commentTemplates"
        @new="createNewDocument"
        @open="openDocument"
        @open-folder="openFolder"
        @save="saveDocument"
        @save-as="saveDocumentAs"
        @close-request="requestCloseApplication"
        @run="handleRunScript"
        @open-terminal="openTerminal"
        @hide-terminal="hideTerminal"
        @toggle-theme="toggleTheme"
        @insert-template="handleInsertTemplate"
      />
    </template>

    <template #activity>
      <ActivityRail />
    </template>

    <template #sidebar>
      <AppSidebar
        :document="editorStore.document"
        :is-desktop-runtime="isDesktopRuntime"
        :workspace-root-path="editorStore.workspaceRootPath"
        @open-file="openDocumentByPath"
      />
    </template>

    <template #header>
      <WorkbenchHeader
        :documents="editorStore.documents"
        :active-document-id="editorStore.activeDocumentId"
        :file-path="editorStore.document.path"
        @select-tab="activateDocument"
        @close-tab="requestCloseDocument"
      />
    </template>

    <div class="h-full">
      <SmartScriptEditor
        ref="editorRef"
        :model-value="editorStore.document.content"
        :theme="appStore.theme"
        @update:model-value="updateContent"
        @cursor-position-change="handleCursorPositionChange"
      />
    </div>

    <template #terminal>
      <RunPanel
        :terminal-output="editorStore.terminalOutput"
        :run-logs="editorStore.runLogs"
        :last-run-result="editorStore.lastRunResult"
        :is-running="editorStore.isRunning"
        :executor="editorStore.selectedExecutor"
        :theme="appStore.theme"
        :workspace-root-path="editorStore.workspaceRootPath"
        :visible="isTerminalVisible"
        @hide="hideTerminal"
      />
    </template>

    <template #statusbar>
      <WorkbenchStatusBar
        :is-running="editorStore.isRunning"
        :encoding="editorStore.document.encoding"
        :executor="editorStore.selectedExecutor"
        :cursor-line="editorStore.cursorLine"
        :cursor-column="editorStore.cursorColumn"
        :char-count="editorStore.document.charCount"
        @change-encoding="updateEncoding"
        @change-executor="updateExecutor"
      />
    </template>
  </AppShellLayout>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import WindowTitleBar from '@/components/common/WindowTitleBar.vue';
import SmartScriptEditor from '@/components/editor/SmartScriptEditor.vue';
import ActivityRail from '@/components/workbench/ActivityRail.vue';
import AppSidebar from '@/components/workbench/AppSidebar.vue';
import RunPanel from '@/components/workbench/RunPanel.vue';
import WorkbenchHeader from '@/components/workbench/WorkbenchHeader.vue';
import WorkbenchStatusBar from '@/components/workbench/WorkbenchStatusBar.vue';
import { useWorkbench } from '@/composables/useWorkbench';
import AppShellLayout from '@/layouts/AppShellLayout.vue';
import type { ICommandTemplate } from '@/types/editor';

type TEditorExpose = {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
};

const editorRef = ref<TEditorExpose | null>(null);
const isTerminalVisible = ref(true);
const terminalHeight = ref(236);

const {
  appStore,
  editorStore,
  isDesktopRuntime,
  commandTemplates,
  commentTemplates,
  initialize,
  createNewDocument,
  openDocument,
  openFolder,
  openDocumentByPath,
  saveDocument,
  saveDocumentAs,
  requestCloseDocument,
  requestCloseApplication,
  activateDocument,
  runScript,
  updateContent,
  updateEncoding,
  updateExecutor,
  toggleTheme,
  notifyTemplateInserted,
} = useWorkbench();

const handleInsertTemplate = (template: ICommandTemplate): void => {
  editorRef.value?.insertSnippet(template.snippet);
  editorRef.value?.focusEditor();
  notifyTemplateInserted(template);
};

const handleCursorPositionChange = (line: number, column: number): void => {
  editorStore.setCursorPosition(line, column);
};

const openTerminal = (): void => {
  isTerminalVisible.value = true;
};

const hideTerminal = (): void => {
  isTerminalVisible.value = false;
};

const handleRunScript = async (): Promise<void> => {
  isTerminalVisible.value = true;
  await runScript();
};

onMounted(() => {
  void initialize();
});
</script>
