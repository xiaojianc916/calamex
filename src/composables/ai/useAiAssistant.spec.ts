import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useAiAssistant } from '@/composables/ai/useAiAssistant';
import { useAiAgentStore } from '@/store/aiAgent';
import { useAiThreadStore } from '@/store/aiThread';
import type {
  IAiAgentRun,
  IAiApplyPatchPayload,
  IAiApplyPatchRequest,
  IAiChatRequest,
  IAiPatchSet,
  IAiTaskPlanStep,
} from '@/types/ai';
import type {
  IAiEditGetDiffPayload,
  IAiEditListTimelinePayload,
  IAiEditListTimelineRequest,
  IAiEditRevertTaskPayload,
  IAiEditRevertTaskRequest,
  IAiEditUndoOperationPayload,
  IAiEditUndoOperationRequest,
  IAiSnapshot,
} from '@/types/ai/edit';
import type {
  IAgentExternalChatRequest,
  IAgentExternalChatResultPayload,
  IAgentSidecarChatRequest,
  IAgentSidecarCheckpointRestoreRequest,
  IAgentSidecarOrchestrateRequest,
  IAgentSidecarOrchestrateResumeRequest,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
  TJsonValue,
} from '@/types/ai/sidecar';
import type { IAnalyzeScriptPayload, IEditorDocument } from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STREAM_ID = 'stream-1' as const;
const ASSISTANT_MESSAGE_ID = 'assistant-1' as const;
const CHAT_SESSION_ID = 'acp-chat-session-1' as const;
const MOCK_MODEL = 'mock-ide-assistant' as const;
const WORKSPACE_ROOT = 'd:/com.xiaojianc/my_desktop_app' as const;

// ---------------------------------------------------------------------------
// AI service mock (hoisted so vi.mock factory can reach it)
// ---------------------------------------------------------------------------

const aiServiceMock = vi.hoisted(() => {
  type SidecarStreamHandler = (payload: IAgentSidecarStreamEventPayload) => void;
  let sidecarStreamHandler: SidecarStreamHandler | null = null;
  let streamSequence = 0;
  let sidecarSequence = 0;
  let activeChatSessionId = 'acp-chat-session-1';
  const queuedStreamResponses: Array<{
    streamId: string;
    assistantMessageId: string;
    sessionId: string;
    content: string;
    terminalKind: 'done' | 'error';
    terminalMessage: string | null;
  }> = [];

  const emitSidecarEvent = (
    sessionId: string,
    event: IAgentSidecarStreamEventPayload['event'],
  ): void => {
    sidecarStreamHandler?.({
      sessionId,
      seq: sidecarSequence,
      event,
    });
    sidecarSequence += 1;
  };

  const emitChatDelta = (delta: string, sessionId = activeChatSessionId): void => {
    emitSidecarEvent(sessionId, {
      type: 'message_delta',
      text: delta,
      phase: 'final',
    });
  };

  const emitChatDone = (
    result: string,
    sessionId = activeChatSessionId,
    usage?: Extract<IAgentSidecarStreamEventPayload['event'], { type: 'done' }>['usage'],
  ): void => {
    emitSidecarEvent(sessionId, {
      type: 'done',
      result,
      ...(usage ? { usage } : {}),
    });
  };

  const emitChatError = (message: string, sessionId = activeChatSessionId): void => {
    emitSidecarEvent(sessionId, {
      type: 'error',
      message,
    });
  };

  const chatStream = vi.fn<
    (payload: IAiChatRequest) => Promise<{
      streamId: string;
      assistantMessageId: string;
      providerType: 'mastra';
      model: string;
      sessionId: string;
    }>
  >(async (payload) => {
    // chat 模式已迁移为「前端预生成流式关联键」：FE 在调用前用 streamSessionId 订阅，后端据此
    // 把本回合帧的 session_id 重写为该键。Mock 据此把增量/终态 emit 在 payload.streamSessionId
    // 上，对齐真实后端（与外部 agent 测试同款范式）。
    const streamKey = payload.streamSessionId ?? CHAT_SESSION_ID;
    activeChatSessionId = streamKey;
    const queued = queuedStreamResponses.shift();
    if (!queued) {
      return {
        streamId: STREAM_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        providerType: 'mastra',
        model: MOCK_MODEL,
        sessionId: streamKey,
      };
    }

    void Promise.resolve().then(() => {
      for (const chunk of queued.content.match(/.{1,24}/g) ?? []) {
        emitChatDelta(chunk, streamKey);
      }

      if (queued.terminalKind === 'error') {
        emitChatError(queued.terminalMessage ?? 'AI 流式响应失败', streamKey);
        return;
      }

      emitChatDone(queued.content, streamKey);
    });

    return {
      streamId: queued.streamId,
      assistantMessageId: queued.assistantMessageId,
      providerType: 'mastra',
      model: MOCK_MODEL,
      sessionId: streamKey,
    };
  });

  const generateConversationTitle = vi.fn(async () => ({
    title: '生成会话标题',
    model: MOCK_MODEL,
  }));

  const cancel = vi.fn(async (payload: { streamId: string; threadId: string | null }) => {
    void payload;
  });

  const queryIndex = vi.fn(async () => ({
    rootPath: WORKSPACE_ROOT,
    results: [],
  }));

  const proposePatch = vi.fn(async () => ({
    patch: {
      summary: 'mock patch',
      files: [],
    },
  }));

  const applyPatch = vi.fn<(payload: IAiApplyPatchRequest) => Promise<IAiApplyPatchPayload>>(
    async (payload) => {
      void payload;
      return {
        appliedFiles: [],
      };
    },
  );

  const classifyTask = vi.fn(async () => ({
    classification: 'complex',
    shouldEnterPlanMode: true,
    reason: '任务影响面较大，需要先进入计划模式。',
  }));

  const createSidecarExecuteResponse = (
    goal: string | undefined,
  ): IAgentSidecarResponsePayload => ({
    sessionId: 'sidecar-execute-session-1',
    events: [
      {
        type: 'tool_start',
        toolName: 'read_project_file',
        input: { path: 'src/app.ts' },
      },
      {
        type: 'tool_result',
        toolName: 'read_project_file',
        output: {
          path: 'src/app.ts',
          summary: '璇诲彇褰撳墠鑴氭湰瀹屾垚',
        },
      },
      {
        type: 'done',
        result: `已通过 Mastra Agent 处理：${goal}`,
      },
    ],
    result: `已通过 Mastra Agent 处理：${goal}`,
  });

  const sidecarExecute = vi.fn(async (payload: IAgentSidecarChatRequest) =>
    createSidecarExecuteResponse(payload.goal),
  );

  const sidecarExternalChat = vi.fn<
    (payload: IAgentExternalChatRequest) => Promise<IAgentExternalChatResultPayload>
  >(async (payload) => ({
    sessionId: payload.sessionId ?? 'sidecar-external-session-1',
    stopReason: 'EndTurn',
  }));

  const sidecarResolveApproval = vi.fn(async () => ({
    sessionId: 'sidecar-approval-session-1',
    events: [
      {
        type: 'done',
        result: '审批结果已交给 sidecar。',
      },
    ],
    result: '审批结果已交给 sidecar。',
  }));
  const sidecarRestoreCheckpoint = vi.fn<
    (payload: IAgentSidecarCheckpointRestoreRequest) => Promise<IAgentSidecarResponsePayload>
  >(async (payload) => ({
    sessionId: payload.sessionId ?? 'sidecar-restore-session-1',
    events: [
      {
        type: 'done',
        result: '已恢复到指定检查点。',
      },
    ],
    result: '已恢复到指定检查点。',
  }));
  const sidecarOrchestrate = vi.fn(async (request: IAgentSidecarOrchestrateRequest) => {
    const sessionId = request.sessionId ?? 'sidecar-orchestrate-session-1';
    sidecarStreamHandler?.({
      sessionId,
      seq: 0,
      event: {
        type: 'plan_ready',
        planId: 'orchestrate-plan-1',
        threadId: 'orchestrate-thread-1',
        version: 1,
        status: 'pending_approval',
        createdAt: '2026-04-29T10:00:00.000Z',
        updatedAt: '2026-04-29T10:00:00.000Z',
        approvedAt: null,
        executedAt: null,
        rejectionReason: null,
        errorMessage: null,
        plan: {
          goal: request.goal,
          summary: 'orchestrate plan summary',
          requiresApproval: true,
          steps: [
            {
              id: 'orchestrate-step-1',
              title: '收集上下文',
              goal: '收集上下文',
              status: 'pending',
              tools: ['search_project_files'],
              riskLevel: 'low',
              requiresApproval: false,
              expectedOutput: '上下文摘要',
            },
            {
              id: 'orchestrate-step-2',
              title: '输出实施计划',
              goal: '输出实施计划',
              status: 'pending',
              tools: ['edit_file'],
              riskLevel: 'medium',
              requiresApproval: true,
              expectedOutput: '可执行计划',
            },
          ],
        },
      },
    });

    return { runId: 'orchestrate-run-1', result: null };
  });

  const sidecarOrchestrateResume = vi.fn(
    async (request: IAgentSidecarOrchestrateResumeRequest) => ({
      runId: request.runId,
      result: null,
    }),
  );

  const onSidecarStream = vi.fn(async (handler: SidecarStreamHandler) => {
    sidecarStreamHandler = handler;
    return vi.fn(() => {
      sidecarStreamHandler = null;
    });
  });

  return {
    generateConversationTitle,
    chatStream,
    cancel,
    queryIndex,
    proposePatch,
    applyPatch,
    classifyTask,
    sidecarChat: sidecarExecute,
    sidecarExecute,
    sidecarExternalChat,
    sidecarResolveApproval,
    sidecarRestoreCheckpoint,
    sidecarOrchestrate,
    sidecarOrchestrateResume,
    onSidecarStream,
    queueStreamResponse(
      content: string,
      terminalKind: 'done' | 'error' = 'done',
      terminalMessage: string | null = null,
    ): void {
      streamSequence += 1;
      queuedStreamResponses.push({
        streamId: `${STREAM_ID}-${streamSequence}`,
        assistantMessageId: `${ASSISTANT_MESSAGE_ID}-${streamSequence}`,
        sessionId: `${CHAT_SESSION_ID}-${streamSequence}`,
        content,
        terminalKind,
        terminalMessage,
      });
    },
    emitSidecar(event: IAgentSidecarStreamEventPayload): void {
      sidecarStreamHandler?.(event);
    },
    emitDelta(delta: string): void {
      emitChatDelta(delta);
    },
    emitDone(
      result: string,
      usage?: Extract<IAgentSidecarStreamEventPayload['event'], { type: 'done' }>['usage'],
    ): void {
      emitChatDone(result, activeChatSessionId, usage);
    },
    reset(): void {
      sidecarStreamHandler = null;
      streamSequence = 0;
      sidecarSequence = 0;
      activeChatSessionId = CHAT_SESSION_ID;
      queuedStreamResponses.length = 0;
      generateConversationTitle.mockClear();
      chatStream.mockClear();
      cancel.mockClear();
      queryIndex.mockClear();
      proposePatch.mockClear();
      applyPatch.mockClear();
      classifyTask.mockClear();
      sidecarExecute.mockClear();
      sidecarExternalChat.mockClear();
      sidecarResolveApproval.mockClear();
      sidecarRestoreCheckpoint.mockClear();
      sidecarOrchestrate.mockClear();
      sidecarOrchestrateResume.mockClear();
      onSidecarStream.mockClear();
    },
  };
});

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    generateConversationTitle: aiServiceMock.generateConversationTitle,
    chatStream: aiServiceMock.chatStream,
    cancel: aiServiceMock.cancel,
    queryIndex: aiServiceMock.queryIndex,
    proposePatch: aiServiceMock.proposePatch,
    applyPatch: aiServiceMock.applyPatch,
    classifyTask: aiServiceMock.classifyTask,
    sidecarChat: aiServiceMock.sidecarChat,
    sidecarExecute: aiServiceMock.sidecarExecute,
    sidecarExternalChat: aiServiceMock.sidecarExternalChat,
    sidecarResolveApproval: aiServiceMock.sidecarResolveApproval,
    sidecarRestoreCheckpoint: aiServiceMock.sidecarRestoreCheckpoint,
    sidecarOrchestrate: aiServiceMock.sidecarOrchestrate,
    sidecarOrchestrateResume: aiServiceMock.sidecarOrchestrateResume,
    onSidecarStream: aiServiceMock.onSidecarStream,
  },
}));

