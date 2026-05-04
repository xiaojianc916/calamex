<script setup lang="ts">
import '@/assets/css/run-sidebar.css';
import RunSidebarConfigsSection from '@/components/workbench/run-sidebar/RunSidebarConfigsSection.vue';
import RunSidebarHistorySection from '@/components/workbench/run-sidebar/RunSidebarHistorySection.vue';
import RunSidebarQuickSection from '@/components/workbench/run-sidebar/RunSidebarQuickSection.vue';
import RunSidebarTemplatesSection from '@/components/workbench/run-sidebar/RunSidebarTemplatesSection.vue';
import type {
    IConfigRow,
    IQuickRow,
} from '@/components/workbench/run-sidebar/runSidebarModel';
import {
    buildQuickRows,
    filterItems,
    formatDuration,
    formatHistoryTime,
    resolveHistoryExitLabel,
} from '@/components/workbench/run-sidebar/runSidebarModel';
import { useIntegratedTerminalControls } from '@/composables/useIntegratedTerminal';
import { useMessage } from '@/composables/useMessage';
import type {
    IActiveRunSummary,
    ICommandTemplate,
    IEditorDocument,
    IRunHistoryEntry,
    TExecutorKind,
} from '@/types/editor';
import { toErrorMessage } from '@/utils/error';
import { getExecutorLabel } from '@/utils/templates';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

type TSectionKey = 'configs' | 'quick' | 'templates' | 'history';

type TRunSidebarTemplateSectionItem = {
    id: string;
    title: string;
    description: string;
};

type TRunSidebarHistorySectionItem = {
    id: string;
    status: 'success' | 'failed' | 'canceled';
    documentName: string;
    commandLine: string;
    durationLabel: string;
    exitLabel: string;
    finishedAtLabel: string;
};

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

const message = useMessage();
const { interrupt, clearScreen } = useIntegratedTerminalControls();

const searchQuery = ref('');
const elapsedNow = ref(Date.now());
const collapsedSections = ref<Record<TSectionKey, boolean>>({
    configs: false,
    quick: false,
    templates: true,
    history: false,
});

let elapsedTimerId: number | null = null;

const executorLabel = computed(() => getExecutorLabel(props.executor));
const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLowerCase());
const activeElapsedLabel = computed(() => {
    if (!props.activeRun) {
        return '';
    }

    return formatDuration(
        Math.max(0, elapsedNow.value - new Date(props.activeRun.startedAt).getTime()),
    );
});

const configRows = computed<IConfigRow[]>(() => {
    const currentScriptCommand = props.activeRun?.commandLine
        ?? (props.hasActiveDocument
            ? `${executorLabel.value} · 当前脚本`
            : '创建或打开脚本后即可运行');

    return [
        {
            id: 'current-script',
            name: props.hasActiveDocument ? props.document.name : '未打开脚本',
            command: currentScriptCommand,
            icon: 'terminal',
            action: 'run',
            disabled: !props.canRun && !props.isRunning,
            running: props.isRunning,
        },
        {
            id: 'terminal-session',
            name: '集成终端',
            command: props.isDesktopRuntime
                ? `${executorLabel.value} · 查看实时输出与交互会话`
                : '浏览器预览模式下不可用',
            icon: 'monitor',
            action: 'open-terminal',
            disabled: !props.isDesktopRuntime,
            running: false,
        },
    ];
});

const filteredConfigRows = computed(() => filterItems(configRows.value, normalizedSearchQuery.value, [
    'name',
    'command',
]));

const quickRows = computed<IQuickRow[]>(() => {
    return buildQuickRows({
        isRunning: props.isRunning,
        activeElapsedLabel: activeElapsedLabel.value,
        hasActiveDocument: props.hasActiveDocument,
        documentName: props.document.name,
        canRun: props.canRun,
        isDesktopRuntime: props.isDesktopRuntime,
        runHistory: props.runHistory,
        hasRunArtifacts: props.hasRunArtifacts,
    });
});

const filteredQuickRows = computed(() => filterItems(quickRows.value, normalizedSearchQuery.value, [
    'name',
    'command',
    'badge',
]));

const filteredTemplates = computed(() =>
    filterItems(props.commandTemplates, normalizedSearchQuery.value, [
        'title',
        'description',
        'category',
    ]),
);

const filteredRunHistory = computed(() =>
    filterItems(props.runHistory, normalizedSearchQuery.value, [
        'documentName',
        'commandLine',
        'executorLabel',
    ]),
);

const templateItems = computed<TRunSidebarTemplateSectionItem[]>(() =>
    filteredTemplates.value.map((template) => ({
        id: template.id,
        title: template.title,
        description: template.description,
    })),
);

const historyItems = computed<TRunSidebarHistorySectionItem[]>(() =>
    filteredRunHistory.value.map((entry) => ({
        id: entry.id,
        status: entry.status,
        documentName: entry.documentName,
        commandLine: entry.commandLine,
        durationLabel: formatDuration(entry.durationMs),
        exitLabel: resolveHistoryExitLabel(entry),
        finishedAtLabel: formatHistoryTime(entry.finishedAt),
    })),
);

