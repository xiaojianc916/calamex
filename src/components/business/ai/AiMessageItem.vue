<script setup lang="ts">
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageToolbar,
} from '@/components/ai-elements/message';
import { AiImageAttachmentPreviewGrid } from '@/components/ai-elements/image';
import AiAgentRuntimeTimeline from '@/components/business/ai/AiAgentRuntimeTimeline.vue';
import AiMarkdown from '@/components/business/ai/AiMarkdown.vue';
import { useMessage } from '@/composables/useMessage';
import type { TAiServicePlatformId } from '@/constants/ai-providers';
import type {
  IAiChatMessage,
  IAiContextReference,
  IAiToolCall,
  TAiChatMessageActionId,
} from '@/types/ai';
import { tryWriteClipboardText } from '@/utils/clipboard';
import { Check, Copy } from 'lucide-vue-next';
import { computed, onBeforeUnmount, ref } from 'vue';
import AiThinkingStatus from './AiThinkingStatus.vue';

const props = defineProps<{
  message: IAiChatMessage;
  platformId: TAiServicePlatformId;
  providerLabel: string;
}>();

const emit = defineEmits<{
  messageAction: [messageId: string, actionId: TAiChatMessageActionId];
}>();

const notifier = useMessage();
const isCopied = ref(false);
let copiedResetTimerId: number | null = null;
const tokenNumberFormatter = new Intl.NumberFormat('zh-CN');

const clearCopiedResetTimer = (): void => {
  if (copiedResetTimerId === null) {
    return;
  }

  window.clearTimeout(copiedResetTimerId);
  copiedResetTimerId = null;
};

const markCopied = (): void => {
  isCopied.value = true;
  clearCopiedResetTimer();
  copiedResetTimerId = window.setTimeout(() => {
    isCopied.value = false;
    copiedResetTimerId = null;
  }, 1600);
};

const hasRenderableContent = computed(() => Boolean(props.message.content.trim()));

const hasToolCalls = computed(() => Boolean(props.message.toolCalls?.length));

const hasRuntimeTimeline = computed(() =>
  Boolean(props.message.stream?.runtimeEvents?.some((event) => event.type !== 'acontext.memory.compressed')),
);

const isAgentRuntimePending = computed(
  () =>
    props.message.role === 'assistant' &&
    props.message.stream?.status === 'streaming' &&
    props.message.stream?.finalAnswerStarted !== true &&
    Array.isArray(props.message.stream?.runtimeEvents),
);

const shouldShowRuntimeTimeline = computed(
  () =>
    props.message.role === 'assistant' && (hasRuntimeTimeline.value || isAgentRuntimePending.value),
);

const hasStreamingRuntimeBeforeFinalAnswer = computed(
  () =>
    props.message.role === 'assistant' &&
    hasRuntimeTimeline.value &&
    props.message.stream?.status === 'streaming' &&
    props.message.stream?.finalAnswerStarted !== true,
);

const canShowRuntimeMessageBubble = computed(
  () =>
    !hasStreamingRuntimeBeforeFinalAnswer.value ||
    props.message.stream?.status !== 'streaming' ||
    props.message.stream?.finalAnswerStarted === true,
);

const hasMessageActions = computed(() => Boolean(props.message.actions?.length));

const isToolProgressContent = computed(() => {
  if (props.message.role !== 'assistant' || !hasToolCalls.value) {
    return false;
  }

  const content = props.message.content.trim();

  return [
    'AI 正在自动分析并按需调用工具…',
    'AI 正在自动使用工具：',
    'AI 已自动完成工具调用：',
  ].some((prefix) => content.startsWith(prefix));
});

const shouldShowMessageBubble = computed(
  () =>
    hasRenderableContent.value && !isToolProgressContent.value && canShowRuntimeMessageBubble.value,
);

const copyableContent = computed(() => {
  if (isToolProgressContent.value || !shouldShowMessageBubble.value) {
    return '';
  }

  return props.message.content;
});

const canCopyContent = computed(() => copyableContent.value.trim().length > 0);

const copyButtonVisibilityMode = computed(() => {
  if (!canCopyContent.value) {
    return 'hidden';
  }

  if (props.message.role === 'user') {
    return 'hover';
  }

  if (props.message.role === 'assistant') {
    return props.message.stream?.status === 'streaming' ? 'hidden' : 'ready';
  }

  return 'hidden';
});

const shouldRenderCopyButton = computed(() => copyButtonVisibilityMode.value !== 'hidden');

