<script setup lang="ts">
import type {
    IAnalyzeScriptPayload,
    IScriptDiagnostic,
    TScriptDiagnosticSeverity,
} from '@/types/editor';
import { writeClipboardText } from '@/utils/clipboard';
import { openExternalUrl } from '@/utils/browser';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type TDiagnosticFilter = 'all' | 'error' | 'warning' | 'info';
type TDiagnosticGroup = 'error' | 'warning' | 'info';

interface ISnippetFragment {
    text: string;
    highlighted: boolean;
}

interface ISnippetLine {
    key: string;
    fragments: ISnippetFragment[];
    isEmpty: boolean;
}

interface IDiagnosticCard extends IScriptDiagnostic {
    key: string;
    group: TDiagnosticGroup;
    previewLines: ISnippetLine[];
    isEmptyLine: boolean;
}

interface IDiagnosticFilterOption {
    id: TDiagnosticFilter;
    label: string;
    tone: TDiagnosticGroup | null;
}

interface IDiagnosticGroupOption {
    id: TDiagnosticGroup;
    label: string;
}

interface IDiagnosticGroupData extends IDiagnosticGroupOption {
    visibleCount: number;
    visibleItems: IDiagnosticCard[];
}

const FILTER_OPTIONS: IDiagnosticFilterOption[] = [
    { id: 'all', label: '全部', tone: null },
    { id: 'error', label: '错误', tone: 'error' },
    { id: 'warning', label: '警告', tone: 'warning' },
    { id: 'info', label: '提示', tone: 'info' },
];

const GROUP_OPTIONS: IDiagnosticGroupOption[] = [
    { id: 'error', label: '错误' },
    { id: 'warning', label: '警告' },
    { id: 'info', label: '提示' },
];

const RULES_URL = 'https://www.shellcheck.net/wiki/';

const props = defineProps<{
    analysis: IAnalyzeScriptPayload;
    content: string;
    documentName: string;
}>();

const emit = defineEmits<{
    'select-diagnostic': [line: number, column: number];
    'rerun-analysis': [];
    'ai-fix-diagnostic': [diagnostic: IScriptDiagnostic];
}>();

const activeFilter = ref<TDiagnosticFilter>('all');
const selectedItemKey = ref<string | null>(null);
const lastCheckedAt = ref(Date.now());
const nowTick = ref(Date.now());
const collapsedGroups = ref<Record<TDiagnosticGroup, boolean>>({
    error: false,
    warning: true,
    info: true,
});

let nowTimerId: number | null = null;

const normalizedLines = computed(() =>
    props.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n'),
);

const panelAriaLabel = computed(() =>
    props.documentName ? `ShellCheck 面板 · ${props.documentName}` : 'ShellCheck 面板',
);

const documentLineCount = computed(() => Math.max(1, normalizedLines.value.length));

const resolveDiagnosticGroup = (level: TScriptDiagnosticSeverity): TDiagnosticGroup => {
    switch (level) {
        case 'error':
            return 'error';
        case 'warning':
            return 'warning';
        default:
            return 'info';
    }
};

const resolveFragmentBounds = (
    lineText: string,
    startColumn: number,
    endColumn: number,
): { startIndex: number; endIndex: number } => {
    if (lineText.length === 0) {
        return {
            startIndex: 0,
            endIndex: 0,
        };
    }

    const startIndex = Math.min(Math.max(startColumn - 1, 0), lineText.length - 1);
    const requestedEnd = endColumn > startColumn ? endColumn - 1 : startIndex + 1;
    const endIndex = Math.max(startIndex + 1, Math.min(requestedEnd, lineText.length));

    return {
        startIndex,
        endIndex,
    };
};

const resolvePreviewLines = (item: IScriptDiagnostic): ISnippetLine[] => {
    const startLine = Math.max(1, item.line);
    const endLine = Math.max(startLine, item.endLine);
    const previewLines: ISnippetLine[] = [];

    for (let currentLine = startLine; currentLine <= endLine; currentLine += 1) {
        const lineText = normalizedLines.value[currentLine - 1] ?? '';

        if (lineText.length === 0) {
            previewLines.push({
                key: `${item.code}-${currentLine}`,
                fragments: [{ text: '', highlighted: false }],
                isEmpty: true,
            });
            continue;
        }

        const startColumn = currentLine === startLine ? item.column : 1;
        const endColumn = currentLine === endLine ? item.endColumn : lineText.length + 1;
        const { startIndex, endIndex } = resolveFragmentBounds(lineText, startColumn, endColumn);
        const fragments: ISnippetFragment[] = [];

        if (startIndex > 0) {
            fragments.push({
                text: lineText.slice(0, startIndex),
                highlighted: false,
            });
        }

        fragments.push({
            text: lineText.slice(startIndex, endIndex),
            highlighted: true,
        });

        if (endIndex < lineText.length) {
            fragments.push({
                text: lineText.slice(endIndex),
                highlighted: false,
            });
        }

        previewLines.push({
            key: `${item.code}-${currentLine}`,
            fragments,
            isEmpty: false,
        });
    }

    return previewLines;
};

