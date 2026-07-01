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
import { parseAiAedPatchRef } from '@/components/business/ai/edit/patch-summary';
import { subscribeSidecarSessionStream } from '@/composables/ai/sidecar-stream-listener';
import { useAcpAvailableCommands } from '@/composables/ai/useAcpAvailableCommands';
import { useAcpPlan } from '@/composables/ai/useAcpPlan';
import { useAcpSessionConfigOptions } from '@/composables/ai/useAcpSessionConfigOptions';
import { useAcpUsage } from '@/composables/ai/useAcpUsage';
import {
  type IAiWebSelectionContext,
  useAiWebSelectionInbox,
} from '@/composables/ai/useAiWebSelectionInbox';
import { useSidecarChangedDocumentRefresh } from '@/composables/useSidecarChangedDocumentRefresh';
import { aiService } from '@/services/ipc/ai.service';
import { aiEditService } from '@/services/ipc/ai-edit.service';
import { type IAiPersistedSidecarAgentSession, useAiAgentStore } from '@/store/aiAgent';
import { useAiThreadStore } from '@/store/aiThread';
import type {
  IAiAgentPatchSummary,
  IAiAttachedFile,
  IAiChatMessage,
  IAiContextReference,
  IAiImageAttachmentPreview,
  IAiPatchSet,
} from '@/types/ai';
import type { TAiAssistantMode } from '@/types/ai/assistant-mode';
import type { IAiConversationScrollState } from '@/types/ai/conversation.schema';
import type {
  IAgentPromptAttachment,
  TAgentBackendKind,
  TAgentRuntimeEvent,
  TAgentUiEvent,
} from '@/types/ai/sidecar';
import type {
  IAiThread,
  IAiThreadAssistantMessageEntry,
  IAiThreadEntry,
  IAiThreadToolCall,
  IAiThreadUserMessageEntry,
} from '@/types/ai/thread';
import type { IActiveRunSummary, IEditorDocument, IEditorSelectionSummary } from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';

import { toErrorMessage } from '@/utils/error/error';
import { logger } from '@/utils/platform/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  extractVisibleAgentRuntimeEvents,
  getLatestCheckpointEvent,
  type IAiConversationCheckpoint,
  mergeRuntimeEvents,
} from './useAiAssistant.runtime-events';
import {
  createSidecarLiveEventBuffer,
  getLatestSidecarLiveEvents,
  hasMeaningfulAssistantText,
  resolveSidecarDoneStreamTokenSnapshot,
} from './useAiAssistant.stream';

type TAiQuickActionId = 'explain' | 'fix' | 'review';

type TAiFileRollbackStatus = 'ready' | 'reverting' | 'reverted';

// builtin 是标准 ACP 后端：前端三模式（chat/agent/plan）→ Agent 经官方 session config option
// 「mode」公示的会话模式取值（ask/plan/agent，见 builtin-agent AGENT_MODES /
// RUNTIME_METHOD_BY_MODE 与 acp/mode-config-options.ts）。经官方 set_config_option
// （configId=mode）一次性切换会话模式，绝不随 session/prompt 负载携带（IAgentExternalChatRequest
// 无 mode 字段）。已淘汰的 session/set_mode 通道不再使用。
const MODE_CONFIG_OPTION_ID = 'mode';

const BUILTIN_MODE_CONFIG_VALUE_BY_ASSISTANT_MODE: Record<TAiAssistantMode, string> = {
  chat: 'ask',
  agent: 'agent',
  plan: 'plan',
};

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

interface IAgentExecutionMessagePatchState {
  patches?: readonly IAiPatchSet[];
  changedFilesSummary?: IAiAgentPatchSummary | null;
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
  // ④.1 §D：编排器消息读写真源收敛到 aiThread 权威 entries。conversationStore 别名保留以
  // 最小化触点；活动滚动状态改读权威 authoritativeActiveThread，其余面（activeThreadId /
  // 生命周期）1:1 同名。
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
    fallbackActivityText: string,
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
    // 不再经 legacy 会话形状往返（已无 thread↔message 逆投影）。
    const seedThread: IAiThread = {
      ...targetThread,
      entries: targetThread.entries.filter((entry) => entry.id !== assistantMessageId),
    };
    const liveThread = buildLiveThreadFromSidecarEvents(events, {
      baseThread: seedThread,
      assistantMessageId,
      now: new Date().toISOString(),
    });
    // 统一管线：工具步骤侧栏与活动文案均由 reduce 出的顶层 tool_call entries 派生(单一真源)，
    // 不再并行跑 legacy 工具投影(已退役)。
    const toolCallEntries = liveThread.entries.filter(
      (entry): entry is IAiThreadToolCall => entry.type === 'tool_call',
    );
    agentSteps.value = toolCallEntries.map((toolCall) => ({
      id: toolCall.id,
      title: toolCall.title,
      status: mapThreadToolCallStatusToStepStatus(toolCall.status),
    }));
    const liveActivityText = deriveAgentActivityText(toolCallEntries, fallbackActivityText);
    const stream =
      liveActivityText.length > 0
        ? { ...liveRenderState.stream, activityText: liveActivityText }
        : liveRenderState.stream;
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
        stream,
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
        stream,
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

