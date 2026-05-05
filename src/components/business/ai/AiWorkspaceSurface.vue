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
        class="h-full min-h-[calc(100vh-196px)] gap-0 overflow-hidden rounded-[22px] border-(--shell-divider) py-0 shadow-sm">
        <CardContent class="flex min-h-0 flex-1 px-0 pb-0 pt-0">
            <AiAssistantPanel class="flex-1" :document="document" :active-run="activeRun" :analysis="analysis"
                :selection="selection" :git-status="gitStatus" :workspace-root-path="workspaceRootPath"
                @open-patch-diff="emit('open-patch-diff', $event)" />
        </CardContent>
    </Card>
</template>

<style scoped>
:deep(.ai-assistant-panel) {
    height: 100%;
    background: transparent;
}

:deep(.ai-panel-header) {
    min-height: 52px;
    padding: 12px 18px 10px;
}

:deep(.ai-composer-shell) {
    background: color-mix(in srgb, var(--panel-bg) 90%, transparent);
}
</style>