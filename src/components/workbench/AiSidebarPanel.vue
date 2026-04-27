<script setup lang="ts">
import AiAssistantPanel from '@/components/business/ai/AiAssistantPanel.vue';
import type { IActiveRunSummary, IAnalyzeScriptPayload, IEditorDocument } from '@/types/editor';

defineProps<{
  document: IEditorDocument;
  activeRun: IActiveRunSummary | null;
  analysis: IAnalyzeScriptPayload;
}>();
</script>

<template>
  <AiAssistantPanel :document="document" :active-run="activeRun" :analysis="analysis" />
</template>
