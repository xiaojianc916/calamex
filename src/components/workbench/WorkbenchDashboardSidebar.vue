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
    TWorkbenchOpenFilePayload,
} from '@/types/editor';
import type { IGitDiffPreviewRequest } from '@/types/git';
import {
    FolderTree,
    GitBranch,
    LibraryBig,
    Search,
    TerminalSquare,
} from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import appBrandIcon from '../../../resources/logo.svg';

type TPrimarySidebarView = Exclude<TWorkbenchSidebarView, 'ai'>;

interface ISidebarTabItem {
    label: string;
    view: TPrimarySidebarView;
}

type TSidebarSwitchDirection = 'forward' | 'backward' | 'none';

const props = defineProps<{
    activeView: TWorkbenchSidebarView;
    isAiMode: boolean;
    document: IEditorDocument;
    isDesktopRuntime: boolean;
    workspaceRootPath: string | null;
    preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
    startupExplorerExpandedPaths: string[];
    startupExplorerSelectedPath: string | null;
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

const sidebarTabs: readonly ISidebarTabItem[] = [
    { label: '文件', view: 'explorer' },
    { label: '搜索', view: 'search' },
    { label: 'Git', view: 'source-control' },
    { label: '模板', view: 'run' },
    { label: 'SSH', view: 'extensions' },
] as const;

const activeTabIndex = computed(() =>
    Math.max(0, sidebarTabs.findIndex((item) => item.view === props.activeView)),
);
const switchDirection = ref<TSidebarSwitchDirection>('none');

watch(
    activeTabIndex,
    (nextIndex, previousIndex) => {
        if (previousIndex === undefined || nextIndex === previousIndex) {
            switchDirection.value = 'none';
            return;
        }

        switchDirection.value = nextIndex > previousIndex ? 'forward' : 'backward';
    },
    { flush: 'sync' },
);

</script>

<template>
    <aside class="workbench-dashboard-sidebar flex h-full min-h-0 flex-col overflow-hidden bg-(--sidebar-bg)">
        <div class="workbench-dashboard-sidebar__brand-slot">
            <button
type="button" class="workbench-dashboard-sidebar__brand-button"
                :aria-label="props.isAiMode ? '切换到编辑区' : '切换到 AI 界面'" :title="props.isAiMode ? '切换到编辑区' : '切换到 AI 界面'"
                @click="emit('toggle-primary-mode')">
                <img class="workbench-dashboard-sidebar__brand-icon" :src="appBrandIcon" alt="软件图标">
            </button>
        </div>

        <header class="workbench-dashboard-sidebar__toolbar-shell border-b border-(--shell-divider) px-3 py-3">
            <nav class="workbench-dashboard-sidebar__toolbar" aria-label="工作台侧边栏切换">
                <button
v-for="item in sidebarTabs" :key="item.view" type="button"
                    class="workbench-dashboard-sidebar__toolbar-button"
                    :class="{ 'is-active': props.activeView === item.view }" :aria-label="item.label"
                    :aria-pressed="props.activeView === item.view" @click="emit('select-view', item.view)">
                    <span class="workbench-dashboard-sidebar__toolbar-icon" aria-hidden="true">
                        <FolderTree v-if="item.view === 'explorer'" />
                        <Search v-else-if="item.view === 'search'" />
                        <GitBranch v-else-if="item.view === 'source-control'" />
                        <LibraryBig v-else-if="item.view === 'run'" />
                        <TerminalSquare v-else />
                    </span>

                    <span class="workbench-dashboard-sidebar__toolbar-label-wrap" aria-hidden="true">
                        <span class="workbench-dashboard-sidebar__toolbar-label">
                            {{ item.label }}
                        </span>
                    </span>
                </button>
            </nav>
        </header>

        <div
class="workbench-dashboard-sidebar__panel-host min-h-0 flex-1 overflow-hidden"
            :data-switch-direction="switchDirection">
            <Transition name="workbench-sidebar-panel">
                <AppSidebar
:document="props.document" :view="props.activeView"
                    :is-desktop-runtime="props.isDesktopRuntime" :workspace-root-path="props.workspaceRootPath"
                    :preloaded-workspace-root="props.preloadedWorkspaceRoot"
                    :startup-explorer-expanded-paths="props.startupExplorerExpandedPaths"
                    :startup-explorer-selected-path="props.startupExplorerSelectedPath" :can-run="props.canRun"
                    :is-running="props.isRunning" :has-run-artifacts="props.hasRunArtifacts"
                    :active-run="props.activeRun" :run-history="props.runHistory"
                    :command-templates="props.commandTemplates" :executor="props.executor"
                    @open-file="emit('open-file', $event)" @open-folder="emit('open-folder')"
                    @open-git-diff="emit('open-git-diff', $event)" @run="emit('run')"
                    @create-document="emit('create-document')" @open-terminal="emit('open-terminal')"
                    @insert-template="emit('insert-template', $event)" @clear-run-history="emit('clear-run-history')"
                    @explorer-state-change="emit('explorer-state-change', $event)" />
            </Transition>
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
    background: var(--sidebar-bg);
    flex-shrink: 0;
}

.workbench-dashboard-sidebar__brand-button {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    width: 28px;
    height: 28px;
    border-radius: 10px;
    overflow: visible;
    color: var(--text-primary);
    transition:
        background-color 180ms ease,
        box-shadow 180ms ease,
        transform 180ms ease;
}

.workbench-dashboard-sidebar__brand-button:hover {
    background: color-mix(in srgb, var(--shell-divider) 12%, var(--sidebar-bg));
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
    width: 70px;
    height: auto;
    max-width: none;
    flex-shrink: 0;
    pointer-events: none;
}

