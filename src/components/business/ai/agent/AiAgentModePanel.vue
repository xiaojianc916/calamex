<script setup lang="ts">
import { computed } from 'vue';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import AiErrorNotice from '@/components/business/ai/chat/AiErrorNotice.vue';
import AiChangedFilesSummary from '@/components/business/ai/edit/AiChangedFilesSummary.vue';
import AiAgentRuntimeTimeline from '@/components/business/ai/plan/AiAgentRuntimeTimeline.vue';
import AiToolConfirmationCard from '@/components/business/ai/shell/AiToolConfirmationCard.vue';
import type {
  IAiAgentPatchSummary,
  IAiChatMessage,
  IAiToolConfirmationRequest,
  TAiToolConfirmationDecision,
} from '@/types/ai';
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

type TActivityToolStatus = 'running' | 'succeeded' | 'failed';

interface IAiAgentActivityTool {
  key: string;
  label: string;
  status: TActivityToolStatus;
  detail?: string;
}

interface IAiAgentCompactionActivity {
  id: string;
  label: string;
  detail: string;
}

interface IAiAgentEditedFilesActivity {
  id: string;
  summary: IAiAgentPatchSummary;
  messageId: string;
}

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
    toolConfirmation?: IAiToolConfirmationRequest | null;
    isRunActionPending?: boolean;
    errorMessage?: string;
  }>(),
  {
    conversationId: null,
    workspaceRootPath: null,
    scrollState: null,
    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
    toolConfirmation: null,
    isRunActionPending: false,
    errorMessage: '',
  },
);

const emit = defineEmits<{
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  resolveToolConfirmation: [decision: TAiToolConfirmationDecision];
  scrollStateChange: [state: IAiAgentScrollState];
}>();

const HIDDEN_RUNTIME_EVENT_TYPES = new Set<TAgentRuntimeEvent['type']>([
  'acontext.token.checked',
  'acontext.provider_payload.checked',
]);

const isRuntimeDisplayEvent = (event: TAgentRuntimeEvent): boolean =>
  event.visibility !== 'debug' &&
  event.type !== 'acontext.memory.compressed' &&
  !HIDDEN_RUNTIME_EVENT_TYPES.has(event.type);

const visibleRuntimeEventsForMessage = (message: IAiChatMessage): TAgentRuntimeEvent[] =>
  (message.stream?.runtimeEvents ?? []).filter(isRuntimeDisplayEvent);

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
  const runtimeEvents = visibleRuntimeEventsForMessage(message);
  const isWaitingConfirmation = message.stream?.status === 'waiting-confirmation';
  const isStreaming = message.stream?.status === 'streaming';
  const hasRuntimeBuffer = Array.isArray(message.stream?.runtimeEvents);
  const showTimeline =
    runtimeEvents.length > 0 ||
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

const agentAssistantMessages = computed(() =>
  props.messages.filter((message) => message.role === 'assistant'),
);

const allVisibleRuntimeEvents = computed<TAgentRuntimeEvent[]>(() =>
  agentAssistantMessages.value.flatMap(visibleRuntimeEventsForMessage),
);

const latestVisibleRuntimeEvents = computed<TAgentRuntimeEvent[]>(() => {
  for (let index = agentAssistantMessages.value.length - 1; index >= 0; index -= 1) {
    const message = agentAssistantMessages.value[index];
    const events = message ? visibleRuntimeEventsForMessage(message) : [];

    if (events.length > 0 || message?.stream?.status === 'streaming') {
      return events;
    }
  }

  return [];
});

const latestRunError = computed(() =>
  [...allVisibleRuntimeEvents.value]
    .reverse()
    .find((event): event is Extract<TAgentRuntimeEvent, { type: 'agent.run.error' }> =>
      event.type === 'agent.run.error',
    ),
);

const getRuntimeEventToolKey = (
  event: Extract<
    TAgentRuntimeEvent,
    { type: 'agent.tool.started' | 'agent.tool.progress' | 'agent.tool.completed' }
  >,
): string => event.toolUseId ?? event.toolName ?? event.id;

