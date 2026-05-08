import { computed, ref, shallowRef, unref, watch, type Ref } from 'vue';

import { useAiAgentPlan } from '@/composables/useAiAgentPlan';
import { useAiStream } from '@/composables/useAiStream';
import { useSidecarChangedDocumentRefresh } from '@/composables/useSidecarChangedDocumentRefresh';
import { DEFAULT_LITELLM_MODEL_ID } from '@/constants/ai-providers';
import { aiService } from '@/services/modules/ai';
import {
  buildActiveRunReference,
  buildCurrentFileReference,
  buildDiagnosticsReference,
  buildGitDiffReference,
  buildSelectionReference,
} from '@/services/modules/ai-context';
import { aiEditService } from '@/services/modules/ai-edit';
import { useAiConversationStore } from '@/store/aiConversation';
import {
  extractVisibleAgentRuntimeEvents,
  projectSidecarEventsToToolState,
  projectSidecarExecuteResponse,
} from '@/utils/agent-sidecar-events';
import { createDefaultAiConfigPayload } from '@/utils/ai-config';

import type {
  IAgentCheckpointEvent,
  IAgentSidecarMessage,
  TAgentRuntimeEvent,
  TAgentUiEvent,
} from '@/types/agent-sidecar';
import type {
  IAiApplyPatchMetadata,
  IAiChatMessage,
  IAiChatStreamEventPayload,
  IAiConfigPayload,
  IAiContextReference,
  IAiPatchSet,
  IAiProviderConnectionRequest,
  IAiProviderProfileDetailPayload,
  IAiProviderProfilePayload,
  IAiToolDefinitionPayload,
  TAiModelRole,
  TAiToolConfirmationDecision,
} from '@/types/ai';
import type { IAiEditOperation, IAiEditTimelineEntry } from '@/types/ai-edit';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';

import { toErrorMessage } from '@/utils/error';
import { logger } from '@/utils/logger';
import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type TAiQuickActionId = 'explain' | 'fix' | 'review';

type TAiAssistantMode = 'chat' | 'agent' | 'plan';

type TAiAttachmentKind = 'text' | 'image';

type TAiFileRollbackStatus = 'ready' | 'reverting' | 'reverted';

type TAgentExecutionStepStatus =
  | 'pending'
  | 'running'
  | 'failed'
  | 'cancelled'
  | 'done'
  | 'skipped';

interface IAiImageDimensions {
  width: number;
  height: number;
}

interface ISidecarAgentSession {
  sessionId: string;
  assistantMessageId: string;
  turnId: string | null;
  baseMessages: IAiChatMessage[];
  messageContent: string;
  references: IAiContextReference[];
}

interface IAgentExecutionStep {
  id: string;
  title: string;
  status: TAgentExecutionStepStatus;
}

interface IActiveAgentPatchTarget {
  runId: string;
  stepId: string;
}

export interface IAiAttachedFile {
  id: string;
  name: string;
  sizeLabel: string;
  kind: TAiAttachmentKind;
  detailLabel?: string;
  reference: IAiContextReference;
}

export interface IAiQuickAction {
  id: TAiQuickActionId;
  label: string;
}

export interface IAiFileRollbackPrompt {
  operationId: string;
  fileCount: number;
  status: TAiFileRollbackStatus;
  updatedAt: string;
  restoredFileCount?: number;
}

export interface IAiConversationCheckpoint {
  id: string;
  messageId: string;
  runId: string;
  snapshotId: string;
  sessionId: string;
  createdAt: string;
}

export interface IUseAiAssistantOptions {
  document: Ref<IEditorDocument>;
  activeRun: Ref<IActiveRunSummary | null>;
  analysis: Ref<IAnalyzeScriptPayload>;
  selection: Ref<IEditorSelectionSummary | null>;
  gitStatus: Ref<IGitRepositoryStatusPayload>;
  workspaceRootPath: Ref<string | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONTEXT_CHARS = 12_000;
const MAX_TEXT_ATTACHMENT_BYTES = 128 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const AI_EDIT_ROLLBACK_TIMELINE_LIMIT = 24;
const AGENT_RUNTIME_TIMELINE_LIMIT = 32;
const SIDECAR_MESSAGE_DELTA_PHASE_FALLBACK = 'stage';

const TEXT_ATTACHMENT_PATTERN =
  /^(application\/(json|xml|x-sh|x-shellscript|javascript|typescript)|text\/)/i;

const TEXT_ATTACHMENT_EXTENSION_PATTERN =
  /\.(bash|cjs|conf|css|csv|env|js|json|jsx|log|md|mjs|ps1|py|rs|sh|sql|toml|ts|tsx|txt|vue|xml|yaml|yml|zsh)$/i;

const IMAGE_ATTACHMENT_PATTERN = /^image\//i;

const IMAGE_ATTACHMENT_EXTENSION_PATTERN =
  /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

const CONTEXT_TOKEN_PATTERN =
  /(^|\s)@(file|current-file|selection|terminal|log|diagnostics|shellcheck|git-diff|git|project|folder|search|symbol)(?=\s|$)/gi;

const CODE_BLOCK_PATTERN = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/;

const PROJECT_SEARCH_TOKENS = ['project', 'folder', 'search', 'symbol'] as const;

const MSG_STREAM_ERROR = 'AI 响应出错';
const MSG_CALL_FAILED = 'AI 调用失败';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const createScopedId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createMessageId = (role: IAiChatMessage['role']): string => createScopedId(role);

const buildInitialAgentActivityText = (): string =>
  '';

const getRuntimeReasoningOverlapLength = (previous: string, incoming: string): number => {
  const maxLength = Math.min(previous.length, incoming.length);

  for (let length = maxLength; length > 0; length -= 1) {
    if (previous.slice(-length) === incoming.slice(0, length)) {
      return length;
    }
  }

  return 0;
};

const mergeRuntimeReasoningText = (previous: string, incoming: string): string => {
  if (!previous) {
    return incoming;
  }

  if (!incoming || previous.startsWith(incoming)) {
    return previous;
  }

  if (incoming.startsWith(previous)) {
    return incoming;
  }

  const overlapLength = getRuntimeReasoningOverlapLength(previous, incoming);

  return previous + incoming.slice(overlapLength);
};

const compactRuntimeEvents = (
  events: readonly TAgentRuntimeEvent[],
): TAgentRuntimeEvent[] => {
  const compacted: TAgentRuntimeEvent[] = [];

  for (const event of events) {
    if (event.type === 'agent.text.delta') {
      continue;
    }

    const previous = compacted.at(-1);
    if (previous?.type === 'agent.reasoning.delta' && event.type === 'agent.reasoning.delta') {
      compacted[compacted.length - 1] = {
        ...previous,
        text: mergeRuntimeReasoningText(previous.text, event.text),
        timestamp: event.timestamp,
        seq: event.seq,
      };
      continue;
    }

    compacted.push(event);
  }

  return compacted.slice(-AGENT_RUNTIME_TIMELINE_LIMIT);
};

const mergeRuntimeEvents = (
  currentEvents: readonly TAgentRuntimeEvent[] | undefined,
  incomingEvents: readonly TAgentRuntimeEvent[] | undefined,
): TAgentRuntimeEvent[] | undefined => {
  const nextEvents = [...(currentEvents ?? [])];

  if (!incomingEvents?.length) {
    const compactedEvents = compactRuntimeEvents(nextEvents);

    return compactedEvents.length ? compactedEvents : undefined;
  }

  const seenIds = new Set(nextEvents.map((event) => event.id));

  for (const event of incomingEvents) {
    if (seenIds.has(event.id)) {
      continue;
    }

    seenIds.add(event.id);
    nextEvents.push(event);
  }

  const compactedEvents = compactRuntimeEvents(nextEvents);

  return compactedEvents.length ? compactedEvents : undefined;
};

const isCheckpointCreatedRuntimeEvent = (
  event: TAgentRuntimeEvent,
): event is IAgentCheckpointEvent =>
  event.type === 'rollback.checkpoint.created';

const buildConversationCheckpoints = (
  currentMessages: readonly IAiChatMessage[],
): IAiConversationCheckpoint[] => {
  const checkpoints: IAiConversationCheckpoint[] = [];

  currentMessages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant' || messageIndex >= currentMessages.length - 1) {
      return;
    }

    const runtimeEvents = message.stream?.runtimeEvents ?? [];

    for (let eventIndex = runtimeEvents.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = runtimeEvents[eventIndex];

      if (!event || !isCheckpointCreatedRuntimeEvent(event)) {
        continue;
      }

      checkpoints.push({
        id: event.id,
        messageId: message.id,
        runId: event.runId,
        snapshotId: event.snapshotId?.trim() || event.runId,
        sessionId: event.sessionId,
        createdAt: event.timestamp,
      });
      break;
    }
  });

  return checkpoints;
};

const collectConversationRuntimeEvents = (
  currentMessages: readonly IAiChatMessage[],
): TAgentRuntimeEvent[] => {
  let collectedEvents: TAgentRuntimeEvent[] | undefined;

  for (const message of currentMessages) {
    collectedEvents = mergeRuntimeEvents(collectedEvents, message.stream?.runtimeEvents);
  }

  return collectedEvents ?? [];
};

const normalizePatchDisplayPath = (path: string): string => {
  const normalized = normalizeFileSystemPath(path, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
    foldWindowsCase: false,
  });

  return normalized || path;
};

const materializePatchedContent = (patchFile: IAiPatchSet['files'][number]): string | null => {
  const output: string[] = [];

  for (const hunk of patchFile.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+') || line.startsWith(' ')) {
        output.push(line.slice(1));
        continue;
      }

      if (line.startsWith('-')) {
        continue;
      }

      return null;
    }
  }

  return output.join('\n');
};

const countDocumentLines = (content: string): number => {
  if (!content.length) {
    return 1;
  }

  return content.split('\n').length;
};

