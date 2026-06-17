<script setup lang="ts">
import { ApprovalPrompt } from '@/components/ai-elements/approval';
import { useAcpApproval } from '@/composables/ai/useAcpApproval';

/**
 * ACP 工具调用审批浮层（ADR-20260617 D6）。
 *
 * 驱动 `useAcpApproval()` 队列，复用 `ApprovalPrompt` 渲染队首待决审批。
 * 无 props：sessionId / toolCallId 均来自宝主抹来的负载，组件全局订阅
 * `onAcpApproval`，挂载一份即可。
 */

const { current, resolve, dismiss } = useAcpApproval();

const handleSelect = (decision: string): void => {
  const pending = current.value;
  if (!pending) {
    return;
  }
  // decision = optionId 原文；回投失败已在 composable 内恢复待办，此处吞掉
  // rejection，避免未处理的 Promise。
  void resolve(pending.toolCallId, decision).catch(() => {});
};

const handleCancel = (): void => {
  const pending = current.value;
  if (!pending) {
    return;
  }
  // Esc：优先选拒绝类选项（tone=danger）明确回投；无则仅本地消隐，
  // 由上层 ai_cancel 负责唪醒被挂起的 JSON-RPC。
  const rejectOption = pending.approval.options.find((option) => option.tone === 'danger');
  if (rejectOption) {
    handleSelect(rejectOption.id);
    return;
  }
  dismiss(pending.toolCallId);
};
</script>

<template>
  <div v-if="current" class="acp-approval-overlay">
    <ApprovalPrompt
      :key="current.toolCallId"
      class="acp-approval-overlay__prompt"
      :title="current.approval.title"
      :reason="current.approval.summary"
      :options="current.approval.options"
      autofocus
      @select="handleSelect"
      @cancel="handleCancel"
    >
      <template v-if="current.approval.impact" #context>
        <p class="acp-approval-overlay__impact" v-text="current.approval.impact" />
      </template>
    </ApprovalPrompt>
  </div>
</template>

<style scoped>
.acp-approval-overlay {
  display: flex;
  width: 100%;
  min-width: 0;
}

.acp-approval-overlay__prompt {
  flex: 1 1 auto;
  min-width: 0;
}

.acp-approval-overlay__impact {
  margin: 0;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
