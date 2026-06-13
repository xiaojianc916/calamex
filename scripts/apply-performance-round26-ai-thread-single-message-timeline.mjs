import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const virtualItemFile = path.join(
  repoRoot,
  'src/components/business/ai/chat/AiThreadVirtualMessageItem.vue',
);

const singleTimelineFile = path.join(
  repoRoot,
  'src/components/business/ai/chat/AiThreadSingleMessageTimeline.vue',
);

const fail = (message) => {
  throw new Error(message);
};

const replaceOnce = (source, search, replacement, label) => {
  const count = source.split(search).length - 1;

  if (count !== 1) {
    fail(`[${label}] expected 1 match, got ${count}`);
  }

  return source.replace(search, replacement);
};

if (!fs.existsSync(virtualItemFile)) {
  fail('[guard] 请先成功应用 Round 25，缺少 AiThreadVirtualMessageItem.vue。');
}

let virtualItemSource = fs.readFileSync(virtualItemFile, 'utf8');

if (virtualItemSource.includes("import AiThreadSingleMessageTimeline from './AiThreadSingleMessageTimeline.vue';")) {
  console.log('✅ Round 26 already applied');
  process.exit(0);
}

if (!virtualItemSource.includes("import AiThreadTimeline from '@/components/business/ai/thread/AiThreadTimeline.vue';")) {
  fail('[guard] AiThreadVirtualMessageItem.vue 结构不符合 Round 25 预期，请贴当前文件内容。');
}

const singleTimelineComponent = `<script setup lang="ts">
import { computed } from 'vue';
import type { IAiChatMessage, IAiPatchSet } from '@/types/ai';
import AiThreadAssistantText from '@/components/business/ai/thread/AiThreadAssistantText.vue';
import AiThreadChangedFilesSummary from '@/components/business/ai/thread/AiThreadChangedFilesSummary.vue';
import AiThreadContextCompaction from '@/components/business/ai/thread/AiThreadContextCompaction.vue';
import AiThreadPlanControl from '@/components/business/ai/thread/AiThreadPlanControl.vue';
import AiThreadReasoning from '@/components/business/ai/thread/AiThreadReasoning.vue';
import AiThreadToolCall from '@/components/business/ai/thread/AiThreadToolCall.vue';
import AiThreadUserMessage from '@/components/business/ai/thread/AiThreadUserMessage.vue';
import {
  buildThreadEntries,
  type TAiThreadEntry,
} from '@/components/business/ai/thread/projection';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import { useThreadEntryExpansion } from '@/components/business/ai/thread/useThreadEntryExpansion';

const props = defineProps<{
  message: IAiChatMessage;
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

const entries = computed<TAiThreadEntry[]>(() => buildThreadEntries([props.message]));

const expansion = useThreadEntryExpansion(entries);

const lastEntryId = computed(() => entries.value.at(-1)?.id ?? null);

const isMessageBoundary = (entry: TAiThreadEntry): boolean => entry.id === lastEntryId.value;

const patchesForMessage = computed<readonly IAiPatchSet[]>(() => props.message.patches ?? []);

const shouldAddUserReplyGap = (entry: TAiThreadEntry, index: number): boolean => {
  const previousEntry = entries.value[index - 1];

  return previousEntry?.kind === 'user-message' && entry.kind !== 'user-message';
};

const ASSISTANT_MESSAGE_KINDS: ReadonlySet<TAiThreadEntry['kind']> = new Set([
  'assistant-text',
  'reasoning',
  'tool-call',
]);

const entryClass = (entry: TAiThreadEntry, index: number) => [
  'ai-thread-single-message__entry',
  {
    'ai-thread-single-message__entry--after-user': shouldAddUserReplyGap(entry, index),
    'ai-thread-onelight': ASSISTANT_MESSAGE_KINDS.has(entry.kind),
  },
];

const handlePlanUpdateStepTitle = (stepId: string, title: string): void => {
  emit('planUpdateStepTitle', stepId, title);
};

const handlePlanRemoveStep = (stepId: string): void => {
  emit('planRemoveStep', stepId);
};

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};
</script>

<template>
  <div class="ai-thread-single-message">
    <template v-for="(entry, index) in entries" :key="entry.id">
      <AiThreadUserMessage
        v-if="entry.kind === 'user-message'"
        :class="entryClass(entry, index)"
        :entry="entry"
      />

      <AiThreadAssistantText
        v-else-if="entry.kind === 'assistant-text'"
        :class="entryClass(entry, index)"
        :entry="entry"
      />

      <AiThreadReasoning
        v-else-if="entry.kind === 'reasoning'"
        :class="entryClass(entry, index)"
        :entry="entry"
        :open="expansion.isExpanded(entry)"
        @update:open="expansion.setExpanded(entry, $event)"
      />

      <AiThreadToolCall
        v-else-if="entry.kind === 'tool-call'"
        :class="entryClass(entry, index)"
        :entry="entry"
        :open="expansion.isExpanded(entry)"
        :patches="patchesForMessage"
        :workspace-root-path="workspaceRootPath"
        @update:open="expansion.setExpanded(entry, $event)"
      />

      <AiThreadPlanControl
        v-else-if="entry.kind === 'plan-control'"
        :class="entryClass(entry, index)"
        :entry="entry"
        :details="planDetails"
        @approve="emit('planApprove')"
        @reject="emit('planReject')"
        @regenerate="emit('planRegenerate')"
        @update-step-title="handlePlanUpdateStepTitle"
        @remove-step="handlePlanRemoveStep"
      />

      <AiThreadContextCompaction
        v-else-if="entry.kind === 'context-compaction'"
        :class="entryClass(entry, index)"
        :entry="entry"
      />

      <AiThreadChangedFilesSummary
        v-else-if="entry.kind === 'changed-files-summary'"
        :class="entryClass(entry, index)"
        :entry="entry"
        :patches="patchesForMessage"
        :workspace-root-path="workspaceRootPath"
        :is-reverting="revertingChangedFilesSummaryId === entry.summary.id"
        :is-pinning="pinningChangedFilesSummaryId === entry.summary.id"
        @undo="handleChangedFilesRollback"
        @pin="handleChangedFilesPin"
      />

      <slot v-if="isMessageBoundary(entry)" name="after-message" :message="message" />
    </template>
  </div>
</template>

<style scoped>
.ai-thread-single-message {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.ai-thread-single-message__entry {
  min-width: 0;
  max-width: 100%;
}

.ai-thread-single-message__entry--after-user {
  margin-top: 8px;
}
</style>
`;

