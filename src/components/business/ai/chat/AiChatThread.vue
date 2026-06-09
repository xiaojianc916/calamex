<script setup lang="ts">
import { computed } from 'vue';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message } from '@/components/ai-elements/message';
import AiThreadTimeline from '@/components/business/ai/thread/AiThreadTimeline.vue';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import type { TAiServicePlatformId } from '@/constants/ai/providers';
import type { IAiChatMessage } from '@/types/ai';
import AiThinkingStatus from './AiThinkingStatus.vue';

interface IAiChatScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}

const props = withDefaults(
  defineProps<{
    messages: IAiChatMessage[];
    isTyping: boolean;
    // platformId / providerLabel 由面板传入,作为稳定的对外契约保留(平铺时间线本身
    // 不再渲染逐消息的 provider 标识),避免父级绑定退化成 DOM 透传属性。
    platformId: TAiServicePlatformId;
    providerLabel: string;
    typingLabel?: string;
    conversationId?: string | null;
    workspaceRootPath?: string | null;
    scrollState?: IAiChatScrollState | null;
    hasExtraContent?: boolean;
    // Plan 控制条目(等待批准)的运行态明细;由面板按当前计划注入,渲染层无状态。
    planDetails?: IAiThreadPlanDetails;
    revertingChangedFilesSummaryId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
  }>(),
  {
    typingLabel: '正在思考',
    conversationId: null,
    workspaceRootPath: null,
    scrollState: null,
    hasExtraContent: false,
    planDetails: undefined,
    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
  },
);

const emit = defineEmits<{
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  scrollStateChange: [state: IAiChatScrollState];
  planApprove: [];
  planReject: [];
  planRegenerate: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const TOOL_PROGRESS_PREFIXES = [
  'AI 正在自动分析并按需调用工具…',
  'AI 正在自动使用工具：',
  'Agent 正在调用工具…',
  'Agent 正在根据你的确认继续执行…',
] as const;
// 报错只在输入框上方以一条居中提示线呈现,因此这些“把报错当回复”的助手占位消息
// 不再进入对话流,避免同一个错误出现两次。
const ERROR_REPLY_PREFIXES = ['Agent 执行失败：', 'AI 上下文收集失败：', '计划生成失败：'] as const;
// Plan 执行态的工具活动由真实运行时事件驱动平铺时间线;这个旧的 synthetic assistant
// message 仅保留给 token usage 估算,不能再混入会话时间线。
const PLAN_AGENT_FLOW_MESSAGE_ID_PREFIX = 'agent-flow:';

const isErrorReplyMessage = (message: IAiChatMessage): boolean => {
  if (message.role !== 'assistant') {
    return false;
  }

  const content = message.content.trim();

  if (!content) {
    return false;
  }

  return ERROR_REPLY_PREFIXES.some((prefix) => content.startsWith(prefix));
};

const isPlanAgentFlowMessage = (message: IAiChatMessage): boolean =>
  message.role === 'assistant' && message.id.startsWith(PLAN_AGENT_FLOW_MESSAGE_ID_PREFIX);

const visibleMessages = computed<IAiChatMessage[]>(() =>
  props.messages.filter(
    (message) => !isErrorReplyMessage(message) && !isPlanAgentFlowMessage(message),
  ),
);

const hasInlineProgressMessage = computed(() => {
  const lastMessage = visibleMessages.value.at(-1);
  if (lastMessage?.role !== 'assistant') {
    return false;
  }

  const isEmptyAssistantPlaceholder =
    !lastMessage.content.trim() && !lastMessage.toolCalls?.length && !lastMessage.actions?.length;

  return (
    lastMessage.stream?.status === 'streaming' ||
    Boolean(lastMessage.toolCalls?.length) ||
    isEmptyAssistantPlaceholder ||
    TOOL_PROGRESS_PREFIXES.some((prefix) => lastMessage.content.trim().startsWith(prefix))
  );
});

const shouldRenderStandaloneTyping = computed(
  () => props.isTyping && !hasInlineProgressMessage.value,
);
const shouldRenderEmptyState = computed(
  () =>
    visibleMessages.value.length === 0 &&
    !props.hasExtraContent &&
    !shouldRenderStandaloneTyping.value,
);

const conversationInitialScroll = computed(() => !props.scrollState);
const conversationResizeMode = computed(() => (props.isTyping ? undefined : 'instant'));

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};

const handleScrollStateChange = (state: IAiChatScrollState): void => {
  emit('scrollStateChange', state);
};
</script>

<template>
  <Conversation class="relative size-full overflow-x-hidden ai-chat-list" aria-label="AI 对话记录"
    :initial="conversationInitialScroll" :resize="conversationResizeMode" :restore-key="conversationId"
    :initial-scroll-top="scrollState?.scrollTop ?? null"
    :initial-distance-from-bottom="scrollState?.distanceFromBottom ?? null"
    @scroll-state-change="handleScrollStateChange">
    <ConversationContent class="ai-chat-list__content" :class="{ 'is-empty': shouldRenderEmptyState }">
      <slot v-if="shouldRenderEmptyState" name="empty">
        <ConversationEmptyState class="ai-chat-empty-state" title="还没有对话" description="选择一个提示词，或直接输入你的问题。">
          <template #icon>
            <span class="icon-[lucide--message-square] size-6" />
          </template>
        </ConversationEmptyState>
      </slot>
      <template v-else>
        <AiThreadTimeline :messages="visibleMessages" :workspace-root-path="workspaceRootPath"
          :plan-details="planDetails"
          :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
          :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
          @changed-files-rollback="handleChangedFilesRollback" @changed-files-pin="handleChangedFilesPin"
          @plan-approve="emit('planApprove')" @plan-reject="emit('planReject')"
          @plan-regenerate="emit('planRegenerate')"
          @plan-update-step-title="(stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)"
          @plan-remove-step="emit('planRemoveStep', $event)">
          <template #after-message="{ message }">
            <slot name="after-message" :message="message" />
          </template>
        </AiThreadTimeline>
        <slot name="after-messages" />
        <Message v-if="shouldRenderStandaloneTyping" from="assistant" class="ai-message-typing"
          :aria-label="typingLabel">
          <AiThinkingStatus :label="typingLabel" />
        </Message>
      </template>
    </ConversationContent>
    <ConversationScrollButton v-if="visibleMessages.length > 0" class="ai-chat-scroll-button" />
  </Conversation>
</template>

<style scoped>
.ai-chat-list {
  min-height: 0;
  flex: 1 1 0;
}

.ai-chat-list :deep(> div > div) {
  overscroll-behavior: contain;
  scroll-behavior: auto;
  overflow-anchor: none;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
}

.ai-chat-list.is-scrollbar-active :deep(> div > div) {
  scrollbar-color: color-mix(in srgb, var(--text-primary) 18%, transparent) transparent;
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar-track {
  background: transparent;
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: transparent;
  background-clip: content-box;
  transition: background-color 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-chat-list.is-scrollbar-active :deep(> div > div)::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--text-primary) 18%, transparent);
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--text-primary) 28%, transparent);
}

.ai-chat-list__content {
  min-width: 0;
  gap: 32px;
  min-height: 100%;
  overflow-x: hidden;
  padding: 16px 16px 24px;
}

.ai-chat-list__content.is-empty {
  justify-content: center;
}

.ai-chat-empty-state {
  color: var(--text-tertiary);
}

.ai-chat-scroll-button {
  bottom: 14px;
  left: 50%;
  z-index: 1;
  transform: translateX(-50%);
}

.ai-message-typing {
  display: flex;
  min-width: 0;
  align-items: flex-start;
}
</style>
