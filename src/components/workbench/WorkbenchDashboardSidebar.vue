<script setup lang="ts">
import { Button } from '@/components/ui/button';
import type { TWorkbenchSidebarView } from '@/types/app';
import type { IEditorDocument } from '@/types/editor';
import {
    BarChart3,
    Circle,
    Database,
    FilePenLine,
    FileText,
    FolderKanban,
    LayoutDashboard,
    LifeBuoy,
    Mail,
    MoreHorizontal,
    Search,
    Settings,
    Sparkles,
    Users,
    Workflow
} from 'lucide-vue-next';
import { computed } from 'vue';

interface IPrimaryNavItem {
    label: string;
    view: TWorkbenchSidebarView;
    icon: unknown;
}

interface IStaticDocumentItem {
    label: string;
    icon: unknown;
    view: TWorkbenchSidebarView | 'ai';
}

const props = defineProps<{
    activeView: TWorkbenchSidebarView;
    documents: IEditorDocument[];
    activeDocumentId: string | null;
    isAiMode: boolean;
}>();

const emit = defineEmits<{
    'select-view': [view: TWorkbenchSidebarView];
    'select-document': [documentId: string];
    'create-document': [];
    'toggle-settings': [];
}>();

const primaryItems: readonly IPrimaryNavItem[] = [
    { label: 'Dashboard', view: 'explorer', icon: LayoutDashboard },
    { label: 'Lifecycle', view: 'search', icon: Workflow },
    { label: 'Analytics', view: 'source-control', icon: BarChart3 },
    { label: 'Projects', view: 'run', icon: FolderKanban },
    { label: 'Team', view: 'extensions', icon: Users },
] as const;

const staticDocumentItems: readonly IStaticDocumentItem[] = [
    { label: 'Data Library', icon: Database, view: 'explorer' },
    { label: 'Reports', icon: FileText, view: 'source-control' },
    { label: 'Word Assistant', icon: FilePenLine, view: 'ai' },
] as const;

const recentDocuments = computed(() =>
    props.documents
        .filter((document) => document.kind !== 'ai-diff')
        .slice(0, 3),
);

const selectDocumentItem = (view: TWorkbenchSidebarView | 'ai'): void => {
    if (view === 'ai') {
        emit('select-view', 'ai');
        return;
    }

    emit('select-view', view);
};
</script>

<template>
    <aside class="workbench-dashboard-sidebar flex h-full min-h-0 flex-col overflow-hidden bg-(--sidebar-bg)">
        <div class="px-4 pt-5">
            <div class="flex items-center gap-2 px-1 text-(--text-primary)">
                <Circle class="h-4 w-4 fill-current stroke-none" />
                <span class="text-[15px] font-semibold">Acme Inc.</span>
            </div>

            <div class="mt-5 flex items-center gap-2">
                <Button size="sm"
                    class="h-10 flex-1 justify-start rounded-xl border-0 bg-(--success) px-3 text-white shadow-none hover:brightness-105"
                    @click="emit('create-document')">
                    <Sparkles class="h-4 w-4" />
                    <span>Quick Create</span>
                </Button>

                <button type="button" class="workbench-dashboard-sidebar__icon-button" aria-label="Inbox">
                    <Mail class="h-4 w-4" />
                </button>
            </div>
        </div>

        <div class="mt-5 min-h-0 flex-1 overflow-auto px-3 pb-4">
            <nav class="space-y-1">
                <button v-for="item in primaryItems" :key="item.label" type="button"
                    class="workbench-dashboard-sidebar__nav-item"
                    :class="{ 'is-active': !isAiMode && activeView === item.view }"
                    @click="emit('select-view', item.view)">
                    <component :is="item.icon" class="h-4 w-4" />
                    <span>{{ item.label }}</span>
                </button>
            </nav>

            <section class="mt-8">
                <p class="px-3 text-[12px] leading-5 text-(--text-secondary)">Documents</p>

                <div class="mt-2 space-y-1">
                    <button v-for="item in staticDocumentItems" :key="item.label" type="button"
                        class="workbench-dashboard-sidebar__nav-item"
                        :class="{ 'is-active': item.view === 'ai' ? isAiMode : activeView === item.view && !isAiMode }"
                        @click="selectDocumentItem(item.view)">
                        <component :is="item.icon" class="h-4 w-4" />
                        <span>{{ item.label }}</span>
                    </button>
                </div>
            </section>

            <section v-if="recentDocuments.length > 0" class="mt-8">
                <p class="px-3 text-[12px] leading-5 text-(--text-secondary)">Open Files</p>

                <div class="mt-2 space-y-1">
                    <button v-for="document in recentDocuments" :key="document.id" type="button"
                        class="workbench-dashboard-sidebar__nav-item"
                        :class="{ 'is-active': !isAiMode && activeDocumentId === document.id }"
                        @click="emit('select-document', document.id)">
                        <FileText class="h-4 w-4" />
                        <span class="truncate">{{ document.name }}</span>
                    </button>
                </div>
            </section>

            <nav class="mt-8 space-y-1">
                <button type="button" class="workbench-dashboard-sidebar__nav-item" @click="emit('toggle-settings')">
                    <Settings class="h-4 w-4" />
                    <span>Settings</span>
                </button>
                <button type="button" class="workbench-dashboard-sidebar__nav-item">
                    <LifeBuoy class="h-4 w-4" />
                    <span>Get Help</span>
                </button>
                <button type="button" class="workbench-dashboard-sidebar__nav-item"
                    @click="emit('select-view', 'search')">
                    <Search class="h-4 w-4" />
                    <span>Search</span>
                </button>
            </nav>
        </div>

        <footer class="flex items-center gap-3 border-t border-(--shell-divider) px-4 py-4">
            <div
                class="grid h-9 w-9 place-items-center rounded-full bg-[color-mix(in_srgb,var(--shell-divider)_14%,transparent)] text-[12px] font-semibold text-(--text-primary)">
                sh
            </div>
            <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] font-medium text-(--text-primary)">shadcn</p>
                <p class="truncate text-[12px] text-(--text-secondary)">m@example.com</p>
            </div>
            <button type="button" class="workbench-dashboard-sidebar__icon-button" aria-label="More actions">
                <MoreHorizontal class="h-4 w-4" />
            </button>
        </footer>
    </aside>
</template>

<style scoped>
.workbench-dashboard-sidebar__nav-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    border-radius: 12px;
    padding: 9px 12px;
    color: var(--text-primary);
    text-align: left;
    font-size: 14px;
}

.workbench-dashboard-sidebar__nav-item:hover {
    background: color-mix(in srgb, var(--shell-divider) 10%, transparent);
}

.workbench-dashboard-sidebar__nav-item.is-active {
    background: color-mix(in srgb, var(--shell-divider) 14%, transparent);
}

.workbench-dashboard-sidebar__icon-button {
    display: inline-flex;
    height: 36px;
    width: 36px;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--shell-divider) 86%, transparent);
    background: color-mix(in srgb, var(--panel-bg) 94%, transparent);
    color: var(--text-secondary);
}
</style>