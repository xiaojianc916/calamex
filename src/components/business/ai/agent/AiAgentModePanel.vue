<script setup lang="ts">
import { computed } from 'vue';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import AiChangedFilesSummary from '@/components/business/ai/edit/AiChangedFilesSummary.vue';
import AiAgentRuntimeTimeline from '@/components/business/ai/plan/AiAgentRuntimeTimeline.vue';
import type { IAiChatMessage } from '@/types/ai';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';

interface IAiAgentPanelEntryBase {
  id: string;
  createdAt: string;
}

interface IAiAgentPanelUserEntry extends IAiAgentPanelEntryBase {
  type: 'user';
  message: IAiChatMessage;
}

interface IAiAgentPanelAssistantEntry extends IAiAgentPanelEntryBase {
  type: 'assistant';
  message: IAiChatMessage;
  runtimeEvents: TAgentRuntimeEvent[];
  finalAnswer: string;
  isStreaming: boolean;
  isWaitingConfirmation: boolean;
  showTimeline: boolean;
  showFinalAnswer: boolean;
}

type TAiAgentPanelEntry = IAiAgentPanelUserEntry | IAiAgentPanelAssistantEntry;

interface IAiAgentScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}

const props = withDefaults(
  defineProps<{
    messages: IAiChatMessage[];
    isTyping: boolean;
    conversationId?: string | null;
    workspaceRootPath?: string | null;
    scrollState?: IAiAgentScrollState | null;
    revertingChangedFilesSummaryId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
  }>(),
  {
    conversationId: null,
    workspaceRootPath: null,
    scrollState: null,
    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
  },
);

const emit = defineEmits<{
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  scrollStateChange: [state: IAiAgentScrollState];
}>();

const HIDDEN_RUNTIME_EVENT_TYPES = new Set<TAgentRuntimeEvent['type']>([
  'acontext.token.checked',
  'acontext.provider_payload.checked',
]);

const isRuntimeDisplayEvent = (event: TAgentRuntimeEvent): boolean =>
  event.type !== 'acontext.memory.compressed' && !HIDDEN_RUNTIME_EVENT_TYPES.has(event.type);

const isRuntimeActive = (message: IAiChatMessage): boolean =>
  message.stream?.status === 'streaming' || message.stream?.status === 'waiting-confirmation';

const shouldShowAssistantFinalAnswer = (message: IAiChatMessage): boolean => {
  const content = message.content.trim();

  if (!content) {
    return false;
  }

  if (!message.stream?.runtimeEvents?.length) {
    return true;
  }

  if (message.stream.finalAnswerStarted === true) {
    return true;
  }

  return !isRuntimeActive(message);
};

const buildAssistantEntry = (message: IAiChatMessage): IAiAgentPanelAssistantEntry => {
  const runtimeEvents = message.stream?.runtimeEvents ?? [];
  const hasRuntimeEvents = runtimeEvents.some(isRuntimeDisplayEvent);
  const isWaitingConfirmation = message.stream?.status === 'waiting-confirmation';
  const isStreaming = message.stream?.status === 'streaming';
  const hasRuntimeBuffer = Array.isArray(message.stream?.runtimeEvents);
  const showTimeline =
    hasRuntimeEvents ||
    ((isStreaming || isWaitingConfirmation) && message.stream?.finalAnswerStarted !== true && hasRuntimeBuffer);

  return {
    id: message.id,
    type: 'assistant',
    message,
    createdAt: message.createdAt,
    runtimeEvents,
    finalAnswer: message.content.trim(),
    isStreaming,
    isWaitingConfirmation,
    showTimeline,
    showFinalAnswer: shouldShowAssistantFinalAnswer(message),
  };
};

const entries = computed<TAiAgentPanelEntry[]>(() =>
  props.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) =>
      message.role === 'user'
        ? {
            id: message.id,
            type: 'user',
            message,
            createdAt: message.createdAt,
          }
        : buildAssistantEntry(message),
    )
    .filter((entry) => {
      if (entry.type === 'user') {
        return entry.message.content.trim().length > 0 || entry.message.references.length > 0;
      }

      return (
        entry.showTimeline ||
        entry.showFinalAnswer ||
        Boolean(entry.message.changedFilesSummary) ||
        Boolean(entry.message.actions?.length)
      );
    }),
);

const shouldRenderEmptyState = computed(() => entries.value.length === 0 && !props.isTyping);
const conversationInitialScroll = computed(() => !props.scrollState);
const conversationResizeMode = computed(() => (props.isTyping ? undefined : 'instant'));

const handleScrollStateChange = (state: IAiAgentScrollState): void => {
  emit('scrollStateChange', state);
};
</script>

