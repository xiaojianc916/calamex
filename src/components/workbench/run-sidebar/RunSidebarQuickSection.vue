<script setup lang="ts">
interface IQuickRow {
    id: string;
    name: string;
    command: string;
    icon: 'terminal' | 'monitor' | 'spark' | 'history' | 'trash' | 'plus';
    action: 'run' | 'stop' | 'open-terminal' | 'clear-history';
    badge: string;
    disabled: boolean;
    running: boolean;
}

defineProps<{
    collapsed: boolean;
    rows: IQuickRow[];
}>();

const emit = defineEmits<{
    toggle: [];
    action: [row: IQuickRow];
}>();

const handleAction = (row: IQuickRow): void => {
    emit('action', row);
};
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
            <span>快速命令</span>
        </button>

        <div v-show="!collapsed" class="run-sidebar-section-body">
            <div v-if="rows.length === 0" class="run-sidebar-empty-state">
                未找到匹配项
            </div>

            <div
v-for="row in rows" :key="row.id" class="run-sidebar-row run-sidebar-quick-row" :class="{
                'is-running': row.running,
                'is-disabled': row.disabled,
            }" @click="void handleAction(row)">
                <span class="run-sidebar-row-icon">
                    <svg
v-if="row.running" viewBox="0 0 16 16" class="run-sidebar-status-icon is-running" fill="none"
                        aria-hidden="true">
                        <circle cx="8" cy="8" r="6" stroke="var(--accent-strong)" stroke-width="1.6" />
                        <circle cx="8" cy="8" r="2.4" fill="var(--accent-strong)" stroke="none" />
                    </svg>

                    <svg
v-else-if="row.icon === 'history'" viewBox="0 0 16 16" class="run-sidebar-icon" fill="none"
                        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                        aria-hidden="true">
                        <path d="M8 3.25a4.75 4.75 0 1 1-3.95 2.1" />
                        <path d="M3.5 3.25v3h3" />
                        <path d="M8 5.25v3l2 1.25" />
                    </svg>

                    <svg
v-else-if="row.icon === 'trash'" viewBox="0 0 16 16" class="run-sidebar-icon" fill="none"
                        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                        aria-hidden="true">
                        <path d="M2.5 4.5h11" />
                        <path d="M6 4.5v-1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" />
                        <path d="M4.25 4.5l.7 8a1 1 0 0 0 1 .91h4.1a1 1 0 0 0 1-.91l.7-8" />
                    </svg>

                    <svg
v-else-if="row.icon === 'monitor'" viewBox="0 0 16 16" class="run-sidebar-icon" fill="none"
                        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                        aria-hidden="true">
                        <rect x="2.5" y="3.5" width="11" height="8" rx="1.5" />
                        <path d="M6 13h4" />
                    </svg>

                    <svg
v-else-if="row.icon === 'spark'" viewBox="0 0 16 16" class="run-sidebar-icon" fill="none"
                        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                        aria-hidden="true">
                        <path d="M9 2L4.5 8H8l-1 6 4.5-6H8l1-6z" />
                    </svg>

                    <svg
v-else viewBox="0 0 16 16" class="run-sidebar-icon" fill="none" stroke="currentColor"
                        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3 5l2.5 2.5L3 10" />
                        <path d="M7.5 11h5.5" />
                    </svg>
                </span>

                <span class="run-sidebar-quick-name">{{ row.name }}</span>
                <span class="run-sidebar-quick-command mono-text">{{ row.command }}</span>

                <button
v-if="row.running" type="button" class="run-sidebar-row-action is-stop" aria-label="停止"
                    @click.stop="void handleAction(row)">
                    <svg
viewBox="0 0 16 16" class="run-sidebar-icon run-sidebar-icon-sm" fill="currentColor"
                        aria-hidden="true">
                        <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" />
                    </svg>
                </button>

                <span v-else class="run-sidebar-kbd mono-text">{{ row.badge }}</span>
            </div>
        </div>
    </section>
</template>