const createAiEditSnapshot = (id: string, fileRefs: string[] = []): IAiSnapshot => ({
  id,
  scope: 'revert',
  taskId: 'thread-rollback',
  createdAt: '2026-04-29T00:00:00.000Z',
  label: id,
  fileRefs,
  storageKey: `${id}.json`,
  sizeBytes: 0,
  contentAvailable: true,
  pinned: false,
});

const createUndoOperationPayload = (
  operationId: string,
  restoredFiles: string[] = [],
): IAiEditUndoOperationPayload => ({
  operationId,
  restoredFiles,
  preRevertSnapshot: createAiEditSnapshot('snapshot-pre-revert', restoredFiles),
  restoredSnapshot: createAiEditSnapshot('snapshot-restored', restoredFiles),
});

const createRevertTaskPayload = (
  taskId: string,
  restoredFiles: string[] = [],
): IAiEditRevertTaskPayload => ({
  taskId,
  revertedOperationIds: restoredFiles.length > 0 ? ['operation-rollback-1'] : [],
  restoredFiles,
  preRevertSnapshots: [createAiEditSnapshot('snapshot-pre-revert', restoredFiles)],
  restoredSnapshots: [createAiEditSnapshot('snapshot-restored', restoredFiles)],
});

const aiEditServiceMock = vi.hoisted(() => {
  const listTimeline = vi.fn<
    (payload?: IAiEditListTimelineRequest) => Promise<IAiEditListTimelinePayload>
  >(async () => ({
    entries: [],
  }));
  const undoOperation = vi.fn<
    (payload: IAiEditUndoOperationRequest) => Promise<IAiEditUndoOperationPayload>
  >(async (payload) => createUndoOperationPayload(payload.operationId));
  const revertTask = vi.fn<
    (payload: IAiEditRevertTaskRequest) => Promise<IAiEditRevertTaskPayload>
  >(async (payload) => createRevertTaskPayload(payload.taskId));
  const getDiff = vi.fn<
    (payload: { taskId: string; path: string }) => Promise<IAiEditGetDiffPayload>
  >(async (payload) => ({
    taskId: payload.taskId,
    path: payload.path,
    operationId: 'operation-diff-1',
    kind: 'modify',
    additions: 0,
    deletions: 0,
    hunks: [],
  }));

  return {
    listTimeline,
    undoOperation,
    revertTask,
    getDiff,
    reset(): void {
      listTimeline.mockClear();
      undoOperation.mockClear();
      revertTask.mockClear();
      getDiff.mockClear();
      listTimeline.mockResolvedValue({
        entries: [],
      });
      undoOperation.mockImplementation(async (payload: IAiEditUndoOperationRequest) =>
        createUndoOperationPayload(payload.operationId),
      );
      revertTask.mockImplementation(async (payload: IAiEditRevertTaskRequest) =>
        createRevertTaskPayload(payload.taskId),
      );
      getDiff.mockImplementation(async (payload: { taskId: string; path: string }) => ({
        taskId: payload.taskId,
        path: payload.path,
        operationId: 'operation-diff-1',
        kind: 'modify',
        additions: 0,
        deletions: 0,
        hunks: [],
      }));
    },
  };
});

vi.mock('@/services/ipc/ai-edit.service', () => ({
  aiEditService: {
    listTimeline: aiEditServiceMock.listTimeline,
    getDiff: aiEditServiceMock.getDiff,
    undoOperation: aiEditServiceMock.undoOperation,
    revertTask: aiEditServiceMock.revertTask,
  },
}));

const tauriServiceMock = vi.hoisted(() => {
  const loadScript = vi.fn(async (path: string) => ({
    path,
    name: path.split(/[\\/]/u).pop() || 'script.sh',
    content: 'echo refreshed',
    encoding: 'utf-8' as const,
    lineCount: 1,
    charCount: 14,
  }));
  const analyzeScript = vi.fn(async () => ({
    available: true,
    message: null,
    dialect: 'bash',
    diagnostics: [],
  }));

  return {
    loadScript,
    analyzeScript,
    reset(): void {
      loadScript.mockClear();
      analyzeScript.mockClear();
    },
  };
});

vi.mock('@/services/tauri', () => ({
  tauriService: {
    loadScript: tauriServiceMock.loadScript,
    analyzeScript: tauriServiceMock.analyzeScript,
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const readReactiveValue = <T>(value: { value: T } | T): T => {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return Reflect.get(value, 'value') as T;
  }

  return value;
};

const writeReactiveValue = <T>(target: object, value: T): void => {
  Reflect.set(target, 'value', value);
};

const createDeferred = <T>() => {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });

  return {
    promise,
    resolve(value: T): void {
      if (!resolveValue) {
        throw new Error('deferred resolve is not ready');
      }
      resolveValue(value);
    },
    reject(reason?: unknown): void {
      if (!rejectValue) {
        throw new Error('deferred reject is not ready');
      }
      rejectValue(reason);
    },
  };
};

const waitForStartedStream = async (
  resolveMessageId: () => string | undefined,
  expectedId?: string,
  maxAttempts = 16,
): Promise<void> => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const messageId = resolveMessageId();
    if (
      messageId &&
      (!expectedId || messageId === expectedId) &&
      aiServiceMock.chatStream.mock.calls.length > 0
    ) {
      await flushMicrotasks();
      return;
    }
    await flushMicrotasks();
  }
  throw new Error(
    `assistant stream did not start in time (expected id="${expectedId ?? '<any>'}" within ${maxAttempts} ticks)`,
  );
};

const createDocument = (): IEditorDocument => ({
  id: 'doc-1',
  path: 'src/app.ts',
  name: 'app.ts',
  kind: 'text',
  content: 'const start = true;',
  encoding: 'utf-8',
  savedContent: 'const start = true;',
  savedEncoding: 'utf-8',
  isDirty: false,
  lineCount: 1,
  charCount: 19,
});

const createAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'typescript',
  diagnostics: [],
});

const createGitStatus = (): IGitRepositoryStatusPayload => ({
  available: false,
  message: null,
  repositoryRootPath: null,
  repositoryName: null,
  gitDirPath: null,
  headBranchName: null,
  headShortName: null,
  headShortOid: null,
  isDetached: false,
  isClean: true,
  ahead: 0,
  behind: 0,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  files: [],
  lastCommit: null,
});

const createPlanStep = (
  id: string,
  title: string,
  status: IAiTaskPlanStep['status'] = 'pending',
): IAiTaskPlanStep => ({
  id,
  index: Number(id.replace('plan-step-', '')) - 1,
  title,
  goal: title,
  kind: status === 'done' ? 'verify' : 'inspect',
  status,
  expectedOutput: `${title} 的输出`,
  tools: ['get_diagnostics'],
  requiresUserApproval: false,
  riskLevel: 'low',
});

const createAgentRun = (
  steps: IAiTaskPlanStep[],
  overrides: Partial<IAiAgentRun> = {},
): IAiAgentRun => ({
  id: 'agent-run-stale',
  goal: '旧计划',
  status: 'running-step',
  steps,
  currentStepId: steps[0]?.id ?? null,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:01.000Z',
  startedAt: '2026-04-29T00:00:00.000Z',
  completedAt: null,
  errorMessage: null,
  ...overrides,
});

const createAssistantHarness = (): ReturnType<typeof useAiAssistant> =>
  createAssistantHarnessContext().assistant;