const startElapsedTimer = (): void => {
    if (elapsedTimerId !== null) {
        return;
    }

    elapsedNow.value = Date.now();
    elapsedTimerId = window.setInterval(() => {
        elapsedNow.value = Date.now();
    }, 1000);
};

const stopElapsedTimer = (): void => {
    if (elapsedTimerId === null) {
        return;
    }

    window.clearInterval(elapsedTimerId);
    elapsedTimerId = null;
};

watch(
    () => props.activeRun?.runId ?? null,
    (runId) => {
        if (runId) {
            startElapsedTimer();
            return;
        }

        stopElapsedTimer();
        elapsedNow.value = Date.now();
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    stopElapsedTimer();
});

const toggleSection = (section: TSectionKey): void => {
    collapsedSections.value[section] = !collapsedSections.value[section];
};

const handleRun = (): void => {
    if (!props.canRun && !props.isRunning) {
        message.info('当前没有可执行脚本。');
        return;
    }

    emit('run');
};

const handleStop = async (): Promise<void> => {
    try {
        await interrupt();
        emit('open-terminal');
    } catch (error) {
        message.error(toErrorMessage(error, '停止运行失败'));
    }
};

const handleClearHistory = async (): Promise<void> => {
    emit('clear-run-history');

    try {
        await clearScreen();
    } catch {
        // 日志已清空，忽略终端清屏失败。
    }
};

const handleConfigAction = async (row: IConfigRow): Promise<void> => {
    if (row.disabled) {
        return;
    }

    if (row.action === 'open-terminal') {
        emit('open-terminal');
        return;
    }

    if (props.isRunning) {
        await handleStop();
        return;
    }

    handleRun();
};

const handleQuickAction = async (row: IQuickRow): Promise<void> => {
    if (row.disabled) {
        return;
    }

    switch (row.action) {
        case 'run':
            handleRun();
            return;
        case 'stop':
            await handleStop();
            return;
        case 'open-terminal':
            emit('open-terminal');
            return;
        case 'clear-history':
            await handleClearHistory();
            return;
    }
};

const handleTemplateClick = (template: ICommandTemplate): void => {
    emit('insert-template', template);
};

const handleTemplateSelect = (template: TRunSidebarTemplateSectionItem): void => {
    const selectedTemplate = props.commandTemplates.find((item) => item.id === template.id);
    if (selectedTemplate) {
        handleTemplateClick(selectedTemplate);
    }
};

const handleHistoryClick = (): void => {
    emit('open-terminal');
};
</script>

<template>
    <section class="run-sidebar-shell" aria-label="运行侧边栏">
        <header class="run-sidebar-header">
            <div class="run-sidebar-title-row">
                <span class="run-sidebar-title">运行</span>

                <div class="run-sidebar-actions">
                    <button
type="button" class="run-sidebar-icon-button" aria-label="新建脚本" title="新建脚本"
                        @click="emit('create-document')">
                        <svg
viewBox="0 0 16 16" class="run-sidebar-icon run-sidebar-icon-sm" fill="none"
                            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                            aria-hidden="true">
                            <path d="M8 3.5v9" />
                            <path d="M3.5 8h9" />
                        </svg>
                    </button>

                    <button
type="button" class="run-sidebar-icon-button" aria-label="打开终端" title="打开终端"
                        @click="emit('open-terminal')">
                        <svg
viewBox="0 0 16 16" class="run-sidebar-icon run-sidebar-icon-sm" fill="none"
                            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                            aria-hidden="true">
                            <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
                            <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
                            <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
                        </svg>
                    </button>
                </div>
            </div>

            <label class="run-sidebar-search" aria-label="搜索运行项">
                <svg
viewBox="0 0 16 16" class="run-sidebar-icon run-sidebar-icon-sm" fill="none" stroke="currentColor"
                    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="7" cy="7" r="4.5" />
                    <path d="M10.5 10.5L13.5 13.5" />
                </svg>
                <input v-model="searchQuery" type="text" placeholder="搜索配置…">
            </label>

            <div class="run-sidebar-progress" :class="{ 'is-active': isRunning }" aria-hidden="true">
                <div class="run-sidebar-progress-bar"></div>
            </div>
        </header>

        <div class="run-sidebar-scroll">
            <RunSidebarConfigsSection
:collapsed="collapsedSections.configs" :rows="filteredConfigRows as IConfigRow[]"
                :has-query="Boolean(normalizedSearchQuery)" :active-elapsed-label="activeElapsedLabel"
                @toggle="toggleSection('configs')" @action="(row) => void handleConfigAction(row as IConfigRow)" />

            <RunSidebarQuickSection
:collapsed="collapsedSections.quick" :rows="filteredQuickRows as IQuickRow[]"
                @toggle="toggleSection('quick')" @action="(row) => void handleQuickAction(row as IQuickRow)" />

            <RunSidebarTemplatesSection
:collapsed="collapsedSections.templates" :templates="templateItems"
                :has-query="Boolean(normalizedSearchQuery)" @toggle="toggleSection('templates')"
                @select="handleTemplateSelect" />

            <RunSidebarHistorySection
:collapsed="collapsedSections.history" :entries="historyItems"
                :has-query="Boolean(normalizedSearchQuery)" @toggle="toggleSection('history')"
                @open="handleHistoryClick" />
        </div>
    </section>
</template>
