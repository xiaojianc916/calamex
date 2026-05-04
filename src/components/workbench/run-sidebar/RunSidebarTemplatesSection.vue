<script setup lang="ts">
interface ICommandTemplateView {
    id: string;
    title: string;
    description: string;
}

defineProps<{
    collapsed: boolean;
    templates: ICommandTemplateView[];
    hasQuery: boolean;
}>();

const emit = defineEmits<{
    toggle: [];
    select: [template: ICommandTemplateView];
}>();

const handleSelect = (template: ICommandTemplateView): void => {
    emit('select', template);
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
            <span>脚本模板</span>
        </button>

        <div v-show="!collapsed" class="run-sidebar-section-body">
            <div v-if="templates.length === 0" class="run-sidebar-empty-state">
                {{ hasQuery ? '无匹配模板' : '暂无可用模板' }}
            </div>

            <div
v-for="template in templates" :key="template.id" class="run-sidebar-row"
                @click="handleSelect(template)">
                <span class="run-sidebar-row-icon">
                    <svg
viewBox="0 0 16 16" class="run-sidebar-icon" fill="none" stroke="currentColor"
                        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M9 2L4.5 8H8l-1 6 4.5-6H8l1-6z" />
                    </svg>
                </span>

                <div class="run-sidebar-row-main">
                    <div class="run-sidebar-row-name">{{ template.title }}</div>
                    <div class="run-sidebar-template-desc">{{ template.description }}</div>
                </div>

                <span class="run-sidebar-template-add" aria-hidden="true">
                    <svg
viewBox="0 0 16 16" class="run-sidebar-icon run-sidebar-icon-sm" fill="none"
                        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M8 4v8" />
                        <path d="M4 8h8" />
                    </svg>
                </span>
            </div>
        </div>
    </section>
</template>