<template>
  <Conversation class="relative size-full overflow-x-hidden ai-agent-mode-panel" aria-label="Agent 执行时间线"
    :initial="conversationInitialScroll" :resize="conversationResizeMode" :restore-key="conversationId"
    :initial-scroll-top="scrollState?.scrollTop ?? null"
    :initial-distance-from-bottom="scrollState?.distanceFromBottom ?? null"
    @scroll-state-change="handleScrollStateChange">
    <ConversationContent class="ai-agent-mode-panel__content" :class="{ 'is-empty': shouldRenderEmptyState }">
      <ConversationEmptyState v-if="shouldRenderEmptyState" class="ai-agent-empty-state" title="Agent 尚未开始"
        description="描述目标后，Agent 会把执行过程按时间线展开。">
        <template #icon>
          <span class="icon-[lucide--workflow] size-6" />
        </template>
      </ConversationEmptyState>

      <template v-else>
        <template v-for="entry in entries" :key="entry.id">
          <article v-if="entry.type === 'user'" class="ai-agent-entry is-user">
            <div class="ai-agent-user-bubble">
              <AiMarkdown :message-id="entry.message.id" :content="entry.message.content" />
            </div>
          </article>

          <article v-else class="ai-agent-entry is-assistant">
            <AiAgentRuntimeTimeline v-if="entry.showTimeline" :events="entry.runtimeEvents" :is-streaming="entry.isStreaming"
              :is-waiting-confirmation="entry.isWaitingConfirmation" />

            <div v-if="entry.showFinalAnswer" class="ai-agent-final-answer" aria-label="Agent 最终回复">
              <AiMarkdown :message-id="entry.message.id" :content="entry.finalAnswer"
                :stream-status="entry.message.stream?.status" />
            </div>

            <AiChangedFilesSummary v-if="entry.message.changedFilesSummary" class="ai-agent-changed-files"
              :summary="entry.message.changedFilesSummary" :patches="entry.message.patches ?? []"
              :workspace-root-path="workspaceRootPath"
              :is-reverting="revertingChangedFilesSummaryId === entry.message.changedFilesSummary.id" variant="message"
              :is-pinning="pinningChangedFilesSummaryId === entry.message.changedFilesSummary.id"
              @undo="emit('changedFilesRollback', entry.message.id, $event)"
              @pin="(summaryId, pinned) => emit('changedFilesPin', entry.message.id, summaryId, pinned)" />
          </article>
        </template>
      </template>
    </ConversationContent>
    <ConversationScrollButton v-if="entries.length > 0" class="ai-agent-scroll-button" />
  </Conversation>
</template>

<style scoped>
.ai-agent-mode-panel {
  min-height: 0;
  flex: 1 1 0;
}

.ai-agent-mode-panel :deep(> div > div) {
  overscroll-behavior: contain;
  scroll-behavior: auto;
  overflow-anchor: none;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
}

.ai-agent-mode-panel.is-scrollbar-active :deep(> div > div) {
  scrollbar-color: color-mix(in srgb, var(--text-primary) 18%, transparent) transparent;
}

.ai-agent-mode-panel__content {
  min-width: 0;
  gap: 26px;
  min-height: 100%;
  overflow-x: hidden;
  padding: 16px 16px 24px;
}

.ai-agent-mode-panel__content.is-empty {
  justify-content: center;
}

.ai-agent-empty-state {
  color: var(--text-tertiary);
}

.ai-agent-entry {
  display: flex;
  min-width: 0;
  max-width: 100%;
}

.ai-agent-entry.is-user {
  justify-content: flex-end;
}

.ai-agent-entry.is-assistant {
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding-left: 12px;
  padding-right: 88px;
}

.ai-agent-user-bubble {
  max-width: min(680px, 100%);
  border-radius: 10px;
  background: #f4f4f5;
  color: var(--secondary-foreground);
  padding: 8px 12px;
  font-size: 14px;
  line-height: 22px;
  overflow-wrap: anywhere;
}

.ai-agent-final-answer {
  --ai-chat-font-size-body: 14px;
  --ai-chat-line-height-body: 22px;
  --ai-chat-line-height-body-ratio: 1.5714285714;
  --ai-chat-font-size-caption: 12px;
  --ai-chat-line-height-caption: 18px;
  --ai-chat-font-size-h1: 16px;
  --ai-chat-line-height-h1: 24px;
  --ai-chat-line-height-h1-ratio: 1.5;
  --ai-chat-font-size-h2: 14px;
  --ai-chat-line-height-h2: 22px;
  --ai-chat-line-height-h2-ratio: 1.5714285714;
  --ai-chat-font-size-h3: 13px;
  --ai-chat-line-height-h3: 20px;
  --ai-chat-line-height-h3-ratio: 1.5384615385;
  --ai-chat-font-size-code: 13px;
  --ai-chat-line-height-code: 20px;
  --ai-chat-line-height-code-ratio: 1.5384615385;
  --ai-chat-font-size-table: 13px;
  --ai-chat-line-height-table: 20px;
  --ai-chat-line-height-table-ratio: 1.5384615385;
  --ai-chat-font-weight-strong: 600;
  --ai-chat-space-paragraph: 12px;
  --ai-chat-space-section: 20px;
  --ai-chat-space-subsection: 14px;
  --ai-chat-space-subheading: 12px;
  width: min(680px, 100%);
  min-width: 0;
  color: var(--text-primary);
  font-size: var(--ai-chat-font-size-body);
  line-height: var(--ai-chat-line-height-body);
  overflow: hidden;
  overflow-wrap: anywhere;
}

.ai-agent-entry :deep(.ai-runtime-timeline) {
  width: 100%;
  max-width: min(100%, 760px);
}

.ai-agent-changed-files {
  width: min(100%, 640px);
}

.ai-agent-scroll-button {
  bottom: 14px;
  left: 50%;
  z-index: 1;
  transform: translateX(-50%);
}
</style>
