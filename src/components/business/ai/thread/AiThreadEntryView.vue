<script setup lang="ts">
import type { IAiPatchSet } from '@/types/ai';
import AiThreadAssistantText from './AiThreadAssistantText.vue';
import AiThreadChangedFilesSummary from './AiThreadChangedFilesSummary.vue';
import AiThreadContextCompaction from './AiThreadContextCompaction.vue';
import AiThreadPlanControl from './AiThreadPlanControl.vue';
import AiThreadReasoning from './AiThreadReasoning.vue';
import AiThreadToolCall from './AiThreadToolCall.vue';
import AiThreadUserMessage from './AiThreadUserMessage.vue';
import type { TAiThreadEntry } from './projection';
import type { IAiThreadPlanDetails } from './types';

// 单条平铺时间线条目的渲染分派。当前唯一调用方为 AiChatThread 的逐 entry 虚拟化路径;
// 按 kind 差异化的 patches / workspace 透传经独立 props 承载,以保持调用方行为不变。
withDefaults(
  defineProps<{
    entry: TAiThreadEntry;
    open?: boolean;
    afterUser?: boolean;
    planDetails?: IAiThreadPlanDetails;
    workspaceRootPath?: string | null;
    summaryPatches?: readonly IAiPatchSet[];
    toolCallPatches?: readonly IAiPatchSet[];
    toolCallWorkspaceRootPath?: string | null;
    revertingChangedFilesSummaryId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
  }>(),
  {
    open: false,
    afterUser: false,
    planDetails: undefined,
    workspaceRootPath: null,
    summaryPatches: undefined,
    toolCallPatches: undefined,
    toolCallWorkspaceRootPath: null,
    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
  },
);

const emit = defineEmits<{
  'update:open': [open: boolean];
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  planApprove: [];
  planReject: [];
  planRegenerate: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

// 仅 AI 助手发送的条目(正文 / 推理 / 工具调用)注入 Zed One Light 调色板,经由
// ai-thread-onelight 作用域类局部覆盖 design token;用户消息与其它面板不受影响。
const ASSISTANT_MESSAGE_KINDS: ReadonlySet<TAiThreadEntry['kind']> = new Set([
  'assistant-text',
  'reasoning',
  'tool-call',
]);
</script>

<template>
  <div
    class="ai-thread-entry"
    :class="{
      'ai-thread-entry--after-user': afterUser,
      'ai-thread-onelight': ASSISTANT_MESSAGE_KINDS.has(entry.kind),
    }"
  >
    <AiThreadUserMessage v-if="entry.kind === 'user-message'" :entry="entry" />

    <AiThreadAssistantText v-else-if="entry.kind === 'assistant-text'" :entry="entry" />

    <AiThreadReasoning
      v-else-if="entry.kind === 'reasoning'"
      :entry="entry"
      :open="open"
      @update:open="emit('update:open', $event)"
    />

    <AiThreadToolCall
      v-else-if="entry.kind === 'tool-call'"
      :entry="entry"
      :open="open"
      :patches="toolCallPatches"
      :workspace-root-path="toolCallWorkspaceRootPath"
      @update:open="emit('update:open', $event)"
    />

    <AiThreadPlanControl
      v-else-if="entry.kind === 'plan-control'"
      :entry="entry"
      :details="planDetails"
      @approve="emit('planApprove')"
      @reject="emit('planReject')"
      @regenerate="emit('planRegenerate')"
      @update-step-title="
        (stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)
      "
      @remove-step="emit('planRemoveStep', $event)"
    />

    <AiThreadContextCompaction v-else-if="entry.kind === 'context-compaction'" :entry="entry" />

    <AiThreadChangedFilesSummary
      v-else-if="entry.kind === 'changed-files-summary'"
      :entry="entry"
      :patches="summaryPatches ?? []"
      :workspace-root-path="workspaceRootPath"
      :is-reverting="revertingChangedFilesSummaryId === entry.summary.id"
      :is-pinning="pinningChangedFilesSummaryId === entry.summary.id"
      @undo="
        (messageId: string, summaryId: string) =>
          emit('changedFilesRollback', messageId, summaryId)
      "
      @pin="
        (messageId: string, summaryId: string, pinned: boolean) =>
          emit('changedFilesPin', messageId, summaryId, pinned)
      "
    />
  </div>
</template>

<style scoped>
.ai-thread-entry {
  min-width: 0;
  max-width: 100%;
}

.ai-thread-entry--after-user {
  margin-top: 8px;
}
</style>
