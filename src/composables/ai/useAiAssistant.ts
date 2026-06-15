import {
  computed,
  getCurrentScope,
  onScopeDispose,
  type Ref,
  ref,
  shallowRef,
  unref,
  watch,
} from 'vue';
import {
  buildAiAgentPatchSummaryFromAedDiffs,
  buildAiAgentPatchSummaryFromApplyResult,
  buildAiPatchSetFromAedDiff,
  mergeAiAgentPatchSummaries,
  parseAiAedPatchRef,
} from '@/components/business/ai/edit/patch-summary';
import {
  buildAskUserResumeRequest,
  extractPendingAskUser,
  type IAgentSidecarPendingAskUser,
} from '@/composables/ai/sidecar-ask-user';
import {
  extractVisibleAgentRuntimeEvents,
  projectSidecarEventsToToolState,
  projectSidecarExecuteResponse,
} from '@/composables/ai/sidecar-events';
import {
  subscribeSidecarSessionStream,
  subscribeSidecarStreamWithPrebuffer,
} from '@/composables/ai/sidecar-stream-listener';
import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';
import { useAiStream } from '@/composables/ai/useAiStream';
import {
  type IAiWebSelectionContext,
  useAiWebSelectionInbox,
} from '@/composables/ai/useAiWebSelectionInbox';
import { useSidecarChangedDocumentRefresh } from '@/composables/useSidecarChangedDocumentRefresh';
import { aiService } from '@/services/ipc/ai.service';
import { buildCurrentFileReference } from '@/services/ipc/ai-context.service';
import { aiEditService } from '@/services/ipc/ai-edit.service';
import { type IAiPersistedSidecarAgentSession, useAiAgentStore } from '@/store/aiAgent';
import { type IAiConversationScrollState, useAiConversationStore } from '@/store/aiConversation';
import type {
  IAiAgentPatchSummary,
  IAiApplyPatchMetadata,
  IAiAttachedFile,
  IAiChatMessage,
  IAiContextReference,
  IAiImageAttachmentPreview,
  IAiPatchSet,
  IAiToolConfirmationRequest,
  TAiToolConfirmationDecision,
} from '@/types/ai';
import type { TAiAssistantMode } from '@/types/ai/assistant-mode';
import type { IAiEditGetDiffPayload, IAiEditOperation } from '@/types/ai/edit';
import type {
  IAgentSidecarMessage,
  IAskUserResult,
  TAgentRuntimeEvent,
  TAgentUiEvent,
} from '@/types/ai/sidecar';
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

// [auto-split imports]
import {
  clipText,
  createImageAttachmentSignature,
  createImagePreviewSource,
  createUniqueAttachmentName,
  formatBytes,
  formatImageDimensions,
  isImageAttachment,
  isTextAttachment,
  normalizeAttachmentName,
  readImageDimensions,
} from './useAiAssistant.attachments';
import { useAiConversationTitles } from './useAiAssistant.conversation-titles';
import {
  buildReversePatchSet,
  extractSidecarPatchEntries,
  type ISidecarPatchEntry,
  syncPatchedDocument,
} from './useAiAssistant.patch';
import { useAiProviderConfig } from './useAiAssistant.provider-config';
import {
  buildConversationCheckpoints,
  buildInitialAgentActivityText,
  collectConversationRuntimeEvents,
  compactRuntimeEvents,
  createMessageId,
  createScopedId,
  getLatestCheckpointEvent,
  type IAiConversationCheckpoint,
  mergeRuntimeEvents,
} from './useAiAssistant.runtime-events';
import { runShellCheckForAppliedPatch } from './useAiAssistant.shellcheck';
import {
  createSidecarLiveEventBuffer,
  extractNewVisibleRuntimeEvents,
  getLatestSidecarLiveEvents,
  getOperationAppliedTime,
  hasMeaningfulAssistantText,
  type ISidecarAnswerStreamMetadata,
  type ISidecarAnswerStreamState,
  isAiEditOperationEntry,
  isNonNegativeFiniteNumber,
  mapStreamStatus,
  mapToolConfirmationDecisionToSidecarDecision,
  resolveSidecarDoneStreamTokenSnapshot,
  resolveSidecarToolProjectionStatus,
  resolveSidecarWaitingStreamStatus,
  type TSidecarStreamTokenSnapshot,
} from './useAiAssistant.stream';