  const historyThreads = computed(() => aiThreadStore.authoritativeHistoryThreads);
  const activeConversationId = computed(() => unref(conversationStore.activeThreadId));
  const activeConversationScrollState = computed<IAiConversationScrollState | null>(
    () => aiThreadStore.authoritativeActiveThread?.scrollState ?? null,
  );
  const conversationCheckpoints = computed<IAiConversationCheckpoint[]>(() =>
    buildConversationCheckpointsFromEntries(aiThreadStore.authoritativeActiveEntries),
  );

  const acpAvailableCommands = useAcpAvailableCommands();
  const acpPlan = useAcpPlan();
  const acpUsage = useAcpUsage();
  const acpSessionConfigOptions = useAcpSessionConfigOptions();
  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();

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

  // 统一真源映射：ACP 协议 VM 的 tool_call 状态 → 执行步骤状态。
  const mapThreadToolCallStatusToStepStatus = (
    status: IAiThreadToolCall['status'],
  ): TAgentExecutionStepStatus => {
    switch (status) {
      case 'completed':
        return 'done';
      case 'failed':
        return 'failed';
      case 'canceled':
        return 'cancelled';
      case 'pending':
        return 'pending';
      default:
        return 'running';
    }
  };

  // 活动文案 = 当前进行中/待定工具的标题，否则取最近一个已结束工具的标题；标题已由
  // from-sidecar-events 经同源 presenter(describeToolAction)语义化，故此处不再重复启发式。
  const deriveAgentActivityText = (
    toolCalls: readonly IAiThreadToolCall[],
    fallback: string,
  ): string => {
    const active = [...toolCalls]
      .reverse()
      .find((toolCall) => toolCall.status === 'in_progress' || toolCall.status === 'pending');
    const target =
      active ??
      [...toolCalls]
        .reverse()
        .find(
          (toolCall) =>
            toolCall.status === 'completed' ||
            toolCall.status === 'failed' ||
            toolCall.status === 'canceled',
        );
    return target?.title.trim() || fallback || '';
  };

