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
import { subscribeSidecarSessionStream } from '@/composables/ai/sidecar-stream-listener';
import { useAcpAvailableCommands } from '@/composables/ai/useAcpAvailableCommands';
import { useAcpSessionConfigOptions } from '@/composables/ai/useAcpSessionConfigOptions';
import { useAcpUsage } from '@/composables/ai/useAcpUsage';
import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';
import {
  type IAiWebSelectionContext,
  useAiWebSelectionInbox,
} from '@/composables/ai/useAiWebSelectionInbox';
import { useSidecarChangedDocumentRefresh } from '@/composables/useSidecarChangedDocumentRefresh';
import { aiService } from '@/services/ipc/ai.service';
import { buildCurrentFileReference } from '@/services/ipc/ai-context.service';
import { aiEditService } from '@/services/ipc/ai-edit.service';
import { type IAiPersistedSidecarAgentSession, useAiAgentStore } from '@/store/aiAgent';
import { useAiThreadStore } from '@/store/aiThread';
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
import type { IAiConversationScrollState } from '@/types/ai/conversation.schema';
import type { IAiEditGetDiffPayload, IAiEditOperation } from '@/types/ai/edit';
import type {
  IAgentSidecarMessage,
  IAskUserResult,
  TAgentBackendKind,
  TAgentRuntimeEvent,
  TAgentUiEvent,
} from '@/types/ai/sidecar';
import type { IAiThread, IAiThreadAssistantMessageEntry, IAiThreadEntry } from '@/types/ai/thread';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';

import { toErrorMessage } from '@/utils/error/error';
import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/file/path';
import { logger } from '@/utils/platform/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