const inlineLoaderLabel = computed(
  () => props.message.stream?.activityText?.trim() || '正在准备回复',
);

const streamingCompletionTokens = computed(
  () => props.message.stream?.completionTokens ?? props.message.stream?.usage?.outputTokens ?? 0,
);

const streamTokenProgressLabel = computed(() => {
  const tokens = streamingCompletionTokens.value;

  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '';
  }

  return `约已生成 ${tokenNumberFormatter.format(tokens)} token`;
});

const shouldShowInlineLoader = computed(
  () =>
    props.message.role === 'assistant' &&
    props.message.stream?.status === 'streaming' &&
    (!hasRenderableContent.value || isToolProgressContent.value) &&
    !hasToolCalls.value &&
    !shouldShowRuntimeTimeline.value,
);

const shouldShowThinkingStatus = computed(
  () =>
    props.message.role === 'assistant' &&
    props.message.stream?.status === 'streaming' &&
    props.message.stream?.finalAnswerStarted !== true &&
    (shouldShowInlineLoader.value || hasToolCalls.value),
);

const shouldShowStreamTokenProgress = computed(
  () =>
    props.message.role === 'assistant' &&
    props.message.stream?.status === 'streaming' &&
    streamTokenProgressLabel.value.length > 0,
);

const shouldRenderMessage = computed(
  () =>
    props.message.role === 'user' ||
    hasToolCalls.value ||
    shouldShowMessageBubble.value ||
    shouldShowRuntimeTimeline.value ||
    shouldShowThinkingStatus.value ||
    shouldShowStreamTokenProgress.value ||
    hasMessageActions.value,
);

const userAttachmentReferences = computed(() => {
  if (props.message.role !== 'user') {
    return [];
  }

  return props.message.references.filter(isAttachmentReference);
});

const userAttachmentItems = computed(() =>
  userAttachmentReferences.value.map((reference) => ({
    id: reference.id,
    name: resolveAttachmentLabel(reference),
    preview: reference.attachmentPreview,
    mediaType: reference.attachmentPreview?.mimeType ?? resolveAttachmentMediaType(reference),
  })),
);

function isAttachmentReference(reference: IAiContextReference): boolean {
  return reference.id.startsWith('attachment:');
}

function resolveAttachmentLabel(reference: IAiContextReference): string {
  const path = reference.path?.trim();

  if (path) {
    return path;
  }

  return reference.label
    .replace(/^图片附件\s*·\s*/u, '')
    .replace(/^附件\s*·\s*/u, '')
    .trim();
}

function resolveAttachmentMediaType(reference: IAiContextReference): string {
  if (reference.kind === 'image-attachment') {
    return 'image/*';
  }

  return 'text/plain';
}

const TOOL_CALL_STATUS_LABELS: Readonly<Record<IAiToolCall['status'], string>> = {
  pending: '等待中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  denied: '已拒绝',
};

const getToolCallActionLabel = (toolCall: IAiToolCall): string => {
  const normalizedName = toolCall.name.toLowerCase();

  if (normalizedName.includes('read') || normalizedName.includes('file')) {
    return toolCall.status === 'succeeded' ? '已读取' : '读取';
  }

  if (normalizedName.includes('search') || normalizedName.includes('grep')) {
    return toolCall.status === 'succeeded' ? '已搜索' : '搜索';
  }

  if (
    normalizedName.includes('write') ||
    normalizedName.includes('edit') ||
    normalizedName.includes('patch')
  ) {
    return toolCall.status === 'succeeded' ? '已修改' : '修改';
  }

  if (
    normalizedName.includes('run') ||
    normalizedName.includes('command') ||
    normalizedName.includes('test')
  ) {
    return toolCall.status === 'succeeded' ? '已执行' : '执行';
  }

  return toolCall.status === 'succeeded' ? '已使用' : '使用';
};

const normalizeToolCallSummary = (toolCall: IAiToolCall): string => {
  const summary = toolCall.targetPreview?.trim() || toolCall.summary.trim() || toolCall.name;

  return summary
    .replace(/^正在(?:读取|搜索|执行|修改|使用|运行|验证)\s*[：:]?\s*/u, '')
    .replace(/^已(?:读取|搜索|执行|修改|使用|运行|验证)\s*[：:]?\s*/u, '')
    .trim() || summary;
};

const formatToolCallLabel = (toolCall: IAiToolCall): string =>
  `${getToolCallActionLabel(toolCall)} ${normalizeToolCallSummary(toolCall)}`;