const syncPatchedDocument = (
  document: IEditorDocument,
  patch: IAiPatchSet,
  appliedPaths: string[],
): void => {
  if (!document.path || document.kind !== 'text') {
    return;
  }

  const patchFile = patch.files.find((file) => areFileSystemPathsEqual(file.path, document.path));

  if (!patchFile) {
    return;
  }

  const wasApplied = appliedPaths.some((path) => areFileSystemPathsEqual(path, patchFile.path));

  if (!wasApplied) {
    return;
  }

  const nextContent = materializePatchedContent(patchFile);

  if (nextContent === null) {
    return;
  }

  document.path = normalizePatchDisplayPath(patchFile.path);
  document.content = nextContent;
  document.savedContent = nextContent;
  document.isDirty = false;
  document.lineCount = countDocumentLines(nextContent);
  document.charCount = [...nextContent].length;
};

const clipText = (value: string, limit: number): string => {
  const chars = [...value];

  if (chars.length <= limit) {
    return value;
  }

  return `${chars.slice(0, limit).join('')}\n\n[内容已截断，仅发送前 ${limit} 个字符]`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const isTextAttachment = (file: File): boolean =>
  TEXT_ATTACHMENT_PATTERN.test(file.type) || TEXT_ATTACHMENT_EXTENSION_PATTERN.test(file.name);

const isImageAttachment = (file: File): boolean =>
  IMAGE_ATTACHMENT_PATTERN.test(file.type) || IMAGE_ATTACHMENT_EXTENSION_PATTERN.test(file.name);

const inferImageExtension = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase();

  if (normalized === 'image/jpeg') {
    return 'jpg';
  }

  if (normalized === 'image/svg+xml') {
    return 'svg';
  }

  if (normalized.startsWith('image/')) {
    return normalized.slice('image/'.length);
  }

  return 'png';
};

const normalizeAttachmentName = (file: File): string => {
  const normalizedName = file.name.trim();

  if (normalizedName) {
    return normalizedName;
  }

  if (isImageAttachment(file)) {
    return `pasted-image.${inferImageExtension(file.type)}`;
  }

  return 'pasted-attachment.txt';
};

const formatImageDimensions = (dimensions: IAiImageDimensions | null): string | null => {
  if (!dimensions) {
    return null;
  }

  return `${dimensions.width} × ${dimensions.height}`;
};

const readImageDimensions = async (file: File): Promise<IAiImageDimensions | null> => {
  if (typeof globalThis.createImageBitmap !== 'function') {
    return null;
  }

  try {
    const bitmap = await globalThis.createImageBitmap(file);

    const dimensions = {
      width: bitmap.width,
      height: bitmap.height,
    };

    bitmap.close?.();

    return dimensions;
  } catch {
    return null;
  }
};

const mapStreamStatus = (
  status: ReturnType<typeof useAiStream>['status']['value'],
): NonNullable<IAiChatMessage['stream']>['status'] => {
  if (status === 'cancelled') {
    return 'cancelled';
  }

  if (status === 'completed') {
    return 'completed';
  }

  return 'streaming';
};

const hasMeaningfulAssistantText = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isAiEditOperationEntry = (
  entry: IAiEditTimelineEntry,
): entry is IAiEditTimelineEntry & { type: 'operation'; data: IAiEditOperation } =>
  entry.type === 'operation';

const getOperationAppliedTime = (operation: IAiEditOperation): number => {
  const timestamp = Date.parse(operation.appliedAt);

  return Number.isFinite(timestamp) ? timestamp : 0;
};


interface ILatestSidecarLiveEvents {
  errorEvent: Extract<TAgentUiEvent, { type: 'error' }> | null;
  doneEvent: Extract<TAgentUiEvent, { type: 'done' }> | null;
  messageEvent: Extract<TAgentUiEvent, { type: 'message_delta' }> | null;
  finalMessageEvent: Extract<TAgentUiEvent, { type: 'message_delta' }> | null;
}

type TUiFlushHandle =
  | { kind: 'raf'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

interface ISidecarLiveEventBuffer {
  readonly events: readonly TAgentUiEvent[];
  push: (event: TAgentUiEvent) => void;
  flush: () => void;
  dispose: () => void;
}

interface ISidecarAnswerStreamMetadata {
  messageId: string;
  toolCalls: IAiChatMessage['toolCalls'];
  streamStatus: NonNullable<IAiChatMessage['stream']>['status'];
  activityText: string | undefined;
  runtimeEvents: NonNullable<IAiChatMessage['stream']>['runtimeEvents'] | undefined;
  finalAnswerStarted: boolean | undefined;
}

interface ISidecarAnswerStreamState extends ISidecarAnswerStreamMetadata {
  sourceText: string;
}

const getLatestSidecarLiveEvents = (
  events: readonly TAgentUiEvent[],
): ILatestSidecarLiveEvents => {
  const latest: ILatestSidecarLiveEvents = {
    errorEvent: null,
    doneEvent: null,
    messageEvent: null,
    finalMessageEvent: null,
  };

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (!event) {
      continue;
    }

    if (!latest.errorEvent && event.type === 'error') {
      latest.errorEvent = event;
    }

    if (!latest.doneEvent && event.type === 'done') {
      latest.doneEvent = event;
    }

    if (event.type === 'message_delta') {
      if (!latest.messageEvent) {
        latest.messageEvent = event;
      }

      if (!latest.finalMessageEvent && event.phase === 'final') {
        latest.finalMessageEvent = event;
      }
    }

    if (
      latest.errorEvent
      && latest.doneEvent
      && latest.messageEvent
      && latest.finalMessageEvent
    ) {
      break;
    }
  }

  return latest;
};

const processedRuntimeEventCountsByEvents = new WeakMap<readonly TAgentUiEvent[], number>();

const scheduleUiFlush = (flush: () => void): TUiFlushHandle => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return {
      kind: 'raf',
      id: globalThis.requestAnimationFrame(() => {
        flush();
      }),
    };
  }

  return {
    kind: 'timeout',
    id: setTimeout(flush, 0),
  };
};

const cancelUiFlush = (handle: TUiFlushHandle | null): void => {
  if (!handle) {
    return;
  }

  if (handle.kind === 'raf') {
    globalThis.cancelAnimationFrame?.(handle.id);
    return;
  }

  clearTimeout(handle.id);
};

const createSidecarLiveEventBuffer = (
  onFlush: (events: readonly TAgentUiEvent[], freshEvents: readonly TAgentUiEvent[]) => void,
): ISidecarLiveEventBuffer => {
  const events: TAgentUiEvent[] = [];
  const messageDeltaIndexes = new Map<string, number>();
  let pendingEvents: TAgentUiEvent[] = [];
  let scheduledFlush: TUiFlushHandle | null = null;
  let isFlushScheduled = false;

  const retainEvent = (event: TAgentUiEvent): void => {
    if (event.type !== 'message_delta') {
      events.push(event);
      return;
    }

    const phase = event.phase ?? SIDECAR_MESSAGE_DELTA_PHASE_FALLBACK;
    const existingIndex = messageDeltaIndexes.get(phase);

    if (existingIndex !== undefined && events[existingIndex]?.type === 'message_delta') {
      events[existingIndex] = event;
      return;
    }

    messageDeltaIndexes.set(phase, events.length);
    events.push(event);
  };

  const flush = (): void => {
    scheduledFlush = null;
    isFlushScheduled = false;

    if (pendingEvents.length === 0) {
      return;
    }

    const freshEvents = pendingEvents;
    pendingEvents = [];
    freshEvents.forEach(retainEvent);
    onFlush(events, freshEvents);
  };

  return {
    get events() {
      return events;
    },
    push: (event) => {
      if (event.type === 'message_delta') {
        pendingEvents.push(event);
        cancelUiFlush(scheduledFlush);
        scheduledFlush = null;
        isFlushScheduled = false;
        flush();
        return;
      }

      pendingEvents.push(event);

      if (isFlushScheduled) {
        return;
      }

      isFlushScheduled = true;
      scheduledFlush = scheduleUiFlush(flush);

      if (!isFlushScheduled) {
        scheduledFlush = null;
      }
    },
    flush,
    dispose: () => {
      cancelUiFlush(scheduledFlush);
      scheduledFlush = null;
      isFlushScheduled = false;
      pendingEvents = [];
      events.length = 0;
      messageDeltaIndexes.clear();
    },
  };
};

const extractNewVisibleRuntimeEvents = (
  events: readonly TAgentUiEvent[],
): TAgentRuntimeEvent[] | undefined => {
  if (events.length === 0) {
    return undefined;
  }

  const previousCount = processedRuntimeEventCountsByEvents.get(events) ?? 0;
  const startIndex = Math.min(previousCount, events.length);

  processedRuntimeEventCountsByEvents.set(events, events.length);

  if (startIndex >= events.length) {
    return undefined;
  }

  const visibleEvents = extractVisibleAgentRuntimeEvents(events.slice(startIndex));

  return visibleEvents.length ? visibleEvents : undefined;
};

// ---------------------------------------------------------------------------
// Public quick actions
// ---------------------------------------------------------------------------

