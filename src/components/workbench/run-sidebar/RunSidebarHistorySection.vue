<script setup lang="ts">
interface IRunHistoryViewRow {
    id: string;
    status: 'success' | 'failed' | 'canceled';
    documentName: string;
    commandLine: string;
    durationLabel: string;
    exitLabel: string;
    finishedAtLabel: string;
}

defineProps<{
    collapsed: boolean;
    entries: IRunHistoryViewRow[];
    hasQuery: boolean;
}>();

const emit = defineEmits<{
    toggle: [];
    open: [];
}>();
</script>

<template>
    <section class="run-sidebar-section" :class="{ 'is-collapsed': collapsed }">
        <button type="button" class="run-sidebar-section-head" @click="emit('toggle')">
            <svg
viewBox="0 0 16 16" class="run-sidebar-icon run-sidebar-icon-sm run-sidebar-chevron" fill="none"
                stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                aria-hidden="true">
                <path d="M6 4l4 4-4 4" />
            </svg>
            <span>历史记录</span>
            <span class="run-sidebar-count">{{ entries.length }}</span>
        </button>

        <div v-show="!collapsed" class="run-sidebar-section-body">
            <div v-if="entries.length === 0" class="run-sidebar-empty-state">
                {{ hasQuery ? '无匹配记录' : '暂无运行记录' }}
            </div>

            <div v-for="entry in entries" :key="entry.id" class="run-sidebar-history-row" @click="emit('open')">
                <span class="run-sidebar-history-status" :class="`is-${entry.status}`">
                    <svg
v-if="entry.status === 'success'" viewBox="0 0 16 16" class="run-sidebar-status-icon"
                        fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" fill="var(--success)" stroke="none" />
                        <path
d="M5.2 8.1l1.8 1.9L10.8 6" stroke="var(--panel-bg)" stroke-width="1.6"
                            stroke-linecap="round" stroke-linejoin="round" />
                    </svg>

                    <svg
v-else-if="entry.status === 'canceled'" viewBox="0 0 16 16" class="run-sidebar-status-icon"
                        fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="5.5" stroke="var(--text-quaternary)" stroke-width="1.4" />
                        <path
d="M5.5 5.5l5 5" stroke="var(--text-quaternary)" stroke-width="1.4"
                            stroke-linecap="round" />
                    </svg>

                    <svg v-else viewBox="0 0 16 16" class="run-sidebar-status-icon" fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" fill="var(--danger)" stroke="none" />
                        <path
d="M6 6l4 4M10 6l-4 4" stroke="var(--panel-bg)" stroke-width="1.6"
                            stroke-linecap="round" />
                    </svg>
                </span>

                <div class="run-sidebar-history-name">{{ entry.documentName }}</div>
                <div class="run-sidebar-history-command mono-text">{{ entry.commandLine }}</div>
                <div class="run-sidebar-history-meta mono-text">
                    {{ entry.durationLabel }}
                    <span v-if="entry.exitLabel" class="run-sidebar-history-exit">
                        {{ entry.exitLabel }}
                    </span>
                </div>
                <div class="run-sidebar-history-time">{{ entry.finishedAtLabel }}</div>
            </div>
        </div>
    </section>
</template>
