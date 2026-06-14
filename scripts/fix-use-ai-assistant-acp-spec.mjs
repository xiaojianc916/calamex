import fs from 'node:fs';
import path from 'node:path';

const specPath = path.resolve('src/composables/ai/useAiAssistant.spec.ts');
const tauriTypesPath = path.resolve('src/types/tauri/index.ts');
let content = fs.readFileSync(specPath, 'utf8');

const replaceOrThrow = (pattern, replacement, label) => {
  const next = content.replace(pattern, replacement);
  if (next === content) {
    throw new Error(`未找到需要替换的片段：${label}`);
  }
  content = next;
};

// 1) 类型和常量：Chat 启动结果现在必须带 ACP sessionId，旧 ai:chat-stream 事件类型已删除。
content = content.replace(/\n\s*IAiChatStreamEventPayload,/, '');
if (!content.includes("const CHAT_SESSION_ID = 'acp-chat-session-1' as const;")) {
  replaceOrThrow(
    "const ASSISTANT_MESSAGE_ID = 'assistant-1' as const;\nconst MOCK_MODEL = 'mock-ide-assistant' as const;",
    "const ASSISTANT_MESSAGE_ID = 'assistant-1' as const;\nconst CHAT_SESSION_ID = 'acp-chat-session-1' as const;\nconst MOCK_MODEL = 'mock-ide-assistant' as const;",
    '插入 CHAT_SESSION_ID',
  );
}

// 2) 移除旧 onChatStream mock，改为复用 ai:sidecar-stream handler。
content = content.replace(
  /\n\s*type StreamHandler = \(payload: IAiChatStreamEventPayload\) => void;/,
  '',
);
content = content.replace(/\n\s*let streamHandler: StreamHandler \| null = null;/, '');
content = content.replace(
  /\n\s*const onChatStream = vi\.fn\(async \(handler: StreamHandler\) => \{\n\s*streamHandler = handler;\n\s*return vi\.fn\(\); \/\/ unsubscribe\n\s*\}\);\n/,
  '\n',
);
content = content.replace(/\n\s*onChatStream,/, '');
content = content.replace(/\n\s*onChatStream\.mockClear\(\);/, '');
content = content.replace(/\n\s*streamHandler = null;/, '');
content = content.replace(/\n\s*onChatStream: aiServiceMock\.onChatStream,/, '');

if (!content.includes('let activeChatSessionId')) {
  replaceOrThrow(
    '  let sidecarStreamHandler: SidecarStreamHandler | null = null;\n  let streamSequence = 0;',
    "  let sidecarStreamHandler: SidecarStreamHandler | null = null;\n  let streamSequence = 0;\n  let sidecarSequence = 0;\n  let activeChatSessionId = 'acp-chat-session-1';",
    '新增 ACP chat session 状态',
  );
}

// vi.hoisted 的工厂会早于模块顶层 const 初始化执行，不能在初始化表达式里读 CHAT_SESSION_ID。
// 保留顶层 CHAT_SESSION_ID 给后续普通测试代码用，hoisted mock 的立即初始化只用字面量。
content = content.replace(
  'let activeChatSessionId: string = CHAT_SESSION_ID;',
  "let activeChatSessionId = 'acp-chat-session-1';",
);
content = content.replace(
  /let sidecarSequence = 0;\n\s*let sidecarSequence = 0;/,
  'let sidecarSequence = 0;',
);

if (!content.includes('    sessionId: string;')) {
  replaceOrThrow(
    '    streamId: string;\n    assistantMessageId: string;\n    content: string;',
    '    streamId: string;\n    assistantMessageId: string;\n    sessionId: string;\n    content: string;',
    'queuedStreamResponses 增加 sessionId',
  );
}