export const AI_QUICK_ACTIONS: IAiQuickAction[] = [
  { id: 'explain', label: '解释当前脚本' },
  { id: 'fix', label: '修复报错' },
  { id: 'review', label: '代码审查' },
];

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export const useAiAssistant = (options: IUseAiAssistantOptions) => {
  const conversationStore = useAiConversationStore();

  const config = ref<IAiConfigPayload>(createDefaultAiConfigPayload());
  const draft = ref('');
  const isSending = ref(false);
  const errorMessage = ref('');
  const isSettingsOpen = ref(false);
  const isClearDialogOpen = ref(false);
  const currentReferences = ref<IAiContextReference[]>([]);
  const proposedPatch = ref<IAiPatchSet | null>(null);
  const isApplyingPatch = ref(false);
  const fileRollbackPrompt = ref<IAiFileRollbackPrompt | null>(null);
  const runtimeTimelineEvents = shallowRef<TAgentRuntimeEvent[]>([]);
  const activeMode = ref<TAiAssistantMode>('agent');
  const agentSteps = shallowRef<IAgentExecutionStep[]>([]);
  const toolDefinitions = shallowRef<IAiToolDefinitionPayload[]>([]);
  const providerProfiles = shallowRef<IAiProviderProfilePayload[]>([]);
  const attachedFiles = shallowRef<IAiAttachedFile[]>([]);
  const restoringCheckpointId = ref<string | null>(null);
  const activeAbortController = ref<AbortController | null>(null);
  const activeStreamId = ref<string | null>(null);
  const activeAgentMessageId = ref<string | null>(null);
  const activeStreamResolve = ref<(() => void) | null>(null);
  const activeAssistantMessage = ref<IAiChatMessage | null>(null);
  const activeAssistantBaseMessages = shallowRef<IAiChatMessage[]>([]);
  const activeSidecarAgentSession = ref<ISidecarAgentSession | null>(null);
  const displayMessages = shallowRef<IAiChatMessage[]>(unref(conversationStore.activeMessages));
  const pendingTitleThreadIds = new Set<string>();

  const isConversationWriteBuffered = (): boolean =>
    isSending.value ||
    activeStreamId.value !== null ||
    activeAgentMessageId.value !== null ||
    activeAssistantMessage.value !== null ||
    activeSidecarAgentSession.value !== null ||
    restoringCheckpointId.value !== null;

  const commitDisplayMessagesToStore = (): void => {
    conversationStore.replaceMessages(displayMessages.value);
  };

  const messages = computed<IAiChatMessage[]>({
    get: () => displayMessages.value,
    set: (nextMessages: IAiChatMessage[]) => {
      displayMessages.value = nextMessages;

      if (!isConversationWriteBuffered()) {
        commitDisplayMessagesToStore();
      }
    },
  });

  watch(
    () => unref(conversationStore.activeMessages),
    (nextMessages) => {
      if (isConversationWriteBuffered()) {
        return;
      }

      displayMessages.value = nextMessages;
    },
    { flush: 'sync' },
  );

  const historyThreads = computed(() => unref(conversationStore.historyThreads));
  const activeConversationId = computed(() => unref(conversationStore.activeThreadId));
  const conversationCheckpoints = computed<IAiConversationCheckpoint[]>(() =>
    buildConversationCheckpoints(messages.value),
  );

  const aiStream = useAiStream();
  const sidecarAnswerStream = useAiStream();
  const agentPlan = useAiAgentPlan();
  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();
  let sidecarAnswerStreamState: ISidecarAnswerStreamState | null = null;
  let isSidecarAnswerStreamSyncSuppressed = false;

  const syncActiveAssistantMessage = (): void => {
    const current = activeAssistantMessage.value;

    if (!current) {
      return;
    }

    current.content = aiStream.content.value;
    current.stream = {
      status: mapStreamStatus(aiStream.status.value),
    };

    messages.value = [
      ...activeAssistantBaseMessages.value,
      { ...current },
    ];
  };

  watch(
    () => [aiStream.content.value, aiStream.status.value] as const,
    () => {
      syncActiveAssistantMessage();
    },
    { flush: 'sync' },
  );

  const maybeGenerateConversationTitle = async (threadId: string | null): Promise<void> => {
    if (!threadId || pendingTitleThreadIds.has(threadId)) {
      return;
    }

    const titleStatus = conversationStore.getThreadTitleStatus(threadId);

    if (titleStatus !== 'temporary') {
      return;
    }

    const firstRound = conversationStore.getFirstRoundForTitle(threadId);

    if (!firstRound) {
      return;
    }

    pendingTitleThreadIds.add(threadId);
    conversationStore.markThreadTitleGenerating(threadId);

    try {
      const payload = await aiService.generateConversationTitle(firstRound);
      conversationStore.completeThreadTitleGeneration(threadId, payload.title);
    } catch (error) {
      conversationStore.failThreadTitleGeneration(threadId);
      logger.warn({
        event: 'ai.conversation_title.failed',
        err: error,
        threadId,
      });
    } finally {
      pendingTitleThreadIds.delete(threadId);
    }
  };

  const resolveActiveAgentPatchTarget = (): IActiveAgentPatchTarget | null => {
    const activeRun = unref(agentPlan.store.activeRun);

    if (!activeRun) {
      return null;
    }

    if (activeRun.currentStepId) {
      return {
        runId: activeRun.id,
        stepId: activeRun.currentStepId,
      };
    }

    const activeStep = activeRun.steps.find((step) => step.status === 'running' || step.isActive);

    if (!activeStep) {
      return null;
    }

    return {
      runId: activeRun.id,
      stepId: activeStep.id,
    };
  };

  const buildActiveAgentPatchMetadata = (): Pick<
    IAiApplyPatchMetadata,
    'agentRunId' | 'agentStepId'
  > | null => {
    const target = resolveActiveAgentPatchTarget();

    if (!target) {
      return null;
    }

    return {
      agentRunId: target.runId,
      agentStepId: target.stepId,
    };
  };

  const findMessageIndexById = (
    currentMessages: readonly IAiChatMessage[],
    messageId: string,
  ): number => {
    const lastIndex = currentMessages.length - 1;

    if (lastIndex >= 0 && currentMessages[lastIndex]?.id === messageId) {
      return lastIndex;
    }

    return currentMessages.findIndex((message) => message.id === messageId);
  };

  const findMessageById = (
    messageId: string,
  ): IAiChatMessage | null => {
    const currentMessages = messages.value;
    const messageIndex = findMessageIndexById(currentMessages, messageId);

    return messageIndex >= 0 ? currentMessages[messageIndex] ?? null : null;
  };

  const replaceMessageById = (
    messageId: string,
    updater: (message: IAiChatMessage) => IAiChatMessage,
  ): IAiChatMessage[] => {
    const currentMessages = messages.value;
    const messageIndex = findMessageIndexById(currentMessages, messageId);

    if (messageIndex < 0) {
      return currentMessages;
    }

    const currentMessage = currentMessages[messageIndex]!;
    const nextMessage = updater(currentMessage);

    if (nextMessage === currentMessage) {
      return currentMessages;
    }

    const nextMessages = currentMessages.slice();
    nextMessages[messageIndex] = nextMessage;

    messages.value = nextMessages;

    return nextMessages;
  };

  const appendRuntimeEventsToMessage = (
    messageId: string,
    incomingRuntimeEvents: readonly TAgentRuntimeEvent[] | undefined,
  ): void => {
    if (!incomingRuntimeEvents?.length) {
      return;
    }

    replaceMessageById(messageId, (message) => {
      const nextRuntimeEvents = mergeRuntimeEvents(
        message.stream?.runtimeEvents,
        incomingRuntimeEvents,
      );

      if (!nextRuntimeEvents?.length) {
        return message;
      }

      return {
        ...message,
        stream: {
          status: message.stream?.status ?? 'completed',
          ...(message.stream?.activityText ? { activityText: message.stream.activityText } : {}),
          runtimeEvents: nextRuntimeEvents,
          ...(message.stream?.finalAnswerStarted ? { finalAnswerStarted: true } : {}),
        },
      };
    });
  };

  const updateAgentStep = (
    stepId: string,
    title: string,
    status: TAgentExecutionStepStatus,
  ): void => {
    const currentSteps = agentSteps.value;
    const stepIndex = currentSteps.findIndex((step) => step.id === stepId);

    if (stepIndex >= 0) {
      const currentStep = currentSteps[stepIndex]!;

      if (currentStep.title === title && currentStep.status === status) {
        return;
      }

      const nextSteps = currentSteps.slice();
      nextSteps[stepIndex] = {
        ...currentStep,
        title,
        status,
      };

      agentSteps.value = nextSteps;
      return;
    }

    agentSteps.value = [
      ...currentSteps,
      {
        id: stepId,
        title,
        status,
      },
    ];
  };


  const updateAgentExecutionMessage = (
    messageId: string,
    content: string,
    toolCalls: IAiChatMessage['toolCalls'] = [],
    streamStatus?: NonNullable<IAiChatMessage['stream']>['status'],
    activityText?: string,
    runtimeEvents?: NonNullable<IAiChatMessage['stream']>['runtimeEvents'],
    finalAnswerStarted?: boolean,
  ): void => {
    replaceMessageById(messageId, (message) => {
      const nextActivityText = activityText ?? message.stream?.activityText;
      const nextRuntimeEvents = mergeRuntimeEvents(
        message.stream?.runtimeEvents,
        runtimeEvents,
      );
      const nextFinalAnswerStarted = finalAnswerStarted
        ?? message.stream?.finalAnswerStarted
        ?? (streamStatus === 'completed' && hasMeaningfulAssistantText(content));
      const stream = streamStatus
        ? nextActivityText
          ? {
            status: streamStatus,
            activityText: nextActivityText,
            ...(nextRuntimeEvents?.length ? { runtimeEvents: nextRuntimeEvents } : {}),
            ...(nextFinalAnswerStarted ? { finalAnswerStarted: true } : {}),
          }
          : {
            status: streamStatus,
            ...(nextRuntimeEvents?.length ? { runtimeEvents: nextRuntimeEvents } : {}),
            ...(nextFinalAnswerStarted ? { finalAnswerStarted: true } : {}),
          }
        : message.stream;

      return {
        ...message,
        content,
        toolCalls,
        stream,
      };
    });
  };

  const assignSidecarAnswerStreamMetadata = (
    state: ISidecarAnswerStreamState,
    metadata: ISidecarAnswerStreamMetadata,
  ): void => {
    state.messageId = metadata.messageId;
    state.toolCalls = metadata.toolCalls;
    state.streamStatus = metadata.streamStatus;
    state.activityText = metadata.activityText;
    state.runtimeEvents = metadata.runtimeEvents;
    state.finalAnswerStarted = metadata.finalAnswerStarted;
  };

  const resolveSidecarAnswerDisplayStatus = (
    metadata: ISidecarAnswerStreamMetadata,
  ): NonNullable<IAiChatMessage['stream']>['status'] => {
    const hasActiveSource = sidecarAnswerStreamState?.messageId === metadata.messageId
      && sidecarAnswerStreamState.sourceText.length > 0;

    return metadata.streamStatus === 'completed'
      && hasActiveSource
      && sidecarAnswerStream.status.value !== 'completed'
      ? 'streaming'
      : metadata.streamStatus;
  };

  const syncSidecarAnswerStreamMessage = (): void => {
    if (isSidecarAnswerStreamSyncSuppressed) {
      return;
    }

    const state = sidecarAnswerStreamState;

    if (!state) {
      return;
    }

    updateAgentExecutionMessage(
      state.messageId,
      sidecarAnswerStream.content.value,
      state.toolCalls,
      resolveSidecarAnswerDisplayStatus(state),
      state.activityText,
      state.runtimeEvents,
      state.finalAnswerStarted,
    );
    state.runtimeEvents = undefined;

    if (state.streamStatus === 'completed' && sidecarAnswerStream.status.value === 'completed') {
      sidecarAnswerStreamState = null;
    }
  };

  const runWithSuppressedSidecarAnswerSync = <T>(runner: () => T): T => {
    const wasSuppressed = isSidecarAnswerStreamSyncSuppressed;
    isSidecarAnswerStreamSyncSuppressed = true;

    try {
      return runner();
    } finally {
      isSidecarAnswerStreamSyncSuppressed = wasSuppressed;
    }
  };

  const ensureSidecarAnswerStreamState = (
    metadata: ISidecarAnswerStreamMetadata,
  ): ISidecarAnswerStreamState => {
    if (!sidecarAnswerStreamState || sidecarAnswerStreamState.messageId !== metadata.messageId) {
      sidecarAnswerStreamState = {
        ...metadata,
        sourceText: '',
      };
      runWithSuppressedSidecarAnswerSync(() => {
        sidecarAnswerStream.start({ messageId: metadata.messageId });
      });

      return sidecarAnswerStreamState;
    }

    assignSidecarAnswerStreamMetadata(sidecarAnswerStreamState, metadata);

    return sidecarAnswerStreamState;
  };

  const resetSidecarAnswerStreamContent = (
    metadata: ISidecarAnswerStreamMetadata,
  ): string => {
    const state = ensureSidecarAnswerStreamState(metadata);
    state.sourceText = '';
    runWithSuppressedSidecarAnswerSync(() => {
      sidecarAnswerStream.start({ messageId: metadata.messageId });
    });

    return sidecarAnswerStream.content.value;
  };

  const updateSidecarAnswerStreamContent = (
    sourceText: string,
    metadata: ISidecarAnswerStreamMetadata,
  ): string => {
    const state = ensureSidecarAnswerStreamState(metadata);

    if (!sourceText) {
      state.sourceText = '';
      runWithSuppressedSidecarAnswerSync(() => {
        sidecarAnswerStream.start({ messageId: metadata.messageId });
      });

      return sidecarAnswerStream.content.value;
    }

    if (sourceText === state.sourceText) {
      return sidecarAnswerStream.content.value;
    }

    if (sourceText.startsWith(state.sourceText)) {
      const delta = sourceText.slice(state.sourceText.length);
      state.sourceText = sourceText;
      runWithSuppressedSidecarAnswerSync(() => {
        sidecarAnswerStream.append(delta);
        sidecarAnswerStream.flushNow();
      });

      return sidecarAnswerStream.content.value;
    }

    state.sourceText = '';
    runWithSuppressedSidecarAnswerSync(() => {
      sidecarAnswerStream.start({ messageId: metadata.messageId });
    });
    state.sourceText = sourceText;
    runWithSuppressedSidecarAnswerSync(() => {
      sidecarAnswerStream.append(sourceText);
      sidecarAnswerStream.flushNow();
    });

    return sidecarAnswerStream.content.value;
  };

  const disposeSidecarAnswerStream = (messageId?: string): void => {
    const state = sidecarAnswerStreamState;

    if (!state || (messageId && state.messageId !== messageId)) {
      return;
    }

    sidecarAnswerStreamState = null;
    sidecarAnswerStream.stop();
  };

  const hasActiveSidecarAnswerStreamSource = (messageId: string): boolean =>
    sidecarAnswerStreamState?.messageId === messageId
    && sidecarAnswerStreamState.sourceText.length > 0;

  const completeSidecarAnswerStream = (
    finalText: string,
    metadata: ISidecarAnswerStreamMetadata,
  ): string => {
    if (!hasActiveSidecarAnswerStreamSource(metadata.messageId)) {
      disposeSidecarAnswerStream(metadata.messageId);
      return finalText;
    }

    updateSidecarAnswerStreamContent(finalText, metadata);
    sidecarAnswerStream.complete();

    return sidecarAnswerStream.content.value;
  };

  const waitForSidecarAnswerStreamCompletion = (messageId: string): Promise<void> => {
    if (
      !sidecarAnswerStreamState ||
      sidecarAnswerStreamState.messageId !== messageId ||
      sidecarAnswerStream.status.value === 'completed'
    ) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const stop = watch(
        () => [sidecarAnswerStream.status.value, sidecarAnswerStreamState?.messageId] as const,
        ([status, activeMessageId]) => {
          if (status !== 'completed' && activeMessageId === messageId) {
            return;
          }

          stop();
          resolve();
        },
        { flush: 'sync' },
      );
    });
  };

  watch(
    () => [sidecarAnswerStream.content.value, sidecarAnswerStream.status.value] as const,
    () => {
      syncSidecarAnswerStreamMessage();
    },
    { flush: 'sync' },
  );

  const refreshChangedDocumentsAfterSidecarRun = async (
    changedFilePaths: readonly string[],
    hasFileMutations: boolean,
  ): Promise<void> => {
    const refreshResult = await refreshSidecarChangedDocuments({
      changedFilePaths,
      hasFileMutations,
      workspaceRootPath: options.workspaceRootPath.value,
      currentDocument: options.document.value,
    });

    if (refreshResult.skippedDirtyNames.length > 0) {
      errorMessage.value = `Agent 已修改文件，但 ${refreshResult.skippedDirtyNames.join('、')} 有未保存改动，已跳过自动刷新。`;
      return;
    }

    if (refreshResult.failedNames.length > 0) {
      errorMessage.value = `Agent 已修改文件，但刷新 ${refreshResult.failedNames.join('、')} 失败，请手动重新打开。`;
    }
  };

  const operationTouchesChangedPath = (
    operation: IAiEditOperation,
    changedFilePaths: readonly string[],
  ): boolean => {
    if (changedFilePaths.length === 0) {
      return false;
    }

    const operationPaths = [operation.path, operation.newPath].filter((path): path is string =>
      Boolean(path?.trim())
    );

    return operationPaths.some((operationPath) =>
      changedFilePaths.some((changedPath) => areFileSystemPathsEqual(operationPath, changedPath))
    );
  };

  const findLatestRollbackableOperation = async (
    changedFilePaths: readonly string[],
  ): Promise<IAiEditOperation | null> => {
    if (changedFilePaths.length === 0) {
      return null;
    }

    const timeline = await aiEditService.listTimeline({
      taskId: activeConversationId.value ?? null,
      limit: AI_EDIT_ROLLBACK_TIMELINE_LIMIT,
    });
    const operations = timeline.entries
      .filter(isAiEditOperationEntry)
      .map((entry) => entry.data)
      .filter((operation) => operationTouchesChangedPath(operation, changedFilePaths))
      .sort((left, right) => getOperationAppliedTime(right) - getOperationAppliedTime(left));

    return operations[0] ?? null;
  };

  const updateFileRollbackPrompt = async (
    changedFilePaths: readonly string[],
    hasFileMutations: boolean,
  ): Promise<void> => {
    if (!hasFileMutations || changedFilePaths.length === 0) {
      return;
    }

    try {
      const operation = await findLatestRollbackableOperation(changedFilePaths);

      if (!operation) {
        return;
      }

      fileRollbackPrompt.value = {
        operationId: operation.id,
        fileCount: changedFilePaths.length,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.warn({
        event: 'ai.file_rollback_prompt.failed',
        err: error,
      });
    }
  };

  const mapSidecarToolCallStatusToStepStatus = (
    status: NonNullable<IAiChatMessage['toolCalls']>[number]['status'],
  ): TAgentExecutionStepStatus => {
    switch (status) {
      case 'succeeded':
        return 'done';
      case 'failed':
        return 'failed';
      case 'denied':
        return 'cancelled';
      case 'pending':
        return 'pending';
      case 'running':
      default:
        return 'running';
    }
  };

  const applySidecarLiveEventsToAgentMessage = (
    assistantMessageId: string,
    fallbackContent: string,
    events: readonly TAgentUiEvent[],
  ): void => {
    const currentMessage = findMessageById(assistantMessageId);
    const {
      errorEvent,
      doneEvent,
      messageEvent,
      finalMessageEvent,
    } = getLatestSidecarLiveEvents(events);
    const doneResult = hasMeaningfulAssistantText(doneEvent?.result) ? doneEvent.result : null;
    const currentVisibleContent = hasMeaningfulAssistantText(currentMessage?.content)
      ? currentMessage?.content
      : null;
    const content = errorEvent
      ? `Agent 执行失败：${errorEvent.message}`
      : doneResult ?? finalMessageEvent?.text ?? (messageEvent?.text === '' ? '' : currentVisibleContent ?? fallbackContent);
    const streamStatus = errorEvent || doneEvent ? 'completed' : 'streaming';
    const finalAnswerStarted = Boolean(
      doneResult
      || finalMessageEvent
      || (
        currentMessage?.stream?.finalAnswerStarted
        && messageEvent?.text !== ''
      ),
    );
    const toolProjection = projectSidecarEventsToToolState({
      events,
      fallbackActivityText: fallbackContent,
      streamStatus,
    });
    const runtimeEvents = extractNewVisibleRuntimeEvents(events);

    for (const toolCall of toolProjection.toolCalls) {
      updateAgentStep(
        toolCall.id,
        toolCall.summary,
        mapSidecarToolCallStatusToStepStatus(toolCall.status),
      );
    }

    const streamMetadata: ISidecarAnswerStreamMetadata = {
      messageId: assistantMessageId,
      toolCalls: toolProjection.toolCalls,
      streamStatus,
      activityText: toolProjection.activityText,
      runtimeEvents,
      finalAnswerStarted,
    };
    const displayContent = (() => {
      if (errorEvent) {
        disposeSidecarAnswerStream(assistantMessageId);
        return content;
      }

      if (doneResult) {
        return completeSidecarAnswerStream(doneResult, streamMetadata);
      }

      if (finalMessageEvent) {
        return updateSidecarAnswerStreamContent(finalMessageEvent.text, streamMetadata);
      }

      if (messageEvent?.text === '') {
        return resetSidecarAnswerStreamContent(streamMetadata);
      }

      return content;
    })();

    updateAgentExecutionMessage(
      assistantMessageId,
      displayContent,
      toolProjection.toolCalls,
      resolveSidecarAnswerDisplayStatus(streamMetadata),
      toolProjection.activityText,
      runtimeEvents,
      finalAnswerStarted,
    );
  };


  const appendVisibleRuntimeTimelineEvents = (
    events: readonly TAgentRuntimeEvent[],
  ): void => {
    if (events.length === 0) {
      return;
    }

    const nextEvents = [...runtimeTimelineEvents.value];
    const seenIds = new Set(nextEvents.map((event) => event.id));

    for (const event of events) {
      if (seenIds.has(event.id)) {
        continue;
      }

      seenIds.add(event.id);
      nextEvents.push(event);
    }

    runtimeTimelineEvents.value = nextEvents.slice(-AGENT_RUNTIME_TIMELINE_LIMIT);
  };

  const appendRuntimeTimelineEvents = (
    events: readonly TAgentUiEvent[],
  ): void => {
    appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(events));
  };

  const buildSidecarContextMessage = (
    references: IAiContextReference[],
  ): IAgentSidecarMessage | null => {
    if (!references.length) {
      return null;
    }

    return {
      role: 'system',
      content: [
        '当前 UI 已收集到这些上下文，请在需要时结合它们判断任务：',
        ...references.map((reference, index) => [
          `#${index + 1} ${reference.label}`,
          `类型：${reference.kind}`,
          `路径：${reference.path ?? '无'}`,
          reference.range
            ? `范围：${reference.range.startLine}-${reference.range.endLine}`
            : '范围：无',
          `已脱敏：${reference.redacted ? '是' : '否'}`,
          '内容：',
          reference.contentPreview,
        ].join('\n')),
      ].join('\n\n'),
    };
  };

  const toSidecarMessages = (
    visibleMessages: IAiChatMessage[],
    references: IAiContextReference[],
  ): IAgentSidecarMessage[] => {
    const contextMessage = buildSidecarContextMessage(references);
    const historyMessages = visibleMessages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    return contextMessage ? [contextMessage, ...historyMessages] : historyMessages;
  };

  const executeSidecarAgentRequest = async (
    visibleMessages: IAiChatMessage[],
    messageContent: string,
    references: IAiContextReference[],
    turnId: string,
  ): Promise<void> => {
    errorMessage.value = '';
    isSending.value = true;
    agentSteps.value = [];
    runtimeTimelineEvents.value = [];
    agentPlan.store.clearPendingToolConfirmation();
    activeSidecarAgentSession.value = null;

    const assistantMessageId = createMessageId('assistant');
    const initialActivityText = buildInitialAgentActivityText();
    const placeholderMessage: IAiChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      references: [],
      toolCalls: [],
      stream: {
        status: 'streaming',
        activityText: initialActivityText,
        runtimeEvents: [],
      },
    };

    messages.value = [...visibleMessages, placeholderMessage];
    activeAgentMessageId.value = assistantMessageId;
    activeAbortController.value = new AbortController();
    const sidecarSessionId = `sidecar:${assistantMessageId}`;
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(
        assistantMessageId,
        '',
        events,
      );
    });
    let unlistenSidecarStream: (() => void) | null = null;

    try {
      unlistenSidecarStream = await aiService.onSidecarStream((payload) => {
        if (payload.sessionId !== sidecarSessionId) {
          return;
        }

        liveEventBuffer.push(payload.event);
      });
      const payload = await aiService.sidecarExecute({
        sessionId: sidecarSessionId,
        goal: messageContent,
        messages: toSidecarMessages(visibleMessages, references),
        workspaceRootPath: options.workspaceRootPath.value,
        context: references,
      });
      liveEventBuffer.flush();
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;
      appendRuntimeTimelineEvents(payload.events);
      const projection = projectSidecarExecuteResponse(payload);
      const toolProjection = projectSidecarEventsToToolState({
        events: payload.events,
        fallbackActivityText: initialActivityText,
        streamStatus: 'completed',
      });
      const streamMetadata: ISidecarAnswerStreamMetadata = {
        messageId: assistantMessageId,
        toolCalls: toolProjection.toolCalls,
        streamStatus: 'completed',
        activityText: toolProjection.activityText,
        runtimeEvents: compactRuntimeEvents(extractVisibleAgentRuntimeEvents(payload.events)),
        finalAnswerStarted: hasMeaningfulAssistantText(projection.assistantContent),
      };
      if (projection.errorMessage) {
        disposeSidecarAnswerStream(assistantMessageId);
      }

      const displayContent = projection.errorMessage
        ? projection.assistantContent
        : completeSidecarAnswerStream(projection.assistantContent, streamMetadata);
      const sidecarAnswerCompletion = projection.errorMessage || projection.pendingConfirmation
        ? Promise.resolve()
        : waitForSidecarAnswerStreamCompletion(assistantMessageId);

      for (const toolCall of toolProjection.toolCalls) {
        updateAgentStep(
          toolCall.id,
          toolCall.summary,
          mapSidecarToolCallStatusToStepStatus(toolCall.status),
        );
      }

      updateAgentExecutionMessage(
        assistantMessageId,
        displayContent,
        toolProjection.toolCalls,
        projection.errorMessage ? 'completed' : resolveSidecarAnswerDisplayStatus(streamMetadata),
        toolProjection.activityText,
        streamMetadata.runtimeEvents,
        streamMetadata.finalAnswerStarted,
      );

      await refreshChangedDocumentsAfterSidecarRun(
        projection.changedFilePaths,
        projection.hasFileMutations,
      );
      await updateFileRollbackPrompt(
        projection.changedFilePaths,
        projection.hasFileMutations,
      );
      await sidecarAnswerCompletion;

      if (projection.pendingConfirmation) {
        activeSidecarAgentSession.value = {
          sessionId: payload.sessionId,
          assistantMessageId,
          turnId,
          baseMessages: visibleMessages,
          messageContent,
          references,
        };
        agentPlan.store.setPendingToolConfirmation(projection.pendingConfirmation);
        return;
      }

      agentPlan.store.clearPendingToolConfirmation();
      activeSidecarAgentSession.value = null;
      attachedFiles.value = [];

      if (projection.errorMessage) {
        errorMessage.value = projection.errorMessage;
      }
    } catch (error) {
      const wasAborted = activeAbortController.value?.signal.aborted;
      disposeSidecarAnswerStream(assistantMessageId);

      if (!wasAborted) {
        const message = toErrorMessage(error, MSG_CALL_FAILED);
        updateAgentExecutionMessage(
          assistantMessageId,
          `Agent 执行失败：${message}`,
          [],
          'completed',
        );
        errorMessage.value = message;
      }
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      commitDisplayMessagesToStore();
      isSending.value = false;
    }
  };

  const resolveSidecarToolConfirmation = async (
    decision: TAiToolConfirmationDecision,
  ): Promise<void> => {
    const session = activeSidecarAgentSession.value;
    const confirmation = unref(agentPlan.store.pendingToolConfirmation);

    if (!session || !confirmation) {
      errorMessage.value = '当前没有可继续的 Agent 工具确认。';
      return;
    }

    agentPlan.store.clearPendingToolConfirmation(confirmation.id);

    if (decision === 'stop' || decision === 'skip') {
      activeSidecarAgentSession.value = null;
      updateAgentExecutionMessage(
        session.assistantMessageId,
        decision === 'stop' ? 'Agent 工具调用已停止。' : 'Agent 工具调用已跳过。',
        [],
        'completed',
      );
      return;
    }

    isSending.value = true;
    activeAgentMessageId.value = session.assistantMessageId;
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(
        session.assistantMessageId,
        '',
        events,
      );
    });
    let unlistenSidecarStream: (() => void) | null = null;

    try {
      unlistenSidecarStream = await aiService.onSidecarStream((payload) => {
        if (payload.sessionId !== session.sessionId) {
          return;
        }

        liveEventBuffer.push(payload.event);
      });
      const payload = await aiService.sidecarResolveApproval({
        sessionId: session.sessionId,
        requestId: confirmation.id,
        decision,
      });
      liveEventBuffer.flush();
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;
      appendRuntimeTimelineEvents(payload.events);
      const projection = projectSidecarExecuteResponse(payload);
      const toolProjection = projectSidecarEventsToToolState({
        events: payload.events,
        fallbackActivityText: session.messageContent,
        streamStatus: 'completed',
      });
      const streamMetadata: ISidecarAnswerStreamMetadata = {
        messageId: session.assistantMessageId,
        toolCalls: toolProjection.toolCalls,
        streamStatus: 'completed',
        activityText: toolProjection.activityText,
        runtimeEvents: compactRuntimeEvents(extractVisibleAgentRuntimeEvents(payload.events)),
        finalAnswerStarted: hasMeaningfulAssistantText(projection.assistantContent),
      };
      if (projection.errorMessage) {
        disposeSidecarAnswerStream(session.assistantMessageId);
      }

      const displayContent = projection.errorMessage
        ? projection.assistantContent
        : completeSidecarAnswerStream(projection.assistantContent, streamMetadata);
      const sidecarAnswerCompletion = projection.errorMessage || projection.pendingConfirmation
        ? Promise.resolve()
        : waitForSidecarAnswerStreamCompletion(session.assistantMessageId);

      updateAgentExecutionMessage(
        session.assistantMessageId,
        displayContent,
        toolProjection.toolCalls,
        projection.errorMessage ? 'completed' : resolveSidecarAnswerDisplayStatus(streamMetadata),
        toolProjection.activityText,
        streamMetadata.runtimeEvents,
        streamMetadata.finalAnswerStarted,
      );

      await refreshChangedDocumentsAfterSidecarRun(
        projection.changedFilePaths,
        projection.hasFileMutations,
      );
      await updateFileRollbackPrompt(
        projection.changedFilePaths,
        projection.hasFileMutations,
      );
      await sidecarAnswerCompletion;

      if (projection.pendingConfirmation) {
        activeSidecarAgentSession.value = {
          ...session,
          sessionId: payload.sessionId,
        };
        agentPlan.store.setPendingToolConfirmation(projection.pendingConfirmation);
        return;
      }

      activeSidecarAgentSession.value = null;

      if (projection.errorMessage) {
        errorMessage.value = projection.errorMessage;
      }
    } catch (error) {
      const message = toErrorMessage(error, '处理 Agent 工具确认失败。');
      disposeSidecarAnswerStream(session.assistantMessageId);
      updateAgentExecutionMessage(
        session.assistantMessageId,
        `Agent 执行失败：${message}`,
        [],
        'completed',
      );
      errorMessage.value = message;
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeAgentMessageId.value = null;
      commitDisplayMessagesToStore();
      isSending.value = false;
    }
  };
  // -----------------------------------------------------------------------
  // Computed
  // -----------------------------------------------------------------------

  const providerLabel = computed(() =>
    config.value.chatEnabled
      ? `${config.value.providerType} · ${config.value.selectedModel ?? DEFAULT_LITELLM_MODEL_ID}`
      : '未启用 Chat',
  );

  const sendButtonLabel = computed(() => (isSending.value ? '发送中…' : '发送'));

  const latestAssistantCodeBlock = computed(() => {
    const message = [...messages.value].reverse().find((item) => item.role === 'assistant');
    const match = message?.content.match(CODE_BLOCK_PATTERN);

    return match?.[1] ?? '';
  });

  const canPreviewPatch = computed(() => {
    const document = options.document.value;

    return Boolean(
      document.path &&
      document.kind === 'text' &&
      latestAssistantCodeBlock.value.trim(),
    );
  });

  // -----------------------------------------------------------------------
  // Context builders
  // -----------------------------------------------------------------------

  const buildDocumentContext = (): string => {
    const document = options.document.value;

    if (!document.id || document.kind !== 'text') {
      return '当前没有可用的文本脚本文档。';
    }

    return [
      `文件名：${document.name}`,
      `路径：${document.path ?? '未保存'}`,
      `状态：${document.isDirty ? '有未保存修改' : '已保存'}`,
      '脚本内容：',
      '```sh',
      clipText(document.content, MAX_CONTEXT_CHARS),
      '```',
    ].join('\n');
  };

  const buildRunContext = (): string => {
    const activeRun = options.activeRun.value;

    if (!activeRun) {
      return '当前没有正在运行或最近触发的运行记录。';
    }

    return [
      `运行文件：${activeRun.documentName}`,
      `命令：${activeRun.commandLine}`,
      `执行器：${activeRun.executorLabel}`,
      `开始时间：${activeRun.startedAt}`,
      `临时文件：${activeRun.usedTempFile ? '是' : '否'}`,
    ].join('\n');
  };

  const buildQuickPrompt = (actionId: TAiQuickActionId): string => {
    const documentContext = buildDocumentContext();

    if (actionId === 'explain') {
      return `请解释当前脚本的执行流程、关键变量、外部依赖和潜在风险。\n\n${documentContext}`;
    }

    if (actionId === 'fix') {
      return `请根据当前脚本和运行上下文定位问题根因，并给出最小修改方案。如果上下文不足，请列出还需要哪些信息。\n\n${documentContext}\n\n运行上下文：\n${buildRunContext()}`;
    }

    return `请按安全、参数可靠性、可维护性、边界条件和可验证性审查当前脚本。请只给出基于代码能确认的问题。\n\n${documentContext}`;
  };

  const resolveContextTokens = (prompt: string): Set<string> => {
    const tokens = new Set<string>();

    for (const match of prompt.matchAll(CONTEXT_TOKEN_PATTERN)) {
      const token = match[2]?.toLowerCase();

      if (token) {
        tokens.add(token);
      }
    }

    return tokens;
  };

  const shouldIncludeReference = (
    tokens: Set<string>,
    aliases: readonly string[],
  ): boolean =>
    tokens.size === 0 || aliases.some((alias) => tokens.has(alias));

  const buildProjectSearchReference = async (
    prompt: string,
  ): Promise<IAiContextReference | null> => {
    const tokens = resolveContextTokens(prompt);
    const shouldSearchProject = PROJECT_SEARCH_TOKENS.some((item) => tokens.has(item));
    const workspaceRootPath = options.workspaceRootPath.value;

    if (!shouldSearchProject || !workspaceRootPath) {
      return null;
    }

    const query = prompt
      .replace(CONTEXT_TOKEN_PATTERN, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

    if (!query) {
      return null;
    }

    const payload = await aiService.queryIndex({
      workspaceRootPath,
      query,
      limit: 8,
    });

    if (payload.results.length === 0) {
      return null;
    }

    return {
      id: `search-result:${workspaceRootPath}:${query}`,
      kind: 'search-result',
      label: `项目搜索 · ${query}`,
      path: workspaceRootPath,
      range: null,
      contentPreview: payload.results
        .map((item) =>
          `${item.path}${item.lineNumber ? `:${item.lineNumber}` : ''}\n${item.preview}`)
        .join('\n---\n'),
      redacted: false,
    };
  };

  const buildReferences = async (prompt = ''): Promise<IAiContextReference[]> => {
    const tokens = resolveContextTokens(prompt);

    const currentFile = buildCurrentFileReference(options.document.value);
    const selection = buildSelectionReference(options.selection.value, options.document.value);
    const activeRun = buildActiveRunReference(options.activeRun.value);
    const diagnostics = buildDiagnosticsReference(
      options.analysis.value,
      options.document.value,
    );
    const gitDiff = buildGitDiffReference(options.gitStatus.value);
    const projectSearch = await buildProjectSearchReference(prompt).catch(() => null);

    const candidates: ReadonlyArray<readonly [IAiContextReference | null, readonly string[]]> = [
      [currentFile, ['file', 'current-file']],
      [selection, ['selection']],
      [activeRun, ['terminal', 'log']],
      [diagnostics, ['diagnostics', 'shellcheck']],
      [gitDiff, ['git-diff', 'git']],
      [projectSearch, PROJECT_SEARCH_TOKENS],
    ];

    const references = candidates
      .filter(([, aliases]) => shouldIncludeReference(tokens, aliases))
      .map(([reference]) => reference)
      .filter((item): item is IAiContextReference => item !== null);

    return [
      ...references,
      ...attachedFiles.value.map((file) => file.reference),
    ];
  };

  // -----------------------------------------------------------------------
  // Config / tools / credentials
  // -----------------------------------------------------------------------

  const loadConfig = async (): Promise<void> => {
    config.value = await aiService.getConfig();
  };

  const loadTools = async (): Promise<void> => {
    toolDefinitions.value = await aiService.listTools();
  };

  const loadProviderProfiles = async (): Promise<void> => {
    providerProfiles.value = await aiService.listProviderProfiles();
  };

  const getProviderProfileDetail = (
    profileId: string,
  ): Promise<IAiProviderProfileDetailPayload> =>
    aiService.getProviderProfileDetail({ profileId });

  const saveConfig = async (
    nextConfig: IAiConfigPayload,
    role: TAiModelRole = 'main',
  ): Promise<void> => {
    config.value = await aiService.saveConfig({
      role,
      providerType: role === 'narrator'
        ? nextConfig.narrator.providerType
        : nextConfig.providerType,
      selectedModel: role === 'narrator'
        ? nextConfig.narrator.selectedModel
        : nextConfig.selectedModel,
      baseUrl: role === 'narrator'
        ? nextConfig.narrator.baseUrl
        : nextConfig.baseUrl,
      inlineCompletionEnabled: nextConfig.inlineCompletionEnabled,
      chatEnabled: nextConfig.chatEnabled,
      agentEnabled: nextConfig.agentEnabled,
    });
  };

  const saveCredentials = async (
    apiKey: string,
    providerType = config.value.providerType,
    role: TAiModelRole = 'main',
  ): Promise<void> => {
    config.value = await aiService.saveCredentials({
      role,
      providerType,
      apiKey,
    });
  };

  const createProviderConnectionRequest = (
    nextConfig: IAiConfigPayload,
    apiKey: string,
    role: TAiModelRole = 'main',
  ): IAiProviderConnectionRequest => ({
    role,
    providerType: role === 'narrator'
      ? nextConfig.narrator.providerType
      : nextConfig.providerType,
    selectedModel: role === 'narrator'
      ? nextConfig.narrator.selectedModel
      : nextConfig.selectedModel,
    baseUrl: role === 'narrator'
      ? nextConfig.narrator.baseUrl
      : nextConfig.baseUrl,
    inlineCompletionEnabled: nextConfig.inlineCompletionEnabled,
    chatEnabled: nextConfig.chatEnabled,
    agentEnabled: nextConfig.agentEnabled,
    apiKey: apiKey.trim() || null,
  });

  const testProviderConfig = async (
    nextConfig: IAiConfigPayload,
    apiKey: string,
    role: TAiModelRole = 'main',
  ): Promise<string> => {
    const result = await aiService.testProviderConfig(
      createProviderConnectionRequest(nextConfig, apiKey, role),
    );

    if (!result.ok) {
      errorMessage.value = result.message;
      throw new Error(result.message);
    }

    return result.message;
  };

  const connectProvider = async (
    nextConfig: IAiConfigPayload,
    apiKey: string,
    role: TAiModelRole = 'main',
  ): Promise<string> => {
    const result = await aiService.connectProvider(
      createProviderConnectionRequest(nextConfig, apiKey, role),
    );

    config.value = result.config;
    await loadProviderProfiles();

    return result.test.message;
  };

  const switchProviderProfile = async (profileId: string): Promise<void> => {
    config.value = await aiService.switchProviderProfile({ profileId });
    await loadProviderProfiles();
  };

  const testProvider = async (): Promise<string> => {
    const result = await aiService.testProvider();

    if (!result.ok) {
      errorMessage.value = result.message;
      throw new Error(result.message);
    }

    return result.message;
  };

  // -----------------------------------------------------------------------
  // Quick actions / attachments
  // -----------------------------------------------------------------------

  const applyQuickAction = (action: IAiQuickAction): void => {
    draft.value = buildQuickPrompt(action.id);

    void buildReferences(draft.value).then((references) => {
      currentReferences.value = references;
    });

    errorMessage.value = '';
  };

  const attachFile = async (file: File): Promise<void> => {
    const normalizedName = normalizeAttachmentName(file);

    if (isTextAttachment(file)) {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
        errorMessage.value = `附件超过 ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)}，请先拆分或只粘贴关键片段。`;
        return;
      }

      const content = await file.text().catch((): null => null);

      if (content === null) {
        errorMessage.value = '读取附件失败，请确认文件可访问后重试。';
        return;
      }

      const id = `attachment:${normalizedName}:${file.lastModified}:${file.size}`;

      const reference: IAiContextReference = {
        id,
        kind: 'search-result',
        label: `附件 · ${normalizedName}`,
        path: normalizedName,
        range: null,
        contentPreview: [
          `文件名：${normalizedName}`,
          `大小：${formatBytes(file.size)}`,
          '内容：',
          clipText(content, MAX_CONTEXT_CHARS),
        ].join('\n'),
        redacted: false,
      };

      attachedFiles.value = [
        ...attachedFiles.value.filter((item) => item.id !== id),
        {
          id,
          name: normalizedName,
          sizeLabel: formatBytes(file.size),
          kind: 'text',
          reference,
        },
      ];

      currentReferences.value = await buildReferences(draft.value);
      errorMessage.value = '';

      return;
    }

    if (isImageAttachment(file)) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        errorMessage.value = `图片超过 ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)}，请压缩后再试。`;
        return;
      }

      const dimensions = await readImageDimensions(file);
      const dimensionsLabel = formatImageDimensions(dimensions);
      const id = `attachment:${normalizedName}:${file.lastModified}:${file.size}`;

      const reference: IAiContextReference = {
        id,
        kind: 'image-attachment',
        label: `图片附件 · ${normalizedName}`,
        path: normalizedName,
        range: null,
        contentPreview: [
          `文件名：${normalizedName}`,
          `类型：${file.type || 'image/*'}`,
          `大小：${formatBytes(file.size)}`,
          ...(dimensionsLabel ? [`尺寸：${dimensionsLabel}`] : []),
          '说明：这是用户在 AI 输入框里粘贴或添加的图片附件。当前会把图片元信息作为上下文发送。',
        ].join('\n'),
        redacted: false,
      };

      attachedFiles.value = [
        ...attachedFiles.value.filter((item) => item.id !== id),
        {
          id,
          name: normalizedName,
          sizeLabel: formatBytes(file.size),
          kind: 'image',
          detailLabel: dimensionsLabel ?? undefined,
          reference,
        },
      ];

      currentReferences.value = await buildReferences(draft.value);
      errorMessage.value = '';

      return;
    }

    errorMessage.value = '当前只支持文本文件和图片作为 AI 上下文附件。';
  };

  const removeAttachedFile = (id: string): void => {
    attachedFiles.value = attachedFiles.value.filter((item) => item.id !== id);

    void buildReferences(draft.value).then((references) => {
      currentReferences.value = references;
    });
  };

  // -----------------------------------------------------------------------
  // Streaming pipeline
  // -----------------------------------------------------------------------

  interface IStreamPipeline {
    readonly handleEvent: (event: IAiChatStreamEventPayload) => void;
    readonly startAssistantStream: (streamId: string, assistantMessageId: string) => void;
    readonly flushBufferedText: () => void;
  }

  const createStreamPipeline = (
    assistantMessage: IAiChatMessage,
    settle: () => void,
  ): IStreamPipeline => {
    let isStreamClosed = false;
    let hasStartedStream = false;

    const flushBufferedText = (): void => {
      aiStream.flushNow();
      syncActiveAssistantMessage();
    };

    const startAssistantStream = (
      streamId: string,
      assistantMessageId: string,
    ): void => {
      if (hasStartedStream) {
        return;
      }

      hasStartedStream = true;
      activeStreamId.value = streamId;
      assistantMessage.id = assistantMessageId;

      aiStream.start({ messageId: assistantMessageId });
      syncActiveAssistantMessage();
    };

    const handleEvent = (event: IAiChatStreamEventPayload): void => {
      if (!activeStreamId.value && event.kind === 'start') {
        startAssistantStream(event.streamId, event.assistantMessageId);
        return;
      }

      if (event.streamId !== activeStreamId.value) {
        return;
      }

      if (isStreamClosed) {
        return;
      }

      if (event.kind === 'delta' && event.delta) {
        aiStream.append(event.delta);
        return;
      }

      isStreamClosed = true;

      if (event.kind === 'done') {
        aiStream.complete();
        syncActiveAssistantMessage();
        attachedFiles.value = [];
        settle();
        return;
      }

      if (event.kind === 'cancelled') {
        aiStream.stop();
        syncActiveAssistantMessage();
        errorMessage.value = '';
        settle();
        return;
      }

      if (event.kind === 'error') {
        aiStream.stop();
        syncActiveAssistantMessage();
        errorMessage.value = event.message ?? MSG_STREAM_ERROR;
        settle();
      }
    };

    return {
      handleEvent,
      startAssistantStream,
      flushBufferedText,
    };
  };

  const executeAiRequest = async (
    requestMessages: IAiChatMessage[],
    visibleMessages: IAiChatMessage[],
    references: IAiContextReference[],
  ): Promise<void> => {
    errorMessage.value = '';
    isSending.value = true;

    const assistantMessage: IAiChatMessage = {
      id: createMessageId('assistant'),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      references: [],
      stream: {
        status: 'streaming',
      },
    };

    activeAssistantMessage.value = assistantMessage;
    activeAssistantBaseMessages.value = visibleMessages;
    messages.value = [...visibleMessages, assistantMessage];

    let unlisten: (() => void) | null = null;
    let hasSettledStream = false;

    const settle = (): void => {
      hasSettledStream = true;
      activeStreamResolve.value?.();
    };

    const pipeline = createStreamPipeline(
      assistantMessage,
      settle,
    );

    try {
      unlisten = await aiService.onChatStream(pipeline.handleEvent);

      const stream = await aiService.chatStream({
        threadId: null,
        messages: requestMessages,
        references,
      });

      pipeline.startAssistantStream(
        stream.streamId,
        stream.assistantMessageId,
      );

      await new Promise<void>((resolve) => {
        if (hasSettledStream) {
          resolve();
          return;
        }

        activeStreamResolve.value = resolve;
      });
    } finally {
      pipeline.flushBufferedText();
      commitDisplayMessagesToStore();
      unlisten?.();

      activeStreamResolve.value = null;
      activeStreamId.value = null;
      activeAbortController.value = null;
      activeAssistantMessage.value = null;
      activeAssistantBaseMessages.value = [];
      isSending.value = false;
    }
  };

  // -----------------------------------------------------------------------
  // sendMessage / planAgentTask
  // -----------------------------------------------------------------------

  const restoreConversationCheckpoint = async (checkpointId: string): Promise<void> => {
    if (isSending.value || restoringCheckpointId.value) {
      return;
    }

    const checkpoint = conversationCheckpoints.value.find((item) => item.id === checkpointId);

    if (!checkpoint) {
      errorMessage.value = '未找到可恢复的 checkpoint。';
      return;
    }

    const targetMessageIndex = findMessageIndexById(messages.value, checkpoint.messageId);

    if (targetMessageIndex < 0) {
      errorMessage.value = '未找到 checkpoint 对应的对话消息。';
      return;
    }

    const restoreSessionId = createScopedId('sidecar-restore');
    const liveEventBuffer = createSidecarLiveEventBuffer((_events, freshEvents) => {
      const visibleRuntimeEvents = extractVisibleAgentRuntimeEvents(freshEvents);

      if (!visibleRuntimeEvents.length) {
        return;
      }

      appendRuntimeEventsToMessage(checkpoint.messageId, visibleRuntimeEvents);
      appendVisibleRuntimeTimelineEvents(visibleRuntimeEvents);
    });
    let unlistenSidecarStream: (() => void) | null = null;

    restoringCheckpointId.value = checkpointId;
    errorMessage.value = '';

    try {
      unlistenSidecarStream = await aiService.onSidecarStream((payload) => {
        if (payload.sessionId !== restoreSessionId) {
          return;
        }

        liveEventBuffer.push(payload.event);
      });

      const payload = await aiService.sidecarRestoreCheckpoint({
        sessionId: restoreSessionId,
        runId: checkpoint.runId,
        snapshotId: checkpoint.snapshotId,
      });

      liveEventBuffer.flush();
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;

      const visibleRuntimeEvents = extractVisibleAgentRuntimeEvents(payload.events);

      if (visibleRuntimeEvents.length) {
        appendRuntimeEventsToMessage(checkpoint.messageId, visibleRuntimeEvents);
        appendRuntimeTimelineEvents(payload.events);
      }

      const restoreErrorEvent = payload.events.find((event) => event.type === 'error');

      if (restoreErrorEvent?.type === 'error') {
        throw new Error(restoreErrorEvent.message);
      }

      const nextMessages = messages.value.slice(0, targetMessageIndex + 1);
      messages.value = nextMessages;
      runtimeTimelineEvents.value = collectConversationRuntimeEvents(nextMessages);
      proposedPatch.value = null;
      fileRollbackPrompt.value = null;
      agentSteps.value = [];
      activeSidecarAgentSession.value = null;
      activeAgentMessageId.value = null;
      agentPlan.resetPlan();
      agentPlan.store.clearPendingToolConfirmation();
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value = toErrorMessage(error, '恢复回滚检查点失败');
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      commitDisplayMessagesToStore();
      restoringCheckpointId.value = null;
    }
  };

  const sendMessage = async (): Promise<void> => {
    const content = draft.value.trim();

    if ((!content && attachedFiles.value.length === 0) || isSending.value) {
      return;
    }

    if (!config.value.chatEnabled) {
      errorMessage.value = '请先启用 AI Chat。';
      isSettingsOpen.value = true;
      return;
    }

    if (!config.value.isConfigured) {
      errorMessage.value = 'AI Provider 还没配置完整，请先保存当前厂商配置和 API Key。';
      isSettingsOpen.value = true;
      return;
    }

    const messageContent = content || '请分析我添加的附件内容。';
    const titleThreadId = activeConversationId.value;
    const userMessage: IAiChatMessage = {
      id: createMessageId('user'),
      role: 'user',
      content: messageContent,
      createdAt: new Date().toISOString(),
      references: [],
    };

    const visibleMessages = [...messages.value, userMessage];

    messages.value = visibleMessages;
    draft.value = '';
    errorMessage.value = '';
    isSending.value = true;

    let references: IAiContextReference[];

    try {
      references = await buildReferences(messageContent);
    } catch (error) {
      const message = toErrorMessage(error, MSG_CALL_FAILED);
      errorMessage.value = message;
      messages.value = [
        ...visibleMessages,
        {
          id: createMessageId('assistant'),
          role: 'assistant',
          content: `AI 上下文收集失败：${message}`,
          createdAt: new Date().toISOString(),
          references: [],
        },
      ];
      commitDisplayMessagesToStore();
      isSending.value = false;
      return;
    }

    currentReferences.value = references;

    const nextMessages = visibleMessages.map((message) =>
      message.id === userMessage.id
        ? {
          ...message,
          references,
        }
        : message,
    );

    messages.value = nextMessages;

    if (activeMode.value === 'agent') {
      await executeSidecarAgentRequest(
        nextMessages,
        messageContent,
        references,
        userMessage.id,
      );

      if (!errorMessage.value) {
        void maybeGenerateConversationTitle(titleThreadId);
      }

      return;
    }

    if (activeMode.value === 'plan') {
      agentSteps.value = [];

      try {
        const planResult = await agentPlan.createPlan(
          messageContent,
          references,
          options.workspaceRootPath.value,
        );

        agentSteps.value = planResult.steps.map((step) => ({
          id: step.id,
          title: step.title,
          status: step.status,
        }));

        messages.value = [
          ...nextMessages,
          {
            id: createMessageId('assistant'),
            role: 'assistant',
            content: planResult.assistantContent,
            createdAt: new Date().toISOString(),
            references: [],
            toolCalls: planResult.toolCalls,
          },
        ];

        commitDisplayMessagesToStore();
        isSending.value = false;
        void maybeGenerateConversationTitle(titleThreadId);
        return;
      } catch (error) {
        const message = toErrorMessage(error, '生成计划失败。');
        errorMessage.value = message;
        agentSteps.value = [];
        messages.value = [
          ...nextMessages,
          {
            id: createMessageId('assistant'),
            role: 'assistant',
            content: `计划生成失败：${message}`,
            createdAt: new Date().toISOString(),
            references: [],
          },
        ];
        commitDisplayMessagesToStore();
        isSending.value = false;
        return;
      }
    }

    try {
      await executeAiRequest(
        nextMessages,
        nextMessages,
        references,
      );
      if (!errorMessage.value) {
        void maybeGenerateConversationTitle(titleThreadId);
      }
    } catch (error) {
      errorMessage.value = toErrorMessage(error, MSG_CALL_FAILED);
    }
  };

  // -----------------------------------------------------------------------
  // Conversation / patch
  // -----------------------------------------------------------------------

  const resetConversationUiState = (): void => {
    draft.value = '';
    currentReferences.value = [];
    proposedPatch.value = null;
    agentSteps.value = [];
    fileRollbackPrompt.value = null;
    runtimeTimelineEvents.value = [];

    agentPlan.resetPlan();

    attachedFiles.value = [];
    errorMessage.value = '';
    activeAssistantMessage.value = null;
    activeAssistantBaseMessages.value = [];
    activeAgentMessageId.value = null;
    activeSidecarAgentSession.value = null;
    disposeSidecarAnswerStream();
    agentPlan.store.clearPendingToolConfirmation();
    isClearDialogOpen.value = false;
  };

  const clearConversation = (): void => {
    conversationStore.clearActiveThread();
    resetConversationUiState();
  };

  const startNewConversation = (): void => {
    conversationStore.startNewThread();
    resetConversationUiState();
  };

  const switchConversation = (threadId: string): void => {
    conversationStore.switchThread(threadId);
    resetConversationUiState();
  };

  const previewPatchFromLastAnswer = async (): Promise<void> => {
    const document = options.document.value;
    const updatedContent = latestAssistantCodeBlock.value;

    if (!document.path || document.kind !== 'text' || !updatedContent.trim()) {
      errorMessage.value = '没有可预览的代码块，或当前文件尚未保存。';
      return;
    }

    const payload = await aiService.proposePatch({
      path: document.path,
      originalContent: document.content,
      updatedContent,
      summary: '应用 AI 回复中的代码块',
    });

    proposedPatch.value = payload.patch;
    errorMessage.value = '';
  };

  const applyProposedPatch = async (): Promise<void> => {
    const patch = proposedPatch.value;

    if (!patch || isApplyingPatch.value) {
      return;
    }

    isApplyingPatch.value = true;

    try {
      const result = await aiService.applyPatch({
        patch,
        metadata: {
          taskId: activeConversationId.value,
          turnId: messages.value.at(-1)?.id ?? activeConversationId.value,
          reason: patch.summary,
          toolCallId: null,
          confirmedByUser: true,
          ...(buildActiveAgentPatchMetadata() ?? {}),
        },
      });

      const appliedPaths = result.appliedFiles.map((file) => file.path);

      syncPatchedDocument(options.document.value, patch, appliedPaths);
      await updateFileRollbackPrompt(appliedPaths, appliedPaths.length > 0);

      messages.value = [
        ...messages.value,
        {
          id: createMessageId('assistant'),
          role: 'assistant',
          content: `Patch 已应用：${appliedPaths
            .map((file) => normalizePatchDisplayPath(file))
            .join('、')}`,
          createdAt: new Date().toISOString(),
          references: [],
        },
      ];

      proposedPatch.value = null;
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value = toErrorMessage(error, 'Patch 应用失败');
    } finally {
      isApplyingPatch.value = false;
    }
  };

  const rollbackLatestFileChange = async (): Promise<void> => {
    const prompt = fileRollbackPrompt.value;

    if (!prompt || prompt.status !== 'ready') {
      return;
    }

    fileRollbackPrompt.value = {
      ...prompt,
      status: 'reverting',
      updatedAt: new Date().toISOString(),
    };

    try {
      const result = await aiEditService.undoOperation({
        operationId: prompt.operationId,
      });

      await refreshChangedDocumentsAfterSidecarRun(
        result.restoredFiles,
        result.restoredFiles.length > 0,
      );

      fileRollbackPrompt.value = {
        ...prompt,
        status: 'reverted',
        restoredFileCount: result.restoredFiles.length,
        updatedAt: new Date().toISOString(),
      };
      errorMessage.value = '';
    } catch (error) {
      fileRollbackPrompt.value = {
        ...prompt,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
      errorMessage.value = toErrorMessage(error, '回滚 AI 文件修改失败');
    }
  };

  const stopCurrentRequest = (): void => {
    const streamId = activeStreamId.value;

    if (streamId) {
      void aiService.cancel({ streamId });
    }

    activeAbortController.value?.abort();
    activeAbortController.value = null;

    activeStreamId.value = null;
    activeStreamResolve.value?.();
    activeStreamResolve.value = null;

    aiStream.stop();
    disposeSidecarAnswerStream(activeAgentMessageId.value ?? undefined);

    if (activeAssistantMessage.value) {
      activeAssistantMessage.value.stream = {
        status: 'cancelled',
      };
      activeAssistantMessage.value.content = aiStream.content.value;

      messages.value = [
        ...activeAssistantBaseMessages.value,
        { ...activeAssistantMessage.value },
      ];
    }

    if (activeAgentMessageId.value) {
      updateAgentExecutionMessage(
        activeAgentMessageId.value,
        'Agent 执行已取消。',
        [],
        'cancelled',
      );
      activeAgentMessageId.value = null;
    }

    activeSidecarAgentSession.value = null;
    agentPlan.store.clearPendingToolConfirmation();
    commitDisplayMessagesToStore();
    isSending.value = false;
    errorMessage.value = '';
  };

  // -----------------------------------------------------------------------
  // Public surface
  // -----------------------------------------------------------------------

  return {
    agentPlan,
    config,
    messages,
    historyThreads,
    activeConversationId,
    draft,
    isSending,
    errorMessage,
    isSettingsOpen,
    isClearDialogOpen,
    currentReferences,
    proposedPatch,
    isApplyingPatch,
    fileRollbackPrompt,
    runtimeTimelineEvents,
    conversationCheckpoints,
    restoringCheckpointId,
    activeMode,
    agentSteps,
    toolDefinitions,
    providerProfiles,
    attachedFiles,
    providerLabel,
    sendButtonLabel,
    canPreviewPatch,
    loadConfig,
    loadTools,
    loadProviderProfiles,
    getProviderProfileDetail,
    saveConfig,
    saveCredentials,
    testProviderConfig,
    connectProvider,
    switchProviderProfile,
    testProvider,
    applyQuickAction,
    attachFile,
    removeAttachedFile,
    resolveSidecarToolConfirmation,
    sendMessage,
    stopCurrentRequest,
    previewPatchFromLastAnswer,
    applyProposedPatch,
    rollbackLatestFileChange,
    restoreConversationCheckpoint,
    clearConversation,
    startNewConversation,
    switchConversation,
  };
};