const diagnosticCards = computed<IDiagnosticCard[]>(() =>
    props.analysis.diagnostics.map((item) => {
        const previewLines = resolvePreviewLines(item);

        return {
            ...item,
            key: `${item.code}-${item.line}-${item.column}-${item.message}`,
            group: resolveDiagnosticGroup(item.level),
            previewLines,
            isEmptyLine: previewLines.every((previewLine) => previewLine.isEmpty),
        };
    }),
);

const matchesFilter = (group: TDiagnosticGroup, filter: TDiagnosticFilter): boolean => {
    if (filter === 'all') {
        return true;
    }

    return group === filter;
};

const errorCount = computed(
    () => diagnosticCards.value.filter((item) => item.group === 'error').length,
);

const warningCount = computed(
    () => diagnosticCards.value.filter((item) => item.group === 'warning').length,
);

const infoCount = computed(
    () => diagnosticCards.value.filter((item) => item.group === 'info').length,
);

const hasAnyDiagnostics = computed(() => diagnosticCards.value.length > 0);

const showPassBadge = computed(() => props.analysis.available && !hasAnyDiagnostics.value);

const diagnosticGroups = computed<IDiagnosticGroupData[]>(() =>
    GROUP_OPTIONS.map((group) => {
        const visibleItems = diagnosticCards.value.filter((item) =>
            item.group === group.id && matchesFilter(item.group, activeFilter.value),
        );

        return {
            ...group,
            visibleCount: visibleItems.length,
            visibleItems,
        };
    }),
);

const visibleDiagnosticItems = computed(() =>
    diagnosticGroups.value.flatMap((group) => group.visibleItems),
);

const hasExpandedVisibleGroups = computed(() =>
    diagnosticGroups.value.some((group) => group.visibleCount > 0 && !collapsedGroups.value[group.id]),
);

const collapseAllLabel = computed(() =>
    hasExpandedVisibleGroups.value ? '折叠全部' : '展开全部',
);

const formatRelativeTime = (value: number): string => {
    const elapsedSeconds = Math.max(0, Math.floor((nowTick.value - value) / 1000));

    if (elapsedSeconds < 5) {
        return '刚刚';
    }

    if (elapsedSeconds < 60) {
        return `${elapsedSeconds}s 前`;
    }

    if (elapsedSeconds < 3600) {
        return `${Math.floor(elapsedSeconds / 60)}m 前`;
    }

    if (elapsedSeconds < 86400) {
        return `${Math.floor(elapsedSeconds / 3600)}h 前`;
    }

    return `${Math.floor(elapsedSeconds / 86400)}d 前`;
};

const lastCheckedLabel = computed(
    () => `${formatRelativeTime(lastCheckedAt.value)} · ${documentLineCount.value} 行`,
);

watch(
    () => props.analysis,
    () => {
        lastCheckedAt.value = Date.now();
    },
    { immediate: true },
);

watch(
    diagnosticGroups,
    (groups) => {
        collapsedGroups.value = {
            error: (groups.find((group) => group.id === 'error')?.visibleCount ?? 0) === 0,
            warning: (groups.find((group) => group.id === 'warning')?.visibleCount ?? 0) === 0,
            info: (groups.find((group) => group.id === 'info')?.visibleCount ?? 0) === 0,
        };
    },
    { immediate: true },
);

watch(
    visibleDiagnosticItems,
    (items) => {
        if (items.length === 0) {
            selectedItemKey.value = null;
            return;
        }

        if (!selectedItemKey.value || !items.some((item) => item.key === selectedItemKey.value)) {
            selectedItemKey.value = items[0].key;
        }
    },
    { immediate: true },
);

