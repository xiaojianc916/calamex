import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const chatThreadFile = path.join(
  repoRoot,
  'src/components/business/ai/chat/AiChatThread.vue',
);

const virtualItemFile = path.join(
  repoRoot,
  'src/components/business/ai/chat/AiThreadVirtualMessageItem.vue',
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

const replaceRegexOnce = (source, pattern, replacement, label) => {
  const matches = source.match(pattern);

  if (!matches) {
    fail(`[${label}] expected 1 match, got 0`);
  }

  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );

  const count = [...source.matchAll(globalPattern)].length;

  if (count !== 1) {
    fail(`[${label}] expected 1 match, got ${count}`);
  }

  return source.replace(pattern, replacement);
};

if (!fs.existsSync(chatThreadFile)) {
  fail(`[missing] ${path.relative(repoRoot, chatThreadFile)}`);
}

let source = fs.readFileSync(chatThreadFile, 'utf8');

if (!source.includes("from 'vue-virtual-scroller'")) {
  fail('[guard] 请先成功应用 Round 23/24 的 vue-virtual-scroller 版本。');
}

if (source.includes("import AiThreadVirtualMessageItem from './AiThreadVirtualMessageItem.vue';")) {
  console.log('✅ Round 25 already applied');
  process.exit(0);
}

const virtualItemComponent = `<script setup lang="ts">
import AiThreadTimeline from '@/components/business/ai/thread/AiThreadTimeline.vue';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import type { IAiChatMessage } from '@/types/ai';

defineProps<{
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

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};

const handlePlanUpdateStepTitle = (stepId: string, title: string): void => {
  emit('planUpdateStepTitle', stepId, title);
};

const handlePlanRemoveStep = (stepId: string): void => {
  emit('planRemoveStep', stepId);
};
</script>

<template>
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
</template>
`;

fs.mkdirSync(path.dirname(virtualItemFile), { recursive: true });
fs.writeFileSync(virtualItemFile, virtualItemComponent);

source = replaceOnce(
  source,
  "import AiThreadTimeline from '@/components/business/ai/thread/AiThreadTimeline.vue';",
  "import AiThreadVirtualMessageItem from './AiThreadVirtualMessageItem.vue';",
  'replace timeline import',
);

source = replaceOnce(
  source,
  `const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};`,
  `const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};

const handlePlanUpdateStepTitle = (stepId: string, title: string): void => {
  emit('planUpdateStepTitle', stepId, title);
};

const handlePlanRemoveStep = (stepId: string): void => {
  emit('planRemoveStep', stepId);
};`,
  'add plan relay handlers',
);

source = replaceRegexOnce(
  source,
  /            <AiThreadTimeline\n              v-if="item\.type === 'message'"[\s\S]*?            <\/AiThreadTimeline>/,
  `            <AiThreadVirtualMessageItem
              v-if="item.type === 'message'"
              :message="item.message"
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
              <template #after-message="{ message }">
                <slot name="after-message" :message="message" />
              </template>
            </AiThreadVirtualMessageItem>`,
  'replace inline timeline with virtual item component',
);

fs.writeFileSync(chatThreadFile, source);

console.log('✅ Applied Round 25: extracted AI virtual message item component');
console.log(`📝 Updated: ${path.relative(repoRoot, chatThreadFile)}`);
console.log(`📝 Created: ${path.relative(repoRoot, virtualItemFile)}`);