type TAiQuickActionId = 'explain' | 'fix' | 'review';

type TAiFileRollbackStatus = 'ready' | 'reverting' | 'reverted';

const SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT = 12;

type TAgentExecutionStepStatus =
  | 'pending'
  | 'running'
  | 'failed'
  | 'cancelled'
  | 'done'
  | 'skipped';

interface IAgentExecutionStep {
  id: string;
  title: string;
  status: TAgentExecutionStepStatus;
}

interface IActiveAgentPatchTarget {
  runId: string;
  stepId: string;
}

interface ISidecarPatchApplyResult {
  appliedPaths: string[];
  runtimeEvents: TAgentRuntimeEvent[];
  patches: IAiPatchSet[];
  summaries: IAiAgentPatchSummary[];
}

interface IAgentExecutionMessagePatchState {
  patches?: readonly IAiPatchSet[];
  changedFilesSummary?: IAiAgentPatchSummary | null;
}

interface IAedDiffPatchState {
  patches: IAiPatchSet[];
  changedFilesSummary: IAiAgentPatchSummary | null;
}

export type { IAiAttachedFile, IAiImageAttachmentPreview } from '@/types/ai';

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
const MSG_CALL_FAILED = 'AI 调用失败';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public quick actions
// ---------------------------------------------------------------------------

