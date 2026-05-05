<script setup lang="ts">
import AiAssistantPanel from '@/components/business/ai/AiAssistantPanel.vue';
import { Button } from '@/components/ui/button';
import Card from '@/components/ui/card/Card.vue';
import type {
    IActiveRunSummary,
    IAnalyzeScriptPayload,
    IEditorDocument,
    IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitRepositoryStatusPayload } from '@/types/git';
import { Bot, FileText } from 'lucide-vue-next';

const props = defineProps<{
    document: IEditorDocument;
    activeRun: IActiveRunSummary | null;
    analysis: IAnalyzeScriptPayload;
    selection: IEditorSelectionSummary | null;
    gitStatus: IGitRepositoryStatusPayload;
    workspaceRootPath: string | null;
}>();

const emit = defineEmits<{
    'back-to-editor': [];
    'open-patch-diff': [payload: IGitDiffPreviewPayload];
}>();
</script>

<template>
    <section class="ai-workspace-surface h-full min-h-0 overflow-hidden">
        <div class="ai-workspace-surface__scroll h-full min-h-0 overflow-auto">
            <div class="h-full min-h-full px-4 py-4 lg:px-5 lg:py-5">
                <Card
                    class="ai-workspace-surface__block flex h-full min-h-[calc(100vh-168px)] flex-col gap-0 overflow-hidden rounded-[28px] border-(--shell-divider) bg-[color-mix(in_srgb,var(--panel-bg)_94%,var(--editor-bg))] p-0 shadow-[0_28px_80px_rgba(0,0,0,0.12)]">
                    <div
                        class="flex flex-wrap items-center justify-between gap-3 border-b border-(--shell-divider) px-5 py-4 lg:px-6">
                        <div class="min-w-0 space-y-1">
                            <div
                                class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-(--text-quaternary)">
                                <span
                                    class="inline-flex h-6 w-6 items-center justify-center rounded-full border border-(--shell-divider) bg-[color-mix(in_srgb,var(--accent-strong)_10%,transparent)] text-(--text-primary)">
                                    <Bot class="h-3.5 w-3.5" />
                                </span>
                                <span>AI Workspace</span>
                            </div>
                            <h1 class="truncate text-[20px] font-semibold tracking-[-0.02em] text-(--text-primary)">
                                AI 主界面
                            </h1>
                        </div>

                        <Button variant="outline" size="sm" class="gap-2" @click="emit('back-to-editor')">
                            <FileText class="h-3.5 w-3.5" />
                            <span>返回编辑器</span>
                        </Button>
                    </div>

                    <div class="min-h-0 flex-1">
                        <AiAssistantPanel :document="document" :active-run="activeRun" :analysis="analysis"
                            :selection="selection" :git-status="gitStatus" :workspace-root-path="workspaceRootPath"
                            @open-patch-diff="emit('open-patch-diff', $event)" />
                    </div>
                </Card>
            </div>
        </div>
    </section>
</template>

<style scoped>
.ai-workspace-surface {
    background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--accent-strong) 9%, transparent), transparent 34%),
        linear-gradient(180deg, color-mix(in srgb, var(--editor-bg) 92%, white 2%), var(--editor-bg));
}

.ai-workspace-surface__scroll {
    scrollbar-width: thin;
}

.ai-workspace-surface__block {
    max-width: none;
}

.ai-workspace-surface__assistant-card :deep(.ai-assistant-panel) {
    background: transparent;
}

.ai-workspace-surface__block :deep(.ai-assistant-panel) {
    height: 100%;
    background: transparent;
}

.ai-workspace-surface__block :deep(.ai-panel-header) {
    min-height: 52px;
    padding: 12px 18px 10px;
}

.ai-workspace-surface__block :deep(.ai-composer-shell) {
    background: color-mix(in srgb, var(--panel-bg) 90%, transparent);
}
</style>