.workbench-dashboard-sidebar__toolbar-shell {
    background: var(--sidebar-bg);
}

.workbench-dashboard-sidebar__toolbar {
    --sidebar-pill-ease: cubic-bezier(0.32, 0.72, 0, 1);
    --sidebar-pill-duration: 160ms;
    --sidebar-pill-label-delay: 24ms;
    --sidebar-pill-label-duration: 130ms;
    --sidebar-pill-state-duration: 90ms;

    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    padding: 0;
    scrollbar-width: none;
}

.workbench-dashboard-sidebar__toolbar::-webkit-scrollbar {
    display: none;
}

.workbench-dashboard-sidebar__toolbar-button {
    position: relative;
    display: inline-flex;
    align-self: center;
    min-width: 38px;
    height: 28px;
    align-items: center;
    justify-content: center;
    gap: 0;
    overflow: hidden;
    border-radius: 999px;
    border: none;
    background: color-mix(in srgb, var(--shell-divider) 8%, transparent);
    padding: 0 10px;
    color: var(--text-secondary);
    line-height: 1;
    white-space: nowrap;
    transition:
        background-color var(--sidebar-pill-state-duration) ease,
        color var(--sidebar-pill-state-duration) ease,
        gap var(--sidebar-pill-duration) var(--sidebar-pill-ease);
}

@media (hover: hover) and (pointer: fine) {
    .workbench-dashboard-sidebar__toolbar-button:hover {
        background: color-mix(in srgb, var(--shell-divider) 22%, transparent);
        color: var(--text-primary);
    }
}

.workbench-dashboard-sidebar__toolbar-button.is-active {
    gap: 6px;
    background: color-mix(in srgb, var(--shell-divider) 34%, transparent);
    color: var(--text-primary);
    box-shadow: none;
}

.workbench-dashboard-sidebar__toolbar-button:active {
    background: color-mix(in srgb, var(--shell-divider) 40%, transparent);
}

.workbench-dashboard-sidebar__toolbar-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    transform: translateY(0.5px);
}

.workbench-dashboard-sidebar__toolbar-icon svg {
    width: 16px;
    height: 16px;
}

.workbench-dashboard-sidebar__toolbar-label-wrap {
    display: grid;
    align-items: center;
    grid-template-columns: 0fr;
    transition: grid-template-columns var(--sidebar-pill-duration) var(--sidebar-pill-ease);
}

.workbench-dashboard-sidebar__toolbar-label {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    opacity: 0;
    transform: translate(-3px, 0.5px);
    transition:
        opacity var(--sidebar-pill-label-duration) ease var(--sidebar-pill-label-delay),
        transform var(--sidebar-pill-duration) var(--sidebar-pill-ease) var(--sidebar-pill-label-delay);
}

.workbench-dashboard-sidebar__toolbar-button.is-active .workbench-dashboard-sidebar__toolbar-label-wrap {
    grid-template-columns: 1fr;
}

.workbench-dashboard-sidebar__toolbar-button.is-active .workbench-dashboard-sidebar__toolbar-label {
    opacity: 1;
    transform: translate(0, 0.5px);
}

.workbench-dashboard-sidebar__panel-host {
    --sidebar-panel-enter-x: 0px;
    --sidebar-panel-leave-x: 0px;

    position: relative;
    contain: layout paint;
}

.workbench-dashboard-sidebar__panel-host :deep(.app-sidebar-shell) {
    position: absolute;
    inset: 0;
    width: 100%;
}

.workbench-dashboard-sidebar__panel-host[data-switch-direction='forward'] {
    --sidebar-panel-enter-x: 12px;
    --sidebar-panel-leave-x: -10px;
}

.workbench-dashboard-sidebar__panel-host[data-switch-direction='backward'] {
    --sidebar-panel-enter-x: -12px;
    --sidebar-panel-leave-x: 10px;
}

:deep(.workbench-sidebar-panel-enter-active) {
    transition:
        opacity 220ms var(--motion-easing-emphasized),
        transform 240ms var(--motion-easing-emphasized),
        filter 220ms var(--motion-easing-emphasized);
}

:deep(.workbench-sidebar-panel-leave-active) {
    transition:
        opacity 130ms var(--motion-easing-exit),
        transform 130ms var(--motion-easing-exit),
        filter 130ms var(--motion-easing-exit);
}

:deep(.workbench-sidebar-panel-enter-from) {
    opacity: 0;
    filter: blur(2px);
    transform: translateX(var(--sidebar-panel-enter-x)) scale(0.992);
}

:deep(.workbench-sidebar-panel-leave-to) {
    opacity: 0;
    filter: blur(2px);
    transform: translateX(var(--sidebar-panel-leave-x)) scale(0.992);
}

:deep(.workbench-sidebar-panel-enter-to),
:deep(.workbench-sidebar-panel-leave-from) {
    opacity: 1;
    filter: blur(0);
    transform: translateX(0) scale(1);
}

:deep(.app-sidebar-shell) {
    background: transparent;
}

@media (prefers-reduced-motion: reduce) {

    .workbench-dashboard-sidebar__toolbar-button,
    .workbench-dashboard-sidebar__toolbar-label,
    .workbench-dashboard-sidebar__toolbar-label-wrap,
    :deep(.workbench-sidebar-panel-enter-active),
    :deep(.workbench-sidebar-panel-leave-active) {
        transition: none;
    }

    :deep(.workbench-sidebar-panel-enter-from),
    :deep(.workbench-sidebar-panel-leave-to) {
        filter: none;
        transform: none;
    }
}
</style>
