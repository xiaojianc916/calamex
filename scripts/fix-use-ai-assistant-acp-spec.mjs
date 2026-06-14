import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/composables/ai/useAiAssistant.spec.ts');
let content = fs.readFileSync(filePath, 'utf8');

const replaceOnce = (from, to) => {
  const next = content.replace(from, to);
  if (next === content) {
    throw new Error(`pattern not found:\n${from.slice(0, 300)}`);
  }
  content = next;
};

replaceOnce("  IAiChatRequest,\n  IAiChatStreamEventPayload,\n  IAiPatchSet,", "  IAiChatRequest,\n  IAiPatchSet,");
replaceOnce("const ASSISTANT_MESSAGE_ID = 'assistant-1' as const;\nconst MOCK_MODEL = 'mock-ide-assistant' as const;", "const ASSISTANT_MESSAGE_ID = 'assistant-1' as const;\nconst CHAT_SESSION_ID = 'acp-chat-session-1' as const;\nconst MOCK_MODEL = 'mock-ide-assistant' as const;");

const mockStart = content.indexOf('const aiServiceMock = vi.hoisted(() => {');
const mockEnd = content.indexOf("\n\nvi.mock('@/services/ipc/ai.service'", mockStart);
if (mockStart < 0 || mockEnd < 0) {
  throw new Error('failed to locate aiServiceMock block');
}

const newMock = String.raw`const aiServiceMock = vi.hoisted(() => {
  type SidecarStreamHandler = (payload: IAgentSidecarStreamEventPayload) => void;

  let sidecarStreamHandler: SidecarStreamHandler | null = null;
  let streamSequence = 0;
  let sidecarSequence = 0;
  let activeChatSessionId: string = CHAT_SESSION_ID;
  const queuedStreamResponses: Array<{
    streamId: string;
    assistantMessageId: string;
    sessionId: string;
    content: string;
    terminalKind: 'done' | 'error';
    terminalMessage: string | null;
  }> = [];

  const emitSidecarEvent = (sessionId: string, event: IAgentSidecarStreamEventPayload['event']) => {
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
    void payload;
    const queued = queuedStreamResponses.shift();
    if (!queued) {
      activeChatSessionId = CHAT_SESSION_ID;
      return {
        streamId: STREAM_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        providerType: 'mastra',
        model: MOCK_MODEL,
        sessionId: activeChatSessionId,
      };
    }

    activeChatSessionId = queued.sessionId;
    queueMicrotask(() => {
      for (const chunk of queued.content.match(/.{1,24}/g) ?? []) {
        emitChatDelta(chunk, queued.sessionId);
      }

      if (queued.terminalKind === 'error') {
        emitChatError(queued.terminalMessage ?? 'AI 流式响应失败', queued.sessionId);
        return;
      }

      emitChatDone(queued.content, queued.sessionId);
    });

    return {
      streamId: queued.streamId,
      assistantMessageId: queued.assistantMessageId,
      providerType: 'mastra',
      model: MOCK_MODEL,
      sessionId: queued.sessionId,
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
      sidecarResolveApproval.mockClear();
      sidecarRestoreCheckpoint.mockClear();
      sidecarOrchestrate.mockClear();
      sidecarOrchestrateResume.mockClear();
      onSidecarStream.mockClear();
    },
  };
});`;

content = `${content.slice(0, mockStart)}${newMock}${content.slice(mockEnd)}`;

replaceOnce('    onChatStream: aiServiceMock.onChatStream,\n', '');

replaceOnce(
`const waitForStartedStream = async (\n  resolveMessageId: () => string | undefined,\n  expectedId: string = ASSISTANT_MESSAGE_ID,\n  maxAttempts = 8,\n): Promise<void> => {\n  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {\n    if (resolveMessageId() === expectedId) {\n      return;\n    }\n    await flushMicrotasks();\n  }\n  throw new Error(\n    \`assistant stream did not start in time (expected id=\"\${expectedId}\" within \${maxAttempts} ticks)\`,\n  );\n};`,
`const waitForStartedStream = async (\n  resolveMessageId: () => string | undefined,\n  expectedId?: string,\n  maxAttempts = 8,\n): Promise<void> => {\n  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {\n    const messageId = resolveMessageId();\n    if (messageId && (!expectedId || messageId === expectedId)) {\n      return;\n    }\n    await flushMicrotasks();\n  }\n  throw new Error(\n    \`assistant stream did not start in time (expected id=\"\${expectedId ?? '<any>'}\" within \${maxAttempts} ticks)\`,\n  );\n};`,
);

replaceOnce("    expect(aiServiceMock.cancel).toHaveBeenCalledWith({ streamId: STREAM_ID });", "    expect(aiServiceMock.cancel).toHaveBeenCalledWith({\n      streamId: STREAM_ID,\n      threadId: expect.any(String),\n    });");

replaceOnce(
`    aiServiceMock.emit({\n      streamId: STREAM_ID,\n      assistantMessageId: ASSISTANT_MESSAGE_ID,\n      kind: 'cancelled',\n      delta: null,\n      message: 'AI 流已被取消',\n      model: MOCK_MODEL,\n    });\n    await flushMicrotasks();`,
`    assistant.stopCurrentRequest();\n    await flushMicrotasks();`,
);

replaceOnce(
`    aiServiceMock.emit({\n      streamId: STREAM_ID,\n      assistantMessageId: ASSISTANT_MESSAGE_ID,\n      kind: 'delta',\n      delta: '你好',\n      message: null,\n      model: MOCK_MODEL,\n      promptTokens: 12,\n      completionTokens: 2,\n      totalTokens: 14,\n    });\n    await flushMicrotasks();\n\n    expect(assistant.messages.value.at(-1)?.stream).toMatchObject({\n      status: 'streaming',\n      promptTokens: 12,\n      completionTokens: 2,\n      totalTokens: 14,\n    });\n\n    aiServiceMock.emit({\n      streamId: STREAM_ID,\n      assistantMessageId: ASSISTANT_MESSAGE_ID,\n      kind: 'done',\n      delta: null,\n      message: null,\n      model: MOCK_MODEL,\n      promptTokens: 13,\n      completionTokens: 5,\n      totalTokens: 18,\n      usage: {\n        inputTokens: 13,\n        inputTokenDetails: {\n          noCacheTokens: 13,\n          cacheReadTokens: 0,\n          cacheWriteTokens: 0,\n        },\n        outputTokens: 5,\n        outputTokenDetails: {\n          textTokens: 4,\n          reasoningTokens: 1,\n        },\n        totalTokens: 18,\n        cachedInputTokens: 0,\n        reasoningTokens: 1,\n      },\n    });`,
`    aiServiceMock.emitDelta('你好');\n    await flushMicrotasks();\n\n    expect(assistant.messages.value.at(-1)?.stream).toMatchObject({\n      status: 'streaming',\n    });\n\n    aiServiceMock.emitDone('你好', {\n      inputTokens: 13,\n      inputTokenDetails: {\n        noCacheTokens: 13,\n        cacheReadTokens: 0,\n        cacheWriteTokens: 0,\n      },\n      outputTokens: 5,\n      outputTokenDetails: {\n        textTokens: 4,\n        reasoningTokens: 1,\n      },\n      totalTokens: 18,\n      cachedInputTokens: 0,\n      reasoningTokens: 1,\n    });`,
);

fs.writeFileSync(filePath, content);
console.log('Updated useAiAssistant.spec.ts legacy chat-stream mocks to ACP sidecar-stream.');
