<script setup lang="ts">
import { computed } from 'vue';
import type { IAiChatMessage, IAiPatchSet } from '@/types/ai';
import type { IAiThreadEntry } from '@/types/ai/thread';
import AiThreadEntryView from './AiThreadEntryView.vue';
import { buildThreadEntries, type TAiThreadEntry, threadEntriesToTimeline } from './projection';
import type { IAiThreadPlanDetails } from './types';
import { useThreadEntryExpansion } from './useThreadEntryExpansion';

const props = defineProps<{
  messages: readonly IAiChatMessage[];
  workspaceRootPath?: string | null;
  planDetails?: IAiThreadPlanDetails;
  revertingChangedFilesSummaryId?: string | null;
  pinningChangedFilesSummaryId?: string | null;
  renderFromEntries?: boolean;
  threadEntries?: readonly IAiThreadEntry[];
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

const entries = computed<TAiThreadEntry[]>(() =>
  props.renderFromEntries
    ? threadEntriesToTimeline(props.threadEntries ?? [])
    : buildThreadEntries(props.messages),
);

const expansion = useThreadEntryExpansion(entries);

const messagesById = computed(() => {
  const map = new Map<string, IAiChatMessage>();

  for (const message of props.messages) {
    map.set(message.id, message);
  }

  return map;
});

// 每条来源消息的“最后一个条目”id 集合;平铺渲染时据此在消息边界注入逐消息附加内容
// (如对话检查点),与 Zed acp_thread 把检查点挂在消息末尾的做法一致,而不破坏单一线性时间线。
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

const shouldAddUserReplyGap = (entry: TAiThreadEntry, index: number): boolean => {
  const previousEntry = entries.value[index - 1];

  return previousEntry?.kind === 'user-message' && entry.kind !== 'user-message';
};
</script>

<template>
  <div class="ai-thread-timeline">
    <template v-for="(entry, index) in entries" :key="entry.id">
      <AiThreadEntryView
        :entry="entry"
        :open="expansion.isExpanded(entry)"
        :after-user="shouldAddUserReplyGap(entry, index)"
        :plan-details="planDetails"
        :workspace-root-path="workspaceRootPath"
        :summary-patches="patchesFor(entry.messageId)"
        :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
        :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
        @update:open="expansion.setExpanded(entry, $event)"
        @changed-files-rollback="
          (messageId: string, summaryId: string) =>
            emit('changedFilesRollback', messageId, summaryId)
        "
        @changed-files-pin="
          (messageId: string, summaryId: string, pinned: boolean) =>
            emit('changedFilesPin', messageId, summaryId, pinned)
        "
        @plan-approve="emit('planApprove')"
        @plan-reject="emit('planReject')"
        @plan-regenerate="emit('planRegenerate')"
        @plan-update-step-title="
          (stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)
        "
        @plan-remove-step="emit('planRemoveStep', $event)"
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
</style>
