#!/usr/bin/env node
// 一次性 EOL 自适应 codemod（Task #1 全量重构：chat 模式迁移到「前端预生成流式关联键」，删 prebuffer/bind）。
// 覆盖：
//   Rust  : src-tauri/src/commands/contracts/ai_chat.rs（LF）
//           src-tauri/src/acp/host.rs（CRLF）
//           src-tauri/src/ai/gateway/conversation.rs（LF）
//   前端  : src/types/ai/schema.ts（LF）
//           src/composables/ai/sidecar-stream-listener.ts（LF）
//           src/composables/ai/useAiAssistant.ts（LF）
//   测试  : src/composables/ai/useAiAssistant.spec.ts（LF）
// 规则：每个 hunk 先按 LF 匹配，0 命中则整体转 CRLF 重试；必须命中且仅命中 1 次。
//       任一 hunk 失败立即抛错且不写入任何文件（all-or-nothing），避免半套状态。
// 用法：在仓库根目录（D:\com.xiaojianc\my_desktop_app）执行：node 1.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const L = (arr) => arr.join('\n');
const toCRLF = (s) => s.replace(/\n/g, '\r\n');
const countOcc = (hay, needle) => {
  let n = 0;
  let i = 0;
  for (;;) {
    const idx = hay.indexOf(needle, i);
    if (idx < 0) break;
    n += 1;
    i = idx + needle.length;
  }
  return n;
};

