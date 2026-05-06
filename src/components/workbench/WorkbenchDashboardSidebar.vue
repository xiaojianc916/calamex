<script setup lang="ts">
import AppSidebar from '@/components/workbench/AppSidebar.vue';
import type { TWorkbenchSidebarView } from '@/types/app';
import type {
    IActiveRunSummary,
    ICommandTemplate,
    IEditorDocument,
    IRunHistoryEntry,
    IWorkspaceDirectoryPayload,
    TExecutorKind,
} from '@/types/editor';
import type { IGitDiffPreviewRequest } from '@/types/git';
import appBrandIcon from '../../../assets/brand/1.svg';

type TPrimarySidebarView = Exclude<TWorkbenchSidebarView, 'ai'>;

interface ISidebarTabItem {
    label: string;
    view: TPrimarySidebarView;
}

defineProps<{
    activeView: TWorkbenchSidebarView;
    isAiMode: boolean;
    document: IEditorDocument;
    isDesktopRuntime: boolean;
    workspaceRootPath: string | null;
    preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
    canRun: boolean;
    isRunning: boolean;
    hasRunArtifacts: boolean;
    activeRun: IActiveRunSummary | null;
    runHistory: IRunHistoryEntry[];
    commandTemplates: ICommandTemplate[];
    executor: TExecutorKind;
}>();

const emit = defineEmits<{
    'select-view': [view: TWorkbenchSidebarView];
    'toggle-primary-mode': [];
    'open-file': [path: string];
    'open-git-diff': [payload: IGitDiffPreviewRequest];
    run: [];
    'create-document': [];
    'open-terminal': [];
    'insert-template': [template: ICommandTemplate];
    'clear-run-history': [];
}>();

const sidebarTabs: readonly ISidebarTabItem[] = [
    { label: '文件', view: 'explorer' },
    { label: '搜索', view: 'search' },
    { label: 'Git', view: 'source-control' },
    { label: '运行', view: 'run' },
    { label: 'SSH', view: 'extensions' },
] as const;
</script>

<template>
    <aside class="workbench-dashboard-sidebar flex h-full min-h-0 flex-col overflow-hidden bg-(--sidebar-bg)">
        <div class="workbench-dashboard-sidebar__brand-slot">
            <button type="button" class="workbench-dashboard-sidebar__brand-button app-tooltip-target"
                :title="isAiMode ? '切换到编辑区' : '切换到 AI 界面'" :aria-label="isAiMode ? '切换到编辑区' : '切换到 AI 界面'"
                :data-tooltip="isAiMode ? '切换到编辑区' : '切换到 AI 界面'" data-tooltip-placement="bottom"
                data-tooltip-lock-placement="true" @click="emit('toggle-primary-mode')">
                <img class="workbench-dashboard-sidebar__brand-icon" :src="appBrandIcon" alt="软件图标">
            </button>
        </div>

        <header class="workbench-dashboard-sidebar__toolbar-shell border-b border-(--shell-divider) px-3 py-3">
            <nav class="workbench-dashboard-sidebar__toolbar" aria-label="工作台侧边栏切换">
                <button v-for="item in sidebarTabs" :key="item.view" type="button"
                    class="workbench-dashboard-sidebar__toolbar-button app-tooltip-target"
                    :class="{ 'is-active': activeView === item.view }" :title="item.label" :aria-label="item.label"
                    :aria-pressed="activeView === item.view" :data-tooltip="item.label" data-tooltip-placement="bottom"
                    data-tooltip-lock-placement="true" @click="emit('select-view', item.view)">
                    <span class="workbench-dashboard-sidebar__toolbar-icon" aria-hidden="true">
                        <svg v-if="item.view === 'explorer'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                            <path d="M14 3v5h5" />
                        </svg>

                        <svg v-else-if="item.view === 'search'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="11" cy="11" r="6.5" />
                            <path d="M20 20l-3.5-3.5" />
                        </svg>

                        <svg v-else-if="item.view === 'source-control'" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="6" cy="6" r="2.5" />
                            <circle cx="18" cy="4" r="2.5" />
                            <circle cx="18" cy="18" r="2.5" />
                            <path d="M8.5 6h3a4 4 0 0 1 4 4v5.5" />
                            <path d="M15.5 6.5V9" />
                        </svg>

                        <svg v-else-if="item.view === 'run'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3.5" y="5" width="17" height="14" rx="2" />
                            <path d="M7 9l3 3-3 3" />
                            <path d="M12.5 15h4.5" />
                        </svg>

                        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                            stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
                            <path d="M8 9l4 4-4 4" />
                            <path d="M13.5 17h2.5" />
                        </svg>
                    </span>

                    <span v-if="activeView === item.view" class="workbench-dashboard-sidebar__toolbar-label">
                        {{ item.label }}
                    </span>
                </button>
            </nav>
        </header>

        <div class="min-h-0 flex-1 overflow-hidden">
            <AppSidebar :document="document" :view="activeView" :is-desktop-runtime="isDesktopRuntime"
                :workspace-root-path="workspaceRootPath" :preloaded-workspace-root="preloadedWorkspaceRoot"
                :can-run="canRun" :is-running="isRunning" :has-run-artifacts="hasRunArtifacts" :active-run="activeRun"
                :run-history="runHistory" :command-templates="commandTemplates" :executor="executor"
                @open-file="emit('open-file', $event)" @open-git-diff="emit('open-git-diff', $event)" @run="emit('run')"
                @create-document="emit('create-document')" @open-terminal="emit('open-terminal')"
                @insert-template="emit('insert-template', $event)" @clear-run-history="emit('clear-run-history')" />
        </div>
    </aside>