  const applyAcpReceiveSideEvents = (events: readonly TAgentUiEvent[]): void => {
    // 接收侧宿主接线（ADR-20260617 · D7 接收侧）：把宿主唯一 onSidecarStream 路由到的
    // ACP session/update UI 事件分发到各 ACP composable VM。终端走客户端方法、审批走
    // finalizeSidecarTurn 的 pendingConfirmation，均不经本事件流，故不在此路由。
    // 累计事件每 tick 整份重扫，与统一 reduce 出 tool_call entries 的投影同构；各 applier 均
    // 「整份替换、后者胜」，故重扫幂等。非穷尽 switch（default 兜底），
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
        case 'plan':
          acpPlan.applyPlanUpdate(event.acpUpdate);
          break;
        default:
          break;
      }
    }
  };

  const applySidecarLiveEventsToAgentMessage = (
    events: readonly TAgentUiEvent[],
  ): ISidecarLiveRenderState => {
    applyAcpReceiveSideEvents(events);
    // 仅做副作用 + 算出本帧 stream/patches；工具步骤与活动文案改由统一 reduce 出的 tool_call
    // entries 派生(见 updateLiveThreadFromSidecarEvents)，不再并行投影。
    const { errorEvent, doneEvent } = getLatestSidecarLiveEvents(events);
    const streamStatus: NonNullable<IAiChatMessage['stream']>['status'] =
      errorEvent || doneEvent ? 'completed' : 'streaming';
    const runtimeEvents = compactRuntimeEvents(extractVisibleAgentRuntimeEvents(events));
    const livePatchState = buildLiveAppliedPatchState(extractSidecarPatchEntries(events));

    const tokenSnapshot = resolveSidecarDoneStreamTokenSnapshot(doneEvent);
    const stream: NonNullable<IAiChatMessage['stream']> = {
      status: streamStatus,
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

  const failSidecarAgentMessage = (messageId: string, message: string): void => {
    patchAssistantEntry(messageId, (entry) => ({
      ...entry,
      chunks: [{ type: 'message', block: { type: 'text', text: `Agent 执行失败：${message}` } }],
      stream: { ...(entry.stream ?? { status: 'completed' }), status: 'completed' },
    }));
    errorMessage.value = message;
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
          content,
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

    errorMessage.value =
      'AI 附件仅支持文本/代码文件与图片；PDF、Word、Excel 等二进制文档的解析已下线，请粘贴文本或另存为纯文本后再添加。';
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

  // 唯一标准发送链路（ADR-20260617）：所有 ACP 后端（builtin / Kimi / Codex）一律经
  // builtin_agent_external_chat 驱动一轮标准 session/prompt。builtin 的 chat/plan/agent 三模式经
  // 官方 set_config_option（configId=mode）在发起回合前一次性切换（见下方 modeConfigValue 分支，
  // 映射 ask/plan/agent），不再走自研边车的 mode 分流；Kimi / Codex 自管会话模式，不下发模式取值。过程增量经
  // session/update 帧走既有 sidecar 流（subscribeSidecarSessionStream +
  // applySidecarLiveEventsToAgentMessage）；工具审批 / 反向提问经 session/request_permission 由
  // 面板级 useAcpApproval 闭环呈现，均不在本链路内联处理。
  // 流式关键：用前端预生成的 sidecarSessionId 在发起回合「之前」订阅，后端据此把帧的 session_id
  // 由 ACP 会话 UUID 重写为该键（见 Rust host.prompt_with_stream_key），实现逐 token 实时渲染；
  // prompt 返回即整轮结束，flush 后把消息状态收口为 completed。
  const executeExternalAgentRequest = async (
    backend: TAgentBackendKind,
    messageContent: string,
    threadId: string | null,
    modeConfigValue?: string,
    attachments: IAgentPromptAttachment[] = [],
  ): Promise<void> => {
    errorMessage.value = '';
    isSending.value = true;
    runtimeTimelineEvents.value = [];
    activeBufferedThreadId.value = threadId;

    const assistantMessageId = createMessageId('assistant');
    const targetThreadId = threadId;
    const initialActivityText = buildInitialAgentActivityText();
    const placeholderEntry: IAiThreadAssistantMessageEntry = {
      type: 'assistant_message',
      id: assistantMessageId,
      createdAt: new Date().toISOString(),
      chunks: [],
      stream: {
        status: 'streaming',
        activityText: initialActivityText,
        runtimeEvents: [],
      },
    };

    aiThreadStore.patchActiveThreadEntries((entries) => [...entries, placeholderEntry]);
    activeAgentMessageId.value = assistantMessageId;
    activeAbortController.value = new AbortController();
    const requestAbortController = activeAbortController.value;

    const sidecarSessionId = `sidecar:${assistantMessageId}`;
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      if (requestAbortController.signal.aborted) {
        return;
      }
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      const liveRenderState = applySidecarLiveEventsToAgentMessage(events);
      updateLiveThreadFromSidecarEvents(
        assistantMessageId,
        targetThreadId,
        initialActivityText,
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

      // 唯一标准管线（ADR-20260617）：所有 ACP 后端（builtin / Kimi / Codex）在发起回合「之前」一律
      // 确保会话建立，把 thread_id 绑定到宿主会话——使后续 set_config_option 命中既有会话（未绑定时
      // 宿主 set_session_config_option 会静默空操作 Ok(false)），并让 agent（如 Kimi）在 session/new 后
      // 下发的一次性 config_option_update 有稳定会话可挂靠。builtin 额外经官方 set_config_option
      // （configId=mode）一次性切到目标模式取值（映射 ask/plan/agent）；Kimi / Codex 自管会话模式，
      // 不下发模式取值。随后标准 session/prompt 按会话模式分流（见 builtin-agent CalamexAcpAgent.prompt）。
      const sessionThreadId = targetThreadId ?? '';
      await aiService.ensureAcpSession({
        threadId: sessionThreadId,
        backend,
        workspaceRootPath: options.workspaceRootPath.value,
      });
      if (backend === 'builtin' && modeConfigValue !== undefined) {
        await aiService.setSessionConfigOption({
          threadId: sessionThreadId,
          configId: MODE_CONFIG_OPTION_ID,
          valueId: modeConfigValue,
        });
      }

      await aiService.sidecarExternalChat({
        backend,
        text: messageContent,
        sessionId: sidecarSessionId,
        workspaceRootPath: options.workspaceRootPath.value,
        ...(targetThreadId ? { threadId: targetThreadId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
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
    const userEntry: IAiThreadUserMessageEntry = {
      type: 'user_message',
      id: createMessageId('user'),
      createdAt: new Date().toISOString(),
      content: [{ type: 'text', text: messageContent }],
      references: [],
    };

    aiThreadStore.patchActiveThreadEntries((entries) => [...entries, userEntry]);
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
      const contextErrorEntry: IAiThreadAssistantMessageEntry = {
        type: 'assistant_message',
        id: createMessageId('assistant'),
        createdAt: new Date().toISOString(),
        chunks: [
          { type: 'message', block: { type: 'text', text: `AI 上下文收集失败：${message}` } },
        ],
      };
      aiThreadStore.patchActiveThreadEntries((entries) => [...entries, contextErrorEntry]);
      clearActiveBufferedThread(titleThreadId);
      isSending.value = false;
      return;
    }

    currentReferences.value = references;

    // 正规范式（替代旧的 <附件> 字符串折叠）：把文本类附件作为独立的 ACP embedded resource 内容块
    // 随标准 session/prompt 送达（见 Rust host.prompt_with_attachments / agent-client-protocol
    // ContentBlock::Resource——协议首选的上下文注入方式）。这样保留 name/uri/mimeType 语义、避免正文
    // 分隔符冲突与提示注入；图片附件仍只作 UI 预览、不并入（多模态注入待 promptCapabilities 协商）。
    const promptAttachments: IAgentPromptAttachment[] = references
      .filter((reference) => reference.kind !== 'image-attachment')
      .map((reference) => ({
        name: reference.label,
        uri: `attachment:///${reference.path ?? reference.id}`,
        text: reference.contentPreview,
        mimeType: 'text/plain',
      }));

    aiThreadStore.patchActiveThreadEntries((entries) =>
      entries.map((entry) =>
        entry.type === 'user_message' && entry.id === userEntry.id
          ? { ...entry, references }
          : entry,
      ),
    );
    clearAttachedFiles({ revokePreviews: false });

    // 唯一标准管线（ADR-20260617）：所有后端（builtin / Kimi / Codex）一律经标准 ACP
    // session/prompt 发送。builtin 的 chat/agent/plan 三模式经官方 set_config_option（configId=mode）
    // 一次性切换（见 executeExternalAgentRequest 的 modeConfigValue 分支，映射 ask/plan/agent）；
    // Kimi / Codex 自管会话模式，故不下发模式取值。legacy 分流（executeSidecarAgentRequest /
    // agentPlan.createPlan / executeAiRequest）已停用，随 D1 删除（先建后删，过渡期保留以防回退）。
    const backend: TAgentBackendKind = sendOptions?.agentBackend ?? 'builtin';
    const modeConfigValue =
      backend === 'builtin'
        ? BUILTIN_MODE_CONFIG_VALUE_BY_ASSISTANT_MODE[activeMode.value]
        : undefined;

    await executeExternalAgentRequest(
      backend,
      messageContent,
      titleThreadId,
      modeConfigValue,
      promptAttachments,
    );

    if (!errorMessage.value) {
      void maybeGenerateConversationTitle(titleThreadId);
    }
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
    acpPlan.reset();
    acpUsage.reset();
    acpSessionConfigOptions.reset();
    isClearDialogOpen.value = false;
  };

  const clearConversation = (): void => {
    clearSidecarToolConfirmationForThread(unref(conversationStore.activeThreadId));
    clearSidecarUserQuestionForThread(unref(conversationStore.activeThreadId));
    conversationStore.clearActiveThread();
    resetConversationUiState();
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
    }

    return true;
  };

  const startNewConversation = (): void => {
    conversationStore.startNewThread();
    resetConversationUiState();
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
    acpAvailableCommands,
    acpPlan,
    acpUsage,
    acpSessionConfigOptions,
    config,
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