import { extractDocumentText, isDocumentAttachment } from './attachment-document-text';
// [auto-split imports]
import { buildLiveThreadFromSidecarEvents } from './live-thread-from-sidecar';
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
  buildConversationCheckpointsFromEntries,
  buildInitialAgentActivityText,
  collectConversationRuntimeEventsFromEntries,
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
  getLatestSidecarLiveEvents,
  getOperationAppliedTime,
  hasMeaningfulAssistantText,
  type ISidecarAnswerStreamMetadata,
  isAiEditOperationEntry,
  mapToolConfirmationDecisionToSidecarDecision,
  resolveSidecarDoneStreamTokenSnapshot,
  resolveSidecarToolProjectionStatus,
  resolveSidecarWaitingStreamStatus,
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
const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
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
  const aiThreadStore = useAiThreadStore();
  // ④.1 §D：编排器消息读写真源收敛到 aiThread 权威 entries（drop-in）。conversationStore
  // 别名保留以最小化触点；活动/历史线程改读 legacy 形状 getter（activeConversationThread /
  // conversationHistoryThreads），其余面（activeMessages / activeThreadId / replace* / 生命周期）1:1 同名。
  const conversationStore = aiThreadStore;

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
  const activeSidecarAgentSession = ref<IAiPersistedSidecarAgentSession | null>(null);
  const activeBufferedThreadId = ref<string | null>(null);

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

  interface ISidecarLiveRenderState {
    stream: NonNullable<IAiChatMessage['stream']>;
    patches: IAiChatMessage['patches'];
    // 收尾注入的最终回答正文（live 帧不传）：reduce 无 delta 时也把最终答案落进权威 entries。
    finalContent?: string;
    // 收尾注入的内联 diff 汇总：作为 changed_files entry 落库，逆投影回挂到该 assistant。
    changedFilesSummary?: IAiAgentPatchSummary | null;
  }

  const updateLiveThreadFromSidecarEvents = (
    assistantMessageId: string,
    threadId: string | null,
    events: readonly TAgentUiEvent[],
    liveRenderState: ISidecarLiveRenderState,
  ): void => {
    const activeThreadId = unref(conversationStore.activeThreadId);
    // 回合线程是否仍是当前可见线程：是则覆盖活动投影；否则该回合已被切到后台，仍需把本回合 reduce 态
    // 写回「发起会话」的权威 entries（避免回来后内容清空），但不改活动线程。
    const isActiveTarget = threadId === null || threadId === activeThreadId;
    const targetThread = isActiveTarget
      ? aiThreadStore.authoritativeActiveThread
      : (aiThreadStore.authoritativeHistoryThreads.find((thread) => thread.id === threadId) ??
        null);
    if (!targetThread) {
      return;
    }
    // entries 唯一真源：直接以权威 entries 为 seed，剔除本回合占位 assistant entry（buildLive 会重建），
    // 不再经 legacy 形状往返（threadToLegacyThread → legacyThreadToThread）。
    const seedThread: IAiThread = {
      ...targetThread,
      entries: targetThread.entries.filter((entry) => entry.id !== assistantMessageId),
    };
    const liveThread = buildLiveThreadFromSidecarEvents(events, {
      baseThread: seedThread,
      assistantMessageId,
      now: new Date().toISOString(),
    });
    // reduce 回放出的 assistant entry 不带 stream（runtimeEvents/token/活动文案）。
    // 用本回合实时算出的 stream/patches 富集该 entry——不再回读 legacy displayMessages（已退役）。
    const hasPatches = Boolean(liveRenderState.patches && liveRenderState.patches.length > 0);
    const finalContentRaw = liveRenderState.finalContent;
    const finalText =
      typeof finalContentRaw === 'string' && finalContentRaw.length > 0 ? finalContentRaw : null;
    // 本回合的 assistant_message 段（Zed 多段：messageId / messageId#n）。stream/patches/最终答案
    // 兜底只增益「最后一段」（最终答复所在段），与顶层 tool_call entry 的单一表示互不干扰。
    const turnSegmentIndices = liveThread.entries.flatMap((entry, idx) =>
      entry.type === 'assistant_message' &&
      (entry.id === assistantMessageId || entry.id.startsWith(`${assistantMessageId}#`))
        ? [idx]
        : [],
    );
    const lastSegmentIndex = turnSegmentIndices.at(-1) ?? -1;
    const matchedAssistantEntry = lastSegmentIndex >= 0;
    // 本回合是否已流式出任意 message 正文（跨所有段）：是则保留已交错的 chunks，不再注入最终答案。
    const hasStreamedMessageText = turnSegmentIndices.some((idx) => {
      const segment = liveThread.entries[idx] as IAiThreadAssistantMessageEntry;
      return segment.chunks.some(
        (chunk) =>
          chunk.type === 'message' && chunk.block.type === 'text' && chunk.block.text.length > 0,
      );
    });
    const entries = liveThread.entries.map((entry, idx) => {
      if (entry.type !== 'assistant_message' || idx !== lastSegmentIndex) {
        return entry;
      }
      const nextChunks: IAiThreadAssistantMessageEntry['chunks'] =
        finalText !== null && !hasStreamedMessageText
          ? [...entry.chunks, { type: 'message', block: { type: 'text', text: finalText } }]
          : entry.chunks;
      return {
        ...entry,
        chunks: nextChunks,
        stream: liveRenderState.stream,
        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),
      };
    });
    // reduce 因本回合无 assistant delta/block 而未建 assistant entry 时（直接给最终答案、
    // 或仅 done 带正文），收尾按 assistantMessageId 补建一条，保证最终正文/stream/token 落地。
    if (!matchedAssistantEntry) {
      // reduce 未建 assistant entry（无 delta / 纯工具或 patch 帧）时也补一条，保证 stream/token/patches/正文落地；
      // 无最终正文则用空 chunks 占位（流式中的工具/patch 帧据此挂载），逆投影把尾随工具并入本条。
      const appendedEntry: IAiThreadEntry = {
        type: 'assistant_message',
        id: assistantMessageId,
        createdAt: new Date().toISOString(),
        chunks:
          finalText !== null ? [{ type: 'message', block: { type: 'text', text: finalText } }] : [],
        stream: liveRenderState.stream,
        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),
      };
      entries.push(appendedEntry);
    }
    // 内联 diff 汇总作为 changed_files entry 落库；逆投影把它回挂到最近一条 assistant 消息。
    const liveChangedFilesSummary = liveRenderState.changedFilesSummary;
    if (liveChangedFilesSummary) {
      const changedFilesEntry: IAiThreadEntry = {
        type: 'changed_files',
        id: liveChangedFilesSummary.id,
        createdAt: liveChangedFilesSummary.appliedAt ?? new Date().toISOString(),
        summary: liveChangedFilesSummary,
      };
      entries.push(changedFilesEntry);
    }
    const enrichedThread = {
      ...liveThread,
      entries,
    };
    if (isActiveTarget) {
      aiThreadStore.overlayStreamingActiveThread(enrichedThread);
    } else {
      // 后台（已切走）线程：按 id 覆盖其权威 entries（不改活动线程），不再经 messages 往返。
      aiThreadStore.overlayStreamingThread(enrichedThread);
    }
  };

  const messages = computed<IAiChatMessage[]>({
    // 读真源 = 权威 entries（activeMessages）；影子缓冲已退役。
    get: () => unref(conversationStore.activeMessages),
    set: (nextMessages: IAiChatMessage[]) => {
      // 写真源单写者 = 权威 store，无条件提交（reduce / overlay 幂等）。
      const activeThreadId = unref(conversationStore.activeThreadId);
      if (activeThreadId) {
        conversationStore.replaceThreadMessages(activeThreadId, nextMessages);
      } else {
        conversationStore.replaceMessages(nextMessages);
      }
    },
  });

  const historyThreads = computed(() => aiThreadStore.authoritativeHistoryThreads);
  const activeConversationId = computed(() => unref(conversationStore.activeThreadId));
  const activeConversationScrollState = computed<IAiConversationScrollState | null>(
    () => conversationStore.activeConversationThread?.scrollState ?? null,
  );
  const conversationCheckpoints = computed<IAiConversationCheckpoint[]>(() =>
    buildConversationCheckpointsFromEntries(aiThreadStore.authoritativeActiveEntries),
  );

  const agentPlan = useAiAgentPlan();
  const acpAvailableCommands = useAcpAvailableCommands();
  const acpUsage = useAcpUsage();
  const acpSessionConfigOptions = useAcpSessionConfigOptions();
  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();

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

  const getAssistantEntry = (messageId: string): IAiThreadAssistantMessageEntry | null => {
    for (const entry of aiThreadStore.authoritativeActiveEntries) {
      if (entry.type === 'assistant_message' && entry.id === messageId) {
        return entry;
      }
    }

    return null;
  };

  const getChangedFilesSummary = (summaryId: string): IAiAgentPatchSummary | null => {
    for (const entry of aiThreadStore.authoritativeActiveEntries) {
      if (entry.type === 'changed_files' && entry.id === summaryId) {
        return entry.summary;
      }
    }

    return null;
  };

  const patchAssistantEntry = (
    messageId: string,
    updater: (entry: IAiThreadAssistantMessageEntry) => IAiThreadAssistantMessageEntry,
  ): void => {
    aiThreadStore.patchActiveThreadEntries((entries) =>
      entries.map((entry) =>
        entry.type === 'assistant_message' && entry.id === messageId ? updater(entry) : entry,
      ),
    );
  };

  const readAssistantEntryText = (entry: IAiThreadAssistantMessageEntry): string =>
    entry.chunks
      .flatMap((chunk) =>
        chunk.type === 'message' && chunk.block.type === 'text' ? [chunk.block.text] : [],
      )
      .join('');

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

  const applyAcpReceiveSideEvents = (events: readonly TAgentUiEvent[]): void => {
    // 接收侧宿主接线（ADR-20260617 · D7 接收侧）：把宿主唯一 onSidecarStream 路由到的
    // ACP session/update UI 事件分发到各 ACP composable VM。终端走客户端方法、审批走
    // finalizeSidecarTurn 的 pendingConfirmation，均不经本事件流，故不在此路由。
    // 累计事件每 tick 整份重扫，与既有 reduceAcpUiEventsToToolCalls / projectSidecarEventsToToolState
    // 同构；各 applier 均「整份替换、后者胜」，故重扫幂等。非穷尽 switch（default 兜底），
    // 新增 TAgentUiEvent 成员不会在此触发编译错误。
    for (const event of events) {
      switch (event.type) {
        case 'available_commands_update':
          acpAvailableCommands.applyCommandsUpdate(event.availableCommands);
          break;
        case 'usage_update':
          acpUsage.applyUsageUpdate(event.usage);
          break;
        case 'config_option_update':
          acpSessionConfigOptions.applyConfigOptionUpdate(event.configOptions);
          break;
        default:
          break;
      }
    }
  };

  const applySidecarLiveEventsToAgentMessage = (
    assistantMessageId: string,
    threadId: string | null,
    fallbackContent: string,
    events: readonly TAgentUiEvent[],
  ): ISidecarLiveRenderState => {
    applyAcpReceiveSideEvents(events);
    // 仅做副作用 + 算出本帧 stream/patches；不再写 legacy displayMessages（reduce 为唯一写者）。
    void assistantMessageId;
    void threadId;
    const { errorEvent, doneEvent } = getLatestSidecarLiveEvents(events);
    const streamStatus: NonNullable<IAiChatMessage['stream']>['status'] =
      errorEvent || doneEvent ? 'completed' : 'streaming';
    const toolProjection = projectSidecarEventsToToolState({
      events,
      fallbackActivityText: fallbackContent,
      streamStatus,
    });
    const runtimeEvents = compactRuntimeEvents(extractVisibleAgentRuntimeEvents(events));
    const livePatchState = buildLiveAppliedPatchState(extractSidecarPatchEntries(events));

    for (const toolCall of toolProjection.toolCalls) {
      updateAgentStep(
        toolCall.id,
        toolCall.summary,
        mapSidecarToolCallStatusToStepStatus(toolCall.status),
      );
    }

    const tokenSnapshot = resolveSidecarDoneStreamTokenSnapshot(doneEvent);
    const stream: NonNullable<IAiChatMessage['stream']> = {
      status: streamStatus,
      ...(toolProjection.activityText !== undefined
        ? { activityText: toolProjection.activityText }
        : {}),
      ...(runtimeEvents.length ? { runtimeEvents } : {}),
      // token 用量：usage VM 之外同时补齐顶层扁平字段，供消费侧两种读法都命中（与收尾 finalStream 对齐）。
      ...(tokenSnapshot
        ? {
            usage: tokenSnapshot,
            inputTokens: tokenSnapshot.inputTokens,
            outputTokens: tokenSnapshot.outputTokens,
            totalTokens: tokenSnapshot.totalTokens,
          }
        : {}),
    };

    return { stream, patches: livePatchState?.patches ? [...livePatchState.patches] : undefined };
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

  // 上下文真源 = 权威 entries（对标 Zed AcpThread::to_markdown 由 entries 派生上下文）：
  // user_message → 文本块以空行衔接；assistant_message → message chunk 文本顺序拼接；
  // 仅取 user/assistant 文本、去空、保序、截最近 N 条。与旧 messages 投影按构造等价。
  const toSidecarMessages = (entries: readonly IAiThreadEntry[]): IAgentSidecarMessage[] => {
    const sidecarMessages: IAgentSidecarMessage[] = [];
    for (const entry of entries) {
      if (entry.type === 'user_message') {
        const content = entry.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n\n')
          .trim();
        if (content.length > 0) {
          sidecarMessages.push({ role: 'user', content });
        }
        continue;
      }
      if (entry.type === 'assistant_message') {
        const content = entry.chunks
          .flatMap((chunk) =>
            chunk.type === 'message' && chunk.block.type === 'text' ? [chunk.block.text] : [],
          )
          .join('')
          .trim();
        if (content.length > 0) {
          sidecarMessages.push({ role: 'assistant', content });
        }
      }
    }
    return sidecarMessages.slice(-SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT);
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
              agentRunId: patchMetadata?.agentRunId ?? null,
              agentStepId: patchMetadata?.agentStepId ?? null,
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
      // payload.events 可能漏掉「仅经实时流到达」的 runtime agent 事件，收尾合并本回合累计的可见
      // runtime 时间线（已含实时 + payload 事件，按 id 去重）。
      runtimeEvents: compactRuntimeEvents(
        mergeRuntimeEvents(
          runtimeTimelineEvents.value,
          extractVisibleAgentRuntimeEvents(payload.events),
        ) ?? [],
      ),
      streamTokenSnapshot: resolveSidecarDoneStreamTokenSnapshot(
        getLatestSidecarLiveEvents(payload.events).doneEvent,
      ),
    };

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

    // 收尾：把本回合最终 reduce 态 + patches 写入 authoritative（mirror $subscribe 负责持久化）。
    const finalStream: NonNullable<IAiChatMessage['stream']> = {
      status: projection.errorMessage ? 'completed' : streamMetadata.streamStatus,
      ...(streamMetadata.activityText !== undefined
        ? { activityText: streamMetadata.activityText }
        : {}),
      ...(streamMetadata.runtimeEvents?.length
        ? { runtimeEvents: streamMetadata.runtimeEvents }
        : {}),
      // token 用量：除 usage VM 外，同时补齐顶层扁平字段，供消费侧两种读法都命中。
      ...(streamMetadata.streamTokenSnapshot
        ? {
            usage: streamMetadata.streamTokenSnapshot,
            inputTokens: streamMetadata.streamTokenSnapshot.inputTokens,
            outputTokens: streamMetadata.streamTokenSnapshot.outputTokens,
            totalTokens: streamMetadata.streamTokenSnapshot.totalTokens,
          }
        : {}),
    };
    updateLiveThreadFromSidecarEvents(ctx.assistantMessageId, ctx.threadId, payload.events, {
      stream: finalStream,
      patches: patchState?.patches,
      // 最终回答正文经收尾注入落进权威 entries（唯一真源）。
      finalContent: projection.assistantContent,
      changedFilesSummary: patchState?.changedFilesSummary ?? undefined,
    });

    await refreshChangedDocumentsAfterSidecarRun(
      [...projection.changedFilePaths, ...sidecarAppliedPaths],
      projection.hasFileMutations || sidecarAppliedPaths.length > 0,
    );
    await updateFileRollbackPrompt(
      [...projection.changedFilePaths, ...sidecarAppliedPaths],
      projection.hasFileMutations || sidecarAppliedPaths.length > 0,
    );

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
    patchAssistantEntry(messageId, (entry) => ({
      ...entry,
      chunks: [{ type: 'message', block: { type: 'text', text: `Agent 执行失败：${message}` } }],
      stream: { ...(entry.stream ?? { status: 'completed' }), status: 'completed' },
    }));
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
    // 回合基线 = 「发起回合前」的权威 entries 快照（此刻活动线程已含本回合 user_message、
    // 尚无 assistant 占位）。同时用于本回合 sidecar 上下文与（审批/反向提问）resume 基线。
    const turnBaseEntries = [...aiThreadStore.authoritativeActiveEntries];
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
    const sidecarContextReferences = buildSidecarContextReferences(references);
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      const liveRenderState = applySidecarLiveEventsToAgentMessage(
        assistantMessageId,
        targetThreadId,
        '',
        events,
      );
      updateLiveThreadFromSidecarEvents(
        assistantMessageId,
        targetThreadId,
        events,
        liveRenderState,
      );
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
        messages: toSidecarMessages(turnBaseEntries),
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
            baseEntries: turnBaseEntries,
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
            baseEntries: turnBaseEntries,
            messageContent,
            references: sidecarContextReferences,
          });
        },
      });
    } catch (error) {
      if (!activeAbortController.value?.signal.aborted) {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
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
      const liveRenderState = applySidecarLiveEventsToAgentMessage(
        session.assistantMessageId,
        session.threadId,
        '',
        events,
      );
      updateLiveThreadFromSidecarEvents(
        session.assistantMessageId,
        session.threadId,
        events,
        liveRenderState,
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
        messages: toSidecarMessages(session.baseEntries),
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
      clearActiveBufferedThread(session.threadId);
      isSending.value = false;
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
      const liveRenderState = applySidecarLiveEventsToAgentMessage(
        session.assistantMessageId,
        session.threadId,
        '',
        events,
      );
      updateLiveThreadFromSidecarEvents(
        session.assistantMessageId,
        session.threadId,
        events,
        liveRenderState,
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
        messages: toSidecarMessages(session.baseEntries),
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
      clearActiveBufferedThread(session.threadId);
      isSending.value = false;
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

    if (isDocumentAttachment(file)) {
      if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
        errorMessage.value = `文档超过 ${formatBytes(MAX_DOCUMENT_ATTACHMENT_BYTES)}，请压缩或拆分后再试。`;
        return false;
      }

      const documentText = await extractDocumentText(file).catch((): null => null);

      if (documentText === null) {
        errorMessage.value = '解析文档失败，请确认文件未损坏后重试。';
        return false;
      }

      const trimmedText = documentText.trim();

      if (!trimmedText) {
        errorMessage.value = '未能从该文档中提取到文本（可能是扫描件或纯图片内容）。';
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
          '内容（已从文档提取为纯文本）：',
          clipText(trimmedText, MAX_CONTEXT_CHARS),
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

  // 外部 ACP 编码 agent（Kimi / Codex，ADR-0015）发送链路：经 builtin_agent_external_chat
  // 驱动一轮标准 session/prompt。外部 agent 无富信封，过程增量经 session/update 帧走既有
  // sidecar 流（subscribeSidecarSessionStream + applySidecarLiveEventsToAgentMessage）。
  // 流式关键：用前端预生成的 sidecarSessionId 在发起回合「之前」订阅，后端据此把外部帧的
  // session_id 由 ACP 会话 UUID 重写为该键（见 Rust host.prompt_with_stream_key），实现逐
  // token 实时渲染；prompt 返回即整轮结束，flush 后把消息状态收口为 completed。
  const executeExternalAgentRequest = async (
    backend: TAgentBackendKind,
    visibleMessages: IAiChatMessage[],
    messageContent: string,
    threadId: string | null,
  ): Promise<void> => {
    errorMessage.value = '';
    isSending.value = true;
    runtimeTimelineEvents.value = [];
    activeBufferedThreadId.value = threadId;

    const assistantMessageId = createMessageId('assistant');
    const targetThreadId = threadId;
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
    const requestAbortController = activeAbortController.value;

    const sidecarSessionId = `sidecar:${assistantMessageId}`;
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      if (requestAbortController.signal.aborted) {
        return;
      }
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      const liveRenderState = applySidecarLiveEventsToAgentMessage(
        assistantMessageId,
        targetThreadId,
        initialActivityText,
        events,
      );
      updateLiveThreadFromSidecarEvents(
        assistantMessageId,
        targetThreadId,
        events,
        liveRenderState,
      );
    });
    let unlistenSidecarStream: (() => void) | null = null;

    try {
      // 关键修复（外部 Kimi 流式）：用前端预生成的 sidecarSessionId 在发起回合「之前」订阅该
      // 会话的 session/update 帧。后端据此把外部 agent 帧的 session_id 由 ACP 会话 UUID 重写为
      // 该键（见 Rust host.prompt_with_stream_key），使本订阅即时命中、逐 token 实时渲染——
      // 取代旧的「subscribeSidecarStreamWithPrebuffer + 回合结束后 bind(result.sessionId)」末尾
      // 一次性回放。
      unlistenSidecarStream = await subscribeSidecarSessionStream(sidecarSessionId, (event) => {
        if (requestAbortController.signal.aborted) {
          return;
        }
        liveEventBuffer.push(event);
      });

      await aiService.sidecarExternalChat({
        backend,
        text: messageContent,
        sessionId: sidecarSessionId,
        workspaceRootPath: options.workspaceRootPath.value,
        ...(targetThreadId ? { threadId: targetThreadId } : {}),
      });

      liveEventBuffer.flush();
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;

      if (!requestAbortController.signal.aborted) {
        const assistantEntry = getAssistantEntry(assistantMessageId);
        const assistantText = assistantEntry ? readAssistantEntryText(assistantEntry) : '';
        patchAssistantEntry(assistantMessageId, (entry) => ({
          ...entry,
          stream: {
            ...(entry.stream ?? { status: 'completed' }),
            status: 'completed',
            finalAnswerStarted: hasMeaningfulAssistantText(assistantText),
          },
        }));
      }

      if (!errorMessage.value) {
        clearAttachedFiles({ revokePreviews: false });
      }
    } catch (error) {
      if (!requestAbortController.signal.aborted) {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
    }
  };

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
      // 关键修复(chat 卡死回归):settle() 是本回合唯一的完成信号(解开 await、复位 isSending),
      // 必须在收到 done/error 帧时永远触发,不能被渲染富集写入的异常饿死——该回调跑在缓冲的
      // raf/timeout flush 里,抛错是游离的未处理异常,不会 reject 外层 await,会造成永久「正在准备回复」。
      const { doneEvent, errorEvent } = getLatestSidecarLiveEvents(events);

      try {
        appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
        const liveRenderState = applySidecarLiveEventsToAgentMessage(
          assistantMessageId,
          targetThreadId,
          '',
          events,
        );
        updateLiveThreadFromSidecarEvents(
          assistantMessageId,
          targetThreadId,
          events,
          liveRenderState,
        );
      } catch (error) {
        logger.error({ event: 'ai.chat.live_render_failed', err: error });
        if (!errorMessage.value) {
          errorMessage.value = toErrorMessage(error, MSG_CALL_FAILED);
        }
      } finally {
        if (errorEvent) {
          errorMessage.value = errorEvent.message;
        }
        if (doneEvent || errorEvent) {
          settle();
        }
      }
    });
    const sidecarSessionId = `sidecar:${assistantMessageId}`;
    let unlistenSidecarStream: (() => void) | null = null;

    try {
      // chat 模式与外部 agent 同款零竞态流式：用前端预生成的 sidecarSessionId 在发起回合
      // 「之前」订阅 session/update 帧；后端 chat_stream_via_acp 据此把本回合帧的 session_id
      // 由 ACP 会话 UUID 重写为该键（见 Rust host.agent_chat_with_stream_key），逐 token 实时
      // 渲染。取代旧的「subscribeSidecarStreamWithPrebuffer + 回合返回后 bind(sessionId)」。
      unlistenSidecarStream = await subscribeSidecarSessionStream(sidecarSessionId, (event) => {
        if (requestAbortController.signal.aborted) {
          return;
        }
        liveEventBuffer.push(event);
      });

      const stream = await aiService.chatStream({
        threadId,
        streamSessionId: sidecarSessionId,
        messages: requestMessages,
        references,
      });

      activeStreamId.value = stream.streamId;

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
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;

      if (!errorMessage.value) {
        clearAttachedFiles({ revokePreviews: false });
      }
    } catch (error) {
      if (!requestAbortController.signal.aborted) {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeStreamResolve.value = null;
      activeStreamId.value = null;
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      clearActiveBufferedThread(targetThreadId);
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

    const targetEntryIndex = aiThreadStore.authoritativeActiveEntries.findIndex(
      (entry) => entry.type === 'assistant_message' && entry.id === checkpoint.messageId,
    );

    if (targetEntryIndex < 0) {
      errorMessage.value = '未找到 checkpoint 对应的对话消息。';
      return;
    }

    restoringCheckpointId.value = checkpointId;
    errorMessage.value = '';

    try {
      // 对话 checkpoint 只负责回到历史消息边界；文件改动回滚继续走 AED 操作入口。
      aiThreadStore.patchActiveThreadEntries((entries) => entries.slice(0, targetEntryIndex + 1));
      runtimeTimelineEvents.value = collectConversationRuntimeEventsFromEntries(
        aiThreadStore.authoritativeActiveEntries,
      );
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
      restoringCheckpointId.value = null;
    }
  };

  const sendMessage = async (sendOptions?: { agentBackend?: TAgentBackendKind }): Promise<void> => {
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
      clearActiveBufferedThread(titleThreadId);
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
    clearAttachedFiles({ revokePreviews: false });

    // 外部 ACP 编码 agent（Kimi / Codex）走独立发送链路，与 activeMode（chat/agent/plan）无关：
    // 外部 agent 自管会话与运行循环，不复用自研边车的 mode 分流。
    const externalBackend = sendOptions?.agentBackend;
    if (externalBackend && externalBackend !== 'builtin') {
      await executeExternalAgentRequest(
        externalBackend,
        nextMessages,
        messageContent,
        titleThreadId,
      );

      if (!errorMessage.value) {
        void maybeGenerateConversationTitle(titleThreadId);
      }

      return;
    }

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
        clearActiveBufferedThread(titleThreadId);
        isSending.value = false;
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
    activeAgentMessageId.value = null;
    acpAvailableCommands.reset();
    acpUsage.reset();
    acpSessionConfigOptions.reset();
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

    const assistantEntry = getAssistantEntry(messageId);
    const summary = getChangedFilesSummary(summaryId);

    if (!assistantEntry || !summary || summary.id !== summaryId) {
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
      const checkpointEvent = getLatestCheckpointEvent(assistantEntry.stream?.runtimeEvents ?? []);

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
            aiThreadStore.patchActiveThreadEntries((entries) =>
              entries.map((entry) =>
                entry.type === 'assistant_message' && entry.id === messageId
                  ? {
                      ...entry,
                      stream: {
                        ...(entry.stream ?? { status: 'completed' }),
                        runtimeEvents: mergeRuntimeEvents(
                          entry.stream?.runtimeEvents,
                          restoreRuntimeEvents,
                        ),
                      },
                    }
                  : entry,
              ),
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
        const reversePatch = buildReversePatchSet(assistantEntry.patches, summary);

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
            agentRunId: null,
            agentStepId: null,
          },
        });

        restoredFilePaths.push(...reverseResult.appliedFiles.map((file) => file.path));
      }

      await refreshChangedDocumentsAfterSidecarRun(restoredFilePaths, restoredFilePaths.length > 0);

      const revertedAt = new Date().toISOString();

      aiThreadStore.patchActiveThreadEntries((entries) =>
        entries.map((entry) =>
          entry.type === 'changed_files' && entry.id === summaryId
            ? { ...entry, summary: { ...entry.summary, revertedAt } }
            : entry,
        ),
      );
      fileRollbackPrompt.value = null;
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

    const assistantEntry = getAssistantEntry(messageId);
    const summary = getChangedFilesSummary(summaryId);

    if (!assistantEntry || !summary || summary.id !== summaryId) {
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

      aiThreadStore.patchActiveThreadEntries((entries) =>
        entries.map((entry) =>
          entry.type === 'changed_files' && entry.id === summaryId
            ? { ...entry, summary: { ...entry.summary, pinned } }
            : entry,
        ),
      );
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

    if (activeAgentMessageId.value) {
      const activeMessageId = activeAgentMessageId.value;
      const isChatStreamCancellation = Boolean(streamId);

      patchAssistantEntry(activeMessageId, (entry) => ({
        ...entry,
        chunks: isChatStreamCancellation
          ? entry.chunks
          : [{ type: 'message', block: { type: 'text', text: 'Agent 执行已取消。' } }],
        stream: { ...(entry.stream ?? { status: 'cancelled' }), status: 'cancelled' },
      }));
      activeAgentMessageId.value = null;
    }

    clearSidecarToolConfirmation();
    clearSidecarUserQuestion();
    clearActiveBufferedThread(targetThreadId);
    isSending.value = false;
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
    acpAvailableCommands,
    acpUsage,
    acpSessionConfigOptions,
    config,
    messages,
    historyThreads,
    activeConversationId,
    activeConversationScrollState,
    draft,
    isSending,
    error: errorMessage,
    errorMessage,
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
    activeAgentMessageId,
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
