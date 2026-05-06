<script setup lang="ts">
import AiAssistantPanel from '@/components/business/ai/AiAssistantPanel.vue';
import { Card, CardContent } from '@/components/ui/card';
import type {
    IActiveRunSummary,
    IAnalyzeScriptPayload,
    IEditorDocument,
    IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitRepositoryStatusPayload } from '@/types/git';

defineProps<{
    document: IEditorDocument;
    activeRun: IActiveRunSummary | null;
    analysis: IAnalyzeScriptPayload;
    selection: IEditorSelectionSummary | null;
    gitStatus: IGitRepositoryStatusPayload;
    workspaceRootPath: string | null;
}>();

const emit = defineEmits<{
    'open-patch-diff': [payload: IGitDiffPreviewPayload];
}>();
</script>

<template>
    <Card
        class="ai-assistant-card flex h-full min-h-0 w-full flex-1 gap-0 overflow-hidden rounded-[14px] bg-white py-0 shadow-none border border-slate-900/10"
    >
        <CardContent class="flex min-h-0 flex-1 px-0 pb-0 pt-0">
            <AiAssistantPanel
                class="flex-1"
                :document="document"
                :active-run="activeRun"
                :analysis="analysis"
                :selection="selection"
                :git-status="gitStatus"
                :workspace-root-path="workspaceRootPath"
                @open-patch-diff="emit('open-patch-diff', $event)"
            />
        </CardContent>
    </Card>
</template>

<style scoped>
.ai-assistant-card {
    /* 用 !important 确保盖过 shadcn Card 自带的 shadow */
    box-shadow:
        0 1px 2px rgba(15, 23, 42, 0.04),
        0 2px 6px rgba(15, 23, 42, 0.05) !important;
}

:deep(.ai-assistant-panel) {
    height: 100%;
    background: #ffffff;
}

:deep(.ai-panel-header) {
    min-height: 52px;
    padding: 12px 18px 10px;
}

:deep(.ai-composer-shell) {
    background: #ffffff;
}
</style>