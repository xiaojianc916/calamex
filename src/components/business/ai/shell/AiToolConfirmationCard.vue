<script setup lang="ts">
import { computed } from 'vue';

import { ApprovalPrompt, buildToolConfirmationApproval } from '@/components/ai-elements/approval';
import {
  AI_TOOL_CONFIRMATION_DECISIONS,
  type IAiToolConfirmationRequest,
  type TAiToolConfirmationDecision,
} from '@/types/ai';

/**
 * 工具执行确认 — Codex 风格审批浮层。
 *
 * 本组件仅负责将业务请求映射到纯展示的 ApprovalPrompt,并将选择回传为决策。
 * 负载、风险、可回滚等信息以 Codex 的极简方式内联呈现(问句 + 上下文),
 * 不再使用大卡片/风险图标。
 */
const props = defineProps<{
  confirmation: IAiToolConfirmationRequest;
  disabled: boolean;
}>();

const emit = defineEmits<{
  resolve: [decision: TAiToolConfirmationDecision];
}>();

const approval = computed(() => buildToolConfirmationApproval(props.confirmation));

const isConfirmationDecision = (id: string): id is TAiToolConfirmationDecision =>
  (AI_TOOL_CONFIRMATION_DECISIONS as readonly string[]).includes(id);

const handleSelect = (id: string): void => {
  if (props.disabled) {
    return;
  }

  if (isConfirmationDecision(id)) {
    emit('resolve', id);
  }
};

const handleCancel = (): void => {
  if (props.disabled) {
    return;
  }

  emit('resolve', 'stop');
};
</script>

<template>
  <ApprovalPrompt
    class="ai-tool-confirmation"
    :title="approval.title"
    :options="approval.options"
    :disabled="disabled"
    aria-label="工具执行确认"
    @select="handleSelect"
    @cancel="handleCancel"
  >
    <template v-if="approval.summary || approval.impact" #context>
      <div class="ai-tool-confirmation__context">
        <p
          v-if="approval.summary"
          class="ai-tool-confirmation__summary"
          v-text="approval.summary"
        />
        <code
          v-if="approval.impact"
          class="ai-tool-confirmation__impact"
          :title="approval.impact"
          v-text="approval.impact"
        />
      </div>
    </template>
  </ApprovalPrompt>
</template>

<style scoped>
.ai-tool-confirmation {
  width: min(100%, 504px);
}

.ai-tool-confirmation__context {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.ai-tool-confirmation__summary {
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 16px;
}

.ai-tool-confirmation__impact {
  min-width: 0;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 16px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