const createAssistantHarnessContext = (
  overrides: { analysis?: IAnalyzeScriptPayload; narratorConfigured?: boolean } = {},
) => {
  const document = ref(createDocument());
  const assistant = useAiAssistant({
    document,
    activeRun: ref(null),
    analysis: ref(overrides.analysis ?? createAnalysis()),
    selection: ref(null),
    gitStatus: ref(createGitStatus()),
    workspaceRootPath: ref(WORKSPACE_ROOT),
  });

  assistant.config.value = {
    ...assistant.config.value,
    hasCredentials: true,
    isConfigured: true,
    agentEnabled: true,
    narrator: {
      ...assistant.config.value.narrator,
      hasCredentials: overrides.narratorConfigured ?? false,
      isConfigured: overrides.narratorConfigured ?? false,
    },
  };

  return {
    assistant,
    document,
  };
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('useAiAssistant streaming integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    aiServiceMock.reset();
    aiEditServiceMock.reset();
    tauriServiceMock.reset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('proxies activeMode through the persisted ai agent store mode', () => {
    const assistant = createAssistantHarness();
    const agentStore = useAiAgentStore();

    expect(assistant.activeMode.value).toBe('agent');

    assistant.activeMode.value = 'plan';
    expect(agentStore.mode).toBe('plan');

    agentStore.mode = 'chat';
    expect(assistant.activeMode.value).toBe('chat');
  });

  it('pipes streaming delta through the fence parser into message.stream', async () => {
    const assistant = createAssistantHarness();

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '瑙ｉ噴杩欐浠ｇ爜';
    const sendPromise = assistant.sendMessage();

    await waitForStartedStream(() => {
      const message = assistant.messages.value.at(-1);
      return message?.role === 'assistant' && message.stream?.status === 'streaming'
        ? message.id
        : undefined;
    });

    const fence = String.fromCharCode(96).repeat(3);
    const partialFence = ['鍓嶆枃 **markdown**', '', `${fence}ts`, 'const pending = true;'].join(
      String.fromCharCode(10),
    );

    aiServiceMock.emitDelta(partialFence);
    await flushMicrotasks();

    const assistantMessage = assistant.messages.value.at(-1);
    expect(assistantMessage?.content).toBe(partialFence);
    expect(assistantMessage?.stream?.status).toBe('streaming');

    assistant.stopCurrentRequest();
    await sendPromise;
  });

  it('marks the open block cancelled immediately on stop and ignores late delta', async () => {
    const assistant = createAssistantHarness();

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '缁х画';
    const sendPromise = assistant.sendMessage();

    await waitForStartedStream(() => {
      const message = assistant.messages.value.at(-1);
      return message?.role === 'assistant' && message.stream?.status === 'streaming'
        ? message.id
        : undefined;
    });

    const fence = String.fromCharCode(96).repeat(3);
    const openFence = [`${fence}ts`, 'const pending = true;', ''].join(String.fromCharCode(10));

    aiServiceMock.emitDelta(openFence);
    await flushMicrotasks();

    assistant.stopCurrentRequest();

    const cancelledMessage = assistant.messages.value.at(-1);
    expect(aiServiceMock.cancel).toHaveBeenCalledWith({
      streamId: STREAM_ID,
      threadId: expect.any(String),
    });
    expect(cancelledMessage?.stream?.status).toBe('cancelled');
    expect(cancelledMessage?.content).toBe(openFence);
    expect(assistant.errorMessage.value).toBe('');

    const contentBeforeLateDelta = cancelledMessage?.content;

    // Late delta arriving after cancel must not mutate the message.
    aiServiceMock.emitDelta([fence, '不应该进入消息'].join(String.fromCharCode(10)));
    await flushMicrotasks();

    expect(assistant.messages.value.at(-1)?.content).toBe(contentBeforeLateDelta);
    expect(assistant.errorMessage.value).toBe('');

    await sendPromise;
  });

  it('does not surface a cancellation banner when the stream ends as cancelled', async () => {
    const assistant = createAssistantHarness();

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '停止后不要弹提示';
    const sendPromise = assistant.sendMessage();

    await waitForStartedStream(() => {
      const message = assistant.messages.value.at(-1);
      return message?.role === 'assistant' && message.stream?.status === 'streaming'
        ? message.id
        : undefined;
    });
    assistant.stopCurrentRequest();
    await flushMicrotasks();

    expect(assistant.errorMessage.value).toBe('');
    expect(assistant.messages.value.at(-1)?.stream?.status).toBe('cancelled');

    await sendPromise;
  });

  it('tracks streaming token progress and final provider usage on assistant messages', async () => {
    const assistant = createAssistantHarness();

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '统计 token';
    const sendPromise = assistant.sendMessage();

    await waitForStartedStream(() => {
      const message = assistant.messages.value.at(-1);
      return message?.role === 'assistant' && message.stream?.status === 'streaming'
        ? message.id
        : undefined;
    });
    aiServiceMock.emitDelta('你好');
    await flushMicrotasks();

    expect(assistant.messages.value.at(-1)?.stream).toMatchObject({
      status: 'streaming',
    });

    aiServiceMock.emitDone('你好', {
      inputTokens: 13,
      inputTokenDetails: {
        noCacheTokens: 13,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 5,
      outputTokenDetails: {
        textTokens: 4,
        reasoningTokens: 1,
      },
      totalTokens: 18,
      cachedInputTokens: 0,
      reasoningTokens: 1,
    });

    await sendPromise;

    expect(assistant.messages.value.at(-1)?.stream).toMatchObject({
      status: 'completed',
      inputTokens: 13,
      outputTokens: 5,
      totalTokens: 18,
      usage: expect.objectContaining({
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
      }),
    });
  });

  it('accepts image attachments and includes them in outgoing references', async () => {
    const createObjectURL = vi.fn(() => 'blob:attachment-preview-1');

    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 640,
        height: 480,
        close: vi.fn(),
      })),
    );

    const assistant = createAssistantHarness();
    const image = new File(['image-bytes'], 'pasted-image.png', { type: 'image/png' });

    await assistant.attachFile(image);

    expect(assistant.attachedFiles.value).toHaveLength(1);
    expect(assistant.attachedFiles.value[0]?.kind).toBe('image');
    expect(assistant.attachedFiles.value[0]?.detailLabel).toBe('640 × 480');
    expect(assistant.attachedFiles.value[0]?.preview).toMatchObject({
      src: expect.stringMatching(/^data:image\/png;base64,/),
      width: 640,
      height: 480,
      mimeType: 'image/png',
    });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(assistant.attachedFiles.value[0]?.reference.kind).toBe('image-attachment');

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '';
    const sendPromise = assistant.sendMessage();

    await waitForStartedStream(() => {
      const message = assistant.messages.value.at(-1);
      return message?.role === 'assistant' && message.stream?.status === 'streaming'
        ? message.id
        : undefined;
    });
    expect(assistant.attachedFiles.value).toHaveLength(0);

    expect(aiServiceMock.chatStream).toHaveBeenCalledTimes(1);
    expect(aiServiceMock.chatStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        references: expect.arrayContaining([
          expect.objectContaining({
            kind: 'image-attachment',
            label: '图片附件 · pasted-image.png',
            attachmentPreview: expect.objectContaining({
              src: expect.stringMatching(/^data:image\/png;base64,/),
              width: 640,
              height: 480,
              mimeType: 'image/png',
            }),
          }),
        ]),
      }),
    );
    expect(assistant.messages.value[0]?.references?.[0]?.attachmentPreview).toMatchObject({
      src: expect.stringMatching(/^data:image\/png;base64,/),
      width: 640,
      height: 480,
      mimeType: 'image/png',
    });

    assistant.stopCurrentRequest();
    await sendPromise;
  });

  it('同一输入框内为同名图片生成递增展示名', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 640,
        height: 480,
        close: vi.fn(),
      })),
    );

    const assistant = createAssistantHarness();

    await assistant.attachFile(new File(['first-image'], 'image.png', { type: 'image/png' }));
    await assistant.attachFile(new File(['second-image'], 'image.png', { type: 'image/png' }));
    await assistant.attachFile(new File(['third-image'], 'image.png', { type: 'image/png' }));

    expect(assistant.attachedFiles.value.map((file) => file.name)).toEqual([
      'image.png',
      'image1.png',
      'image2.png',
    ]);
    expect(assistant.attachedFiles.value.map((file) => file.reference.path)).toEqual([
      'image.png',
      'image1.png',
      'image2.png',
    ]);
  });

  it('同一输入框内重复粘贴相同图片时不重复添加', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 640,
        height: 480,
        close: vi.fn(),
      })),
    );

    const assistant = createAssistantHarness();

    await assistant.attachFile(new File(['same-image'], 'image.png', { type: 'image/png' }));
    await assistant.attachFile(new File(['same-image'], 'image.png', { type: 'image/png' }));

    expect(assistant.attachedFiles.value).toHaveLength(1);
    expect(assistant.attachedFiles.value[0]?.name).toBe('image.png');

    assistant.startNewConversation();
    await assistant.attachFile(new File(['same-image'], 'image.png', { type: 'image/png' }));

    expect(assistant.attachedFiles.value).toHaveLength(1);
    expect(assistant.attachedFiles.value[0]?.name).toBe('image.png');
  });

  it('keeps durable image preview sources when removing attachments', async () => {
    const createObjectURL = vi.fn(() => 'blob:attachment-preview-2');
    const revokeObjectURL = vi.fn();

    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL,
    });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 320,
        height: 200,
        close: vi.fn(),
      })),
    );

    const assistant = createAssistantHarness();
    const image = new File(['image-bytes'], 'removable-image.png', { type: 'image/png' });

    await assistant.attachFile(image);

    const attachmentId = assistant.attachedFiles.value[0]?.id;
    expect(assistant.attachedFiles.value[0]?.preview?.src).toMatch(/^data:image\/png;base64,/);
    expect(attachmentId).toBeTruthy();

    assistant.removeAttachedFile(attachmentId as string);

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('清空草稿并展示用户消息时，不再等待 @project 上下文查询', async () => {
    const { assistant } = createAssistantHarnessContext();
    const userQuestion = '@project 查一下发送流程';
    const executeDeferred =
      createDeferred<Awaited<ReturnType<typeof aiServiceMock.sidecarExecute>>>();

    aiServiceMock.sidecarExecute.mockReturnValueOnce(executeDeferred.promise);

    assistant.activeMode.value = 'agent';
    assistant.draft.value = userQuestion;

    const sendPromise = assistant.sendMessage();

    expect(assistant.draft.value).toBe('');
    expect(assistant.isSending.value).toBe(true);
    expect(assistant.messages.value[0]).toMatchObject({
      role: 'user',
      content: userQuestion,
      references: [],
    });
    expect(aiServiceMock.queryIndex).toHaveBeenCalledTimes(0);

    await flushMicrotasks();

    expect(aiServiceMock.sidecarExecute).toHaveBeenCalledTimes(1);

    executeDeferred.resolve({
      sessionId: 'sidecar-execute-session-1',
      events: [
        {
          type: 'done',
          result: '已收到请求。',
        },
      ],
      result: '已收到请求。',
    });
    await sendPromise;
  });

  it('does not restore the draft when the chat stream errors after sending', async () => {
    const assistant = createAssistantHarness();
    const userQuestion = '解释当前脚本';

    aiServiceMock.queueStreamResponse('', 'error', '网络突然断开');
    assistant.activeMode.value = 'chat';
    assistant.draft.value = userQuestion;

    await assistant.sendMessage();

    expect(assistant.errorMessage.value).toBe('网络突然断开');
    expect(assistant.draft.value).toBe('');
    expect(assistant.messages.value[0]).toMatchObject({
      role: 'user',
      content: userQuestion,
    });
  });

  it('后台只用第一轮问答生成正式会话标题', async () => {
    const assistant = createAssistantHarness();
    const conversationStore = useAiThreadStore();

    aiServiceMock.queueStreamResponse('第一轮 AI 回答');
    assistant.activeMode.value = 'chat';
    assistant.draft.value = '如何修复会话记录弹窗？';

    await assistant.sendMessage();
    await flushMicrotasks();

    expect(aiServiceMock.generateConversationTitle).toHaveBeenCalledWith({
      userMessage: '如何修复会话记录弹窗？',
      assistantMessage: '第一轮 AI 回答',
    });
    expect(readReactiveValue(conversationStore.activeConversationThread)?.title).toBe(
      '生成会话标题',
    );
    expect(readReactiveValue(conversationStore.activeConversationThread)?.titleStatus).toBe(
      'generated',
    );
  });

  it('会话标题首次失败后会自动重试', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    });
    const assistant = createAssistantHarness();
    const conversationStore = useAiThreadStore();

    aiServiceMock.generateConversationTitle
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValueOnce({
        title: '重试后标题',
        model: MOCK_MODEL,
      });
    aiServiceMock.queueStreamResponse('第一轮 AI 回答');
    assistant.activeMode.value = 'chat';
    assistant.draft.value = '为什么标题有时生成失败？';

    await assistant.sendMessage();
    await flushMicrotasks();

    expect(aiServiceMock.generateConversationTitle).toHaveBeenCalledTimes(1);
    expect(readReactiveValue(conversationStore.activeConversationThread)?.titleStatus).toBe(
      'failed',
    );

    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(aiServiceMock.generateConversationTitle).toHaveBeenCalledTimes(2);
    expect(readReactiveValue(conversationStore.activeConversationThread)?.title).toBe('重试后标题');
    expect(readReactiveValue(conversationStore.activeConversationThread)?.titleStatus).toBe(
      'generated',
    );
  });

  it('starts a new conversation by clearing draft and transient state', () => {
    const assistant = createAssistantHarness();

    assistant.draft.value = '杩樻病鍙戦€佺殑鍐呭';
    writeReactiveValue(assistant.messages, [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '旧会话消息',
        createdAt: '2026-04-28T10:00:00.000Z',
        references: [],
      },
    ]);
    assistant.currentReferences.value = [
      {
        id: 'ref-1',
        kind: 'current-file',
        label: '褰撳墠鏂囦欢',
        path: 'src/app.ts',
        range: null,
        contentPreview: 'const start = true;',
        redacted: false,
      },
    ];
    assistant.errorMessage.value = '旧错误';

    assistant.startNewConversation();

    expect(assistant.draft.value).toBe('');
    expect(assistant.messages.value).toHaveLength(0);
    expect(readReactiveValue(assistant.historyThreads)).toHaveLength(1);
    expect(readReactiveValue(assistant.historyThreads)[0]?.messages[0]?.id).toBe('assistant-1');
    expect(assistant.currentReferences.value).toHaveLength(0);
    expect(assistant.errorMessage.value).toBe('');
  });

  it('switching conversations keeps pending sidecar approval persisted for its original thread', () => {
    const assistant = createAssistantHarness();
    const conversationStore = useAiThreadStore();
    const agentStore = useAiAgentStore();
    const firstThreadId = readReactiveValue(assistant.activeConversationId);

    expect(firstThreadId).toBeTruthy();

    agentStore.setPendingToolConfirmation({
      id: 'approval-switch-command',
      runId: 'sidecar:sidecar-switch-session',
      stepId: 'sidecar:approval-switch-command',
      toolName: 'run_command',
      question: '允许 Agent 执行命令吗？',
      summary: '运行验证命令。',
      riskLevel: 'medium',
      impact: '运行验证命令。',
      reversible: false,
      createdAt: '2026-05-17T00:00:00.000Z',
      options: [
        { id: 'allow-once', label: '允许', tone: 'primary' },
        { id: 'stop', label: '拒绝', tone: 'danger' },
      ],
    });
    agentStore.setPendingSidecarAgentSession({
      sessionId: 'sidecar-switch-session',
      assistantMessageId: 'assistant-switch-approval',
      threadId: firstThreadId,
      turnId: 'user-switch-approval',
      baseMessages: [],
      messageContent: '运行验证命令',
      references: [],
    });

    conversationStore.startNewThread();
    const secondThreadId = readReactiveValue(conversationStore.activeThreadId);

    expect(secondThreadId).toBeTruthy();
    expect(secondThreadId).not.toBe(firstThreadId);

    assistant.switchConversation(secondThreadId ?? '');
    expect(agentStore.pendingToolConfirmation?.id).toBe('approval-switch-command');
    expect(agentStore.pendingSidecarAgentSession?.threadId).toBe(firstThreadId);

    assistant.switchConversation(firstThreadId ?? '');
    expect(agentStore.pendingToolConfirmation?.id).toBe('approval-switch-command');
    expect(agentStore.pendingSidecarAgentSession?.threadId).toBe(firstThreadId);
  });

  it('hydrates persisted messages from the conversation store', () => {
    const conversationStore = useAiThreadStore();

    conversationStore.replaceMessages([
      {
        id: 'persisted-message',
        role: 'assistant',
        content: '持久化历史消息',
        createdAt: '2026-04-28T10:00:00.000Z',
        references: [],
      },
    ]);

    const assistant = createAssistantHarness();

    expect(assistant.messages.value).toHaveLength(1);
    expect(assistant.messages.value[0]?.id).toBe('persisted-message');
  });

  it('runs a complex sidecar Plan flow via orchestration', async () => {
    const { assistant } = createAssistantHarnessContext();
    const store = assistant.agentPlan.store;
    const userQuestion = '帮我完成一个复杂的多步骤任务';

    aiServiceMock.sidecarOrchestrate.mockImplementationOnce(async (request) => {
      const sessionId = request.sessionId ?? 'complex-session-1';
      const events: IAgentSidecarStreamEventPayload['event'][] = [
        { type: 'tool_start', toolName: 'list_project_files', input: {} },
        { type: 'tool_result', toolName: 'list_project_files', output: {} },
        {
          type: 'plan_ready',
          planId: 'complex-plan-1',
          threadId: 'thread-1',
          version: 1,
          status: 'pending_approval',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          approvedAt: null,
          executedAt: null,
          rejectionReason: null,
          errorMessage: null,
          plan: {
            goal: 'complex-goal',
            requiresApproval: true,
            steps: [
              {
                id: 'complex-step-1',
                title: 'complex-step-1',
                goal: 'complex-step-1',
                status: 'pending',
                tools: [],
                riskLevel: 'low',
                requiresApproval: false,
                expectedOutput: '',
              },
              {
                id: 'complex-step-2',
                title: 'complex-step-2',
                goal: 'complex-step-2',
                status: 'pending',
                tools: [],
                riskLevel: 'medium',
                requiresApproval: true,
                expectedOutput: '',
              },
              {
                id: 'complex-step-3',
                title: 'complex-step-3',
                goal: 'complex-step-3',
                status: 'pending',
                tools: [],
                riskLevel: 'low',
                requiresApproval: false,
                expectedOutput: '',
              },
            ],
          },
        },
      ];
      events.forEach((event, index) => {
        aiServiceMock.emitSidecar({ sessionId, seq: index, event });
      });
      return { runId: 'complex-orchestrate-run-1', result: null };
    });

    assistant.activeMode.value = 'plan';
    assistant.draft.value = userQuestion;

    await assistant.sendMessage();
    await flushMicrotasks();

    expect(assistant.messages.value).toHaveLength(1);
    expect(assistant.messages.value[0]?.role).toBe('user');
    expect(assistant.messages.value[0]?.content).toBe(userQuestion);

    expect(aiServiceMock.classifyTask).toHaveBeenCalledTimes(0);
    expect(aiServiceMock.chatStream).toHaveBeenCalledTimes(0);

    expect(aiServiceMock.sidecarOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({ goal: userQuestion }),
    );

    expect(assistant.agentSteps.value).toHaveLength(3);
    expect(readReactiveValue(store.steps)).toHaveLength(3);
    expect(readReactiveValue(store.steps)[1]?.requiresUserApproval).toBe(true);
  });

  it('plan 请求只把目标交给 sidecar 编排，不再转发消息和文件上下文', async () => {
    const { assistant } = createAssistantHarnessContext();

    assistant.activeMode.value = 'plan';
    assistant.draft.value = '@current-file 修改完善这个文件';

    await assistant.sendMessage();

    const request = aiServiceMock.sidecarOrchestrate.mock.calls[0]?.[0];

    expect(request?.goal).toBe('@current-file 修改完善这个文件');
    expect(request).not.toHaveProperty('messages');
    expect(request).not.toHaveProperty('context');
  });

  it('璁″垝鐢熸垚澶辫触鏃舵竻鎺夋棫姝ラ鍜屾棫 run锛岄伩鍏嶅崱鍦ㄦ墽琛屼腑', async () => {
    const { assistant } = createAssistantHarnessContext();
    const staleSteps = [
      createPlanStep('plan-step-1', '旧计划第一步', 'running'),
      createPlanStep('plan-step-2', '旧计划第二步'),
    ];
    const planStore = assistant.agentPlan.store;
    const userQuestion = '@current-file 修改完善这个文件';

    planStore.setPlan('旧计划', staleSteps);
    Reflect.set(planStore, 'approvedAt', '2026-04-29T00:00:00.000Z');
    planStore.upsertRun(createAgentRun(staleSteps));
    assistant.agentSteps.value = staleSteps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
    }));
    aiServiceMock.classifyTask.mockResolvedValueOnce({
      classification: 'complex',
      shouldEnterPlanMode: true,
      reason: '当前请求需要多步计划。',
    });
    aiServiceMock.sidecarOrchestrate.mockRejectedValueOnce(
      new Error('IPC 请求参数无效，已记录 traceId=b45c10a5-d0d1-487d-bd。'),
    );

    assistant.activeMode.value = 'plan';
    assistant.draft.value = userQuestion;

    await assistant.sendMessage();

    expect(readReactiveValue(planStore.steps)).toHaveLength(0);
    expect(readReactiveValue(planStore.activeRunId)).toBeNull();
    expect(readReactiveValue(planStore.approvedAt)).toBeNull();
    expect(readReactiveValue(planStore.errorMessage)).toContain('IPC 请求参数无效');
    expect(assistant.agentSteps.value).toHaveLength(0);
    expect(assistant.draft.value).toBe('');
  });

  it('uses Mastra sidecar execute directly in agent mode without generating a plan', async () => {
    const { assistant } = createAssistantHarnessContext();

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '瑙ｉ噴褰撳墠鑴氭湰';

    await assistant.sendMessage();

    expect(aiServiceMock.classifyTask).toHaveBeenCalledTimes(0);
    expect(aiServiceMock.chatStream).toHaveBeenCalledTimes(0);
    expect(aiServiceMock.sidecarExecute).toHaveBeenCalledTimes(1);
    expect(aiServiceMock.applyPatch).toHaveBeenCalledTimes(0);
    expect(assistant.messages.value[1]?.content).toContain('已通过 Mastra Agent 处理：');
    expect(assistant.messages.value[1]?.toolCalls?.[0]).toMatchObject({
      name: 'read_project_file',
      status: 'succeeded',
      summary: expect.stringContaining('src/app.ts'),
    });
  });

  it('does not call narrator for plain read activity without a meaningful transition', async () => {
    const { assistant } = createAssistantHarnessContext({ narratorConfigured: true });

    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-narrator-read-session',
      events: [
        {
          type: 'tool_start',
          toolName: 'read_project_file',
          input: { path: 'src/app.ts:1-20' },
        },
        {
          type: 'tool_result',
          toolName: 'read_project_file',
          output: {
            path: 'src/app.ts:1-20',
            summary: '已读取 20 行',
          },
        },
      ],
      result: '已读取完成。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '先看看 app.ts';

    await assistant.sendMessage();
    await flushMicrotasks();
  });

  it('raw sidecar event 模式下编辑完成时不会再启动 narrator', async () => {
    const { assistant } = createAssistantHarnessContext({ narratorConfigured: true });
    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-narrator-edit-session',
      events: [
        {
          type: 'tool_start',
          toolName: 'write_file',
          input: { path: 'src/app.ts' },
        },
        {
          type: 'tool_result',
          toolName: 'write_file',
          output: {
            path: 'src/app.ts',
            summary: 'src/app.ts +3 -1',
            content: 'const shouldNotLeak = true;',
          },
        },
      ],
      result: '已完成修改。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '修复 app.ts';

    await assistant.sendMessage();
    await flushMicrotasks();
  });

  it('raw sidecar event 模式下重复编辑事件也不会创建 narrator 请求', async () => {
    const { assistant } = createAssistantHarnessContext({ narratorConfigured: true });

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-narrator-dedupe-session';
        const toolStartEvent = {
          type: 'tool_start' as const,
          toolName: 'write_file',
          input: { path: 'src/app.ts' },
        };
        const toolResultEvent = {
          type: 'tool_result' as const,
          toolName: 'write_file',
          output: {
            path: 'src/app.ts',
            summary: 'src/app.ts +2 -0',
          },
        };

        aiServiceMock.emitSidecar({ sessionId, seq: 0, event: toolStartEvent });
        aiServiceMock.emitSidecar({ sessionId, seq: 1, event: toolResultEvent });

        return {
          sessionId,
          events: [toolStartEvent, toolResultEvent],
          result: '已完成修改。',
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '修复 app.ts';

    await assistant.sendMessage();
    await flushMicrotasks();
  });

  it('raw sidecar event 模式下不会监听 narrator turn 结果', async () => {
    const { assistant } = createAssistantHarnessContext({ narratorConfigured: true });
    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-narrator-turn-session',
      events: [
        {
          type: 'tool_start',
          toolName: 'write_file',
          input: { path: 'src/app.ts' },
        },
        {
          type: 'tool_result',
          toolName: 'write_file',
          output: {
            path: 'src/app.ts',
            summary: 'src/app.ts +1 -0',
          },
        },
      ],
      result: '已完成修改。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '修复 app.ts';

    await assistant.sendMessage();
    await flushMicrotasks();
  });

  it('raw sidecar event 模式下连续序列更新不会创建 narrator 序列', async () => {
    const { assistant } = createAssistantHarnessContext({ narratorConfigured: true });
    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-narrator-sequence-session';

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'tool_start',
            toolName: 'write_file',
            input: { path: 'src/first.ts' },
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 1,
          event: {
            type: 'tool_result',
            toolName: 'write_file',
            output: {
              path: 'src/first.ts',
              summary: 'src/first.ts +1 -0',
            },
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 2,
          event: {
            type: 'tool_start',
            toolName: 'write_file',
            input: { path: 'src/second.ts' },
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 3,
          event: {
            type: 'tool_result',
            toolName: 'write_file',
            output: {
              path: 'src/second.ts',
              summary: 'src/second.ts +2 -0',
            },
          },
        });

        return {
          sessionId,
          events: [],
          result: '连续两次修改完成。',
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '连续修改两个文件';

    await assistant.sendMessage();
    await flushMicrotasks();
  });

  it('raw sidecar event 模式下不会再发送 narrator facts', async () => {
    const { assistant } = createAssistantHarnessContext({ narratorConfigured: true });

    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-narrator-safety-session',
      events: [
        {
          type: 'tool_start',
          toolName: 'write_file',
          input: {
            path: 'src/unsafe.ts',
            content: 'const secret = 1;',
            raw: { token: 'sensitive' },
          },
        },
        {
          type: 'tool_result',
          toolName: 'write_file',
          output: {
            path: 'src/unsafe.ts',
            summary: 'src/unsafe.ts +4 -0',
            stdout: 'should-not-leak-stdout',
            content: 'const secret = 1;',
            raw: {
              nested: 'should-not-leak-json',
            },
          },
        },
      ],
      result: '已完成修改。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '修复 unsafe.ts';

    await assistant.sendMessage();
    await flushMicrotasks();
  });

  it('sidecar 首个事件到达前就显示上下文相关的运行状态', async () => {
    const { assistant } = createAssistantHarnessContext();
    const conversationStore = useAiThreadStore();
    const sidecarGate = createDeferred<void>();

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        await sidecarGate.promise;

        return {
          sessionId: payload.sessionId ?? 'sidecar-news-session',
          events: [
            {
              type: 'done',
              result: '已整理今日热点新闻。',
            },
          ],
          result: '已整理今日热点新闻。',
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '今天有什么新闻';

    const sendPromise = assistant.sendMessage();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (assistant.messages.value[1]) {
        break;
      }
      await Promise.resolve();
    }

    expect(assistant.messages.value[1]).toMatchObject({
      role: 'assistant',
      content: '',
      stream: {
        status: 'streaming',
        activityText: '',
        runtimeEvents: [],
      },
    });
    expect(conversationStore.activeMessages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      stream: {
        status: 'streaming',
        runtimeEvents: [],
      },
    });

    sidecarGate.resolve(undefined);
    await sendPromise;

    expect(assistant.messages.value[1]?.content).toBe('已整理今日热点新闻。');
    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
    expect(assistant.messages.value[1]?.stream?.activityText).toBe('请求处理中');
  });

  it('streams sidecar tool activity into the assistant message before the final response resolves', async () => {
    const { assistant } = createAssistantHarnessContext();
    const conversationStore = useAiThreadStore();
    const sidecarGate = createDeferred<void>();

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-live-session';

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'tool_start',
            toolName: 'search_project_files',
            input: { query: '实时工具' },
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 1,
          event: {
            type: 'agent_event',
            event: {
              id: 'runtime-live-tool-start',
              type: 'agent.tool.started',
              runId: 'run-live-1',
              sessionId,
              agentId: 'agent-live-1',
              timestamp: '2026-05-02T10:00:00.000Z',
              seq: 0,
              schemaVersion: 1,
              redacted: true,
              visibility: 'user',
              level: 'info',
              toolName: 'search_project_files',
              inputPreview: '{"query":"实时工具"}',
            },
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 2,
          event: {
            type: 'message_delta',
            text: '第一段实时回答',
            phase: 'final',
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 3,
          event: {
            type: 'message_delta',
            text: '第一段实时回答，第二段继续到达',
            phase: 'final',
          },
        });

        await sidecarGate.promise;

        return {
          sessionId,
          events: [
            {
              type: 'tool_start',
              toolName: 'search_project_files',
              input: { query: '实时工具' },
            },
            {
              type: 'tool_result',
              toolName: 'search_project_files',
              output: { query: '实时工具', summary: '搜索完成' },
            },
            {
              type: 'done',
              result: '实时工具完成',
            },
          ],
          result: '实时工具完成',
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '搜索实时工具';

    const sendPromise = assistant.sendMessage();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (assistant.messages.value[1]?.toolCalls?.[0]) {
        break;
      }
      await Promise.resolve();
    }

    expect(assistant.messages.value[1]?.toolCalls?.[0]).toMatchObject({
      name: 'search_project_files',
      status: 'running',
      summary: expect.stringContaining('实时工具'),
    });
    expect(assistant.messages.value[1]?.content).toContain('第二段继续到达');
    expect(assistant.messages.value[1]?.stream?.status).toBe('streaming');
    expect(assistant.messages.value[1]?.stream?.activityText).toBe(
      '正在搜索「实时工具」，范围 工作区',
    );
    expect(assistant.messages.value[1]?.stream?.runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.tool.started',
          toolName: 'search_project_files',
        }),
      ]),
    );
    expect(conversationStore.activeMessages[1]?.stream?.runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.tool.started',
          toolName: 'search_project_files',
        }),
      ]),
    );
    expect(assistant.runtimeTimelineEvents.value).toHaveLength(1);
    expect(assistant.runtimeTimelineEvents.value[0]).toMatchObject({
      type: 'agent.tool.started',
      toolName: 'search_project_files',
    });

    sidecarGate.resolve(undefined);
    await sendPromise;

    expect(assistant.messages.value[1]?.content).toContain('实时工具完成');
    expect(assistant.messages.value[1]?.toolCalls?.[0]?.status).toBe('succeeded');
    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
    expect(assistant.messages.value[1]?.stream?.activityText).toBe('在 工作区 搜索「实时工具」');
    expect(assistant.messages.value[1]?.stream?.runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.tool.started',
          toolName: 'search_project_files',
        }),
      ]),
    );
  });

  it('stores sidecar done token usage on the assistant message stream', async () => {
    const { assistant } = createAssistantHarnessContext();

    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-usage-session',
      events: [
        {
          type: 'done',
          result: '已统计 token。',
          inputTokens: 13,
          outputTokens: 5,
          totalTokens: 18,
          usage: {
            inputTokens: 13,
            inputTokenDetails: {
              noCacheTokens: 13,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokens: 5,
            outputTokenDetails: {
              textTokens: 4,
              reasoningTokens: 1,
            },
            totalTokens: 18,
            cachedInputTokens: 0,
            reasoningTokens: 1,
          },
        },
      ],
      result: '已统计 token。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '统计 token';

    await assistant.sendMessage();

    expect(assistant.messages.value[1]?.stream).toMatchObject({
      status: 'completed',
      inputTokens: 13,
      outputTokens: 5,
      totalTokens: 18,
      usage: expect.objectContaining({
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
      }),
    });
  });

  it('工具校验失败但 sidecar 返回 done 时不保持思考中', async () => {
    const { assistant } = createAssistantHarnessContext();

    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-tool-validation-session',
      events: [
        {
          type: 'agent_event',
          event: {
            id: 'runtime-time-tool-start',
            type: 'agent.tool.started',
            runId: 'run-time-tool',
            sessionId: 'sidecar-tool-validation-session',
            agentId: 'agent-time-tool',
            timestamp: '2026-05-09T10:00:00.000Z',
            seq: 0,
            schemaVersion: 1,
            redacted: true,
            visibility: 'user',
            level: 'info',
            toolName: 'get_current_time',
          },
        },
        {
          type: 'agent_event',
          event: {
            id: 'runtime-time-tool-failed',
            type: 'agent.tool.completed',
            runId: 'run-time-tool',
            sessionId: 'sidecar-tool-validation-session',
            agentId: 'agent-time-tool',
            timestamp: '2026-05-09T10:00:01.000Z',
            seq: 1,
            schemaVersion: 1,
            redacted: true,
            visibility: 'user',
            level: 'error',
            toolName: 'get_current_time',
            ok: false,
            errorMessage: 'Tool input validation failed for get_current_time.',
          },
        },
        {
          type: 'tool_result',
          toolName: 'get_current_time',
          output: {
            error: 'Tool input validation failed for get_current_time.',
          },
        },
        {
          type: 'done',
          result: '时间工具调用失败，请重试。',
        },
      ],
      result: '时间工具调用失败，请重试。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '网络搜索上周的新闻';

    await assistant.sendMessage();

    const assistantMessage = assistant.messages.value[1];

    expect(assistantMessage?.content).toBe('时间工具调用失败，请重试。');
    expect(assistantMessage?.stream?.status).toBe('completed');
    expect(assistantMessage?.toolCalls?.[0]).toMatchObject({
      name: 'get_current_time',
      status: 'failed',
    });
  });

  it('sidecar message_delta 合帧刷新，避免长回答逐 token 卡住且不改变最终结果', async () => {
    const { assistant } = createAssistantHarnessContext();
    const conversationStore = useAiThreadStore();
    const replaceThreadMessagesSpy = vi.spyOn(conversationStore, 'replaceThreadMessages');
    const sidecarGate = createDeferred<void>();
    const queuedFrames = new Map<number, FrameRequestCallback>();
    const expectedLiveText = '第一段实时回答，第二段实时回答';
    let nextFrameId = 0;
    let frameTimestamp = 0;

    const runNextQueuedFrame = (): void => {
      const frame = Array.from(queuedFrames.entries())[0];
      expect(frame).toBeDefined();

      if (!frame) {
        throw new Error('expected queued animation frame');
      }

      frameTimestamp += 16;
      queuedFrames.delete(frame[0]);
      frame[1](frameTimestamp);
    };

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      nextFrameId += 1;
      queuedFrames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (frameId: number): void => {
      queuedFrames.delete(frameId);
    });

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-batched-frame-session';

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'tool_start',
            toolName: 'search_project_files',
            input: { query: '批量刷新' },
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 1,
          event: {
            type: 'message_delta',
            text: '第一段实时回答',
            phase: 'final',
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 2,
          event: {
            type: 'message_delta',
            // message_delta 是增量片段；缓冲层按阶段拼成累计文本。
            text: '，第二段实时回答',
            phase: 'final',
          },
        });

        await sidecarGate.promise;

        return {
          sessionId,
          events: [
            {
              type: 'tool_start',
              toolName: 'search_project_files',
              input: { query: '批量刷新' },
            },
            {
              type: 'tool_result',
              toolName: 'search_project_files',
              output: { query: '批量刷新', summary: '搜索完成' },
            },
            {
              type: 'done',
              result: '批量刷新完成',
            },
          ],
          result: '批量刷新完成',
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '测试批量刷新';

    const sendPromise = assistant.sendMessage();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (queuedFrames.size > 0) {
        break;
      }
      await Promise.resolve();
    }

    expect(queuedFrames.size).toBe(1);
    runNextQueuedFrame();
    await Promise.resolve();

    // 合帧刷新：两个 message_delta 已被合并进同一帧；落帧后内容一次性追平到最新文本，
    // 不再依赖 useAiStream 的二次逐帧节流（逐帧揭示已下沉到渲染层 markstream-vue）。
    expect(queuedFrames.size).toBe(0);
    expect(assistant.messages.value[1]?.content).toBe(expectedLiveText);
    expect(assistant.messages.value[1]?.toolCalls?.[0]).toMatchObject({
      name: 'search_project_files',
      status: 'running',
    });

    sidecarGate.resolve(undefined);

    await sendPromise;

    expect(assistant.messages.value[1]?.content).toBe('批量刷新完成');
    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
    expect(replaceThreadMessagesSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('sidecar 执行中切换会话仍回写发起会话，避免回来后内容清空', async () => {
    const { assistant } = createAssistantHarnessContext();
    const conversationStore = useAiThreadStore();
    const sidecarGate = createDeferred<void>();
    const finalText = '切换会话后仍然保留的 Agent 回复';

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-thread-switch-session';

        await sidecarGate.promise;

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'message_delta',
            text: finalText,
            phase: 'final',
          },
        });

        return {
          sessionId,
          events: [
            {
              type: 'done',
              result: finalText,
            },
          ],
          result: finalText,
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '测试执行中切换会话';
    const sourceThreadId = conversationStore.activeThreadId;

    const sendPromise = assistant.sendMessage();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (assistant.messages.value[1]) {
        break;
      }
      await Promise.resolve();
    }

    conversationStore.startNewThread();
    expect(conversationStore.activeThreadId).not.toBe(sourceThreadId);
    expect(conversationStore.activeMessages).toHaveLength(0);

    sidecarGate.resolve(undefined);
    await sendPromise;

    const sourceThread = conversationStore.conversationHistoryThreads.find(
      (thread) => thread.id === sourceThreadId,
    );
    expect(sourceThread?.messages[1]?.content).toBe(finalText);
    expect(sourceThread?.messages[1]?.stream?.status).toBe('completed');
    expect(conversationStore.activeMessages).toHaveLength(0);
    expect(assistant.messages.value).toHaveLength(0);
  });

  it('没有实时回答 delta 时直接提交 sidecar 最终结果，避免长文本被慢放', async () => {
    const { assistant } = createAssistantHarnessContext();
    const sidecarGate = createDeferred<void>();
    const queuedFrames = new Map<number, FrameRequestCallback>();
    const finalText = '这是一段没有提前收到实时 delta 的最终回答。'.repeat(20);
    let nextFrameId = 0;

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      nextFrameId += 1;
      queuedFrames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (frameId: number): void => {
      queuedFrames.delete(frameId);
    });

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-final-only-session';

        await sidecarGate.promise;

        return {
          sessionId,
          events: [
            {
              type: 'done',
              result: finalText,
            },
          ],
          result: finalText,
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '测试最终结果直接提交';

    const sendPromise = assistant.sendMessage();
    sidecarGate.resolve(undefined);
    await sendPromise;

    expect(assistant.messages.value[1]?.content).toBe(finalText);
    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
    expect(queuedFrames.size).toBe(0);
  });

  it('收到空的 sidecar message_delta 时清空非最终阶段说明，等待后续最终回答流', async () => {
    const { assistant } = createAssistantHarnessContext();
    const finalGate = createDeferred<void>();

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-clear-delta-session';

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'message_delta',
            text: '我先查看一下文件。',
            phase: 'stage',
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 1,
          event: {
            type: 'message_delta',
            text: '',
            phase: 'stage',
          },
        });

        await finalGate.promise;

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 2,
          event: {
            type: 'message_delta',
            text: '这是最终回答的流式内容。',
            phase: 'final',
          },
        });

        return {
          sessionId,
          events: [
            {
              type: 'done',
              result: '这是最终回答的流式内容。',
            },
          ],
          result: '这是最终回答的流式内容。',
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '检查文件';

    const sendPromise = assistant.sendMessage();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (assistant.messages.value[1]?.stream?.status === 'streaming') {
        break;
      }
      await Promise.resolve();
    }

    expect(assistant.messages.value[1]?.content).toBe('');

    finalGate.resolve(undefined);
    await sendPromise;

    expect(assistant.messages.value[1]?.content).toBe('这是最终回答的流式内容。');
    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
  });

  it('按 Streaming Events 的字段语义裁剪公开进度，不把 raw JSON 直接塞进活动轨迹', async () => {
    const { assistant } = createAssistantHarnessContext();
    const sidecarGate = createDeferred<void>();

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-runtime-preview-session';

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'agent_event',
            event: {
              id: 'runtime-preview-started',
              type: 'agent.run.started',
              runId: 'run-preview-1',
              sessionId,
              agentId: 'agent-preview-1',
              timestamp: '2026-05-02T10:00:00.000Z',
              seq: 0,
              schemaVersion: 1,
              redacted: true,
              visibility: 'user',
              level: 'info',
              inputPreview:
                '{"query":"淘宝网 最新商品 2026","site":"taobao.com","path":"D:/repo/src/搜索🙂.vue"}',
            },
          },
        });

        await sidecarGate.promise;

        return {
          sessionId,
          events: [
            {
              type: 'agent_event',
              event: {
                id: 'runtime-preview-started',
                type: 'agent.run.started',
                runId: 'run-preview-1',
                sessionId,
                agentId: 'agent-preview-1',
                timestamp: '2026-05-02T10:00:00.000Z',
                seq: 0,
                schemaVersion: 1,
                redacted: true,
                visibility: 'user',
                level: 'info',
                inputPreview:
                  '{"query":"淘宝网 最新商品 2026","site":"taobao.com","path":"D:/repo/src/搜索🙂.vue"}',
              },
            },
            {
              type: 'done',
              result: '已完成搜索。',
            },
          ],
          result: '已完成搜索。',
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '搜索淘宝网最新商品';

    const sendPromise = assistant.sendMessage();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (assistant.runtimeTimelineEvents.value.length > 0) {
        break;
      }
      await Promise.resolve();
    }
    expect(assistant.runtimeTimelineEvents.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.run.started',
          inputPreview:
            '{"query":"淘宝网 最新商品 2026","site":"taobao.com","path":"D:/repo/src/搜索🙂.vue"}',
        }),
      ]),
    );

    sidecarGate.resolve(undefined);
    await sendPromise;
  });

  it('把 user-visible side_effect 和 rollback runtime event 保留到新 runtime 时间线', async () => {
    const { assistant } = createAssistantHarnessContext();
    const sidecarGate = createDeferred<void>();

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-runtime-activity-session';

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'agent_event',
            event: {
              id: 'runtime-side-effect-recorded',
              type: 'side_effect.recorded',
              runId: 'run-activity-1',
              sessionId,
              agentId: 'agent-runtime-1',
              timestamp: '2026-05-02T10:00:00.000Z',
              seq: 0,
              schemaVersion: 1,
              redacted: true,
              visibility: 'user',
              level: 'warn',
              toolName: 'write_file',
              riskLevel: 'high',
              undoAvailable: false,
              message: '已记录文件写入副作用风险，后续需要人工确认。',
            },
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 1,
          event: {
            type: 'agent_event',
            event: {
              id: 'runtime-rollback-started',
              type: 'rollback.restore.started',
              runId: 'run-activity-1',
              sessionId,
              agentId: 'agent-runtime-1',
              timestamp: '2026-05-02T10:00:01.000Z',
              seq: 1,
              schemaVersion: 1,
              redacted: true,
              visibility: 'user',
              level: 'info',
              snapshotId: 'snapshot-42',
            },
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 2,
          event: {
            type: 'agent_event',
            event: {
              id: 'runtime-rollback-failed',
              type: 'rollback.restore.failed',
              runId: 'run-activity-1',
              sessionId,
              agentId: 'agent-runtime-1',
              timestamp: '2026-05-02T10:00:02.000Z',
              seq: 2,
              schemaVersion: 1,
              redacted: true,
              visibility: 'user',
              level: 'error',
              snapshotId: 'snapshot-42',
              errorMessage: '未找到可恢复的 checkpoint。',
            },
          },
        });

        await sidecarGate.promise;

        return {
          sessionId,
          events: [
            {
              type: 'agent_event',
              event: {
                id: 'runtime-side-effect-recorded',
                type: 'side_effect.recorded',
                runId: 'run-activity-1',
                sessionId,
                agentId: 'agent-runtime-1',
                timestamp: '2026-05-02T10:00:00.000Z',
                seq: 0,
                schemaVersion: 1,
                redacted: true,
                visibility: 'user',
                level: 'warn',
                toolName: 'write_file',
                riskLevel: 'high',
                undoAvailable: false,
                message: '已记录文件写入副作用风险，后续需要人工确认。',
              },
            },
            {
              type: 'agent_event',
              event: {
                id: 'runtime-rollback-started',
                type: 'rollback.restore.started',
                runId: 'run-activity-1',
                sessionId,
                agentId: 'agent-runtime-1',
                timestamp: '2026-05-02T10:00:01.000Z',
                seq: 1,
                schemaVersion: 1,
                redacted: true,
                visibility: 'user',
                level: 'info',
                snapshotId: 'snapshot-42',
              },
            },
            {
              type: 'agent_event',
              event: {
                id: 'runtime-rollback-failed',
                type: 'rollback.restore.failed',
                runId: 'run-activity-1',
                sessionId,
                agentId: 'agent-runtime-1',
                timestamp: '2026-05-02T10:00:02.000Z',
                seq: 2,
                schemaVersion: 1,
                redacted: true,
                visibility: 'user',
                level: 'error',
                snapshotId: 'snapshot-42',
                errorMessage: '未找到可恢复的 checkpoint。',
              },
            },
            {
              type: 'done',
              result: '已结束回滚验证。',
            },
          ],
          result: '已结束回滚验证。',
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '执行带回滚保护的修改';

    const sendPromise = assistant.sendMessage();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if ((assistant.messages.value[1]?.stream?.runtimeEvents?.length ?? 0) >= 3) {
        break;
      }
      await Promise.resolve();
    }

    expect(assistant.messages.value[1]?.stream?.runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'side_effect.recorded',
          message: '已记录文件写入副作用风险，后续需要人工确认。',
        }),
        expect.objectContaining({
          type: 'rollback.restore.started',
          snapshotId: 'snapshot-42',
        }),
        expect.objectContaining({
          type: 'rollback.restore.failed',
          errorMessage: '未找到可恢复的 checkpoint。',
        }),
      ]),
    );

    sidecarGate.resolve(undefined);
    await sendPromise;

    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
    expect(assistant.messages.value[1]?.stream?.runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'side_effect.recorded',
          message: '已记录文件写入副作用风险，后续需要人工确认。',
        }),
        expect.objectContaining({
          type: 'rollback.restore.started',
          snapshotId: 'snapshot-42',
        }),
        expect.objectContaining({
          type: 'rollback.restore.failed',
          errorMessage: '未找到可恢复的 checkpoint。',
        }),
      ]),
    );
  });

  it('preserves cumulative sidecar markdown exactly while a code fence is still streaming', async () => {
    const { assistant } = createAssistantHarnessContext();
    const sidecarGate = createDeferred<void>();

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        const sessionId = payload.sessionId ?? 'sidecar-code-fence-session';
        const fence = String.fromCharCode(96).repeat(3);
        const firstChunk = [
          '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：',
          '',
          `${fence}bash`,
          '',
        ].join('\n');
        const secondChunk = [
          '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：',
          '',
          `${fence}bash`,
          'Remove-Item .\\666.sh',
          '',
        ].join('\n');

        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'message_delta',
            text: firstChunk,
            phase: 'final',
          },
        });
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 1,
          event: {
            type: 'message_delta',
            // 增量片段：仅携带相对 firstChunk 新增的部分，由缓冲层拼回累计文本。
            text: secondChunk.slice(firstChunk.length),
            phase: 'final',
          },
        });

        await sidecarGate.promise;

        return {
          sessionId,
          events: [
            {
              type: 'done',
              result: secondChunk,
            },
          ],
          result: secondChunk,
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '删除空文件';

    const sendPromise = assistant.sendMessage();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (assistant.messages.value[1]?.content.length) {
        break;
      }
      await Promise.resolve();
    }

    const expectedStreamingContent = [
      '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：',
      '',
      '```bash',
      'Remove-Item .\\666.sh',
      '',
    ].join('\n');

    expect(assistant.messages.value[1]?.content).toBe(expectedStreamingContent);
    expect(assistant.messages.value[1]?.stream?.status).toBe('streaming');

    sidecarGate.resolve(undefined);
    await sendPromise;

    expect(assistant.messages.value[1]?.content).toBe(expectedStreamingContent);
    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
  });

  it('shows a silent streaming placeholder while sidecar agent is starting', async () => {
    const { assistant } = createAssistantHarnessContext();
    const sidecarGate = createDeferred<void>();

    aiServiceMock.sidecarExecute.mockImplementationOnce(
      async (payload: IAgentSidecarChatRequest) => {
        await sidecarGate.promise;

        return {
          sessionId: payload.sessionId ?? 'sidecar-loading-session',
          events: [
            {
              type: 'done',
              result: `已通过 Mastra Agent 处理：${payload.goal}`,
            },
          ],
          result: `已通过 Mastra Agent 处理：${payload.goal}`,
        };
      },
    );

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '保持加载态可见';

    const sendPromise = assistant.sendMessage();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (assistant.messages.value[1]) {
        break;
      }
      await Promise.resolve();
    }

    expect(assistant.messages.value[1]).toMatchObject({
      role: 'assistant',
      content: '',
      stream: {
        status: 'streaming',
      },
    });

    sidecarGate.resolve(undefined);
    await sendPromise;

    expect(assistant.messages.value[1]?.content).toContain('已通过 Mastra Agent 处理');
    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
  });

  it('refreshes the current open document after sidecar file mutation tools write to disk', async () => {
    const { assistant, document } = createAssistantHarnessContext();

    document.value.path = 'D:/test/test.sh';
    document.value.name = 'test.sh';
    document.value.content = 'echo 111';
    document.value.savedContent = 'echo 111';
    document.value.isDirty = false;
    document.value.lineCount = 1;
    document.value.charCount = 8;

    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-write-session',
      events: [
        {
          type: 'tool_start',
          toolName: 'write_file',
          input: { path: 'D:/test/test.sh' },
        },
        {
          type: 'tool_result',
          toolName: 'write_file',
          output: {
            path: 'D:/test/test.sh',
            summary: 'updated',
          },
        },
        {
          type: 'done',
          result: '文件已修改成功。',
        },
      ],
      result: '文件已修改成功。',
    });
    tauriServiceMock.loadScript.mockResolvedValueOnce({
      path: 'D:/test/test.sh',
      name: 'test.sh',
      content: 'echo 111\necho done',
      encoding: 'utf-8',
      lineCount: 2,
      charCount: 18,
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '在这个文件随便写一些代码进去';

    await assistant.sendMessage();

    expect(tauriServiceMock.loadScript).toHaveBeenCalledWith('D:/test/test.sh');
    expect(document.value.content).toBe('echo 111\necho done');
    expect(document.value.savedContent).toBe('echo 111\necho done');
    expect(document.value.isDirty).toBe(false);
  });

  it('把 sidecar 已自动落盘的编辑结果挂到对应助手消息，供对话内联 diff 渲染', async () => {
    const { assistant, document } = createAssistantHarnessContext();
    const patch: IAiPatchSet = {
      summary: '更新启动提示',
      files: [
        {
          path: 'src/app.ts',
          originalHash: 'fnv64:test',
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-const start = true;', '+const start = false;'],
            },
          ],
        },
      ],
    };
    const patchToolOutput: TJsonValue = {
      patch: {
        summary: patch.summary,
        files: patch.files.map((file) => ({
          path: file.path,
          originalHash: file.originalHash,
          hunks: file.hunks.map((hunk) => ({
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines: [...hunk.lines],
          })),
        })),
      },
      applied: true,
    };

    document.value.path = 'src/app.ts';
    document.value.content = 'const start = true;';
    document.value.savedContent = 'const start = true;';
    tauriServiceMock.loadScript.mockResolvedValueOnce({
      path: 'src/app.ts',
      name: 'app.ts',
      content: 'const start = false;',
      encoding: 'utf-8',
      lineCount: 1,
      charCount: 20,
    });
    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-aed-session',
      events: [
        {
          type: 'tool_start',
          toolName: 'apply_file_edits',
          input: { path: 'src/app.ts' },
        },
        {
          type: 'tool_result',
          toolName: 'apply_file_edits',
          output: patchToolOutput,
        },
        {
          type: 'done',
          result: '已完成文件修改。',
        },
      ],
      result: '已完成文件修改。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '把启动提示改一下';

    await assistant.sendMessage();

    const assistantMessage = assistant.messages.value[1];
    expect(aiServiceMock.applyPatch).not.toHaveBeenCalled();
    expect(assistantMessage?.patches).toEqual([patch]);
    expect(assistantMessage?.changedFilesSummary).toMatchObject({
      files: [
        expect.objectContaining({
          path: 'src/app.ts',
          additions: 1,
          deletions: 1,
          status: 'modified',
        }),
      ],
      totalAdditions: 1,
      totalDeletions: 1,
    });
    expect(document.value.content).toBe('const start = false;');
  });

  it('在 apply_file_edits 完成事件到达时立刻挂载折叠 diff，不等待整轮 Agent 结束', async () => {
    const { assistant, document } = createAssistantHarnessContext();
    const executeDeferred =
      createDeferred<Awaited<ReturnType<typeof aiServiceMock.sidecarExecute>>>();
    const patch: IAiPatchSet = {
      summary: '更新启动提示',
      files: [
        {
          path: 'src/app.ts',
          originalHash: 'fnv64:test',
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-const start = true;', '+const start = false;'],
            },
          ],
        },
      ],
    };
    const patchToolOutput: TJsonValue = {
      patch: {
        summary: patch.summary,
        files: patch.files.map((file) => ({
          path: file.path,
          originalHash: file.originalHash,
          hunks: file.hunks.map((hunk) => ({
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines: [...hunk.lines],
          })),
        })),
      },
      applied: true,
    };

    document.value.path = 'src/app.ts';
    document.value.content = 'const start = true;';
    document.value.savedContent = 'const start = true;';
    aiServiceMock.sidecarExecute.mockImplementationOnce(async (payload) => {
      const sessionId = payload.sessionId ?? 'sidecar-live-patch';

      void Promise.resolve().then(() => {
        aiServiceMock.emitSidecar({
          sessionId,
          seq: 0,
          event: {
            type: 'tool_result',
            toolName: 'apply_file_edits',
            output: patchToolOutput,
          },
        });
      });

      return executeDeferred.promise.then(() => ({
        sessionId,
        events: [
          {
            type: 'tool_result',
            toolName: 'apply_file_edits',
            output: patchToolOutput,
          },
          {
            type: 'done',
            result: '已完成文件修改。',
          },
        ],
        result: `已完成：${payload.goal}`,
      }));
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '把启动提示改一下';

    const sendPromise = assistant.sendMessage();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const liveAssistantMessage = assistant.messages.value[1];

    expect(liveAssistantMessage?.patches).toEqual([patch]);
    expect(liveAssistantMessage?.changedFilesSummary).toBeUndefined();
    expect(document.value.content).toBe('const start = false;');

    executeDeferred.resolve({
      sessionId: 'sidecar-live-patch',
      events: [],
      result: '已完成文件修改。',
    });
    await sendPromise;
  });

  it('把已有 AED 记录的旧写入事件转换成对话内联 diff', async () => {
    const { assistant } = createAssistantHarnessContext();

    aiEditServiceMock.getDiff.mockResolvedValueOnce({
      taskId: 'thread-aed-diff',
      path: 'D:/test/test.sh',
      operationId: 'operation-aed-diff-1',
      kind: 'modify',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          hunkIndex: 0,
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-echo old', '+echo new'],
        },
      ],
    });
    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-aed-diff-session',
      events: [
        {
          type: 'tool_start',
          toolName: 'write_file',
          input: { path: 'D:/test/test.sh' },
        },
        {
          type: 'tool_result',
          toolName: 'write_file',
          output: {
            path: 'D:/test/test.sh',
            summary: 'updated',
          },
        },
        {
          type: 'done',
          result: '文件已修改成功。',
        },
      ],
      result: '文件已修改成功。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '修改脚本';

    await assistant.sendMessage();

    const assistantMessage = assistant.messages.value[1];

    expect(aiEditServiceMock.getDiff).toHaveBeenCalledWith({
      taskId: expect.any(String),
      path: 'D:/test/test.sh',
    });
    expect(assistantMessage?.patches).toEqual([
      {
        summary: '已修改 D:/test/test.sh',
        files: [
          {
            path: 'D:/test/test.sh',
            originalHash: 'aed:operation-aed-diff-1',
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-echo old', '+echo new'],
              },
            ],
          },
        ],
      },
    ]);
    expect(assistantMessage?.changedFilesSummary).toMatchObject({
      files: [
        expect.objectContaining({
          path: 'D:/test/test.sh',
          additions: 1,
          deletions: 1,
          status: 'modified',
        }),
      ],
      totalAdditions: 1,
      totalDeletions: 1,
    });
  });

  it('does not overwrite dirty document content when sidecar writes the same path', async () => {
    const { assistant, document } = createAssistantHarnessContext();

    document.value.path = 'D:/test/test.sh';
    document.value.name = 'test.sh';
    document.value.content = 'echo local edit';
    document.value.savedContent = 'echo 111';
    document.value.isDirty = true;

    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-write-session',
      events: [
        {
          type: 'tool_start',
          toolName: 'edit_file',
          input: { path: 'D:/test/test.sh' },
        },
        {
          type: 'tool_result',
          toolName: 'edit_file',
          output: {
            path: 'D:/test/test.sh',
            summary: 'updated',
          },
        },
        {
          type: 'done',
          result: '文件已修改成功。',
        },
      ],
      result: '文件已修改成功。',
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '修改当前文件';

    await assistant.sendMessage();

    expect(tauriServiceMock.loadScript).not.toHaveBeenCalled();
    expect(document.value.content).toBe('echo local edit');
    expect(assistant.errorMessage.value).toContain('未保存改动');
  });

  it('不再把 @current-file 解析成系统上下文，当前文件仅作为工具上下文传给 sidecar', async () => {
    const { assistant } = createAssistantHarnessContext();

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '@current-file 丰富一下当前的脚本内容';

    await assistant.sendMessage();

    const request = aiServiceMock.sidecarExecute.mock.calls[0]?.[0];

    expect(request?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '@current-file 丰富一下当前的脚本内容',
      }),
    ]);
    expect(request?.context).toEqual([
      expect.objectContaining({
        kind: 'current-file',
        path: 'src/app.ts',
      }),
    ]);
  });

  it('普通 Agent 请求不把当前文件写进消息上下文，只保留按需工具上下文', async () => {
    const { assistant } = createAssistantHarnessContext();

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '科学原理如何解释';

    await assistant.sendMessage();

    const request = aiServiceMock.sidecarExecute.mock.calls[0]?.[0];

    expect(request?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '科学原理如何解释',
      }),
    ]);
    expect(request?.context).toEqual([
      expect.objectContaining({
        kind: 'current-file',
        path: 'src/app.ts',
      }),
    ]);
  });

  it('Agent 模式携带当前对话 threadId，并向 Mastra 发送当前线程上下文', async () => {
    const { assistant } = createAssistantHarnessContext();
    const threadId = readReactiveValue(assistant.activeConversationId);

    assistant.messages.value = [
      {
        id: 'assistant-history-1',
        role: 'assistant',
        content: '上一轮已经解释过背景。',
        createdAt: '2026-05-03T09:00:00.000Z',
        references: [],
      },
    ];
    assistant.activeMode.value = 'agent';
    assistant.draft.value = '继续总结当前状态';

    await assistant.sendMessage();

    const request = aiServiceMock.sidecarExecute.mock.calls[0]?.[0];

    expect(request?.threadId).toBe(threadId);
    expect(request?.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: '上一轮已经解释过背景。',
      }),
      expect.objectContaining({
        role: 'user',
        content: '继续总结当前状态',
      }),
    ]);
  });

  it('普通 Chat 请求不附加当前文件引用', async () => {
    const { assistant } = createAssistantHarnessContext();

    aiServiceMock.queueStreamResponse('这是普通回答。');
    assistant.activeMode.value = 'chat';
    assistant.draft.value = '科学原理如何解释';

    await assistant.sendMessage();

    expect(assistant.messages.value[0]).toMatchObject({
      role: 'user',
      content: '科学原理如何解释',
      references: [],
    });
  });

  it('projects sidecar approval requests into the direct Agent confirmation UI', async () => {
    const { assistant } = createAssistantHarnessContext();
    const agentStore = useAiAgentStore();
    const timestamp = '2026-04-29T00:00:00.000Z';
    const createObjectURL = vi.fn(() => 'blob:attachment-preview-confirmation');

    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 320,
        height: 200,
        close: vi.fn(),
      })),
    );

    aiServiceMock.sidecarExecute.mockResolvedValueOnce({
      sessionId: 'sidecar-confirmation-session',
      events: [
        {
          type: 'approval_required',
          request: {
            id: 'approval-run-command',
            toolName: 'run_shell_command',
            question: '鍏佽 Agent 鎵ц pnpm test 鍚楋紵',
            summary: '运行最小验证命令。',
            riskLevel: 'medium',
            reversible: false,
            createdAt: timestamp,
          },
        },
        {
          type: 'done',
          result: 'Agent 姝ｅ湪绛夊緟纭锛氬厑璁?Agent 鎵ц pnpm test 鍚楋紵',
        },
      ],
      result: 'Agent 姝ｅ湪绛夊緟纭锛氬厑璁?Agent 鎵ц pnpm test 鍚楋紵',
    });

    await assistant.attachFile(
      new File(['image-bytes'], 'confirm-image.png', { type: 'image/png' }),
    );
    expect(assistant.attachedFiles.value).toHaveLength(1);

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '运行一次最小验证';

    await assistant.sendMessage();

    expect(assistant.attachedFiles.value).toHaveLength(0);
    expect(agentStore.pendingToolConfirmation).toMatchObject({
      id: 'approval-run-command',
      runId: 'sidecar:sidecar-confirmation-session',
      toolName: 'run_command',
      question: '鍏佽 Agent 鎵ц pnpm test 鍚楋紵',
    });
    expect(agentStore.pendingSidecarAgentSession).toMatchObject({
      sessionId: 'sidecar-confirmation-session',
      assistantMessageId: assistant.messages.value[1]?.id,
      threadId: expect.any(String),
      turnId: assistant.messages.value[0]?.id,
      messageContent: '运行一次最小验证',
    });
    expect(assistant.messages.value[1]?.content).toContain('绛夊緟纭');

    await assistant.resolveSidecarToolConfirmation('allow-once');

    expect(aiServiceMock.sidecarResolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sidecar-confirmation-session',
        requestId: 'approval-run-command',
        decision: 'approve',
        goal: '运行一次最小验证',
        threadId: expect.any(String),
      }),
    );
    expect(agentStore.pendingToolConfirmation).toBeNull();
    expect(agentStore.pendingSidecarAgentSession).toBeNull();
    expect(assistant.messages.value[1]?.content).toContain('审批结果已交给 sidecar');
    expect(assistant.attachedFiles.value).toHaveLength(0);
  });

  it('seamlessly resumes a persisted sidecar approval after assistant recreation', async () => {
    const agentStore = useAiAgentStore();

    agentStore.setPendingToolConfirmation({
      id: 'approval-persisted-command',
      runId: 'sidecar:sidecar-persisted-session',
      stepId: 'sidecar:approval-persisted-command',
      toolName: 'run_command',
      question: '允许 Agent 执行 pnpm test 吗？',
      summary: '运行最小验证命令。',
      riskLevel: 'medium',
      impact: '运行最小验证命令。',
      reversible: false,
      createdAt: '2026-04-29T00:00:00.000Z',
      options: [
        { id: 'allow-once', label: '允许', tone: 'primary' },
        { id: 'stop', label: '拒绝', tone: 'danger' },
      ],
    });
    agentStore.setPendingSidecarAgentSession({
      sessionId: 'sidecar-persisted-session',
      assistantMessageId: 'assistant-persisted-approval',
      threadId: null,
      turnId: 'user-persisted-approval',
      baseMessages: [],
      messageContent: '运行一次最小验证',
      references: [],
    });

    const assistant = createAssistantHarness();

    await assistant.resolveSidecarToolConfirmation('stop');

    expect(aiServiceMock.sidecarResolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sidecar-persisted-session',
        requestId: 'approval-persisted-command',
        decision: 'cancel',
        goal: '运行一次最小验证',
      }),
    );
    expect(agentStore.pendingToolConfirmation).toBeNull();
    expect(agentStore.pendingSidecarAgentSession).toBeNull();
  });

  it('在本地恢复对话 checkpoint，并丢弃 checkpoint 后的消息', async () => {
    const { assistant } = createAssistantHarnessContext();

    assistant.messages.value = [
      {
        id: 'user-before-checkpoint',
        role: 'user',
        content: '先做第一步修改',
        createdAt: '2026-05-03T10:00:00.000Z',
        references: [],
      },
      {
        id: 'assistant-checkpoint',
        role: 'assistant',
        content: '第一步已经完成。',
        createdAt: '2026-05-03T10:01:00.000Z',
        references: [],
        stream: {
          status: 'completed',
          runtimeEvents: [
            {
              id: 'checkpoint-created-1',
              type: 'rollback.checkpoint.created',
              runId: 'run-checkpoint-1',
              sessionId: 'session-checkpoint-1',
              agentId: 'agent-checkpoint-1',
              timestamp: '2026-05-03T10:01:00.000Z',
              seq: 0,
              schemaVersion: 1,
              redacted: true,
              visibility: 'user',
              level: 'info',
              snapshotId: 'snapshot-checkpoint-1',
            },
          ],
        },
      },
      {
        id: 'user-after-checkpoint',
        role: 'user',
        content: '继续做第二步修改',
        createdAt: '2026-05-03T10:02:00.000Z',
        references: [],
      },
      {
        id: 'assistant-after-checkpoint',
        role: 'assistant',
        content: '第二步也完成了。',
        createdAt: '2026-05-03T10:03:00.000Z',
        references: [],
      },
    ];

    expect(assistant.conversationCheckpoints.value).toEqual([
      expect.objectContaining({
        id: 'checkpoint-created-1',
        messageId: 'assistant-checkpoint',
        runId: 'run-checkpoint-1',
        snapshotId: 'snapshot-checkpoint-1',
      }),
    ]);

    await assistant.restoreConversationCheckpoint('checkpoint-created-1');

    expect(aiServiceMock.sidecarRestoreCheckpoint).not.toHaveBeenCalled();
    expect(assistant.messages.value.map((message) => message.id)).toEqual([
      'user-before-checkpoint',
      'assistant-checkpoint',
    ]);
    expect(assistant.messages.value[1]?.stream?.runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'rollback.checkpoint.created',
          id: 'checkpoint-created-1',
        }),
      ]),
    );
    expect(assistant.runtimeTimelineEvents.value).toEqual([
      expect.objectContaining({ type: 'rollback.checkpoint.created' }),
    ]);
    expect(assistant.conversationCheckpoints.value).toEqual([]);
    expect(assistant.restoringCheckpointId.value).toBeNull();
    expect(assistant.errorMessage.value).toBe('');
  });

  it('点击最终变更汇总撤销时回滚 AED task 并触发 Mastra checkpoint 恢复', async () => {
    const { assistant, document } = createAssistantHarnessContext();

    document.value.path = 'D:/test/xiaojianc.sh';
    document.value.name = 'xiaojianc.sh';
    document.value.content = 'echo new';
    document.value.savedContent = 'echo new';
    document.value.lineCount = 1;
    document.value.charCount = 8;
    assistant.messages.value = [
      {
        id: 'assistant-summary',
        role: 'assistant',
        content: '已完成修改。',
        createdAt: '2026-05-03T10:01:00.000Z',
        references: [],
        changedFilesSummary: {
          id: 'patch-summary-rollback',
          runId: 'run-checkpoint-1',
          stepId: 'agent',
          files: [
            {
              path: 'D:/test/xiaojianc.sh',
              status: 'modified',
              additions: 1,
              deletions: 1,
              diffRef: 'diff:xiaojianc',
            },
          ],
          totalAdditions: 1,
          totalDeletions: 1,
          patchRef: 'aed-patch:thread-rollback',
          appliedAt: '2026-05-03T10:01:00.000Z',
        },
        stream: {
          status: 'completed',
          runtimeEvents: [
            {
              id: 'checkpoint-created-1',
              type: 'rollback.checkpoint.created',
              runId: 'run-checkpoint-1',
              sessionId: 'session-checkpoint-1',
              agentId: 'agent-checkpoint-1',
              timestamp: '2026-05-03T10:01:00.000Z',
              seq: 0,
              schemaVersion: 1,
              redacted: true,
              visibility: 'user',
              level: 'info',
              snapshotId: 'snapshot-checkpoint-1',
            },
          ],
        },
      },
    ];
    aiServiceMock.sidecarRestoreCheckpoint.mockResolvedValueOnce({
      sessionId: 'mastra-rollback-session',
      events: [
        {
          type: 'agent_event',
          event: {
            id: 'runtime-rollback-completed',
            type: 'rollback.restore.completed',
            runId: 'run-checkpoint-1',
            sessionId: 'mastra-rollback-session',
            agentId: 'agent-checkpoint-1',
            timestamp: '2026-05-03T10:02:00.000Z',
            seq: 1,
            schemaVersion: 1,
            redacted: true,
            visibility: 'user',
            level: 'info',
            snapshotId: 'snapshot-checkpoint-1',
            savedAsLatest: true,
            message: '已恢复到最近 checkpoint。',
          },
        },
        {
          type: 'done',
          result: '已恢复到最近 checkpoint。',
        },
      ],
      result: '已恢复到最近 checkpoint。',
    });
    aiEditServiceMock.revertTask.mockResolvedValueOnce(
      createRevertTaskPayload('thread-rollback', ['D:/test/xiaojianc.sh']),
    );
    tauriServiceMock.loadScript.mockResolvedValueOnce({
      path: 'D:/test/xiaojianc.sh',
      name: 'xiaojianc.sh',
      content: 'echo old',
      encoding: 'utf-8',
      lineCount: 1,
      charCount: 8,
    });

    await assistant.rollbackChangedFilesSummary('assistant-summary', 'patch-summary-rollback');

    expect(aiServiceMock.sidecarRestoreCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-checkpoint-1',
        snapshotId: 'snapshot-checkpoint-1',
      }),
    );
    expect(aiEditServiceMock.revertTask).toHaveBeenCalledWith({
      taskId: 'thread-rollback',
    });
    expect(document.value.content).toBe('echo old');
    expect(assistant.messages.value[0]?.changedFilesSummary?.revertedAt).toEqual(
      expect.any(String),
    );
    expect(assistant.messages.value[0]?.stream?.runtimeEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'rollback.restore.completed' })]),
    );
    expect(assistant.revertingChangedFilesSummaryId.value).toBeNull();
  });

  it('外部 Kimi agent 回合在 prompt 进行中实时流式 message_delta（而非末尾一次性渲染）', async () => {
    const { assistant } = createAssistantHarnessContext();
    const promptGate = createDeferred<IAgentExternalChatResultPayload>();

    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {
      const sessionId = payload.sessionId ?? 'sidecar-external-live-session';

      aiServiceMock.emitSidecar({
        sessionId,
        seq: 0,
        event: { type: 'message_delta', text: '第一段已到达', phase: 'final' },
      });
      aiServiceMock.emitSidecar({
        sessionId,
        seq: 1,
        event: { type: 'message_delta', text: '；第二段实时到达', phase: 'final' },
      });

      // 在回合「进行中」（prompt 尚未返回）阻塞：断言此刻已实时渲染增量、状态仍为 streaming。
      await promptGate.promise;

      return { sessionId, stopReason: 'EndTurn' };
    });

    assistant.draft.value = '用 Kimi 跑一轮';
    const sendPromise = assistant.sendMessage({ agentBackend: 'kimi' });

    await flushMicrotasks();

    const assistantMessageId = assistant.messages.value[1]?.id;
    expect(assistantMessageId).toBeTruthy();
    const capturedRequest = aiServiceMock.sidecarExternalChat.mock.calls[0]?.[0];
    expect(capturedRequest?.backend).toBe('kimi');
    expect(capturedRequest?.sessionId).toBe(`sidecar:${assistantMessageId}`);
    expect(assistant.messages.value[1]?.content).toContain('第二段实时到达');
    expect(assistant.messages.value[1]?.stream?.status).toBe('streaming');

    promptGate.resolve({
      sessionId: capturedRequest?.sessionId ?? 'sidecar-external-live-session',
      stopReason: 'EndTurn',
    });
    await sendPromise;

    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
    expect(assistant.messages.value[1]?.content).toContain('第二段实时到达');
  });
});