const collectActivityTools = (events: readonly TAgentRuntimeEvent[]): IAiAgentActivityTool[] => {
  const toolMap = new Map<string, IAiAgentActivityTool>();

  events.forEach((event) => {
    if (
      event.type !== 'agent.tool.started' &&
      event.type !== 'agent.tool.progress' &&
      event.type !== 'agent.tool.completed'
    ) {
      return;
    }

    const key = getRuntimeEventToolKey(event);
    const previous = toolMap.get(key);
    const fallbackLabel = event.toolName ?? previous?.label ?? '工具';

    if (event.type === 'agent.tool.started') {
      toolMap.set(key, {
        key,
        label: event.toolName,
        status: 'running',
        detail: event.inputPreview,
      });
      return;
    }

    if (event.type === 'agent.tool.progress') {
      toolMap.set(key, {
        key,
        label: fallbackLabel,
        status: previous?.status ?? 'running',
        detail: event.dataPreview ?? previous?.detail,
      });
      return;
    }

    toolMap.set(key, {
      key,
      label: event.toolName,
      status: event.ok ? 'succeeded' : 'failed',
      detail: event.ok ? event.resultPreview : event.errorMessage,
    });
  });

  return [...toolMap.values()].slice(-4);
};

const activityTools = computed(() => collectActivityTools(latestVisibleRuntimeEvents.value));
const activeToolCount = computed(
  () => activityTools.value.filter((tool) => tool.status === 'running').length,
);
const completedToolCount = computed(
  () => activityTools.value.filter((tool) => tool.status === 'succeeded').length,
);
const failedToolCount = computed(
  () => activityTools.value.filter((tool) => tool.status === 'failed').length,
);

const compactionActivities = computed<IAiAgentCompactionActivity[]>(() =>
  allVisibleRuntimeEvents.value
    .filter(
      (
        event,
      ): event is Extract<
        TAgentRuntimeEvent,
        { type: 'acontext.context_compaction.started' | 'acontext.context_compaction.completed' }
      > =>
        event.type === 'acontext.context_compaction.started' ||
        event.type === 'acontext.context_compaction.completed',
    )
    .map((event) => {
      if (event.type === 'acontext.context_compaction.started') {
        return {
          id: event.id,
          label: '上下文整理开始',
          detail: event.projectedInputTokens
            ? `预计输入 ${event.projectedInputTokens} tokens`
            : '正在为后续执行腾出上下文窗口',
        };
      }

      return {
        id: event.id,
        label: '上下文整理完成',
        detail: `摘要 ${event.summaryCharCount} 字符`,
      };
    })
    .slice(-2),
);

const editedFilesActivities = computed<IAiAgentEditedFilesActivity[]>(() =>
  agentAssistantMessages.value
    .filter((message): message is IAiChatMessage & { changedFilesSummary: IAiAgentPatchSummary } =>
      Boolean(message.changedFilesSummary),
    )
    .map((message) => ({
      id: `${message.id}:${message.changedFilesSummary.id}`,
      messageId: message.id,
      summary: message.changedFilesSummary,
    }))
    .slice(-2),
);

const shouldShowActivityBar = computed(
  () =>
    Boolean(props.toolConfirmation) ||
    Boolean(props.errorMessage.trim()) ||
    Boolean(latestRunError.value) ||
    activityTools.value.length > 0 ||
    compactionActivities.value.length > 0 ||
    editedFilesActivities.value.length > 0 ||
    props.isTyping,
);