onMounted(() => {
    nowTimerId = window.setInterval(() => {
        nowTick.value = Date.now();
    }, 1000);
});

onBeforeUnmount(() => {
    if (nowTimerId !== null) {
        window.clearInterval(nowTimerId);
        nowTimerId = null;
    }
});

const countForFilter = (filter: TDiagnosticFilter): number => {
    switch (filter) {
        case 'error':
            return errorCount.value;
        case 'warning':
            return warningCount.value;
        case 'info':
            return infoCount.value;
        default:
            return diagnosticCards.value.length;
    }
};

const isGroupCollapsed = (group: TDiagnosticGroup): boolean => collapsedGroups.value[group];

const handleFilterSelect = (filter: TDiagnosticFilter): void => {
    activeFilter.value = filter;
};

const toggleGroupCollapse = (group: TDiagnosticGroup): void => {
    collapsedGroups.value[group] = !collapsedGroups.value[group];
};

const toggleCollapseAll = (): void => {
    const nextCollapsed = hasExpandedVisibleGroups.value;

    collapsedGroups.value = {
        error:
            diagnosticGroups.value.find((group) => group.id === 'error')?.visibleCount === 0
                ? collapsedGroups.value.error
                : nextCollapsed,
        warning:
            diagnosticGroups.value.find((group) => group.id === 'warning')?.visibleCount === 0
                ? collapsedGroups.value.warning
                : nextCollapsed,
        info:
            diagnosticGroups.value.find((group) => group.id === 'info')?.visibleCount === 0
                ? collapsedGroups.value.info
                : nextCollapsed,
    };
};

const emitRerunAnalysis = (): void => {
    emit('rerun-analysis');
};

const handleSelect = (item: IDiagnosticCard): void => {
    selectedItemKey.value = item.key;
    emit('select-diagnostic', item.line, item.column);
};

const openRulesOverview = (): void => {
    openExternalUrl(RULES_URL);
};

const openRuleDocumentation = (code: string): void => {
    openExternalUrl(`${RULES_URL}${encodeURIComponent(code)}`);
};

const copyRuleCode = async (code: string): Promise<void> => {
    try {
        await writeClipboardText(code);
    } catch {
        // 忽略剪贴板失败，避免把 UI 交互变成阻断错误。
    }
};

const itemToneClass = (group: TDiagnosticGroup): string => `diagnostics-panel__item--${group}`;

const toneClass = (group: TDiagnosticGroup): string => `diagnostics-panel__tone--${group}`;

const highlightToneClass = (group: TDiagnosticGroup): string =>
    `diagnostics-panel__highlight--${group}`;
</script>

<template>
    <section class="diagnostics-panel" :aria-label="panelAriaLabel">
        <header class="diagnostics-panel__head">
            <h2 class="diagnostics-panel__title">ShellCheck 代码检查</h2>

            <span v-if="showPassBadge" class="diagnostics-panel__pass-badge" title="当前文件通过检查">
                <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
                    stroke-linejoin="round" aria-hidden="true">
                    <path d="m5 12 4 4 10-10" />
                </svg>
                通过
            </span>

            <button
type="button" class="diagnostics-panel__icon-button" title="重新运行" aria-label="重新运行"
                @click="emitRerunAnalysis">
                <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                    stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-3-6.7" />
                    <path d="M21 4v5h-5" />
                </svg>
            </button>

            <button
v-if="hasAnyDiagnostics" type="button" class="diagnostics-panel__icon-button"
                :class="{ 'diagnostics-panel__icon-button--rotated': !hasExpandedVisibleGroups }"
                :title="collapseAllLabel" :aria-label="collapseAllLabel" @click="toggleCollapseAll">
                <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                    stroke-linejoin="round" aria-hidden="true">
                    <path d="m7 14 5-5 5 5" />
                </svg>
            </button>

            <button
type="button" class="diagnostics-panel__icon-button" title="查看规则文档" aria-label="查看规则文档"
                @click="openRulesOverview">
                <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                    stroke-linejoin="round" aria-hidden="true">
                    <circle cx="5" cy="12" r="1" />
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="19" cy="12" r="1" />
                </svg>
            </button>
        </header>

        <div
class="diagnostics-panel__filter-bar"
            :class="{ 'diagnostics-panel__filter-bar--muted': !analysis.available }">
            <button