if (!content.includes('const emitSidecarEvent = (sessionId: string')) {
  replaceOrThrow(
    '  const queuedStreamResponses: Array<{\n    streamId: string;\n    assistantMessageId: string;\n    sessionId: string;\n    content: string;\n    terminalKind: \'done\' | \'error\';\n    terminalMessage: string | null;\n  }> = [];\n',
    `  const queuedStreamResponses: Array<{\n    streamId: string;\n    assistantMessageId: string;\n    sessionId: string;\n    content: string;\n    terminalKind: 'done' | 'error';\n    terminalMessage: string | null;\n  }> = [];\n\n  const emitSidecarEvent = (\n    sessionId: string,\n    event: IAgentSidecarStreamEventPayload['event'],\n  ): void => {\n    sidecarStreamHandler?.({\n      sessionId,\n      seq: sidecarSequence,\n      event,\n    });\n    sidecarSequence += 1;\n  };\n\n  const emitChatDelta = (delta: string, sessionId = activeChatSessionId): void => {\n    emitSidecarEvent(sessionId, {\n      type: 'message_delta',\n      text: delta,\n      phase: 'final',\n    });\n  };\n\n  const emitChatDone = (\n    result: string,\n    sessionId = activeChatSessionId,\n    usage?: Extract<IAgentSidecarStreamEventPayload['event'], { type: 'done' }>['usage'],\n  ): void => {\n    emitSidecarEvent(sessionId, {\n      type: 'done',\n      result,\n      ...(usage ? { usage } : {}),\n    });\n  };\n\n  const emitChatError = (message: string, sessionId = activeChatSessionId): void => {\n    emitSidecarEvent(sessionId, {\n      type: 'error',\n      message,\n    });\n  };\n`,
    '新增 sidecar chat emit helpers',
  );
}

// 3) chatStream mock：返回 mastra + sessionId，并把 queued 回答发成 ACP message_delta/done/error。
if (content.includes("providerType: 'mock'") || !content.includes('sessionId: activeChatSessionId')) {
  replaceOrThrow(
    /  const chatStream = vi\.fn<[\s\S]*?\n  \}\);\n\n  const generateConversationTitle =/,
    `  const chatStream = vi.fn<\n    (payload: IAiChatRequest) => Promise<{\n      streamId: string;\n      assistantMessageId: string;\n      providerType: 'mastra';\n      model: string;\n      sessionId: string;\n    }>\n  >(async (payload) => {\n    void payload;\n    const queued = queuedStreamResponses.shift();\n    if (!queued) {\n      activeChatSessionId = CHAT_SESSION_ID;\n      return {\n        streamId: STREAM_ID,\n        assistantMessageId: ASSISTANT_MESSAGE_ID,\n        providerType: 'mastra',\n        model: MOCK_MODEL,\n        sessionId: activeChatSessionId,\n      };\n    }\n\n    activeChatSessionId = queued.sessionId;\n    queueMicrotask(() => {\n      for (const chunk of queued.content.match(/.{1,24}/g) ?? []) {\n        emitChatDelta(chunk, queued.sessionId);\n      }\n\n      if (queued.terminalKind === 'error') {\n        emitChatError(queued.terminalMessage ?? 'AI 流式响应失败', queued.sessionId);\n        return;\n      }\n\n      emitChatDone(queued.content, queued.sessionId);\n    });\n\n    return {\n      streamId: queued.streamId,\n      assistantMessageId: queued.assistantMessageId,\n      providerType: 'mastra',\n      model: MOCK_MODEL,\n      sessionId: queued.sessionId,\n    };\n  });\n\n  const generateConversationTitle =`,
    '替换 chatStream mock',
  );
}

