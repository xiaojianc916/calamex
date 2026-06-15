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
      projection.errorMessage || projection.pendingConfirmation
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

    const pendingUserQuestion = extractPendingAskUser(payload);

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
  ): Promise<void> => {
    errorMessage.value = '';
    isSending.value = true;
    agentSteps.value = [];
    runtimeTimelineEvents.value = [];
    clearSidecarToolConfirmation();
    clearSidecarUserQuestion();

    const assistantMessageId = createMessageId('assistant');
    const targetThreadId = threadId;
    activeBufferedThreadId.value = targetThreadId;
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
    commitDisplayMessagesToStore(targetThreadId);
    activeAgentMessageId.value = assistantMessageId;
    activeAbortController.value = new AbortController();
    const sidecarSessionId = `sidecar:${assistantMessageId}`;
    const sidecarContextReferences = buildSidecarContextReferences(references);
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(assistantMessageId, targetThreadId, '', events);
    });
    let unlistenSidecarStream: (() => void) | null = null;

    try {
      unlistenSidecarStream = await subscribeSidecarSessionStream(sidecarSessionId, (event) => {
        liveEventBuffer.push(event);
      });
      const payload = await aiService.sidecarChat({
        sessionId: sidecarSessionId,
        mode: 'agent',
        goal: messageContent,
        messages: toSidecarMessages(visibleMessages),
        workspaceRootPath: options.workspaceRootPath.value,
        context: sidecarContextReferences,
        ...(targetThreadId ? { threadId: targetThreadId } : {}),
      });
      liveEventBuffer.flush();
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;
      await finalizeSidecarTurn(payload, {
        assistantMessageId,
        threadId: targetThreadId,
        fallbackActivityText: initialActivityText,
        patchTaskId: turnId,
        patchSessionId: sidecarSessionId,
        updateSteps: true,
        onPendingConfirmation: (pendingConfirmation) => {
          persistSidecarToolConfirmation(pendingConfirmation, {
            sessionId: payload.sessionId,
            assistantMessageId,
            threadId: targetThreadId,
            turnId,
            baseMessages: visibleMessages,
            messageContent,
            references: sidecarContextReferences,
          });
        },
        onPendingUserQuestion: (pendingUserQuestion) => {
          persistSidecarUserQuestion(pendingUserQuestion, {
            sessionId: payload.sessionId,
            assistantMessageId,
            threadId: targetThreadId,
            turnId,
            baseMessages: visibleMessages,
            messageContent,
            references: sidecarContextReferences,
          });
        },
      });
    } catch (error) {
      if (activeAbortController.value?.signal.aborted) {
        disposeSidecarAnswerStream(assistantMessageId);
      } else {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      commitDisplayMessagesToStore(targetThreadId);
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }
  };

  const resolveSidecarToolConfirmation = async (
    decision: TAiToolConfirmationDecision,
  ): Promise<void> => {
    const session = agentStore.pendingSidecarAgentSession;
    const confirmation = unref(agentPlan.store.pendingToolConfirmation);

    if (!session || !confirmation) {
      errorMessage.value = '当前没有可继续的 Agent 工具确认。';
      return;
    }

    isSending.value = true;
    activeSidecarAgentSession.value = session;
    activeAgentMessageId.value = session.assistantMessageId;
    activeBufferedThreadId.value = session.threadId;
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(
        session.assistantMessageId,
        session.threadId,
        '',
        events,
      );
    });
    let unlistenSidecarStream: (() => void) | null = null;

    try {
      unlistenSidecarStream = await subscribeSidecarSessionStream(session.sessionId, (event) => {
        liveEventBuffer.push(event);
      });
      const payload = await aiService.sidecarResolveApproval({
        sessionId: session.sessionId,
        requestId: confirmation.id,
        decision: mapToolConfirmationDecisionToSidecarDecision(decision),
        goal: session.messageContent,
        messages: toSidecarMessages(session.baseMessages),
        workspaceRootPath: options.workspaceRootPath.value,
        context: session.references,
        ...(session.threadId ? { threadId: session.threadId } : {}),
      });
      liveEventBuffer.flush();
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;
      clearSidecarToolConfirmation(confirmation.id);
      await finalizeSidecarTurn(payload, {
        assistantMessageId: session.assistantMessageId,
        threadId: session.threadId,
        fallbackActivityText: session.messageContent,
        patchTaskId: session.turnId ?? session.assistantMessageId,
        patchSessionId: payload.sessionId,
        updateSteps: false,
        onPendingConfirmation: (pendingConfirmation) => {
          persistSidecarToolConfirmation(pendingConfirmation, {
            ...session,
            sessionId: payload.sessionId,
          });
        },
        onPendingUserQuestion: (pendingUserQuestion) => {
          persistSidecarUserQuestion(pendingUserQuestion, {
            ...session,
            sessionId: payload.sessionId,
          });
        },
      });
    } catch (error) {
      failSidecarAgentMessage(
        session.assistantMessageId,
        toErrorMessage(error, '处理 Agent 工具确认失败。'),
      );
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeAgentMessageId.value = null;
      activeSidecarAgentSession.value = null;
      commitDisplayMessagesToStore(session.threadId);
      clearActiveBufferedThread(session.threadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }
  };

  const resolveSidecarUserQuestion = async (result: IAskUserResult): Promise<void> => {
    const session = agentStore.pendingSidecarAgentSession;
    const question = agentStore.pendingUserQuestion;

    if (!session || !question) {
      errorMessage.value = '当前没有可继续的反向提问。';
      return;
    }

    isSending.value = true;
    activeSidecarAgentSession.value = session;
    activeAgentMessageId.value = session.assistantMessageId;
    activeBufferedThreadId.value = session.threadId;
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(
        session.assistantMessageId,
        session.threadId,
        '',
        events,
      );
    });
    let unlistenSidecarStream: (() => void) | null = null;

    try {
      unlistenSidecarStream = await subscribeSidecarSessionStream(session.sessionId, (event) => {
        liveEventBuffer.push(event);
      });
      const payload = await aiService.sidecarResolveAskUser({
        ...buildAskUserResumeRequest({
          requestId: question.requestId,
          result,
          sessionId: session.sessionId,
        }),
        goal: session.messageContent,
        messages: toSidecarMessages(session.baseMessages),
        workspaceRootPath: options.workspaceRootPath.value,
        context: session.references,
        ...(session.threadId ? { threadId: session.threadId } : {}),
      });
      liveEventBuffer.flush();
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;
      clearSidecarUserQuestion(question.requestId);
      await finalizeSidecarTurn(payload, {
        assistantMessageId: session.assistantMessageId,
        threadId: session.threadId,
        fallbackActivityText: session.messageContent,
        patchTaskId: session.turnId ?? session.assistantMessageId,
        patchSessionId: payload.sessionId,
        updateSteps: false,
        onPendingConfirmation: (pendingConfirmation) => {
          persistSidecarToolConfirmation(pendingConfirmation, {
            ...session,
            sessionId: payload.sessionId,
          });
        },
        onPendingUserQuestion: (pendingUserQuestion) => {
          persistSidecarUserQuestion(pendingUserQuestion, {
            ...session,
            sessionId: payload.sessionId,
          });
        },
      });
    } catch (error) {
      failSidecarAgentMessage(
        session.assistantMessageId,
        toErrorMessage(error, '处理反向提问失败。'),
      );
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeAgentMessageId.value = null;
      activeSidecarAgentSession.value = null;
      commitDisplayMessagesToStore(session.threadId);
      clearActiveBufferedThread(session.threadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }
  };
  // -----------------------------------------------------------------------
  // Computed
  // -----------------------------------------------------------------------

  const sendButtonLabel = computed(() => (isSending.value ? '发送中…' : '发送'));

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

  const buildReferences = async (): Promise<IAiContextReference[]> =>
    attachedFiles.value.map((file) => file.reference);

  const buildSidecarToolReferences = (): IAiContextReference[] => {
    const currentFile = buildCurrentFileReference(options.document.value);

    return currentFile ? [currentFile] : [];
  };

  const buildSidecarContextReferences = (
    references: IAiContextReference[] = currentReferences.value,
  ): IAiContextReference[] => {
    const seen = new Set<string>();
    const merged: IAiContextReference[] = [];

    for (const reference of [...references, ...buildSidecarToolReferences()]) {
      if (seen.has(reference.id)) {
        continue;
      }

      seen.add(reference.id);
      merged.push(reference);
    }

    return merged;
  };

  // -----------------------------------------------------------------------
  // Quick actions / attachments
  // -----------------------------------------------------------------------

  const applyQuickAction = (action: IAiQuickAction): void => {
    draft.value = buildQuickPrompt(action.id);

    void buildReferences().then((references) => {
      currentReferences.value = references;
    });

    errorMessage.value = '';
  };

  const attachFile = async (file: File): Promise<boolean> => {
    const normalizedName = normalizeAttachmentName(file);

    if (isTextAttachment(file)) {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
        errorMessage.value = `附件超过 ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)}，请先拆分或只粘贴关键片段。`;
        return false;
      }

      const content = await file.text().catch((): null => null);

      if (content === null) {
        errorMessage.value = '读取附件失败，请确认文件可访问后重试。';
        return false;
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

      replaceAttachedFile({
        id,
        name: normalizedName,
        sizeLabel: formatBytes(file.size),
        kind: 'text',
        reference,
      });

      currentReferences.value = await buildReferences();
      errorMessage.value = '';

      return true;
    }

    if (isImageAttachment(file)) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        errorMessage.value = `图片超过 ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)}，请压缩后再试。`;
        return false;
      }

      const signature = await createImageAttachmentSignature(file);
      const id = `attachment:${signature}`;

      if (attachedFiles.value.some((attachment) => attachment.id === id)) {
        return true;
      }

      const attachmentName = createUniqueAttachmentName(normalizedName, attachedFiles.value);
      const previewSource = await createImagePreviewSource(file);
      const dimensions = await readImageDimensions(file, previewSource);
      const dimensionsLabel = formatImageDimensions(dimensions);
      const preview: IAiImageAttachmentPreview | undefined = previewSource
        ? {
            src: previewSource,
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
            mimeType: file.type || 'image/*',
          }
        : undefined;

      const reference: IAiContextReference = {
        id,
        kind: 'image-attachment',
        label: `图片附件 · ${attachmentName}`,
        path: attachmentName,
        range: null,
        contentPreview: [
          `文件名：${attachmentName}`,
          `类型：${file.type || 'image/*'}`,
          `大小：${formatBytes(file.size)}`,
          ...(dimensionsLabel ? [`尺寸：${dimensionsLabel}`] : []),
          '说明：这是用户在 AI 输入框里粘贴或添加的图片附件。当前会把图片元信息作为上下文发送。',
        ].join('\n'),
        redacted: false,
        attachmentPreview: preview,
      };

      replaceAttachedFile({
        id,
        name: attachmentName,
        sizeLabel: formatBytes(file.size),
        kind: 'image',
        detailLabel: dimensionsLabel ?? undefined,
        preview,
        reference,
      });

      currentReferences.value = await buildReferences();
      errorMessage.value = '';

      return true;
    }

    errorMessage.value = '当前只支持文本文件和图片作为 AI 上下文附件。';
    return false;
  };

  const removeAttachedFile = (id: string): void => {
    const remainingFiles: IAiAttachedFile[] = [];

    attachedFiles.value.forEach((file) => {
      if (file.id === id) {
        revokeAttachmentPreview(file);
        return;
      }

      remainingFiles.push(file);
    });

    attachedFiles.value = remainingFiles;

    void buildReferences().then((references) => {
      currentReferences.value = references;
    });
  };

  // -----------------------------------------------------------------------
  // Streaming pipeline
  // -----------------------------------------------------------------------

  const executeAiRequest = async (
    requestMessages: IAiChatMessage[],
    visibleMessages: IAiChatMessage[],
    references: IAiContextReference[],
    threadId: string | null,
  ): Promise<void> => {
    // chat 模式现走 ACP:后端 chat_stream_via_acp 回填 sessionId,投影事件
    // (message_delta / done / error)落在 ai:sidecar-stream,复用 agent 同款消费机制。
    errorMessage.value = '';
    isSending.value = true;
    activeBufferedThreadId.value = threadId;

    const assistantMessageId = createMessageId('assistant');
    const targetThreadId = threadId;
    const placeholderMessage: IAiChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      references: [],
      stream: {
        status: 'streaming',
      },
    };

    messages.value = [...visibleMessages, placeholderMessage];
    commitDisplayMessagesToStore(targetThreadId);
    activeAgentMessageId.value = assistantMessageId;
    activeAbortController.value = new AbortController();
    const requestAbortController = activeAbortController.value;

    let hasSettledStream = false;
    const settle = (): void => {
      hasSettledStream = true;
      activeStreamResolve.value?.();
    };

    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      if (requestAbortController.signal.aborted) {
        return;
      }
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(assistantMessageId, targetThreadId, '', events);

      const { doneEvent, errorEvent } = getLatestSidecarLiveEvents(events);

      if (errorEvent) {
        errorMessage.value = errorEvent.message;
      }

      if (doneEvent || errorEvent) {
        settle();
      }
    });
    let sidecarStream: Awaited<ReturnType<typeof subscribeSidecarStreamWithPrebuffer>> | null =
      null;

    try {
      sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {
        if (requestAbortController.signal.aborted) {
          return;
        }
        liveEventBuffer.push(event);
      });

      const stream = await aiService.chatStream({
        threadId,
        messages: requestMessages,
        references,
      });

      activeStreamId.value = stream.streamId;

      const sessionId = stream.sessionId;

      if (!sessionId) {
        throw new Error('AI 流式响应缺少 sessionId,无法订阅 ACP 流。');
      }

      sidecarStream.bind(sessionId);

      if (requestAbortController.signal.aborted) {
        settle();
      }

      await new Promise<void>((resolve) => {
        if (hasSettledStream) {
          resolve();
          return;
        }

        activeStreamResolve.value = resolve;
      });

      liveEventBuffer.flush();

      if (!errorMessage.value) {
        clearAttachedFiles({ revokePreviews: false });
      }
    } catch (error) {
      if (requestAbortController.signal.aborted) {
        disposeSidecarAnswerStream(assistantMessageId);
      } else {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      sidecarStream?.dispose();
      activeStreamResolve.value = null;
      activeStreamId.value = null;
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      commitDisplayMessagesToStore(targetThreadId);
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
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

    restoringCheckpointId.value = checkpointId;
    errorMessage.value = '';

    try {
      // 对话 checkpoint 只负责回到历史消息边界；文件改动回滚继续走 AED 操作入口。
      const nextMessages = messages.value.slice(0, targetMessageIndex + 1);
      messages.value = nextMessages;
      runtimeTimelineEvents.value = collectConversationRuntimeEvents(nextMessages);
      fileRollbackPrompt.value = null;
      agentSteps.value = [];
      clearSidecarToolConfirmation();
      clearSidecarUserQuestion();
      activeAgentMessageId.value = null;
      agentPlan.resetPlan();
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value = toErrorMessage(error, '恢复回滚检查点失败');
    } finally {
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
    activeBufferedThreadId.value = titleThreadId;

    let references: IAiContextReference[];

    try {
      references = await buildReferences();
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
      commitDisplayMessagesToStore(titleThreadId);
      clearActiveBufferedThread(titleThreadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
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
    clearAttachedFiles({ revokePreviews: false });

    if (activeMode.value === 'agent') {
      await executeSidecarAgentRequest(
        nextMessages,
        messageContent,
        references,
        userMessage.id,
        titleThreadId,
      );

      if (!errorMessage.value) {
        void maybeGenerateConversationTitle(titleThreadId);
      }

      return;
    }

    if (activeMode.value === 'plan') {
      agentSteps.value = [];
      let planSucceeded = false;

      try {
        const planResult = await agentPlan.createPlan(
          messageContent,
          buildSidecarContextReferences(references),
          options.workspaceRootPath.value,
          titleThreadId ? { threadId: titleThreadId } : {},
        );

        agentSteps.value = planResult.steps.map((step) => ({
          id: step.id,
          title: step.title,
          status: step.status,
        }));

        messages.value = nextMessages;
        clearAttachedFiles({ revokePreviews: false });
        planSucceeded = true;
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
      } finally {
        commitDisplayMessagesToStore(titleThreadId);
        clearActiveBufferedThread(titleThreadId);
        isSending.value = false;
        syncDisplayMessagesFromActiveThread();
        if (planSucceeded) {
          void maybeGenerateConversationTitle(titleThreadId);
        }
      }

      return;
    }
    if (activeMode.value === 'chat') {
      try {
        await executeAiRequest(nextMessages, nextMessages, references, titleThreadId);
        if (!errorMessage.value) {
          void maybeGenerateConversationTitle(titleThreadId);
        }
      } catch (error) {
        errorMessage.value = toErrorMessage(error, MSG_CALL_FAILED);
      }
      return;
    }

    const exhaustiveModeCheck: never = activeMode.value;
    throw new Error(`未处理的 AI 助手模式：${String(exhaustiveModeCheck)}`);
  };

  // -----------------------------------------------------------------------
  // Conversation / patch
  // -----------------------------------------------------------------------

  const resetConversationUiState = (): void => {
    draft.value = '';
    currentReferences.value = [];
    agentSteps.value = [];
    fileRollbackPrompt.value = null;
    revertingChangedFilesSummaryId.value = null;
    runtimeTimelineEvents.value = [];

    clearAttachedFiles();
    errorMessage.value = '';
    activeAssistantMessage.value = null;
    activeAssistantBaseMessages.value = [];
    activeAgentMessageId.value = null;
    disposeSidecarAnswerStream();
    isClearDialogOpen.value = false;
  };

  const clearConversation = (): void => {
    clearSidecarToolConfirmationForThread(unref(conversationStore.activeThreadId));
    clearSidecarUserQuestionForThread(unref(conversationStore.activeThreadId));
    conversationStore.clearActiveThread();
    resetConversationUiState();
    agentPlan.resetPlan();
  };

  const deleteConversation = (threadId: string): boolean => {
    const wasActiveThread = unref(conversationStore.activeThreadId) === threadId;
    const deleted = conversationStore.deleteThread(threadId);

    if (!deleted) {
      return false;
    }

    clearSidecarToolConfirmationForThread(threadId);
    clearSidecarUserQuestionForThread(threadId);

    if (wasActiveThread) {
      resetConversationUiState();
      agentPlan.resetPlan();
    } else {
      syncDisplayMessagesFromActiveThread();
    }

    return true;
  };

  const startNewConversation = (): void => {
    conversationStore.startNewThread();
    resetConversationUiState();
    agentPlan.resetPlan();
  };

  const switchConversation = (threadId: string): void => {
    conversationStore.switchThread(threadId);
    resetConversationUiState();
  };

  const updateConversationScrollState = (scrollState: IAiConversationScrollState): void => {
    const threadId = activeConversationId.value;

    if (!threadId) {
      return;
    }

    conversationStore.updateThreadScrollState(threadId, scrollState);
  };

  const rollbackLatestFileChange = async (): Promise<void> => {
    const prompt = fileRollbackPrompt.value;

    if (prompt?.status !== 'ready') {
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

  const rollbackChangedFilesSummary = async (
    messageId: string,
    summaryId: string,
  ): Promise<void> => {
    if (isSending.value || revertingChangedFilesSummaryId.value) {
      return;
    }

    const message = findMessageById(messageId);
    const summary = message?.changedFilesSummary;

    if (!message || !summary || summary.id !== summaryId) {
      errorMessage.value = '未找到可回滚的文件变更。';
      return;
    }

    if (summary.revertedAt) {
      return;
    }

    revertingChangedFilesSummaryId.value = summaryId;
    errorMessage.value = '';

    const restoredFilePaths: string[] = [];

    try {
      const checkpointEvent = getLatestCheckpointEvent(message);

      if (checkpointEvent) {
        try {
          const restorePayload = await aiService.sidecarRestoreCheckpoint({
            sessionId: createScopedId('mastra-rollback'),
            runId: checkpointEvent.runId,
            snapshotId: checkpointEvent.snapshotId?.trim() || checkpointEvent.runId,
          });
          const restoreRuntimeEvents = compactRuntimeEvents(
            extractVisibleAgentRuntimeEvents(restorePayload.events),
          );

          if (restoreRuntimeEvents.length > 0) {
            appendVisibleRuntimeTimelineEvents(restoreRuntimeEvents);
            messages.value = messages.value.map((item) =>
              item.id === messageId
                ? {
                    ...item,
                    stream: {
                      ...(item.stream ?? { status: 'completed' }),
                      runtimeEvents: mergeRuntimeEvents(
                        item.stream?.runtimeEvents,
                        restoreRuntimeEvents,
                      ),
                    },
                  }
                : item,
            );
          }
        } catch (error) {
          logger.warn({
            event: 'ai.changed_files_summary.mastra_rollback_failed',
            summaryId,
            err: error,
          });
        }
      }

      const taskId = parseAiAedPatchRef(summary.patchRef);

      if (taskId) {
        try {
          const revertResult = await aiEditService.revertTask({ taskId });

          restoredFilePaths.push(...revertResult.restoredFiles);
        } catch (error) {
          logger.warn({
            event: 'ai.changed_files_summary.aed_revert_task_failed',
            summaryId,
            taskId,
            err: error,
          });
        }
      }

      if (restoredFilePaths.length === 0) {
        const reversePatch = buildReversePatchSet(message.patches, summary);

        if (!reversePatch) {
          throw new Error('没有可用于回滚的 AED task 或反向 patch。');
        }

        const reverseResult = await aiService.applyPatch({
          patch: reversePatch,
          metadata: {
            taskId: activeConversationId.value,
            turnId: messageId,
            reason: reversePatch.summary,
            toolCallId: 'rollback_changed_files_summary',
            confirmedByUser: true,
            workspaceRootPath: options.workspaceRootPath.value,
          },
        });

        restoredFilePaths.push(...reverseResult.appliedFiles.map((file) => file.path));
      }

      await refreshChangedDocumentsAfterSidecarRun(restoredFilePaths, restoredFilePaths.length > 0);

      const revertedAt = new Date().toISOString();

      messages.value = messages.value.map((item) =>
        item.id === messageId && item.changedFilesSummary?.id === summaryId
          ? {
              ...item,
              changedFilesSummary: {
                ...item.changedFilesSummary,
                revertedAt,
              },
            }
          : item,
      );
      fileRollbackPrompt.value = null;
      commitDisplayMessagesToStore();
    } catch (error) {
      errorMessage.value = toErrorMessage(error, '回滚文件变更失败');
    } finally {
      revertingChangedFilesSummaryId.value = null;
    }
  };

  const setChangedFilesSummaryPin = async (
    messageId: string,
    summaryId: string,
    pinned: boolean,
  ): Promise<void> => {
    if (pinningChangedFilesSummaryId.value) {
      return;
    }

    const message = findMessageById(messageId);
    const summary = message?.changedFilesSummary;

    if (!message || !summary || summary.id !== summaryId) {
      errorMessage.value = '未找到可钉住的文件变更。';
      return;
    }

    const taskId = parseAiAedPatchRef(summary.patchRef);
    if (!taskId) {
      errorMessage.value = '当前变更没有可钉住的 AED 任务。';
      return;
    }

    pinningChangedFilesSummaryId.value = summaryId;
    errorMessage.value = '';

    try {
      await aiEditService.setPin({
        targetType: 'task',
        targetId: taskId,
        pinned,
      });

      messages.value = messages.value.map((item) =>
        item.id === messageId && item.changedFilesSummary?.id === summaryId
          ? {
              ...item,
              changedFilesSummary: {
                ...item.changedFilesSummary,
                pinned,
              },
            }
          : item,
      );
      commitDisplayMessagesToStore();
    } catch (error) {
      errorMessage.value = toErrorMessage(error, '更新 AED Pin 状态失败');
    } finally {
      pinningChangedFilesSummaryId.value = null;
    }
  };

  const stopCurrentRequest = (): void => {
    const targetThreadId =
      activeSidecarAgentSession.value?.threadId ??
      activeBufferedThreadId.value ??
      unref(conversationStore.activeThreadId);
    const streamId = activeStreamId.value;

    if (streamId) {
      void aiService.cancel({ streamId, threadId: targetThreadId ?? null });
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
        ...activeAssistantMessage.value.stream,
        status: 'cancelled',
      };
      activeAssistantMessage.value.content = aiStream.content.value;

      messages.value = [...activeAssistantBaseMessages.value, { ...activeAssistantMessage.value }];
    }

    if (activeAgentMessageId.value) {
      const activeMessageId = activeAgentMessageId.value;
      const currentMessage = findMessageById(activeMessageId);
      const isChatStreamCancellation = Boolean(streamId);

      updateAgentExecutionMessage({
        messageId: activeMessageId,
        content: isChatStreamCancellation ? (currentMessage?.content ?? '') : 'Agent 执行已取消。',
        toolCalls: isChatStreamCancellation ? (currentMessage?.toolCalls ?? []) : [],
        streamStatus: 'cancelled',
      });
      activeAgentMessageId.value = null;
    }

    clearSidecarToolConfirmation();
    clearSidecarUserQuestion();
    commitDisplayMessagesToStore(targetThreadId);
    clearActiveBufferedThread(targetThreadId);
    isSending.value = false;
    syncDisplayMessagesFromActiveThread();
    errorMessage.value = '';
  };

  // -----------------------------------------------------------------------
  // Built-in browser selection inbox
  // -----------------------------------------------------------------------

  const webSelectionInbox = useAiWebSelectionInbox();

  const MAX_WEB_SELECTION_HTML_CHARS = 2_000;

  const buildWebSelectionMessage = (selection: IAiWebSelectionContext): string => {
    const htmlSnippet =
      selection.outerHtml.length > MAX_WEB_SELECTION_HTML_CHARS
        ? `${selection.outerHtml.slice(0, MAX_WEB_SELECTION_HTML_CHARS)}…`
        : selection.outerHtml;
    const lines = [
      '我从内置浏览器选中了一个页面元素作为上下文：',
      `- 元素：${selection.label}`,
      `- 页面：${selection.url}`,
    ];

    const comment = selection.comment.trim();

    if (comment) {
      lines.push(`- 备注：${comment}`);
    }

    lines.push('', '元素 HTML：', '```html', htmlSnippet, '```');

    return lines.join('\n');
  };

  const appendWebSelectionToDraft = (message: string): void => {
    draft.value = draft.value.trim() ? `${draft.value.trimEnd()}\n\n${message}` : message;
  };

  watch(
    () => webSelectionInbox.pendingSelection.value,
    (selection) => {
      if (!selection) {
        return;
      }

      webSelectionInbox.consumeSelection();

      const message = buildWebSelectionMessage(selection);

      if (isSending.value) {
        appendWebSelectionToDraft(message);
        return;
      }

      draft.value = message;
      void sendMessage();
    },
  );

  // -----------------------------------------------------------------------
  // Public surface
  // -----------------------------------------------------------------------

  return {
    agentPlan,
    config,
    messages,
    historyThreads,
    activeConversationId,
    activeConversationScrollState,
    draft,
    isSending,
    error: errorMessage,
    providerLabel,
    isSettingsOpen,
    isClearDialogOpen,
    currentReferences,
    conversationCheckpoints,
    fileRollbackPrompt,
    revertingChangedFilesSummaryId,
    pinningChangedFilesSummaryId,
    runtimeTimelineEvents,
    activeMode,
    agentSteps,
    attachedFiles,
    restoringCheckpointId,
    sendButtonLabel,
    // provider config actions
    loadConfig,
    saveConfig,
    saveCredentials,
    loadTavilyApiKey,
    saveTavilyApiKey,
    testProviderConfig,
    connectProvider,
    testProvider,
    // quick actions / attachments
    applyQuickAction,
    attachFile,
    removeAttachedFile,
    // conversation lifecycle
    sendMessage,
    restoreConversationCheckpoint,
    resolveSidecarToolConfirmation,
    resolveSidecarUserQuestion,
    clearConversation,
    deleteConversation,
    startNewConversation,
    switchConversation,
    updateConversationScrollState,
    // file rollback / patch summary
    rollbackLatestFileChange,
    rollbackChangedFilesSummary,
    setChangedFilesSummaryPin,
    stopCurrentRequest,
  };
};