const activitySummaryLabel = computed(() => {
  if (props.toolConfirmation) {
    return '等待工具确认';
  }

  if (latestRunError.value || props.errorMessage.trim()) {
    return '运行需要处理';
  }

  if (props.isTyping || activeToolCount.value > 0) {
    return activeToolCount.value > 0 ? `正在执行 ${activeToolCount.value} 个工具` : 'Agent 正在执行';
  }

  if (failedToolCount.value > 0) {
    return `工具失败 ${failedToolCount.value} 个`;
  }

  if (completedToolCount.value > 0) {
    return `已完成 ${completedToolCount.value} 个工具动作`;
  }

  return 'Agent 活动';
});

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
        <section v-if="shouldShowActivityBar" class="ai-agent-activity-bar" aria-label="Agent 活动概览">
          <header class="ai-agent-activity-bar__header">
            <span class="ai-agent-activity-bar__icon" aria-hidden="true">
              <span class="icon-[lucide--activity]" />
            </span>
            <div class="ai-agent-activity-bar__copy">
              <strong v-text="activitySummaryLabel"></strong>
              <span>按时间线展示工具、上下文、改动和确认状态</span>
            </div>
          </header>

          <div v-if="toolConfirmation" class="ai-agent-activity-bar__section is-confirmation">
            <AiToolConfirmationCard :confirmation="toolConfirmation" :disabled="isRunActionPending"
              @resolve="emit('resolveToolConfirmation', $event)" />
          </div>

          <div v-if="activityTools.length" class="ai-agent-activity-bar__section" aria-label="最近工具活动">
            <div v-for="tool in activityTools" :key="tool.key" class="ai-agent-activity-tool" :class="`is-${tool.status}`">
              <span class="ai-agent-activity-tool__status" aria-hidden="true"></span>
              <span class="ai-agent-activity-tool__label" v-text="tool.label"></span>
              <code v-if="tool.detail" class="ai-agent-activity-tool__detail" v-text="tool.detail"></code>
            </div>
          </div>

          <div v-if="compactionActivities.length" class="ai-agent-activity-bar__section" aria-label="上下文整理">
            <div v-for="compaction in compactionActivities" :key="compaction.id" class="ai-agent-context-event">
              <span class="icon-[lucide--archive]" aria-hidden="true" />
              <span class="ai-agent-context-event__label" v-text="compaction.label"></span>
              <span class="ai-agent-context-event__detail" v-text="compaction.detail"></span>
            </div>
          </div>

          <div v-if="editedFilesActivities.length" class="ai-agent-activity-bar__section is-edits" aria-label="最近文件改动">
            <AiChangedFilesSummary v-for="edited in editedFilesActivities" :key="edited.id"
              class="ai-agent-activity-edits" :summary="edited.summary" :patches="[]"
              :workspace-root-path="workspaceRootPath"
              :is-reverting="revertingChangedFilesSummaryId === edited.summary.id" variant="message"
              :is-pinning="pinningChangedFilesSummaryId === edited.summary.id"
              @undo="emit('changedFilesRollback', edited.messageId, $event)"
              @pin="(summaryId, pinned) => emit('changedFilesPin', edited.messageId, summaryId, pinned)" />
          </div>

          <AiErrorNotice v-if="errorMessage || latestRunError" class="ai-agent-activity-error"
            :message="errorMessage || latestRunError?.errorMessage || ''" />
        </section>

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

.ai-agent-activity-bar {
  display: grid;
  width: min(100%, 760px);
  gap: 10px;
  align-self: flex-start;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 86%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-soft) 62%, transparent);
  color: var(--text-secondary);
  padding: 12px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--text-primary) 4%, transparent);
}

.ai-agent-activity-bar__header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.ai-agent-activity-bar__icon {
  display: inline-grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent-strong) 10%, transparent);
  color: var(--accent-strong);
}

.ai-agent-activity-bar__icon svg {
  width: 16px;
  height: 16px;
  stroke-width: 2;
}

.ai-agent-activity-bar__copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ai-agent-activity-bar__copy strong {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
}

.ai-agent-activity-bar__copy span {
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 17px;
}

.ai-agent-activity-bar__section {
  display: grid;
  min-width: 0;
  gap: 6px;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 74%, transparent);
  padding-top: 10px;
}

.ai-agent-activity-bar__section.is-confirmation {
  justify-items: start;
}

.ai-agent-activity-bar__section.is-edits {
  gap: 8px;
}

.ai-agent-activity-bar__section.is-confirmation :deep(.ai-tool-confirmation-card) {
  width: min(100%, 520px);
  background: var(--panel-bg);
}

.ai-agent-activity-tool,
.ai-agent-context-event {
  display: grid;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.ai-agent-activity-tool {
  grid-template-columns: 8px auto minmax(0, 1fr);
}

.ai-agent-activity-tool__status {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--text-quaternary);
}

.ai-agent-activity-tool.is-running .ai-agent-activity-tool__status {
  background: var(--accent-strong);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-strong) 12%, transparent);
}

.ai-agent-activity-tool.is-succeeded .ai-agent-activity-tool__status {
  background: var(--success);
}

.ai-agent-activity-tool.is-failed .ai-agent-activity-tool__status {
  background: var(--danger);
}

.ai-agent-activity-tool__label,
.ai-agent-context-event__label {
  color: var(--text-secondary);
  font-weight: 600;
  white-space: nowrap;
}

.ai-agent-activity-tool__detail,
.ai-agent-context-event__detail {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-agent-context-event {
  grid-template-columns: auto auto minmax(0, 1fr);
}

.ai-agent-context-event svg {
  width: 14px;
  height: 14px;
  stroke-width: 1.8;
}

.ai-agent-activity-edits {
  width: min(100%, 640px);
}

.ai-agent-activity-error {
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 74%, transparent);
  padding-top: 10px;
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