content = content.replace(
  /const cancel = vi\.fn\(async \(payload: \{ streamId: string \}\) => \{/,
  'const cancel = vi.fn(async (payload: { streamId: string; threadId: string | null }) => {',
);

content = content.replace(
  /assistantMessageId: `\$\{ASSISTANT_MESSAGE_ID\}-\$\{streamSequence\}`,\n\s*content,/,
  'assistantMessageId: `${ASSISTANT_MESSAGE_ID}-${streamSequence}`,\n        sessionId: `${CHAT_SESSION_ID}-${streamSequence}`,\n        content,',
);

// 4) 替换旧 emit/emitDelta API，测试继续通过 emitDelta/emitDone 驱动，但底层已走 sidecar-stream。
content = content.replace(
  /\n\s*emit\(event: IAiChatStreamEventPayload\): void \{\n\s*streamHandler\?\.\(event\);\n\s*\},/,
  '',
);
if (content.includes('streamHandler?.({')) {
  replaceOrThrow(
    /    emitDelta\(delta: string\): void \{\n\s*streamHandler\?\.\(\{[\s\S]*?\n\s*\}\);\n\s*\},/,
    `    emitDelta(delta: string): void {\n      emitChatDelta(delta);\n    },\n    emitDone(\n      result: string,\n      usage?: Extract<IAgentSidecarStreamEventPayload['event'], { type: 'done' }>['usage'],\n    ): void {\n      emitChatDone(result, activeChatSessionId, usage);\n    },`,
    '替换 emitDelta',
  );
}

content = content.replace(
  '      streamSequence = 0;\n      queuedStreamResponses.length = 0;',
  "      streamSequence = 0;\n      sidecarSequence = 0;\n      activeChatSessionId = 'acp-chat-session-1';\n      queuedStreamResponses.length = 0;",
);
content = content.replace(
  /activeChatSessionId = CHAT_SESSION_ID;\n\s*activeChatSessionId = CHAT_SESSION_ID;/g,
  'activeChatSessionId = CHAT_SESSION_ID;',
);

// 5) waitForStartedStream 不再假设后端 assistantMessageId 就是前端 placeholder id。
if (content.includes('expectedId: string = ASSISTANT_MESSAGE_ID')) {
  replaceOrThrow(
    /const waitForStartedStream = async \([\s\S]*?\n\};\n\nconst createDocument =/,
    `const waitForStartedStream = async (\n  resolveMessageId: () => string | undefined,\n  expectedId?: string,\n  maxAttempts = 8,\n): Promise<void> => {\n  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {\n    const messageId = resolveMessageId();\n    if (messageId && (!expectedId || messageId === expectedId)) {\n      return;\n    }\n    await flushMicrotasks();\n  }\n  throw new Error(\n    \`assistant stream did not start in time (expected id=\"\${expectedId ?? '<any>'}\" within \${maxAttempts} ticks)\`,\n  );\n};\n\nconst createDocument =`,
    '替换 waitForStartedStream',
  );
}

// 6) 调整仍然引用旧 chat-stream emit 的三个断言块。
content = content.replace(
  "    expect(aiServiceMock.cancel).toHaveBeenCalledWith({ streamId: STREAM_ID });",
  "    expect(aiServiceMock.cancel).toHaveBeenCalledWith({\n      streamId: STREAM_ID,\n      threadId: expect.any(String),\n    });",
);

content = content.replace(
  /\n\s*aiServiceMock\.emit\(\{\n\s*streamId: STREAM_ID,\n\s*assistantMessageId: ASSISTANT_MESSAGE_ID,\n\s*kind: 'cancelled',[\s\S]*?\n\s*\}\);\n\s*await flushMicrotasks\(\);/,
  '\n    assistant.stopCurrentRequest();\n    await flushMicrotasks();',
);

content = content.replace(
  /\n\s*aiServiceMock\.emit\(\{\n\s*streamId: STREAM_ID,\n\s*assistantMessageId: ASSISTANT_MESSAGE_ID,\n\s*kind: 'delta',[\s\S]*?\n\s*\}\);\n\s*await flushMicrotasks\(\);\n\n\s*expect\(assistant\.messages\.value\.at\(-1\)\?\.stream\)\.toMatchObject\(\{\n\s*status: 'streaming',[\s\S]*?\n\s*\}\);\n\n\s*aiServiceMock\.emit\(\{\n\s*streamId: STREAM_ID,\n\s*assistantMessageId: ASSISTANT_MESSAGE_ID,\n\s*kind: 'done',[\s\S]*?\n\s*\}\);/,
  `\n    aiServiceMock.emitDelta('你好');\n    await flushMicrotasks();\n\n    expect(assistant.messages.value.at(-1)?.stream).toMatchObject({\n      status: 'streaming',\n    });\n\n    aiServiceMock.emitDone('你好', {\n      inputTokens: 13,\n      inputTokenDetails: {\n        noCacheTokens: 13,\n        cacheReadTokens: 0,\n        cacheWriteTokens: 0,\n      },\n      outputTokens: 5,\n      outputTokenDetails: {\n        textTokens: 4,\n        reasoningTokens: 1,\n      },\n      totalTokens: 18,\n      cachedInputTokens: 0,\n      reasoningTokens: 1,\n    });`,
);

for (const forbidden of ['IAiChatStreamEventPayload', 'onChatStream', 'aiServiceMock.emit({', 'streamHandler']) {
  if (content.includes(forbidden)) {
    throw new Error(`迁移后仍残留旧实现标记：${forbidden}`);
  }
}

fs.writeFileSync(specPath, content);

// 顺手修复已知格式回归。
if (fs.existsSync(tauriTypesPath)) {
  let tauriTypes = fs.readFileSync(tauriTypesPath, 'utf8');
  tauriTypes = tauriTypes.replace(
    /agentSidecarRestoreCheckpoint\(\n\s*payload: IAgentSidecarCheckpointRestoreRequest\): Promise<IAgentSidecarResponsePayload>;/,
    'agentSidecarRestoreCheckpoint(\n    payload: IAgentSidecarCheckpointRestoreRequest,\n  ): Promise<IAgentSidecarResponsePayload>;',
  );
  fs.writeFileSync(tauriTypesPath, tauriTypes);
}

console.log('已把 useAiAssistant.spec.ts 的 Chat 流 mock 迁移到 ACP sidecar-stream，并修复 tauri 类型格式。');