v-for="filter in FILTER_OPTIONS" :key="filter.id" type="button" class="diagnostics-panel__filter"
                :class="[
                    filter.tone ? toneClass(filter.tone) : undefined,
                    { 'diagnostics-panel__filter--active': activeFilter === filter.id },
                ]" :aria-pressed="activeFilter === filter.id" @click="handleFilterSelect(filter.id)">
                <span v-if="filter.tone" class="diagnostics-panel__filter-dot" :class="toneClass(filter.tone)" />
                <span>{{ filter.label }}</span>
                <span class="diagnostics-panel__filter-num">{{ countForFilter(filter.id) }}</span>
            </button>
        </div>

        <div v-if="!analysis.available" class="diagnostics-panel__body diagnostics-panel__body--center">
            <div class="diagnostics-panel__notice diagnostics-panel__notice--warning">
                <div class="diagnostics-panel__notice-title-row">
                    <span class="diagnostics-panel__notice-icon">!</span>
                    <span class="diagnostics-panel__notice-title">ShellCheck 当前不可用</span>
                </div>

                <p class="diagnostics-panel__notice-desc">
                    {{ analysis.message || '暂时无法返回诊断结果，请稍后重试。' }}
                </p>

                <div class="diagnostics-panel__empty-actions diagnostics-panel__empty-actions--notice">
                    <button type="button" class="diagnostics-panel__ghost-button" @click="emitRerunAnalysis">
                        <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M21 12a9 9 0 1 1-3-6.7" />
                            <path d="M21 4v5h-5" />
                        </svg>
                        再次检查
                    </button>
                </div>
            </div>
        </div>

        <div v-else-if="!hasAnyDiagnostics" class="diagnostics-panel__body diagnostics-panel__body--center">
            <div class="diagnostics-panel__empty-state">
                <div class="diagnostics-panel__empty-ring">
                    <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
                        stroke-linejoin="round" aria-hidden="true">
                        <path d="m5 12 4 4 10-10" />
                    </svg>
                </div>

                <div class="diagnostics-panel__empty-title">未发现问题</div>

                <div class="diagnostics-panel__empty-desc">
                    ShellCheck 已检查当前文件，没有发现任何错误、警告或提示。
                </div>

                <div class="diagnostics-panel__empty-meta">
                    <span class="diagnostics-panel__pulse" />
                    <span>{{ lastCheckedLabel }}</span>
                </div>

                <div class="diagnostics-panel__empty-actions">
                    <button type="button" class="diagnostics-panel__ghost-button" @click="emitRerunAnalysis">
                        <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M21 12a9 9 0 1 1-3-6.7" />
                            <path d="M21 4v5h-5" />
                        </svg>
                        再次检查
                    </button>

                    <button type="button" class="diagnostics-panel__ghost-button" @click="openRulesOverview">
                        <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="3" />
                            <path
                                d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
                        </svg>
                        规则
                    </button>
                </div>
            </div>
        </div>

        <div v-else class="diagnostics-panel__list">
            <section
v-for="group in diagnosticGroups" :key="group.id" class="diagnostics-panel__group"
                :class="{ 'diagnostics-panel__group--collapsed': isGroupCollapsed(group.id) }">
                <button
type="button" class="diagnostics-panel__group-head" :aria-expanded="!isGroupCollapsed(group.id)"
                    @click="toggleGroupCollapse(group.id)">
                    <span class="diagnostics-panel__caret" aria-hidden="true">
                        <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                            stroke-linecap="round" stroke-linejoin="round">
                            <path d="m6 9 6 6 6-6" />
                        </svg>
                    </span>
                    <span>{{ group.label }}</span>
                    <span class="diagnostics-panel__group-count">{{ group.visibleCount }}</span>
                </button>

                <div class="diagnostics-panel__group-items">
                    <article
v-for="item in group.visibleItems" :key="item.key" class="diagnostics-panel__item" :class="[
                        itemToneClass(item.group),
                        { 'diagnostics-panel__item--active': selectedItemKey === item.key },
                    ]" role="button" tabindex="0" :aria-label="`${item.code}，第 ${item.line} 行，第 ${item.column} 列`"
                        @click="handleSelect(item)" @keydown.enter.prevent="handleSelect(item)"
                        @keydown.space.prevent="handleSelect(item)">
                        <div class="diagnostics-panel__item-meta diagnostics-panel__mono">
                            <span