</template>

<style scoped>
.workbench-dashboard-sidebar {
    padding-top: 0;
}

.workbench-dashboard-sidebar__brand-slot {
    display: flex;
    align-items: center;
    min-height: 28px;
    padding: 8px 18px 2px;
    background: #fafafa;
    flex-shrink: 0;
}

.workbench-dashboard-sidebar__brand-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 10px;
    color: var(--text-primary);
    transition:
        background-color 180ms ease,
        box-shadow 180ms ease,
        transform 180ms ease;
}

.workbench-dashboard-sidebar__brand-button:hover {
    background: color-mix(in srgb, var(--shell-divider) 12%, #fafafa);
}

.workbench-dashboard-sidebar__brand-button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 32%, transparent);
}

.workbench-dashboard-sidebar__brand-button:active {
    transform: translateY(1px);
}

.workbench-dashboard-sidebar__brand-icon {
    display: block;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
}

.workbench-dashboard-sidebar__toolbar-shell {
    background: #fafafa;
}

.workbench-dashboard-sidebar__toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
}

.workbench-dashboard-sidebar__toolbar::-webkit-scrollbar {
    display: none;
}

.workbench-dashboard-sidebar__toolbar-button {
    display: inline-flex;
    min-width: 38px;
    height: 38px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 999px;
    padding: 0 10px;
    color: var(--text-secondary);
    transition:
        background-color 180ms ease,
        color 180ms ease,
        box-shadow 180ms ease;
}

.workbench-dashboard-sidebar__toolbar-button:hover {
    color: var(--text-primary);
    background: #fafafa;
}

.workbench-dashboard-sidebar__toolbar-button.is-active {
    color: var(--text-primary);
    background: #fafafa;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--shell-divider) 86%, transparent);
}

.workbench-dashboard-sidebar__toolbar-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
}

.workbench-dashboard-sidebar__toolbar-icon svg {
    width: 18px;
    height: 18px;
}

.workbench-dashboard-sidebar__toolbar-label {
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
}

:deep(.app-sidebar-shell) {
    background: transparent;
}
</style>