const getToolCallStatusLabel = (toolCall: IAiToolCall): string =>
  TOOL_CALL_STATUS_LABELS[toolCall.status];

const copyMessageContent = async (): Promise<void> => {
  if (!canCopyContent.value) {
    notifier.warning('暂无可复制内容');
    return;
  }

  const copied = await tryWriteClipboardText(copyableContent.value);
  if (copied) {
    markCopied();
    notifier.success('已复制对话内容');
    return;
  }

  notifier.error('当前环境不支持剪贴板写入');
};

onBeforeUnmount(() => {
  clearCopiedResetTimer();
});
</script>

<template>
  <Message
    v-if="shouldRenderMessage"
    :from="message.role"
    class="ai-message"
    :class="[`is-${message.role}`, { 'is-inline-loading': shouldShowInlineLoader }]"
  >
    <div
      v-if="shouldShowThinkingStatus"
      class="ai-message-status-line"
    >
      <AiThinkingStatus :label="inlineLoaderLabel" />
    </div>
    <AiAgentRuntimeTimeline
      v-if="shouldShowRuntimeTimeline"
      :events="message.stream?.runtimeEvents ?? []"
      :is-streaming="message.stream?.status === 'streaming'"
    />
    <div v-if="hasToolCalls" class="ai-tool-call-list" aria-label="工具活动">
      <div
        v-for="toolCall in message.toolCalls"
        :key="toolCall.id"
        class="ai-tool-call"
        :data-status="toolCall.status"
      >
        <span class="ai-tool-call__indicator" aria-hidden="true"></span>
        <span class="ai-tool-call__label">{{ formatToolCallLabel(toolCall) }}</span>
        <span class="ai-tool-call__status">{{ getToolCallStatusLabel(toolCall) }}</span>
      </div>
    </div>
    <AiImageAttachmentPreviewGrid
      v-if="userAttachmentItems.length"
      class="ai-message-image-attachments"
      :items="userAttachmentItems"
      aria-label="已发送附件"
      variant="message"
    />
    <MessageContent
      v-if="shouldShowMessageBubble"
      class="ai-message-bubble"
      :class="{ 'is-assistant-flat': message.role !== 'user' }"
    >
      <AiMarkdown
        :message-id="message.id"
        :content="message.content"
        :stream-status="message.stream?.status"
      />
    </MessageContent>
    <div v-if="shouldShowStreamTokenProgress" class="ai-message-token-progress" aria-live="polite">
      {{ streamTokenProgressLabel }}
    </div>
    <MessageActions v-if="hasMessageActions" class="ai-message-options" aria-label="AI 选项">
      <MessageAction
        v-for="action in message.actions"
        :key="`${message.id}:${action.id}`"
        class="ai-message-option-button"
        :disabled="action.disabled"
        :label="action.label"
        size="sm"
        :tooltip="action.label"
        variant="outline"
        @click.stop="emit('messageAction', message.id, action.id)"
      >
        {{ action.label }}
      </MessageAction>
    </MessageActions>
    <MessageToolbar
      v-if="shouldRenderCopyButton"
      class="ai-message-toolbar"
      :class="[`is-copy-mode-${copyButtonVisibilityMode}`]"
    >
      <MessageActions class="ai-message-actions">
        <MessageAction
          class="ai-message-copy-button"
          :class="{ 'is-copied': isCopied }"
          :label="isCopied ? '已复制对话内容' : '复制对话内容'"
          @click.stop="copyMessageContent"
        >
          <Check v-if="isCopied" aria-hidden="true" />
          <Copy v-else aria-hidden="true" />
        </MessageAction>
      </MessageActions>
    </MessageToolbar>
  </Message>
</template>

<style scoped>
.ai-message {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.ai-message.is-assistant {
  width: 100%;
  max-width: 100%;
  padding-left: 12px;
  padding-right: 88px;
}

.ai-message.is-user {
  align-items: flex-end;
}

.ai-message.is-inline-loading {
  justify-content: center;
}

.ai-message.is-assistant > .ai-runtime-timeline {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow-x: hidden;
}

.ai-message.is-assistant > :not(.ai-runtime-timeline) {
  min-width: 0;
  max-width: 100%;
}

.ai-tool-call-list {
  display: grid;
  width: min(100%, 520px);
  gap: 6px;
}

.ai-tool-call {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--panel-bg) 86%, transparent);
  padding: 6px 8px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
}

.ai-tool-call__indicator {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--text-quaternary);
}