class="diagnostics-panel__severity" :class="toneClass(item.group)"
                                :title="group.label" />
                            <span class="diagnostics-panel__code">{{ item.code }}</span>
                            <span class="diagnostics-panel__pos">第 {{ item.line }} 行 · 列 {{ item.column }}</span>
                        </div>

                        <div class="diagnostics-panel__message">{{ item.message }}</div>

                        <div class="diagnostics-panel__preview diagnostics-panel__mono">
                            <div v-if="item.isEmptyLine" class="diagnostics-panel__preview-empty">~</div>

                            <template v-else>
                                <div
v-for="previewLine in item.previewLines" :key="previewLine.key"
                                    class="diagnostics-panel__preview-line">
                                    <span
v-for="(fragment, index) in previewLine.fragments"
                                        :key="`${previewLine.key}-${index}`" :class="fragment.highlighted
                                            ? ['diagnostics-panel__highlight', highlightToneClass(item.group)]
                                            : undefined">{{ fragment.text }}</span>
                                </div>
                            </template>
                        </div>

                        <div class="diagnostics-panel__item-actions">
                            <button type="button" class="diagnostics-panel__action" @click.stop="emit('ai-fix-diagnostic', item)">
                                <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                                    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <path d="M12 3v18" />
                                    <path d="M3 12h18" />
                                </svg>
                                AI 修复
                            </button>

                            <button type="button" class="diagnostics-panel__action" @click.stop="handleSelect(item)">
                                <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                                    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <path d="M9 12 11 14 15 10" />
                                    <circle cx="12" cy="12" r="9" />
                                </svg>
                                定位
                            </button>

                            <button
type="button" class="diagnostics-panel__action"
                                @click.stop="void copyRuleCode(item.code)">
                                <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                                    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <rect x="9" y="9" width="11" height="11" rx="2" />
                                    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
                                </svg>
                                复制规则
                            </button>

                            <button
type="button" class="diagnostics-panel__action"
                                @click.stop="openRuleDocumentation(item.code)">
                                <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                                    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <path d="M14 3h7v7" />
                                    <path d="M10 14 21 3" />
                                    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                                </svg>
                                文档
                            </button>
                        </div>
                    </article>
                </div>
            </section>
        </div>
    </section>
</template>

<style scoped>
.diagnostics-panel {
    --diagnostics-border: color-mix(in srgb, var(--shell-divider) 78%, transparent);
    --diagnostics-divider: color-mix(in srgb, var(--shell-divider) 58%, transparent);
    --diagnostics-hover: color-mix(in srgb, var(--surface-soft) 100%, transparent);
    --diagnostics-active: color-mix(in srgb, var(--surface-soft-strong) 100%, transparent);
    --diagnostics-code-bg: color-mix(in srgb, var(--app-bg) 86%, black);
    --diagnostics-info: var(--accent-strong);
    display: flex;
    min-height: 0;
    height: 100%;
    flex-direction: column;
    background: var(--panel-bg);
}

.diagnostics-panel__head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 10px 0 12px;
    border-bottom: 1px solid var(--diagnostics-border);
    flex: none;
}

.diagnostics-panel__title {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text-primary);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: -0.005em;
}

.diagnostics-panel__pass-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 18px;
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--success) 28%, transparent);
    background: color-mix(in srgb, var(--success) 10%, transparent);
    color: color-mix(in srgb, var(--success) 88%, white);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
}

.diagnostics-panel__pass-badge svg {
    width: 10px;
    height: 10px;
}

.diagnostics-panel__icon-button {
    display: inline-flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    color: var(--text-tertiary);
    background: transparent;
    cursor: pointer;
    transition:
        background-color 120ms ease,
        color 120ms ease;
}

.diagnostics-panel__icon-button:hover {
    background: var(--diagnostics-hover);
    color: var(--text-primary);
}

.diagnostics-panel__icon-button svg {
    width: 13px;
    height: 13px;
    transition: transform 120ms ease;
}

.diagnostics-panel__icon-button--rotated svg {
    transform: rotate(180deg);
}

.diagnostics-panel__filter-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--diagnostics-border);
    flex: none;
}

.diagnostics-panel__filter-bar--muted {
    opacity: 0.72;
}

.diagnostics-panel__filter {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px;
    border-radius: 4px;
    color: var(--text-tertiary);
    font-size: 11.5px;
    user-select: none;
    cursor: pointer;
    transition:
        background-color 120ms ease,
        color 120ms ease;
}

