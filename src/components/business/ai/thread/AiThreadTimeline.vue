<script setup lang="ts">
import { computed } from 'vue';
import type { IAiChatMessage, IAiPatchSet } from '@/types/ai';
import AiThreadAssistantText from './AiThreadAssistantText.vue';
import AiThreadChangedFilesSummary from './AiThreadChangedFilesSummary.vue';
import AiThreadContextCompaction from './AiThreadContextCompaction.vue';
import AiThreadPlanControl from './AiThreadPlanControl.vue';
import AiThreadReasoning from './AiThreadReasoning.vue';
import AiThreadToolCall from './AiThreadToolCall.vue';
import AiThreadUserMessage from './AiThreadUserMessage.vue';
import { buildThreadEntries, type TAiThreadEntry } from './projection';
import type { IAiThreadPlanDetails } from './types';
import { useThreadEntryExpansion } from './useThreadEntryExpansion';

const props = defineProps<{
  messages: readonly IAiChatMessage[];
  workspaceRootPath?: string | null;
  planDetails?: IAiThreadPlanDetails;
  revertingChangedFilesSummaryId?: string | null;
  pinningChangedFilesSummaryId?: string | null;
}>();

const emit = defineEmits<{
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  planApprove: [];
  planReject: [];
  planRegenerate: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const entries = computed<TAiThreadEntry[]>(() => buildThreadEntries(props.messages));

const expansion = useThreadEntryExpansion(entries);

const messagesById = computed(() => {
  const map = new Map<string, IAiChatMessage>();

  for (const message of props.messages) {
    map.set(message.id, message);
  }

  return map;
});

// 每条来源消息的“最后一个条目”id 集合;平铺渲染时据此在消息边界注入逐消息附加
// 内容(如对话检查点),与 Zed `acp_thread` 把检查点挂在消息末尾的做法一致,而
// 不破坏单一线性时间线。
const lastEntryIdByMessage = computed(() => {
  const lastById = new Map<string, string>();

  for (const entry of entries.value) {
    lastById.set(entry.messageId, entry.id);
  }

  return new Set(lastById.values());
});

const isMessageBoundary = (entry: TAiThreadEntry): boolean =>
  lastEntryIdByMessage.value.has(entry.id);

const patchesFor = (messageId: string): readonly IAiPatchSet[] =>
  messagesById.value.get(messageId)?.patches ?? [];
</script>

<template>
  <div class="ai-thread-timeline">
    <template v-for="entry in entries" :key="entry.id">
      <AiThreadUserMessage
        v-if="entry.kind === 'user-message'"
        class="ai-thread-timeline__entry"
        :entry="entry"
      />
      <AiThreadAssistantText
        v-if="entry.kind === 'assistant-text'"
        class="ai-thread-timeline__entry"
        :entry="entry"
      />
      <AiThreadReasoning
        v-if="entry.kind === 'reasoning'"
        class="ai-thread-timeline__entry"
        :entry="entry"
        :open="expansion.isExpanded(entry)"
        @update:open="expansion.setExpanded(entry, $event)"
      />
      <AiThreadToolCall
        v-if="entry.kind === 'tool-call'"
        class="ai-thread-timeline__entry"
        :entry="entry"
        :open="expansion.isExpanded(entry)"
        :patches="patchesFor(entry.messageId)"
        :workspace-root-path="workspaceRootPath"
        @update:open="expansion.setExpanded(entry, $event)"
      />
      <AiThreadPlanControl
        v-if="entry.kind === 'plan-control'"
        class="ai-thread-timeline__entry"
        :entry="entry"
        :details="planDetails"
        @approve="emit('planApprove')"
        @reject="emit('planReject')"
        @regenerate="emit('planRegenerate')"
        @update-step-title="(stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)"
        @remove-step="emit('planRemoveStep', $event)"
      />
      <AiThreadContextCompaction
        v-if="entry.kind === 'context-compaction'"
        class="ai-thread-timeline__entry"
        :entry="entry"
      />
      <AiThreadChangedFilesSummary
        v-if="entry.kind === 'changed-files-summary'"
        class="ai-thread-timeline__entry"
        :entry="entry"
        :patches="patchesFor(entry.messageId)"
        :workspace-root-path="workspaceRootPath"
        :is-reverting="revertingChangedFilesSummaryId === entry.summary.id"
        :is-pinning="pinningChangedFilesSummaryId === entry.summary.id"
        @undo="(messageId: string, summaryId: string) => emit('changedFilesRollback', messageId, summaryId)"
        @pin="(messageId: string, summaryId: string, pinned: boolean) => emit('changedFilesPin', messageId, summaryId, pinned)"
      />
      <slot
        v-if="isMessageBoundary(entry) && messagesById.get(entry.messageId)"
        name="after-message"
        :message="messagesById.get(entry.messageId)"
      />
    </template>
  </div>
</template>

<style scoped>
.ai-thread-timeline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-width: 0;
}

.ai-thread-timeline__entry {
  min-width: 0;
  max-width: 100%;
}
</style>