fs.mkdirSync(path.dirname(singleTimelineFile), { recursive: true });
fs.writeFileSync(singleTimelineFile, singleTimelineComponent);

virtualItemSource = replaceOnce(
  virtualItemSource,
  "import AiThreadTimeline from '@/components/business/ai/thread/AiThreadTimeline.vue';",
  "import AiThreadSingleMessageTimeline from './AiThreadSingleMessageTimeline.vue';",
  'replace timeline import',
);

virtualItemSource = replaceOnce(
  virtualItemSource,
  `<template>
  <AiThreadTimeline
    :messages="[message]"
    :workspace-root-path="workspaceRootPath"
    :plan-details="planDetails"
    :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
    :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
    @changed-files-rollback="handleChangedFilesRollback"
    @changed-files-pin="handleChangedFilesPin"
    @plan-approve="emit('planApprove')"
    @plan-reject="emit('planReject')"
    @plan-regenerate="emit('planRegenerate')"
    @plan-update-step-title="handlePlanUpdateStepTitle"
    @plan-remove-step="handlePlanRemoveStep"
  >
    <template #after-message="{ message: slotMessage }">
      <slot name="after-message" :message="slotMessage" />
    </template>
  </AiThreadTimeline>
</template>`,
  `<template>
  <AiThreadSingleMessageTimeline
    :message="message"
    :workspace-root-path="workspaceRootPath"
    :plan-details="planDetails"
    :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
    :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
    @changed-files-rollback="handleChangedFilesRollback"
    @changed-files-pin="handleChangedFilesPin"
    @plan-approve="emit('planApprove')"
    @plan-reject="emit('planReject')"
    @plan-regenerate="emit('planRegenerate')"
    @plan-update-step-title="handlePlanUpdateStepTitle"
    @plan-remove-step="handlePlanRemoveStep"
  >
    <template #after-message="{ message: slotMessage }">
      <slot name="after-message" :message="slotMessage" />
    </template>
  </AiThreadSingleMessageTimeline>
</template>`,
  'replace virtual item template',
);

fs.writeFileSync(virtualItemFile, virtualItemSource);

console.log('✅ Applied Round 26: single-message timeline for virtualized AI items');
console.log(`📝 Created: ${path.relative(repoRoot, singleTimelineFile)}`);
console.log(`📝 Updated: ${path.relative(repoRoot, virtualItemFile)}`);