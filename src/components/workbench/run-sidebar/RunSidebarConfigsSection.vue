<script setup lang="ts">
interface IConfigRow {
    id: string;
    name: string;
    command: string;
    icon: 'terminal' | 'monitor' | 'spark' | 'history' | 'trash' | 'plus';
    action: 'run' | 'open-terminal';
    disabled: boolean;
    running: boolean;
}

defineProps<{
    collapsed: boolean;
    rows: IConfigRow[];
    hasQuery: boolean;
    activeElapsedLabel: string;
}>();

const emit = defineEmits<{
    toggle: [];
    action: [row: IConfigRow];
}>();

const handleAction = (row: IConfigRow): void => {
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
            <span>运行配置</span>
            <span class="run-sidebar-count">{{ rows.length }}</span>
        </button>

        <div v-show="!collapsed" class="run-sidebar-section-body">
            <div v-if="rows.length === 0" class="run-sidebar-empty-state">
                {{ hasQuery ? '无匹配结果' : '暂无运行配置' }}
            </div>

            <div
v-for="row in rows" :key="row.id" class="run-sidebar-row" :class="{
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
v-else-if="row.icon === 'monitor'" viewBox="0 0 16 16" class="run-sidebar-icon" fill="none"
                        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                        aria-hidden="true">
                        <rect x="2.5" y="3.5" width="11" height="8" rx="1.5" />
                        <path d="M6 13h4" />
                    </svg>

                    <svg
v-else viewBox="0 0 16 16" class="run-sidebar-icon" fill="none" stroke="currentColor"
                        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3 5l2.5 2.5L3 10" />
                        <path d="M7.5 11h5.5" />
                    </svg>
                </span>

                <div class="run-sidebar-row-main">
                    <div class="run-sidebar-row-name">{{ row.name }}</div>
                    <div class="run-sidebar-row-sub mono-text">{{ row.command }}</div>
                </div>

                <span v-if="row.running && activeElapsedLabel" class="run-sidebar-elapsed mono-text">
                    {{ activeElapsedLabel }}
                </span>

                <button
type="button" class="run-sidebar-row-action" :class="row.running ? 'is-stop' : 'is-play'"
                    :disabled="row.disabled"
                    :aria-label="row.running ? '停止' : row.action === 'open-terminal' ? '打开终端' : '运行'"
                    @click.stop="void handleAction(row)">
                    <svg
v-if="row.running" viewBox="0 0 16 16" class="run-sidebar-icon run-sidebar-icon-sm"
                        fill="currentColor" aria-hidden="true">
                        <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" />
                    </svg>

                    <svg
v-else-if="row.action === 'open-terminal'" viewBox="0 0 16 16"
                        class="run-sidebar-icon run-sidebar-icon-sm" fill="none" stroke="currentColor"
                        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3 5l2.5 2.5L3 10" />
                        <path d="M7.5 11h5.5" />
                    </svg>

                    <svg
v-else viewBox="0 0 16 16" class="run-sidebar-icon run-sidebar-icon-sm" fill="currentColor"
                        aria-hidden="true">
                        <path d="M5.5 3.5l7 4.5-7 4.5z" />
                    </svg>
                </button>
            </div>
        </div>
    </section>
</template>