.diagnostics-panel__filter:hover {
    background: var(--diagnostics-hover);
    color: var(--text-primary);
}

.diagnostics-panel__filter--active {
    background: var(--diagnostics-active);
    color: var(--text-primary);
}

.diagnostics-panel__filter-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: currentColor;
    opacity: 0.35;
}

.diagnostics-panel__filter-num {
    color: var(--text-quaternary);
    font-variant-numeric: tabular-nums;
}

.diagnostics-panel__filter--active .diagnostics-panel__filter-num {
    color: currentColor;
}

.diagnostics-panel__tone--error {
    color: var(--danger);
}

.diagnostics-panel__tone--warning {
    color: var(--warning);
}

.diagnostics-panel__tone--info {
    color: var(--diagnostics-info);
}

.diagnostics-panel__body {
    flex: 1;
    min-height: 0;
}

.diagnostics-panel__body--center {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 24px 40px;
}

.diagnostics-panel__notice {
    width: 100%;
    max-width: 272px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--warning) 26%, transparent);
    background: color-mix(in srgb, var(--warning) 8%, var(--panel-bg));
    padding: 16px;
}

.diagnostics-panel__notice-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
}

.diagnostics-panel__notice-icon {
    display: inline-flex;
    width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--warning) 28%, transparent);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    color: color-mix(in srgb, var(--warning) 88%, white);
    font-size: 11px;
    font-weight: 700;
}

.diagnostics-panel__notice-title {
    color: color-mix(in srgb, var(--warning) 88%, white);
    font-size: 13px;
    font-weight: 600;
}

.diagnostics-panel__notice-desc {
    margin: 12px 0 0;
    color: var(--text-secondary);
    font-size: 12.5px;
    line-height: 1.7;
}

.diagnostics-panel__list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 20px;
}

.diagnostics-panel__list::-webkit-scrollbar {
    width: 8px;
}

.diagnostics-panel__list::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: color-mix(in srgb, var(--shell-divider) 72%, transparent);
}

.diagnostics-panel__list::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--shell-divider) 100%, transparent);
}

.diagnostics-panel__group {
    border-bottom: 1px solid var(--diagnostics-divider);
}

.diagnostics-panel__group-head {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px 0 12px;
    color: var(--text-quaternary);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: transparent;
    cursor: pointer;
    user-select: none;
}

.diagnostics-panel__group-head:hover {
    color: var(--text-tertiary);
}

.diagnostics-panel__caret {
    display: inline-flex;
    width: 10px;
    height: 10px;
    align-items: center;
    justify-content: center;
    flex: none;
    transition: transform 120ms ease;
}

.diagnostics-panel__caret svg {
    width: 10px;
    height: 10px;
}

.diagnostics-panel__group--collapsed .diagnostics-panel__caret {
    transform: rotate(-90deg);
}

.diagnostics-panel__group-count,
.diagnostics-panel__mono,
.diagnostics-panel__pos,
.diagnostics-panel__code,
.diagnostics-panel__empty-meta {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
}

.diagnostics-panel__group-count {
    margin-left: auto;
}

.diagnostics-panel__group--collapsed .diagnostics-panel__group-items {
    display: none;
}

.diagnostics-panel__item {
    position: relative;
    padding: 8px 10px 10px 14px;
    border-top: 1px solid var(--diagnostics-divider);
    background: transparent;
    cursor: pointer;
    transition: background-color 100ms ease;
}

.diagnostics-panel__item:hover {
    background: var(--diagnostics-hover);
}

.diagnostics-panel__item--active {
    background: var(--diagnostics-active);
}

.diagnostics-panel__item::before {
    content: '';
    position: absolute;
    top: 8px;
    bottom: 10px;
    left: 0;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background: transparent;
}

.diagnostics-panel__item--error::before {
    background: color-mix(in srgb, var(--danger) 72%, black);
}

.diagnostics-panel__item--warning::before {
    background: color-mix(in srgb, var(--warning) 72%, black);
}

.diagnostics-panel__item--info::before {
    background: color-mix(in srgb, var(--diagnostics-info) 74%, black);
}

.diagnostics-panel__item-meta {
    display: flex;
    min-height: 16px;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
    color: var(--text-tertiary);
    font-size: 11.5px;
}

.diagnostics-panel__severity {
    position: relative;
    display: inline-flex;
    width: 12px;
    height: 12px;
    flex: none;
}

