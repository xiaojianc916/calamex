import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useAiAssistant } from '@/composables/ai/useAiAssistant';
import { useAiAgentStore } from '@/store/aiAgent';
import type { TAgentUiEvent } from '@/types/ai/sidecar';
import type { IAnalyzeScriptPayload, IEditorDocument } from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = 'd:/com.xiaojianc/my_desktop_app';

// ---------------------------------------------------------------------------
// ai.service mock：仅保留 ACP-native 单一管线触达的方法（hoisted 供 vi.mock 工厂引用）。
// 唯一发送链路 = subscribeSidecarSessionStream -> (builtin) ensureAcpSession + setSessionMode
// -> sidecarExternalChat。流式经 onSidecarStream 回放。
// ---------------------------------------------------------------------------

const aiServiceMock = vi.hoisted(() => {
  type StreamHandler = (payload: { sessionId: string; seq: number; event: TAgentUiEvent }) => void;
  let streamHandler: StreamHandler | null = null;
  let seq = 0;

  const onSidecarStream = vi.fn(async (handler: StreamHandler) => {
    streamHandler = handler;
    return vi.fn(() => {
      streamHandler = null;
    });
  });
  const ensureAcpSession = vi.fn(async () => {});
  const setSessionMode = vi.fn(async () => true);
  const sidecarExternalChat = vi.fn(async (payload: { sessionId?: string }) => ({
    sessionId: payload.sessionId ?? 'sidecar-external-session',
    stopReason: 'EndTurn',
  }));
  const sidecarRestoreCheckpoint = vi.fn(async (payload: { sessionId?: string }) => ({
    sessionId: payload.sessionId ?? 'sidecar-restore-session',
    events: [],
    result: '',
  }));
  const generateConversationTitle = vi.fn(async () => ({
    title: '生成会话标题',
    model: 'mock-model',
  }));
  const cancel = vi.fn(async () => {});
  const applyPatch = vi.fn(async () => ({ appliedFiles: [] }));
  const proposePatch = vi.fn(async () => ({ patch: { summary: '', files: [] } }));

  return {
    onSidecarStream,
    ensureAcpSession,
    setSessionMode,
    sidecarExternalChat,
    sidecarRestoreCheckpoint,
    generateConversationTitle,
    cancel,
    applyPatch,
    proposePatch,
    emit(sessionId: string, event: TAgentUiEvent): void {
      streamHandler?.({ sessionId, seq, event });
      seq += 1;
    },
    reset(): void {
      streamHandler = null;
      seq = 0;
      onSidecarStream.mockClear();
      ensureAcpSession.mockClear();
      setSessionMode.mockClear();
      sidecarExternalChat.mockClear();
      sidecarRestoreCheckpoint.mockClear();
      generateConversationTitle.mockClear();
      cancel.mockClear();
      applyPatch.mockClear();
      proposePatch.mockClear();
      sidecarExternalChat.mockImplementation(async (payload: { sessionId?: string }) => ({
        sessionId: payload.sessionId ?? 'sidecar-external-session',
        stopReason: 'EndTurn',
      }));
    },
  };
});

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    onSidecarStream: aiServiceMock.onSidecarStream,
    ensureAcpSession: aiServiceMock.ensureAcpSession,
    setSessionMode: aiServiceMock.setSessionMode,
    sidecarExternalChat: aiServiceMock.sidecarExternalChat,
    sidecarRestoreCheckpoint: aiServiceMock.sidecarRestoreCheckpoint,
    generateConversationTitle: aiServiceMock.generateConversationTitle,
    cancel: aiServiceMock.cancel,
    applyPatch: aiServiceMock.applyPatch,
    proposePatch: aiServiceMock.proposePatch,
  },
}));

const aiEditServiceMock = vi.hoisted(() => ({
  listTimeline: vi.fn(async () => ({ entries: [] })),
  getDiff: vi.fn(async () => ({
    taskId: 'task',
    path: 'src/app.ts',
    operationId: 'op',
    kind: 'modify',
    additions: 0,
    deletions: 0,
    hunks: [],
  })),
  undoOperation: vi.fn(async () => ({
    operationId: 'op',
    restoredFiles: [],
    preRevertSnapshot: null,
    restoredSnapshot: null,
  })),
  revertTask: vi.fn(async () => ({
    taskId: 'task',
    revertedOperationIds: [],
    restoredFiles: [],
    preRevertSnapshots: [],
    restoredSnapshots: [],
  })),
  setPin: vi.fn(async () => {}),
}));

vi.mock('@/services/ipc/ai-edit.service', () => ({
  aiEditService: aiEditServiceMock,
}));

const tauriServiceMock = vi.hoisted(() => ({
  loadScript: vi.fn(async (path: string) => ({
    path,
    name: 'script.sh',
    content: 'echo refreshed',
    encoding: 'utf-8',
    lineCount: 1,
    charCount: 14,
  })),
  analyzeScript: vi.fn(async () => ({
    available: true,
    message: null,
    dialect: 'bash',
    diagnostics: [],
  })),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: tauriServiceMock,
}));

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitFor = async (predicate: () => boolean, maxAttempts = 24): Promise<void> => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('waitFor 超时：条件在限定 tick 内未满足');
};