const files = [
  // ===========================================================================
  // 1) Rust 契约：AiChatRequest 增加 stream_session_id（镜像 thread_id，无 serde default）
  // ===========================================================================
  {
    path: 'src-tauri/src/commands/contracts/ai_chat.rs',
    edits: [
      {
        find: L([
          'pub struct AiChatRequest {',
          '    pub(crate) thread_id: Option<String>,',
          '    pub(crate) messages: Vec<AiChatMessagePayload>,',
          '    pub(crate) references: Vec<AiContextReferencePayload>,',
          '}',
        ]),
        replace: L([
          'pub struct AiChatRequest {',
          '    pub(crate) thread_id: Option<String>,',
          '    pub(crate) messages: Vec<AiChatMessagePayload>,',
          '    pub(crate) references: Vec<AiContextReferencePayload>,',
          '    /// 前端预生成的流式关联键（sidecar:assistantMessageId）。chat 模式发起回合前据此',
          '    /// 订阅 ai:sidecar-stream；后端把本回合 session/update 帧的 session_id 重写为该键，',
          '    /// 实现逐 token 实时渲染。与 thread_id 同为可选可空（前端总会携带，缺省回退会话 id）。',
          '    pub(crate) stream_session_id: Option<String>,',
          '}',
        ]),
      },
    ],
  },

  // ===========================================================================
  // 2) Rust 宿主：在 agent_chat 之后新增 agent_chat_with_stream_key（镜像 prompt_with_stream_key）
  // ===========================================================================
  {
    path: 'src-tauri/src/acp/host.rs',
    edits: [
      {
        find: L([
          '        let value = self.handle.agent_chat(request).await?;',
          '        serde_json::from_value(value).map_err(|error| {',
          '            AcpClientError::Protocol(format!(\"invalid agent chat response envelope: {error}\"))',
          '        })',
          '    }',
        ]),
        replace: L([
          '        let value = self.handle.agent_chat(request).await?;',
          '        serde_json::from_value(value).map_err(|error| {',
          '            AcpClientError::Protocol(format!(\"invalid agent chat response envelope: {error}\"))',
          '        })',
          '    }',
          '',
          '    /// 同 agent_chat，但额外接受前端预生成的「流式关联键」用于帧重写（内置 chat 回合专用）。',
          '    ///',
          '    /// 背景与 prompt_with_stream_key 同构：agent_chat 回合的过程增量经 session/update 帧由',
          '    /// EventSink 转发，帧以 ACP 会话 UUID 标记，而前端在回合发起前只知道自造的',
          '    /// sidecar:assistantMessageId 键并据此订阅过滤。若不重写，整轮 live 帧会被前端丢弃、退化',
          '    /// 为末尾一次性渲染。',
          '    ///',
          '    /// 实现：调用方传入本回合的 ACP 会话 id 与前端预生成的 stream_key，若 stream_key 非空且',
          '    /// 不等于 ACP id，就在重写表登记「acp_session_id → stream_key」（sink 据此重写帧的',
          '    /// session_id），跑完 agent_chat 后立即移除（无论成败），把重写作用域严格限定在本回合。',
          '    /// stream_key 为 None / 空白 / 恰等于 ACP id 时不登记，sink 原样透传（行为同旧 agent_chat）。',
          '    pub async fn agent_chat_with_stream_key(',
          '        &self,',
          '        request: AgentChatExtRequest,',
          '        acp_session_id: &str,',
          '        stream_key: Option<&str>,',
          '    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {',
          '        let override_key = stream_key',
          '            .map(str::trim)',
          '            .filter(|key| !key.is_empty() && *key != acp_session_id);',
          '        let registered = if let Some(key) = override_key {',
          '            self.stream_key_overrides',
          '                .lock()',
          '                .insert(acp_session_id.to_string(), key.to_string());',
          '            true',
          '        } else {',
          '            false',
          '        };',
          '',
          '        let outcome = self.agent_chat(request).await;',
          '',
          '        if registered {',
          '            self.stream_key_overrides.lock().remove(acp_session_id);',
          '        }',
          '',
          '        outcome',
          '    }',
        ]),
      },
    ],
  },

  // ===========================================================================
  // 3) Rust 网关：chat_stream_via_acp 引入 stream_key，并据此驱动帧重写 / emit / 返回值
  // ===========================================================================
  {
    path: 'src-tauri/src/ai/gateway/conversation.rs',
    edits: [
      {
        find: L(['    let session_key = session_id.to_string();']),
        replace: L([
          '    let session_key = session_id.to_string();',
          '    // 前端预生成的「流式关联键」（sidecar:assistantMessageId）：用于把本回合 session/update',
          '    // 帧的 session_id 由 ACP 会话 UUID 重写为该键，实现逐 token 实时渲染（与外部 agent 的',
          '    // prompt_with_stream_key 同构）。缺省（未携带 stream_session_id）时回退为 ACP 会话 id，',
          '    // 行为同旧路径。',
          '    let stream_key = payload',
          '        .stream_session_id',
          '        .as_deref()',
          '        .map(str::trim)',
          '        .filter(|key| !key.is_empty())',
          '        .map(str::to_owned)',
          '        .unwrap_or_else(|| session_key.clone());',
        ]),
      },
      {
        find: L([
          '    let task_app = app.clone();',
          '    let task_session_key = session_key.clone();',
        ]),
        replace: L([
          '    let task_app = app.clone();',
          '    // 终态 done/error 经 app.emit 合成补发，键用前端流式关联键 stream_key（FE 据此订阅）；',
          '    // task_acp_session_id 为本回合 ACP 会话 id，供 agent_chat_with_stream_key 登记帧重写表。',
          '    let task_session_key = stream_key.clone();',
          '    let task_acp_session_id = session_key.clone();',
        ]),
      },
      {
        find: L([
          '    tokio::spawn(async move {',
          '        match host.agent_chat(request).await {',
        ]),
        replace: L([
          '    tokio::spawn(async move {',
          '        match host',
          '            .agent_chat_with_stream_key(request, &task_acp_session_id, Some(task_session_key.as_str()))',
          '            .await',
          '        {',
        ]),
      },
      {
        find: L(['        session_id: session_key,', '    })']),
        replace: L(['        session_id: stream_key,', '    })']),
      },
    ],
  },

  // ===========================================================================
  // 4) 前端 schema：aiChatRequestSchema 增加 streamSessionId（required-nullable，对齐 Rust）
  // ===========================================================================
  {
    path: 'src/types/ai/schema.ts',
    edits: [
      {
        find: L([
          'export const aiChatRequestSchema = z.object({',
          '  threadId: z.string().nullable(),',
          '  messages: z.array(aiChatMessageSchema).min(1),',
          '  references: z.array(aiContextReferenceSchema),',
          '});',
        ]),
        replace: L([
          'export const aiChatRequestSchema = z.object({',
          '  threadId: z.string().nullable(),',
          '  /**',
          '   * 前端预生成的流式关联键（sidecar:assistantMessageId）。chat 模式发起回合前据此订阅',
          '   * `ai:sidecar-stream`；后端把本回合 session/update 帧的 session_id 重写为该键，实现逐',
          '   * token 实时渲染。与 threadId 同为 required-nullable（对齐 Rust `Option<String>`）。',
          '   */',
          '  streamSessionId: z.string().nullable(),',
          '  messages: z.array(aiChatMessageSchema).min(1),',
          '  references: z.array(aiContextReferenceSchema),',
          '});',
        ]),
      },
    ],
  },

  // ===========================================================================
  // 5) 前端 listener：删除 subscribeSidecarStreamWithPrebuffer + IBufferedSidecarSessionStream
  // ===========================================================================
  {
    path: 'src/composables/ai/sidecar-stream-listener.ts',
    edits: [
      {
        find: L([
          '  });',
          '',
          '/**',
          ' * 在已知 sessionId 之前就订阅 sidecar 流:先缓冲全部帧,bind(sessionId) 后回放匹配帧',
          ' * 并继续转发后续匹配帧。消除「先 await chatStream → 再订阅」之间的丢帧窗口(零竞态)。',
          ' */',
          'export interface IBufferedSidecarSessionStream {',
          '  bind(sessionId: string): void;',
          '  dispose(): void;',
          '}',
          '',
          'export const subscribeSidecarStreamWithPrebuffer = async (',
          '  onEvent: (event: TAgentUiEvent) => void,',
          '): Promise<IBufferedSidecarSessionStream> => {',
          '  const buffered: Array<{ sessionId: string; event: TAgentUiEvent }> = [];',
          '  let boundSessionId: string | null = null;',
          '',
          '  const unlisten = await aiService.onSidecarStream((payload) => {',
          '    if (boundSessionId === null) {',
          '      buffered.push({ sessionId: payload.sessionId, event: payload.event });',
          '      return;',
          '    }',
          '',
          '    if (payload.sessionId !== boundSessionId) {',
          '      return;',
          '    }',
          '',
          '    onEvent(payload.event);',
          '  });',
          '',
          '  return {',
          '    bind(sessionId: string): void {',
          '      if (boundSessionId !== null) {',
          '        return;',
          '      }',
          '',
          '      boundSessionId = sessionId;',
          '',
          '      for (const frame of buffered.splice(0)) {',
          '        if (frame.sessionId === sessionId) {',
          '          onEvent(frame.event);',
          '        }',
          '      }',
          '    },',
          '    dispose(): void {',
          '      buffered.length = 0;',
          '      unlisten();',
          '    },',
          '  };',
          '};',
        ]),
        replace: L(['  });']),
      },
    ],
  },

  // ===========================================================================
  // 6) 前端 composable：executeAiRequest 迁移到预生成键订阅 + 删 bind/sessionId 抛错
  // ===========================================================================
  {
    path: 'src/composables/ai/useAiAssistant.ts',
    edits: [
      // 6A 收敛 import（去掉 subscribeSidecarStreamWithPrebuffer）
      {
        find: L([
          'import {',
          '  subscribeSidecarSessionStream,',
          '  subscribeSidecarStreamWithPrebuffer,',
          "} from '@/composables/ai/sidecar-stream-listener';",
        ]),
        replace: L([
          "import { subscribeSidecarSessionStream } from '@/composables/ai/sidecar-stream-listener';",
        ]),
      },
      // 6B 声明 + 订阅 + chatStream + 删 bind/sessionId 抛错
      {
        find: L([
          '    let sidecarStream: Awaited<ReturnType<typeof subscribeSidecarStreamWithPrebuffer>> | null =',
          '      null;',
          '',
          '    try {',
          '      sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {',
          '        if (requestAbortController.signal.aborted) {',
          '          return;',
          '        }',
          '        liveEventBuffer.push(event);',
          '      });',
          '',
          '      const stream = await aiService.chatStream({',
          '        threadId,',
          '        messages: requestMessages,',
          '        references,',
          '      });',
          '',
          '      activeStreamId.value = stream.streamId;',
          '',
          '      const sessionId = stream.sessionId;',
          '',
          '      if (!sessionId) {',
          "        throw new Error('AI 流式响应缺少 sessionId,无法订阅 ACP 流。');",
          '      }',
          '',
          '      sidecarStream.bind(sessionId);',
          '',
          '      if (requestAbortController.signal.aborted) {',
          '        settle();',
          '      }',
        ]),
        replace: L([
          '    const sidecarSessionId = `sidecar:${assistantMessageId}`;',
          '    let unlistenSidecarStream: (() => void) | null = null;',
          '',
          '    try {',
          '      // chat 模式与外部 agent 同款零竞态流式：用前端预生成的 sidecarSessionId 在发起回合',
          '      // 「之前」订阅 session/update 帧；后端 chat_stream_via_acp 据此把本回合帧的 session_id',
          '      // 由 ACP 会话 UUID 重写为该键（见 Rust host.agent_chat_with_stream_key），逐 token 实时',
          '      // 渲染。取代旧的「subscribeSidecarStreamWithPrebuffer + 回合返回后 bind(sessionId)」。',
          '      unlistenSidecarStream = await subscribeSidecarSessionStream(sidecarSessionId, (event) => {',
          '        if (requestAbortController.signal.aborted) {',
          '          return;',
          '        }',
          '        liveEventBuffer.push(event);',
          '      });',
          '',
          '      const stream = await aiService.chatStream({',
          '        threadId,',
          '        streamSessionId: sidecarSessionId,',
          '        messages: requestMessages,',
          '        references,',
          '      });',
          '',
          '      activeStreamId.value = stream.streamId;',
          '',
          '      if (requestAbortController.signal.aborted) {',
          '        settle();',
          '      }',
        ]),
      },
      // 6C flush 后取消订阅
      {
        find: L([
          '      liveEventBuffer.flush();',
          '',
          '      if (!errorMessage.value) {',
          '        clearAttachedFiles({ revokePreviews: false });',
          '      }',
        ]),
        replace: L([
          '      liveEventBuffer.flush();',
          '      unlistenSidecarStream?.();',
          '      unlistenSidecarStream = null;',
          '',
          '      if (!errorMessage.value) {',
          '        clearAttachedFiles({ revokePreviews: false });',
          '      }',
        ]),
      },
      // 6D finally：dispose → unlisten
      {
        find: L([
          '      liveEventBuffer.dispose();',
          '      sidecarStream?.dispose();',
          '      activeStreamResolve.value = null;',
        ]),
        replace: L([
          '      liveEventBuffer.dispose();',
          '      unlistenSidecarStream?.();',
          '      activeStreamResolve.value = null;',
        ]),
      },
    ],
  },

  // ===========================================================================
  // 7) 测试：chatStream mock 改为按 payload.streamSessionId emit（对齐真实后端 / 外部 agent 范式）
  // ===========================================================================
  {
    path: 'src/composables/ai/useAiAssistant.spec.ts',
    edits: [
      {
        find: L([
          '  const chatStream = vi.fn<',
          '    (payload: IAiChatRequest) => Promise<{',
          '      streamId: string;',
          '      assistantMessageId: string;',
          "      providerType: 'mastra';",
          '      model: string;',
          '      sessionId: string;',
          '    }>',
          '  >(async (payload) => {',
          '    void payload;',
          '    const queued = queuedStreamResponses.shift();',
          '    if (!queued) {',
          '      activeChatSessionId = CHAT_SESSION_ID;',
          '      return {',
          '        streamId: STREAM_ID,',
          '        assistantMessageId: ASSISTANT_MESSAGE_ID,',
          "        providerType: 'mastra',",
          '        model: MOCK_MODEL,',
          '        sessionId: activeChatSessionId,',
          '      };',
          '    }',
          '',
          '    activeChatSessionId = queued.sessionId;',
          '    void Promise.resolve().then(() => {',
          '      for (const chunk of queued.content.match(/.{1,24}/g) ?? []) {',
          '        emitChatDelta(chunk, queued.sessionId);',
          '      }',
          '',
          "      if (queued.terminalKind === 'error') {",
          "        emitChatError(queued.terminalMessage ?? 'AI 流式响应失败', queued.sessionId);",
          '        return;',
          '      }',
          '',
          '      emitChatDone(queued.content, queued.sessionId);',
          '    });',
          '',
          '    return {',
          '      streamId: queued.streamId,',
          '      assistantMessageId: queued.assistantMessageId,',
          "      providerType: 'mastra',",
          '      model: MOCK_MODEL,',
          '      sessionId: queued.sessionId,',
          '    };',
          '  });',
        ]),
        replace: L([
          '  const chatStream = vi.fn<',
          '    (payload: IAiChatRequest) => Promise<{',
          '      streamId: string;',
          '      assistantMessageId: string;',
          "      providerType: 'mastra';",
          '      model: string;',
          '      sessionId: string;',
          '    }>',
          '  >(async (payload) => {',
          '    // chat 模式已迁移为「前端预生成流式关联键」：FE 在调用前用 streamSessionId 订阅，后端据此',
          '    // 把本回合帧的 session_id 重写为该键。Mock 据此把增量/终态 emit 在 payload.streamSessionId',
          '    // 上，对齐真实后端（与外部 agent 测试同款范式）。',
          '    const streamKey = payload.streamSessionId ?? CHAT_SESSION_ID;',
          '    activeChatSessionId = streamKey;',
          '    const queued = queuedStreamResponses.shift();',
          '    if (!queued) {',
          '      return {',
          '        streamId: STREAM_ID,',
          '        assistantMessageId: ASSISTANT_MESSAGE_ID,',
          "        providerType: 'mastra',",
          '        model: MOCK_MODEL,',
          '        sessionId: streamKey,',
          '      };',
          '    }',
          '',
          '    void Promise.resolve().then(() => {',
          '      for (const chunk of queued.content.match(/.{1,24}/g) ?? []) {',
          '        emitChatDelta(chunk, streamKey);',
          '      }',
          '',
          "      if (queued.terminalKind === 'error') {",
          "        emitChatError(queued.terminalMessage ?? 'AI 流式响应失败', streamKey);",
          '        return;',
          '      }',
          '',
          '      emitChatDone(queued.content, streamKey);',
          '    });',
          '',
          '    return {',
          '      streamId: queued.streamId,',
          '      assistantMessageId: queued.assistantMessageId,',
          "      providerType: 'mastra',",
          '      model: MOCK_MODEL,',
          '      sessionId: streamKey,',
          '    };',
          '  });',
        ]),
      },
    ],
  },
];

const pending = [];
for (const file of files) {
  let content = readFileSync(file.path, 'utf8');
  file.edits.forEach((edit, k) => {
    let find = edit.find;
    let replace = edit.replace;
    let cnt = countOcc(content, find);
    if (cnt === 0) {
      find = toCRLF(edit.find);
      replace = toCRLF(edit.replace);
      cnt = countOcc(content, find);
    }
    if (cnt !== 1) {
      throw new Error(
        `[ABORT] ${file.path} 第 ${k + 1} 个 hunk 期望命中 1 处，实际 ${cnt} 处（LF/CRLF 均已尝试）。未写入任何文件。`,
      );
    }
    content = content.replace(find, () => replace);
  });
  pending.push({ path: file.path, content });
}

for (const p of pending) {
  writeFileSync(p.path, p.content, 'utf8');
  console.log(`[OK] 已更新 ${p.path}`);
}
console.log('[DONE] 全部 hunk 命中并写入完成。');