.diagnostics-panel__severity::before,
.diagnostics-panel__severity::after {
    content: '';
    position: absolute;
    border-radius: 999px;
    background: currentColor;
}

.diagnostics-panel__severity::before {
    inset: 0;
    opacity: 0.16;
}

.diagnostics-panel__severity::after {
    inset: 3px;
}

.diagnostics-panel__code {
    color: var(--text-primary);
    letter-spacing: 0.01em;
}

.diagnostics-panel__pos {
    margin-left: auto;
    color: var(--text-quaternary);
    font-size: 11px;
}

.diagnostics-panel__message {
    margin-bottom: 6px;
    color: var(--text-primary);
    font-size: 12.5px;
    line-height: 1.5;
    word-break: break-word;
}

.diagnostics-panel__preview {
    overflow-x: auto;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
    background: var(--diagnostics-code-bg);
    padding: 3px 8px;
    color: color-mix(in srgb, var(--text-secondary) 88%, white);
    font-size: 11px;
    line-height: 1.45;
}

.diagnostics-panel__preview-line {
    min-width: max-content;
    white-space: pre;
}

.diagnostics-panel__preview-empty {
    color: color-mix(in srgb, var(--danger) 78%, white);
}

.diagnostics-panel__highlight {
    border-bottom: 1px dotted currentColor;
}

.diagnostics-panel__highlight--error {
    color: color-mix(in srgb, var(--danger) 84%, white);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
}

.diagnostics-panel__highlight--warning {
    color: color-mix(in srgb, var(--warning) 88%, white);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
}

.diagnostics-panel__highlight--info {
    color: color-mix(in srgb, var(--diagnostics-info) 88%, white);
    background: color-mix(in srgb, var(--diagnostics-info) 12%, transparent);
}

.diagnostics-panel__item-actions {
    display: flex;
    gap: 2px;
    margin-top: 6px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
}

.diagnostics-panel__item:hover .diagnostics-panel__item-actions,
.diagnostics-panel__item--active .diagnostics-panel__item-actions {
    opacity: 1;
    pointer-events: auto;
}

.diagnostics-panel__action,
.diagnostics-panel__ghost-button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 7px;
    border-radius: 4px;
    color: var(--text-tertiary);
    background: transparent;
    cursor: pointer;
    transition:
        background-color 120ms ease,
        border-color 120ms ease,
        color 120ms ease;
}

.diagnostics-panel__action {
    font-size: 11px;
}

.diagnostics-panel__action:hover,
.diagnostics-panel__ghost-button:hover {
    background: var(--diagnostics-active);
    color: var(--text-primary);
}

.diagnostics-panel__action svg,
.diagnostics-panel__ghost-button svg {
    width: 11px;
    height: 11px;
}

.diagnostics-panel__empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 32px 24px 48px;
    text-align: center;
}

.diagnostics-panel__empty-ring {
    position: relative;
    display: flex;
    width: 52px;
    height: 52px;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--success) 24%, transparent);
    background: color-mix(in srgb, var(--success) 10%, transparent);
    color: var(--success);
}

.diagnostics-panel__empty-ring::after {
    content: '';
    position: absolute;
    inset: -6px;
    border: 1px solid color-mix(in srgb, var(--success) 24%, transparent);
    border-radius: 999px;
    opacity: 0.5;
}

.diagnostics-panel__empty-ring svg {
    width: 22px;
    height: 22px;
}

.diagnostics-panel__empty-title {
    color: var(--text-primary);
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.005em;
}

.diagnostics-panel__empty-desc {
    max-width: 240px;
    color: var(--text-tertiary);
    font-size: 12px;
    line-height: 1.55;
}

.diagnostics-panel__empty-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    color: var(--text-quaternary);
    font-size: 10.5px;
}

.diagnostics-panel__pulse {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--success);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent);
}

.diagnostics-panel__empty-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
}

.diagnostics-panel__empty-actions--notice {
    margin-top: 14px;
}

.diagnostics-panel__ghost-button {
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--diagnostics-border);
    font-size: 11.5px;
}

.diagnostics-panel__icon-button:focus-visible,
.diagnostics-panel__filter:focus-visible,
.diagnostics-panel__group-head:focus-visible,
.diagnostics-panel__item:focus-visible,
.diagnostics-panel__action:focus-visible,
.diagnostics-panel__ghost-button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent-strong) 40%, transparent);
    outline-offset: -2px;
}
</style>