const createDeferred = <T>() => {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!resolveValue) {
        throw new Error('deferred 尚未就绪');
      }
      resolveValue(value);
    },
  };
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

const createAssistantHarness = (): ReturnType<typeof useAiAssistant> => {
  const assistant = useAiAssistant({
    document: ref(createDocument()),
    activeRun: ref(null),
    analysis: ref(createAnalysis()),
    selection: ref(null),
    gitStatus: ref(createGitStatus()),
    workspaceRootPath: ref(WORKSPACE_ROOT),
  });

  assistant.config.value = {
    ...assistant.config.value,
    hasCredentials: true,
    isConfigured: true,
    chatEnabled: true,
    agentEnabled: true,
  };

  return assistant;
};

const finalDelta = (text: string): TAgentUiEvent => ({
  type: 'message_delta',
  text,
  phase: 'final',
});

// ---------------------------------------------------------------------------
// 套件
// ---------------------------------------------------------------------------

describe('useAiAssistant · ACP-native 单一发送管线', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    aiServiceMock.reset();
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

  // -------------------------------------------------------------------------
  // 模式代理
  // -------------------------------------------------------------------------

  it('activeMode 双向代理到 ai-agent store 的 mode', () => {
    const assistant = createAssistantHarness();
    const agentStore = useAiAgentStore();

    expect(assistant.activeMode.value).toBe('agent');

    assistant.activeMode.value = 'plan';
    expect(agentStore.mode).toBe('plan');

    agentStore.setMode('chat');
    expect(assistant.activeMode.value).toBe('chat');
  });

  // -------------------------------------------------------------------------
  // builtin 三模式经官方 set_session_mode 切换后再发起标准 session/prompt
  // -------------------------------------------------------------------------

  it('chat 模式先 set_session_mode 到 ask，再走 builtin session/prompt', async () => {
    const assistant = createAssistantHarness();

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '解释当前脚本';
    await assistant.sendMessage();

    expect(aiServiceMock.ensureAcpSession).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'builtin', workspaceRootPath: WORKSPACE_ROOT }),
    );
    expect(aiServiceMock.setSessionMode).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: 'ask' }),
    );
    expect(aiServiceMock.sidecarExternalChat).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'builtin',
        text: '解释当前脚本',
        sessionId: expect.stringContaining('sidecar:'),
      }),
    );
  });

  it('agent 模式 set_session_mode 到 agent', async () => {
    const assistant = createAssistantHarness();

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '执行一次最小修改';
    await assistant.sendMessage();

    expect(aiServiceMock.setSessionMode).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: 'agent' }),
    );
    expect(aiServiceMock.sidecarExternalChat).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'builtin' }),
    );
  });

  it('plan 模式 set_session_mode 到 plan', async () => {
    const assistant = createAssistantHarness();

    assistant.activeMode.value = 'plan';
    assistant.draft.value = '先做个计划';
    await assistant.sendMessage();

    expect(aiServiceMock.setSessionMode).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: 'plan' }),
    );
  });

  // -------------------------------------------------------------------------
  // 外部后端自管会话模式：不下发 sessionMode
  // -------------------------------------------------------------------------

  it('外部 Kimi 后端不下发 sessionMode，直接 session/prompt', async () => {
    const assistant = createAssistantHarness();

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '用 Kimi 跑一轮';
    await assistant.sendMessage({ agentBackend: 'kimi' });

    expect(aiServiceMock.ensureAcpSession).not.toHaveBeenCalled();
    expect(aiServiceMock.setSessionMode).not.toHaveBeenCalled();
    expect(aiServiceMock.sidecarExternalChat).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'kimi', text: '用 Kimi 跑一轮' }),
    );
  });

  // -------------------------------------------------------------------------
  // 流式：final 阶段 message_delta 实时累计，done/收尾后 completed
  // -------------------------------------------------------------------------

  it('final 阶段 message_delta 累计进助手消息，收尾收口为 completed', async () => {
    const assistant = createAssistantHarness();

    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {
      const sessionId = payload.sessionId ?? 'sidecar-stream-session';
      aiServiceMock.emit(sessionId, finalDelta('你好，这是实时回答'));
      return { sessionId, stopReason: 'EndTurn' };
    });

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '问一个问题';
    await assistant.sendMessage();

    expect(assistant.messages.value[1]?.content).toContain('你好，这是实时回答');
    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
  });

  it('prompt 进行中即实时渲染增量，返回后收口 completed', async () => {
    const assistant = createAssistantHarness();
    const promptGate = createDeferred<void>();

    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {
      const sessionId = payload.sessionId ?? 'sidecar-live-session';
      aiServiceMock.emit(sessionId, finalDelta('第一段已到达'));
      aiServiceMock.emit(sessionId, finalDelta('第一段已到达，第二段继续到达'));
      await promptGate.promise;
      return { sessionId, stopReason: 'EndTurn' };
    });

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '实时流式问题';
    const sendPromise = assistant.sendMessage();

    await waitFor(() => Boolean(assistant.messages.value[1]?.content?.length));

    expect(assistant.messages.value[1]?.content).toContain('第二段继续到达');
    expect(assistant.messages.value[1]?.stream?.status).toBe('streaming');

    promptGate.resolve();
    await sendPromise;

    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
    expect(assistant.messages.value[1]?.content).toContain('第二段继续到达');
  });

  // -------------------------------------------------------------------------
  // 生命周期与门禁
  // -------------------------------------------------------------------------

  it('空草稿且无附件时不发送', async () => {
    const assistant = createAssistantHarness();

    assistant.draft.value = '   ';
    await assistant.sendMessage();

    expect(aiServiceMock.sidecarExternalChat).not.toHaveBeenCalled();
    expect(assistant.messages.value).toHaveLength(0);
  });

  it('未启用 Chat 时给出提示并打开设置面板', async () => {
    const assistant = createAssistantHarness();
    assistant.config.value = { ...assistant.config.value, chatEnabled: false };

    assistant.draft.value = '随便问问';
    await assistant.sendMessage();

    expect(aiServiceMock.sidecarExternalChat).not.toHaveBeenCalled();
    expect(assistant.isSettingsOpen.value).toBe(true);
    expect(assistant.errorMessage.value).toContain('启用 AI Chat');
  });

  it('Provider 未配置完整时给出提示', async () => {
    const assistant = createAssistantHarness();
    assistant.config.value = { ...assistant.config.value, isConfigured: false };

    assistant.draft.value = '随便问问';
    await assistant.sendMessage();

    expect(aiServiceMock.sidecarExternalChat).not.toHaveBeenCalled();
    expect(assistant.isSettingsOpen.value).toBe(true);
    expect(assistant.errorMessage.value).toContain('Provider');
  });

  it('发送即清空草稿并先行追加用户消息', async () => {
    const assistant = createAssistantHarness();
    const promptGate = createDeferred<void>();
    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {
      await promptGate.promise;
      return { sessionId: payload.sessionId ?? 'sidecar-draft-session', stopReason: 'EndTurn' };
    });

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '这条会被清空';
    const sendPromise = assistant.sendMessage();

    expect(assistant.draft.value).toBe('');
    expect(assistant.isSending.value).toBe(true);
    expect(assistant.messages.value[0]).toMatchObject({
      role: 'user',
      content: '这条会被清空',
    });

    promptGate.resolve();
    await sendPromise;
    expect(assistant.isSending.value).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 错误与中止
  // -------------------------------------------------------------------------

  it('session/prompt 抛错时标记助手失败并暴露错误信息', async () => {
    const assistant = createAssistantHarness();
    aiServiceMock.sidecarExternalChat.mockRejectedValueOnce(new Error('网络突然断开'));

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '触发错误';
    await assistant.sendMessage();

    expect(assistant.errorMessage.value).toContain('网络突然断开');
    expect(assistant.messages.value[1]?.content).toContain('Agent 执行失败');
    expect(assistant.isSending.value).toBe(false);
  });

  it('stopCurrentRequest 中止外部回合：取消文案 + cancelled + 结束发送态', async () => {
    const assistant = createAssistantHarness();
    const promptGate = createDeferred<void>();
    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {
      await promptGate.promise;
      return { sessionId: payload.sessionId ?? 'sidecar-stop-session', stopReason: 'EndTurn' };
    });

    assistant.activeMode.value = 'agent';
    assistant.draft.value = '跑一轮长任务';
    const sendPromise = assistant.sendMessage();

    await waitFor(() => assistant.messages.value.length >= 2);
    assistant.stopCurrentRequest();

    expect(assistant.messages.value[1]?.stream?.status).toBe('cancelled');
    expect(assistant.messages.value[1]?.content).toContain('取消');
    expect(assistant.isSending.value).toBe(false);
    expect(aiServiceMock.cancel).not.toHaveBeenCalled();

    promptGate.resolve();
    await sendPromise;
  });

  // -------------------------------------------------------------------------
  // 附件
  // -------------------------------------------------------------------------

  it('粘贴图片附件并在发送后并入用户消息引用且清空附件', async () => {
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

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '';
    await assistant.sendMessage();

    expect(aiServiceMock.sidecarExternalChat).toHaveBeenCalledTimes(1);
    expect(assistant.attachedFiles.value).toHaveLength(0);
    expect(assistant.messages.value[0]?.references?.[0]?.kind).toBe('image-attachment');
  });

  // -------------------------------------------------------------------------
  // 会话标题
  // -------------------------------------------------------------------------

  it('成功发送后用首轮问答生成会话标题', async () => {
    const assistant = createAssistantHarness();
    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {
      const sessionId = payload.sessionId ?? 'sidecar-title-session';
      aiServiceMock.emit(sessionId, finalDelta('这是首轮回答'));
      return { sessionId, stopReason: 'EndTurn' };
    });

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '如何修复这个问题？';
    await assistant.sendMessage();
    await flushMicrotasks();

    expect(aiServiceMock.generateConversationTitle).toHaveBeenCalled();
  });
});
