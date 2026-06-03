<template>
  <AppShellLayout :is-desktop-runtime="isDesktopRuntime" :sidebar-visible="isSidebarVisible"
    :sidebar-width="sidebarWidth" @close-request="handleRequestCloseApplication">
    <template #sidebar>
      <WorkbenchDashboardSidebar :active-view="activeSidebarView" :document="editorStore.document"
        :is-ai-mode="isAiMode" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="visibleWorkspaceRootPath"
        :preloaded-workspace-root="startupWorkspaceRoot"
        :startup-explorer-expanded-paths="startupShellState?.explorerExpandedPaths ?? []"
        :startup-explorer-selected-path="startupShellState?.explorerSelectedPath ?? null" :can-run="canRun"
        :is-running="editorStore.isRunning" :has-run-artifacts="editorStore.hasRunArtifacts"
        :active-run="editorStore.activeRunSummary" :run-history="editorStore.runHistory"
        :command-templates="commandTemplates" :executor="editorStore.selectedExecutor"
        @select-view="handleSelectSidebarView" @toggle-primary-mode="handleTogglePrimaryMode"
        @open-file="handleSidebarOpenFile" @open-folder="openFolder" @open-git-diff="handleSidebarOpenGitDiff"
        @run="handleRunScript" @create-document="createNewDocument" @open-terminal="openTerminal"
        @insert-template="handleInsertTemplate" @clear-run-history="handleClearRunHistory"
        @explorer-state-change="handleExplorerSessionStateChange" />
    </template>

    <section :ref="bindEditorViewportRef" data-testid="workbench-root"
      class="workbench-editor-viewport relative flex h-full min-h-0 flex-col overflow-hidden bg-(--app-bg)"
      :data-diagnostics-resizing="diagnosticsTransitionsEnabled ? 'false' : 'true'">
      <div class="@container/main workbench-content-stage">
        <div class="workbench-content-dock">
          <div class="workbench-content-frame flex min-h-0 flex-1 flex-col workbench-content-card">
            <template v-if="isStartupShellVisible && startupShellState">
              <StartupAiWorkbenchShell v-if="isAiMode" />

              <StartupWorkbenchShell v-else :state="startupShellState"
                :show-terminal="isTerminalPanelVisible" :terminal-height="terminalHeight" />
            </template>

            <template v-else>
              <DeferredAiWorkspaceSurface v-if="isAiMode || hasPinnedAiWorkspace" v-show="isAiMode" class="min-w-0 flex-1"
                :aria-hidden="!isAiMode" :document="editorStore.document" :active-run="editorStore.activeRunSummary"
                :analysis="editorStore.activeScriptAnalysis" :selection="editorStore.activeSelectionSummary"
                :git-status="gitStore.status" :workspace-root-path="editorStore.workspaceRootPath"
                @open-patch-diff="openGitDiffPreviewPayload" />

              <Card v-show="!isAiMode"
                class="flex h-full