export const useAiAssistant = (options: IUseAiAssistantOptions) => {
  const agentStore = useAiAgentStore();
  const conversationStore = useAiConversationStore();

  const draft = ref('');
  const isSending = ref(false);
  const errorMessage = ref('');

  const {
    config,
    providerLabel,
    loadConfig,
    saveConfig,
    saveCredentials,
    loadTavilyApiKey,
    saveTavilyApiKey,
    testProviderConfig,
    connectProvider,
    testProvider,
  } = useAiProviderConfig({
    workspaceRootPath: options.workspaceRootPath,
    errorMessage,
  });
  const isSettingsOpen = ref(false);
  const isClearDialogOpen = ref(false);
  const currentReferences = ref<IAiContextReference[]>([]);
  const fileRollbackPrompt = ref<IAiFileRollbackPrompt | null>(null);
  const revertingChangedFilesSummaryId = ref<string | null>(null);
  const pinningChangedFilesSummaryId = ref<string | null>(null);
  const runtimeTimelineEvents = shallowRef<TAgentRuntimeEvent[]>([]);
  const activeMode = computed<TAiAssistantMode>({
    get: () => agentStore.mode,
    set: (nextMode) => {
      agentStore.setMode(nextMode);
    },
  });
  const agentSteps = shallowRef<IAgentExecutionStep[]>([]);
  const attachedFiles = shallowRef<IAiAttachedFile[]>([]);
  const restoringCheckpointId = ref<string | null>(null);
  const activeAbortController = ref<AbortController | null>(null);
  const activeStreamId = ref<string | null>(null);
  const activeAgentMessageId = ref<string | null>(null);
  const activeStreamResolve = ref<(() => void) | null>(null);
  const activeAssistantMessage = ref<IAiChatMessage | null>(null);
  const activeAssistantBaseMessages = shallowRef<IAiChatMessage[]>([]);
  const activeSidecarAgentSession = ref<IAiPersistedSidecarAgentSession | null>(null);
  const activeBufferedThreadId = ref<string | null>(null);
  const displayMessages = shallowRef<IAiChatMessage[]>(unref(conversationStore.activeMessages));

  const { maybeGenerateConversationTitle } = useAiConversationTitles({ conversationStore });

  const revokeAttachmentPreview = (file: IAiAttachedFile): void => {
    const src = file.preview?.src;

    if (
      !src?.startsWith('blob:') ||
      typeof URL === 'undefined' ||
      typeof URL.revokeObjectURL !== 'function'
    ) {
      return;
    }

    URL.revokeObjectURL(src);
  };

  const clearAttachedFiles = (options?: { revokePreviews?: boolean }): void => {
    if (options?.revokePreviews !== false) {
      attachedFiles.value.forEach(revokeAttachmentPreview);
    }

    attachedFiles.value = [];
  };

  const replaceAttachedFile = (nextFile: IAiAttachedFile): void => {
    const remainingFiles: IAiAttachedFile[] = [];

    attachedFiles.value.forEach((file) => {
      if (file.id === nextFile.id) {
        revokeAttachmentPreview(file);
        return;
      }

      remainingFiles.push(file);
    });

    attachedFiles.value = [...remainingFiles, nextFile];
  };

  if (getCurrentScope()) {
    onScopeDispose(() => {
      clearAttachedFiles();
    });
  }

  const isConversationWriteBuffered = (): boolean =>
    isSending.value ||
    activeStreamId.value !== null ||
    activeAgentMessageId.value !== null ||
    activeAssistantMessage.value !== null ||
    activeSidecarAgentSession.value !== null ||
    restoringCheckpointId.value !== null;

  const commitDisplayMessagesToStore = (
    threadId: string | null = unref(conversationStore.activeThreadId),
  ): void => {
    if (threadId) {
      conversationStore.replaceThreadMessages(threadId, displayMessages.value);
      return;
    }

    conversationStore.replaceMessages(displayMessages.value);
  };

  const clearActiveBufferedThread = (threadId: string | null): void => {
    if (activeBufferedThreadId.value === threadId) {
      activeBufferedThreadId.value = null;
    }
  };

  const persistSidecarToolConfirmation = (
    confirmation: IAiToolConfirmationRequest,
    session: IAiPersistedSidecarAgentSession,
  ): void => {
    agentStore.setPendingToolConfirmation(confirmation);
    agentStore.setPendingSidecarAgentSession(session);
  };

  const clearSidecarToolConfirmation = (confirmationId?: string): void => {
    agentStore.clearPendingToolConfirmation(confirmationId);

    if (!confirmationId || !agentStore.pendingToolConfirmation) {
      agentStore.clearPendingSidecarAgentSession();
      activeSidecarAgentSession.value = null;
    }
  };

  const clearSidecarToolConfirmationForThread = (threadId: string | null): void => {
    if (agentStore.pendingSidecarAgentSession?.threadId !== threadId) {
      return;
    }

    clearSidecarToolConfirmation();
  };

  // ask_user 反向提问门：与 pendingToolConfirmation 完全对称的一套持久化 / 清理助手。
  // 提问与工具审批互斥地占用同一回合，二者共用同一条 pendingSidecarAgentSession。
  const persistSidecarUserQuestion = (
    question: IAgentSidecarPendingAskUser,
    session: IAiPersistedSidecarAgentSession,
  ): void => {
    agentStore.setPendingUserQuestion(question);
    agentStore.setPendingSidecarAgentSession(session);
  };

  const clearSidecarUserQuestion = (requestId?: string): void => {
    agentStore.clearPendingUserQuestion(requestId);

    if (!requestId || !agentStore.pendingUserQuestion) {
      agentStore.clearPendingSidecarAgentSession();
      activeSidecarAgentSession.value = null;
    }
  };

  const clearSidecarUserQuestionForThread = (threadId: string | null): void => {
    if (agentStore.pendingSidecarAgentSession?.threadId !== threadId) {
      return;
    }

    clearSidecarUserQuestion();
  };

  const syncDisplayMessagesFromActiveThread = (): void => {
    if (!isConversationWriteBuffered()) {
      displayMessages.value = unref(conversationStore.activeMessages);
    }
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
  const activeConversationScrollState = computed<IAiConversationScrollState | null>(
    () => conversationStore.activeThread?.scrollState ?? null,
  );
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
      ...current.stream,
      status: mapStreamStatus(aiStream.status.value),
    };

    messages.value = [...activeAssistantBaseMessages.value, { ...current }];
  };

  watch(
    () => [aiStream.content.value, aiStream.status.value] as const,
    () => {
      syncActiveAssistantMessage();
    },
    { flush: 'sync' },
  );

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

  const findMessageById = (messageId: string): IAiChatMessage | null => {
    const currentMessages = messages.value;
    const messageIndex = findMessageIndexById(currentMessages, messageId);

    return messageIndex >= 0 ? (currentMessages[messageIndex] ?? null) : null;
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

  interface IUpdateAgentExecutionMessageInput {
    messageId: string;
    content: string;
    toolCalls?: IAiChatMessage['toolCalls'];
    streamStatus?: NonNullable<IAiChatMessage['stream']>['status'];
    activityText?: string;
    runtimeEvents?: NonNullable<IAiChatMessage['stream']>['runtimeEvents'];
    finalAnswerStarted?: boolean;
    streamTokenSnapshot?: TSidecarStreamTokenSnapshot;
    patchState?: IAgentExecutionMessagePatchState;
  }

  const updateAgentExecutionMessage = (input: IUpdateAgentExecutionMessageInput): void => {
    const {
      messageId,
      content,
      toolCalls = [],
      streamStatus,
      activityText,
      runtimeEvents,
      finalAnswerStarted,
      streamTokenSnapshot,
      patchState,
    } = input;
    replaceMessageById(messageId, (message) => {
      const nextActivityText = activityText ?? message.stream?.activityText;
      const nextRuntimeEvents = mergeRuntimeEvents(message.stream?.runtimeEvents, runtimeEvents);
      const nextFinalAnswerStarted =
        finalAnswerStarted ??
        message.stream?.finalAnswerStarted ??
        (streamStatus === 'completed' && hasMeaningfulAssistantText(content));
      const nextPromptTokens = isNonNegativeFiniteNumber(streamTokenSnapshot?.promptTokens)
        ? streamTokenSnapshot.promptTokens
        : message.stream?.promptTokens;
      const nextCompletionTokens = isNonNegativeFiniteNumber(streamTokenSnapshot?.completionTokens)
        ? streamTokenSnapshot.completionTokens
        : message.stream?.completionTokens;
      const nextTotalTokens = isNonNegativeFiniteNumber(streamTokenSnapshot?.totalTokens)
        ? streamTokenSnapshot.totalTokens
        : message.stream?.totalTokens;
      const nextUsage = streamTokenSnapshot?.usage ?? message.stream?.usage;
      const stream = streamStatus
        ? {
            ...message.stream,
            status: streamStatus,
            ...(nextActivityText !== undefined ? { activityText: nextActivityText } : {}),
            ...(nextRuntimeEvents?.length ? { runtimeEvents: nextRuntimeEvents } : {}),
            ...(nextFinalAnswerStarted ? { finalAnswerStarted: true } : {}),
            ...(isNonNegativeFiniteNumber(nextPromptTokens)
              ? { promptTokens: nextPromptTokens }
              : {}),
            ...(isNonNegativeFiniteNumber(nextCompletionTokens)
              ? { completionTokens: nextCompletionTokens }
              : {}),
            ...(isNonNegativeFiniteNumber(nextTotalTokens) ? { totalTokens: nextTotalTokens } : {}),
            ...(nextUsage ? { usage: nextUsage } : {}),
          }
        : message.stream;

      return {
        ...message,
        content,
        toolCalls,
        stream,
        ...(patchState?.patches ? { patches: [...patchState.patches] } : {}),
        ...(patchState?.changedFilesSummary !== undefined
          ? { changedFilesSummary: patchState.changedFilesSummary ?? undefined }
          : {}),
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
    const hasActiveSource =
      sidecarAnswerStreamState?.messageId === metadata.messageId &&
      sidecarAnswerStreamState.sourceText.length > 0;

    return metadata.streamStatus === 'completed' &&
      hasActiveSource &&
      sidecarAnswerStream.status.value !== 'completed'
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

    updateAgentExecutionMessage({
      messageId: state.messageId,
      content: sidecarAnswerStream.content.value,
      toolCalls: state.toolCalls,
      streamStatus: resolveSidecarAnswerDisplayStatus(state),
      activityText: state.activityText,
      runtimeEvents: state.runtimeEvents,
      finalAnswerStarted: state.finalAnswerStarted,
      streamTokenSnapshot: state.streamTokenSnapshot,
    });
    commitDisplayMessagesToStore(state.threadId);
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

  const resetSidecarAnswerStreamContent = (metadata: ISidecarAnswerStreamMetadata): string => {
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
    sidecarAnswerStreamState?.messageId === messageId &&
    sidecarAnswerStreamState.sourceText.length > 0;

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
      Boolean(path?.trim()),
    );

    return operationPaths.some((operationPath) =>
      changedFilePaths.some((changedPath) => areFileSystemPathsEqual(operationPath, changedPath)),
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

  const collectUniqueAedDiffPaths = (
    changedFilePaths: readonly string[],
    excludedPaths: readonly string[],
  ): string[] => {
    const paths: string[] = [];
    const seen = new Set<string>();

    for (const path of changedFilePaths) {
      const trimmedPath = path.trim();

      if (!trimmedPath) {
        continue;
      }

      if (
        excludedPaths.some((excludedPath) => areFileSystemPathsEqual(excludedPath, trimmedPath))
      ) {
        continue;
      }

      const normalized = normalizeFileSystemPath(trimmedPath, {
        collapseDuplicateSeparators: true,
        trimTrailingSeparator: true,
      });

      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      paths.push(trimmedPath);
    }

    return paths;
  };

  const loadAedDiffPatchStateForChangedFiles = async (input: {
    changedFilePaths: readonly string[];
    excludedPaths: readonly string[];
    fallbackTaskId: string;
    runId: string;
    stepId: string;
  }): Promise<IAedDiffPatchState | null> => {
    const taskId = activeConversationId.value ?? input.fallbackTaskId;
    const paths = collectUniqueAedDiffPaths(input.changedFilePaths, input.excludedPaths);

    if (!taskId.trim() || paths.length === 0) {
      return null;
    }

    const diffs: IAiEditGetDiffPayload[] = [];

    for (const path of paths) {
      try {
        const diff = await aiEditService.getDiff({ taskId, path });

        if (diff.hunks.length > 0) {
          diffs.push(diff);
        }
      } catch (error) {
        logger.warn({
          event: 'ai.aed_diff_preview.load_failed',
          path,
          err: error,
        });
      }
    }

    if (diffs.length === 0) {
      return null;
    }

    const patches = diffs
      .map(buildAiPatchSetFromAedDiff)
      .filter((patch): patch is IAiPatchSet => patch !== null);
    const changedFilesSummary = buildAiAgentPatchSummaryFromAedDiffs({
      diffs,
      taskId,
      runId: input.runId,
      stepId: input.stepId,
      appliedAt: new Date().toISOString(),
    });

    return patches.length > 0 || changedFilesSummary
      ? {
          patches,
          changedFilesSummary,
        }
      : null;
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
      default:
        return 'running';
    }
  };

  const applySidecarLiveEventsToAgentMessage = (
    assistantMessageId: string,
    threadId: string | null,
    fallbackContent: string,
    events: readonly TAgentUiEvent[],
  ): void => {
    const currentMessage = findMessageById(assistantMessageId);
    const { errorEvent, doneEvent, messageEvent, finalMessageEvent } =
      getLatestSidecarLiveEvents(events);
    const doneResult = hasMeaningfulAssistantText(doneEvent?.result) ? doneEvent.result : null;
    const currentVisibleContent = hasMeaningfulAssistantText(currentMessage?.content)
      ? currentMessage?.content
      : null;
    const content = errorEvent
      ? `Agent 执行失败：${errorEvent.message}`
      : (doneResult ??
        finalMessageEvent?.text ??
        (messageEvent?.text === '' ? '' : (currentVisibleContent ?? fallbackContent)));
    const streamStatus = errorEvent || doneEvent ? 'completed' : 'streaming';
    const finalAnswerStarted = Boolean(
      doneResult ||
        finalMessageEvent ||
        (currentMessage?.stream?.finalAnswerStarted && messageEvent?.text !== ''),
    );
    const toolProjection = projectSidecarEventsToToolState({
      events,
      fallbackActivityText: fallbackContent,
      streamStatus,
    });
    const runtimeEvents = extractNewVisibleRuntimeEvents(events);
    const livePatchState = buildLiveAppliedPatchState(extractSidecarPatchEntries(events));

    for (const toolCall of toolProjection.toolCalls) {
      updateAgentStep(
        toolCall.id,
        toolCall.summary,
        mapSidecarToolCallStatusToStepStatus(toolCall.status),
      );
    }

    const streamMetadata: ISidecarAnswerStreamMetadata = {
      messageId: assistantMessageId,
      threadId,
      toolCalls: toolProjection.toolCalls,
      streamStatus,
      activityText: toolProjection.activityText,
      runtimeEvents,
      finalAnswerStarted,
      streamTokenSnapshot: resolveSidecarDoneStreamTokenSnapshot(doneEvent),
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

    updateAgentExecutionMessage({
      messageId: assistantMessageId,
      content: displayContent,
      toolCalls: toolProjection.toolCalls,
      streamStatus: resolveSidecarAnswerDisplayStatus(streamMetadata),
      activityText: toolProjection.activityText,
      runtimeEvents: runtimeEvents,
      finalAnswerStarted: finalAnswerStarted,
      streamTokenSnapshot: streamMetadata.streamTokenSnapshot,
      patchState: livePatchState,
    });
    commitDisplayMessagesToStore(threadId);
  };

  const appendVisibleRuntimeTimelineEvents = (events: readonly TAgentRuntimeEvent[]): void => {
    if (events.length === 0) {
      return;
    }

    runtimeTimelineEvents.value = mergeRuntimeEvents(runtimeTimelineEvents.value, events) ?? [];
  };

  const appendRuntimeTimelineEvents = (events: readonly TAgentUiEvent[]): void => {
    appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(events));
  };

  const toSidecarMessages = (visibleMessages: IAiChatMessage[]): IAgentSidecarMessage[] => {
    return visibleMessages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: message.content.trim(),
      }))
      .filter((message) => message.content.length > 0)
      .slice(-SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT);
  };

  const applySidecarPatchSets = async (
    patchEntries: readonly ISidecarPatchEntry[],
    turnId: string,
    sessionId: string,
  ): Promise<ISidecarPatchApplyResult> => {
    const appliedPaths: string[] = [];
    const runtimeEvents: TAgentRuntimeEvent[] = [];
    const appliedPatches: IAiPatchSet[] = [];
    const summaries: IAiAgentPatchSummary[] = [];

    for (const patchEntry of patchEntries) {
      const patch = patchEntry.patch;
      const patchMetadata = buildActiveAgentPatchMetadata();
      const result = patchEntry.alreadyApplied
        ? {
            appliedFiles: patch.files.map((file) => ({
              path: file.path,
              byteSize: 0,
            })),
          }
        : await aiService.applyPatch({
            patch,
            metadata: {
              taskId: activeConversationId.value,
              turnId,
              reason: patch.summary,
              toolCallId: 'apply_file_edits',
              confirmedByUser: true,
              workspaceRootPath: options.workspaceRootPath.value,
              ...patchMetadata,
            },
          });
      const currentAppliedPaths = result.appliedFiles.map((file) => file.path);

      syncPatchedDocument(options.document.value, patch, currentAppliedPaths);
      appliedPaths.push(...currentAppliedPaths);
      if (currentAppliedPaths.length > 0) {
        appliedPatches.push(patch);
      }
      runtimeEvents.push(
        ...(await runShellCheckForAppliedPatch({
          patch,
          appliedPaths: currentAppliedPaths,
          runId: patchMetadata?.agentRunId ?? `sidecar:${turnId}`,
          sessionId,
          seqStart: runtimeEvents.length + 1,
        })),
      );

      const taskId = activeConversationId.value ?? turnId;
      const summary = buildAiAgentPatchSummaryFromApplyResult({
        patch,
        applyResult: result,
        taskId,
        runId: patchMetadata?.agentRunId ?? `sidecar:${turnId}`,
        stepId: patchMetadata?.agentStepId ?? 'agent',
        appliedAt: new Date().toISOString(),
      });

      if (summary) {
        summaries.push(summary);
        if (patchMetadata?.agentRunId && patchMetadata.agentStepId) {
          agentPlan.store.appendPatchSummary(summary);
        }
      }
    }

    return {
      appliedPaths,
      runtimeEvents,
      patches: appliedPatches,
      summaries,
    };
  };

  const buildLiveAppliedPatchState = (
    patchEntries: readonly ISidecarPatchEntry[],
  ): IAgentExecutionMessagePatchState | undefined => {
    const appliedEntries = patchEntries.filter((entry) => entry.alreadyApplied);

    if (appliedEntries.length === 0) {
      return undefined;
    }

    for (const entry of appliedEntries) {
      const appliedPaths = entry.patch.files.map((file) => file.path);

      syncPatchedDocument(options.document.value, entry.patch, appliedPaths);
    }

    const patches = appliedEntries.map((entry) => entry.patch);

    return patches.length > 0
      ? {
          patches,
        }
      : undefined;
  };

  interface IFinalizeSidecarTurnContext {
    assistantMessageId: string;
    threadId: string | null;
    fallbackActivityText: string;
    patchTaskId: string;
    patchSessionId: string;
    updateSteps: boolean;
    onPendingConfirmation: (pendingConfirmation: IAiToolConfirmationRequest) => void;
    onPendingUserQuestion: (pendingUserQuestion: IAgentSidecarPendingAskUser) => void;
  }

  const finalizeSidecarTurn = async (
    payload: Awaited<ReturnType<typeof aiService.sidecarChat>>,
    ctx: IFinalizeSidecarTurnContext,
  ): Promise<void> => {
    appendRuntimeTimelineEvents(payload.events);
    const projection = projectSidecarExecuteResponse(payload);
    // ask_user 反向提问门与工具审批门一样,通过响应信封承载;经专用 bridge 投影成待作答门。
    const pendingUserQuestion = extractPendingAskUser(payload);
    const toolProjection = projectSidecarEventsToToolState({
      events: payload.events,
      fallbackActivityText: ctx.fallbackActivityText,
      streamStatus: resolveSidecarToolProjectionStatus(projection),
    });
    const sidecarStreamStatus = resolveSidecarWaitingStreamStatus(projection);
    const streamMetadata: ISidecarAnswerStreamMetadata = {
      messageId: ctx.assistantMessageId,
      threadId: ctx.threadId,
      toolCalls: toolProjection.toolCalls,
      streamStatus: sidecarStreamStatus,
      activityText: toolProjection.activityText,
      runtimeEvents: compactRuntimeEvents(extractVisibleAgentRuntimeEvents(payload.events)),
      finalAnswerStarted: hasMeaningfulAssistantText(projection.assistantContent),
      streamTokenSnapshot: resolveSidecarDoneStreamTokenSnapshot(
        getLatestSidecarLiveEvents(payload.events).doneEvent,
      ),
    };
    if (projection.errorMessage) {
      disposeSidecarAnswerStream(ctx.assistantMessageId);
    }

    const displayContent = projection.errorMessage
      ? projection.assistantContent
      : completeSidecarAnswerStream(projection.assistantContent, streamMetadata);
    const sidecarAnswerCompletion =
      projection.errorMessage || projection.pendingConfirmation || pendingUserQuestion
        ? Promise.resolve()
        : waitForSidecarAnswerStreamCompletion(ctx.assistantMessageId);
    const sidecarPatchEntries = projection.errorMessage
      ? []
      : extractSidecarPatchEntries(payload.events);
    const sidecarPatchResult =
      sidecarPatchEntries.length > 0
        ? await applySidecarPatchSets(sidecarPatchEntries, ctx.patchTaskId, ctx.patchSessionId)
        : { appliedPaths: [], runtimeEvents: [], patches: [], summaries: [] };
    const sidecarAppliedPaths = sidecarPatchResult.appliedPaths;
    const aedDiffPatchState = projection.errorMessage
      ? null
      : await loadAedDiffPatchStateForChangedFiles({
          changedFilePaths: projection.changedFilePaths,
          excludedPaths: sidecarAppliedPaths,
          fallbackTaskId: ctx.patchTaskId,
          runId: `sidecar:${ctx.patchTaskId}`,
          stepId: 'agent',
        });
    const patchSummaries = [
      ...sidecarPatchResult.summaries,
      ...(aedDiffPatchState?.changedFilesSummary ? [aedDiffPatchState.changedFilesSummary] : []),
    ];
    const displayedPatches = [...sidecarPatchResult.patches, ...(aedDiffPatchState?.patches ?? [])];
    const changedFilesSummary = mergeAiAgentPatchSummaries(patchSummaries);
    const patchState =
      displayedPatches.length > 0 || changedFilesSummary
        ? { patches: displayedPatches, changedFilesSummary }
        : undefined;

    if (sidecarPatchResult.runtimeEvents.length > 0) {
      streamMetadata.runtimeEvents = compactRuntimeEvents([
        ...(streamMetadata.runtimeEvents ?? []),
        ...sidecarPatchResult.runtimeEvents,
      ]);
      appendVisibleRuntimeTimelineEvents(sidecarPatchResult.runtimeEvents);
    }

    if (ctx.updateSteps) {
      for (const toolCall of toolProjection.toolCalls) {
        updateAgentStep(
          toolCall.id,
          toolCall.summary,
          mapSidecarToolCallStatusToStepStatus(toolCall.status),
        );
      }
    }

    updateAgentExecutionMessage({
      messageId: ctx.assistantMessageId,
      content: displayContent,
      toolCalls: toolProjection.toolCalls,
      streamStatus: projection.errorMessage
        ? 'completed'
        : resolveSidecarAnswerDisplayStatus(streamMetadata),
      activityText: toolProjection.activityText,
      runtimeEvents: streamMetadata.runtimeEvents,
      finalAnswerStarted: streamMetadata.finalAnswerStarted,
      streamTokenSnapshot: streamMetadata.streamTokenSnapshot,
      patchState: patchState,
    });

    await refreshChangedDocumentsAfterSidecarRun(
      [...projection.changedFilePaths, ...sidecarAppliedPaths],
      projection.hasFileMutations || sidecarAppliedPaths.length > 0,
    );
    await updateFileRollbackPrompt(
      [...projection.changedFilePaths, ...sidecarAppliedPaths],
      projection.hasFileMutations || sidecarAppliedPaths.length > 0,
    );
    await sidecarAnswerCompletion;

    if (projection.pendingConfirmation) {
      ctx.onPendingConfirmation(projection.pendingConfirmation);
      return;
    }

    if (pendingUserQuestion) {
      ctx.onPendingUserQuestion(pendingUserQuestion);
      return;
    }

    clearSidecarToolConfirmation();
    clearSidecarUserQuestion();

    if (!projection.errorMessage) {
      clearAttachedFiles({ revokePreviews: false });
    }

    if (projection.errorMessage) {
      errorMessage.value = projection.errorMessage;
    }
  };

  const failSidecarAgentMessage = (messageId: string, message: string): void => {
    disposeSidecarAnswerStream(messageId);
    updateAgentExecutionMessage({
      messageId,
      content: `Agent 执行失败：${message}`,
      toolCalls: [],
      streamStatus: 'completed',
    });
    errorMessage.value = message;
  };

  const executeSidecarAgentRequest = async (
    visibleMessages: IAiChatMessage[],
    messageContent: string,
    references: IAiContextReference[],
    turnId: string,
    threadId: string | null,