.ai-tool-call[data-status='running'] .ai-tool-call__indicator,
.ai-tool-call[data-status='pending'] .ai-tool-call__indicator {
  background: var(--accent-strong);
}

.ai-tool-call[data-status='succeeded'] .ai-tool-call__indicator {
  background: var(--success);
}

.ai-tool-call[data-status='failed'] .ai-tool-call__indicator,
.ai-tool-call[data-status='denied'] .ai-tool-call__indicator {
  background: var(--danger);
}

.ai-tool-call__label {
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-tool-call__status {
  color: var(--text-quaternary);
  font-size: 11px;
}

.ai-message > .ai-runtime-timeline + .ai-message-bubble,
.ai-message > .ai-message-status-line + .ai-message-bubble {
  margin-top: 6px;
}

.ai-message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 6px;
}

.ai-message-image-attachments {
  max-width: min(520px, 100%);
  padding-bottom: 4px;
}

.ai-message.is-user .ai-message-attachments {
  justify-content: flex-end;
}

.ai-message-attachment-chip {
  display: inline-flex;
  max-width: 100%;
  min-width: 0;
  align-items: center;
  gap: 5px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 999px;
  background: var(--secondary);
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 22px;
  padding: 0 10px;
}

.ai-message-attachment-chip svg {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-message-attachment-chip span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-message-bubble {
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
  min-width: 0;
  color: inherit;
  font-size: var(--ai-chat-font-size-body);
  line-height: var(--ai-chat-line-height-body);
  overflow: hidden;
  overflow-wrap: anywhere;
}

.ai-message.is-assistant .ai-message-bubble {
  max-width: min(680px, 100%);
  color: var(--text-primary);
  font-size: var(--ai-chat-font-size-body);
  line-height: var(--ai-chat-line-height-body);
}

.ai-message.is-assistant .ai-message-bubble.is-assistant-flat {
  color: var(--text-primary);
}

.ai-message-status-line {
  display: inline-flex;
  min-width: 0;
  justify-content: flex-start;
}

.ai-message-token-progress {
  color: var(--text-quaternary);
  font-size: 12px;
  line-height: 18px;
}

.ai-message.is-user .ai-message-attachment-chip {
  border-color: color-mix(in srgb, var(--secondary-foreground) 10%, transparent);
  background: #f4f4f5;
  color: var(--secondary-foreground);
}

.ai-message.is-user .ai-message-bubble {
  background: #f4f4f5;
}

.ai-message-toolbar {
  width: auto;
  margin-top: 0;
  gap: 0;
}

.ai-message-actions {
  display: flex;
  min-height: 18px;
  justify-content: flex-start;
  padding-top: 3px;
}

.ai-message-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 10px;
}

.ai-message-option-button {
  border: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--foreground) 3%, var(--background));
  color: color-mix(in srgb, var(--foreground) 78%, transparent);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  padding: 10px 14px;
  transition:
    transform 160ms ease-out,
    border-color 160ms ease-out,
    background-color 160ms ease-out;
}

.ai-message-option-button:active {
  transform: scale(0.97);
}

.ai-message-option-button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
  transform: none;
}

.ai-message.is-user .ai-message-actions {
  justify-content: flex-end;
}

.ai-message-copy-button {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text-quaternary);
  opacity: 0;
  padding: 0;
  pointer-events: none;
  transform: translateY(-1px);
  transition:
    opacity 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-message-toolbar.is-copy-mode-ready .ai-message-copy-button {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.ai-message.is-user:hover .ai-message-copy-button,
.ai-message.is-user:focus-within .ai-message-copy-button {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.ai-message-copy-button:hover {
  background: transparent;
  color: var(--text-primary);
}

.ai-message-copy-button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 60%, transparent);
  outline-offset: 2px;
}

.ai-message-copy-button svg {
  width: 15px;
  height: 15px;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.ai-message.is-user .ai-message-copy-button {
  color: var(--text-quaternary);
}

.ai-message.is-user .ai-message-copy-button:hover {
  color: var(--text-primary);
}

.ai-message.is-user .ai-message-copy-button.is-copied {
  opacity: 0;
  pointer-events: none;
  transform: translateY(-1px);
}

.ai-message.is-user:hover .ai-message-copy-button.is-copied,
.ai-message.is-user:focus-within .ai-message-copy-button.is-copied {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.ai-message-copy-button.is-copied {
  background: transparent;
  color: var(--text-quaternary);
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

</style>
