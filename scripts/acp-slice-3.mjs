// scripts/acp-slice-3.mjs
// Slice 3 — chat 模式从 legacy ai:chat-stream 迁移到 ACP ai:sidecar-stream。
// 方案 A:复用 agent 那套 sidecar 消费机制 + cancel 走 threadId。
//
// 前置条件(务必先满足,否则前端 tsc 会因生成绑定缺字段而失败):
//   1) 已应用 scripts/acp-slice-2b-ii.mjs
//   2) cargo build --features acp_client && cargo build && cargo test --features acp_client 全绿
//      —— 这一步会用 tauri-specta 重新生成 src/bindings/tauri.ts,
//         使 aiChatStream 返回 sessionId、aiCancel 接受 threadId。
//
// 运行:  node scripts/acp-slice-3.mjs       (在仓库根目录)
// 验证:  pnpm tsc --noEmit && pnpm vitest run && pnpm eslint .

import { readFileSync, writeFileSync } from 'node:fs';

/** 把 CRLF/CR 统一成 LF,仅用于"锚点匹配",写回时再还原原始 EOL。 */
const toLF = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** @type {{file:string, edits:{find:string, replace:string, count?:number}[]}[]} */
const tasks = [
  // ──────────────────────────────────────────────────────────────────────
  // 1) src/types/ai/schema.ts —— 给 chat 流 start 信封补 sessionId(可选,向后兼容)
  // ──────────────────────────────────────────────────────────────────────
  {
    file: 'src/types/ai/schema.ts',
    edits: [
      {
        find: `export const aiChatStreamPayloadSchema = z.object({
  streamId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  providerType: aiProviderTypeSchema,
  model: z.string().min(1),
});`,
        replace: `export const aiChatStreamPayloadSchema = z.object({
  streamId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  providerType: aiProviderTypeSchema,
  model: z.string().min(1),
  /**
   * ACP 会话标识。chat 模式走 ACP host 时由后端 \`chat_stream_via_acp\` 回填,
   * 前端据此订阅 \`ai:sidecar-stream\` 上属于本轮的投影事件。legacy 路径不设置,
   * 故为 \`.optional()\`,保持对旧后端的向后兼容。
   */
  sessionId: z.string().min(1).optional(),
});`,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // 2) src/types/ai/index.ts —— 手写 IAiCancelRequest 增加 threadId
  // ──────────────────────────────────────────────────────────────────────
  {
    file: 'src/types/ai/index.ts',
    edits: [
      {
        find: `export interface IAiCancelRequest {
  streamId: string;
}`,
        replace: `export interface IAiCancelRequest {
  streamId: string;
  /**
   * ACP 取消按 thread 维度:\`ai_cancel\` 在 \`acp_client\` 下调用
   * \`AcpRuntime.cancel_thread(thread_id)\`(thread_id 为空则回退 stream_manager)。
   * 与生成绑定的 \`Option<String>\` 对齐,使用 \`string | null\`。
   */
  threadId: string | null;
}`,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // 3) src/services/ipc/ai.service.ts —— cancel 改用 IAiCancelRequest
  // ──────────────────────────────────────────────────────────────────────
  {
    file: 'src/services/ipc/ai.service.ts',
    edits: [
      {
        find: `  IAiApplyPatchRequest,
  IAiChatRequest,`,
        replace: `  IAiApplyPatchRequest,
  IAiCancelRequest,
  IAiChatRequest,`,
      },
      {
        find: `  cancel(payload: { streamId: string }): Promise<void> {
    return tauriService.aiCancel(payload);
  },`,
        replace: `  cancel(payload: IAiCancelRequest): Promise<void> {
    return tauriService.aiCancel(payload);
  },`,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // 4) src/composables/ai/useAiAssistant.ts
  // ──────────────────────────────────────────────────────────────────────
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    edits: [
      // (a) 移除 createStreamPipeline 导入
      {
        find: `} from './useAiAssistant.stream';
import { createStreamPipeline } from './useAiAssistant.stream-pipeline';

type TAiQuickActionId = 'explain' | 'fix' | 'review';`,
        replace: `} from './useAiAssistant.stream';

type TAiQuickActionId = 'explain' | 'fix' | 'review';`,
      },
      // (b) 重写 executeAiRequest:走 ACP sidecar 消费机制
      {
        find: `  const executeAiRequest = async (
    requestMessages: IAiChatMessage[],
    visibleMessages: IAiChatMessage[],
    references: IAiContextReference[],
    threadId: string | null,
  ): Promise<void> => {
    errorMessage.value = '';
    isSending.value = true;
    activeBufferedThreadId.value = threadId;

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
      {
        aiStream,
        activeStreamId,
        errorMessage,
        syncActiveAssistantMessage,
        clearAttachedFiles,
      },
      assistantMessage,
      settle,
    );

    try {
      unlisten = await aiService.onChatStream(pipeline.handleEvent);

      const stream = await aiService.chatStream({
        threadId,
        messages: requestMessages,
        references,
      });

      pipeline.startAssistantStream(stream.streamId, stream.assistantMessageId);

      await new Promise<void>((resolve) => {
        if (hasSettledStream) {
          resolve();
          return;
        }

        activeStreamResolve.value = resolve;
      });
    } finally {
      pipeline.flushBufferedText();
      commitDisplayMessagesToStore(threadId);
      unlisten?.();

      activeStreamResolve.value = null;
      activeStreamId.value = null;
      activeAbortController.value = null;
      activeAssistantMessage.value = null;
      activeAssistantBaseMessages.value = [];
      clearActiveBufferedThread(threadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }
  };`,
        replace: `  const executeAiRequest = async (
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

    let hasSettledStream = false;
    const settle = (): void => {
      hasSettledStream = true;
      activeStreamResolve.value?.();
    };

    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
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
    let unlistenSidecarStream: (() => void) | null = null;

    try {
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

      unlistenSidecarStream = await subscribeSidecarSessionStream(sessionId, (event) => {
        liveEventBuffer.push(event);
      });

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
      if (activeAbortController.value?.signal.aborted) {
        disposeSidecarAnswerStream(assistantMessageId);
      } else {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeStreamResolve.value = null;
      activeStreamId.value = null;
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      commitDisplayMessagesToStore(targetThreadId);
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }
  };`,
      },
      // (c) stopCurrentRequest 的 cancel 透传 threadId
      {
        find: `    const streamId = activeStreamId.value;

    if (streamId) {
      void aiService.cancel({ streamId });
    }`,
        replace: `    const streamId = activeStreamId.value;

    if (streamId) {
      void aiService.cancel({ streamId, threadId: targetThreadId ?? null });
    }`,
      },
    ],
  },
];

let totalEdits = 0;

for (const task of tasks) {
  const original = readFileSync(task.file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let working = toLF(original);

  for (const edit of task.edits) {
    const find = toLF(edit.find);
    const expected = edit.count ?? 1;
    const occurrences = working.split(find).length - 1;

    if (occurrences !== expected) {
      throw new Error(
        `[${task.file}] 锚点出现 ${occurrences} 次,预期 ${expected} 次。已中止(未写入任何文件)。\n--- 锚点开头 ---\n${find.slice(0, 120)}…`,
      );
    }

    working = working.split(find).join(toLF(edit.replace));
    totalEdits += expected;
  }

  const next = eol === '\n' ? working : working.replace(/\n/g, eol);
  writeFileSync(task.file, next, 'utf8');
  console.log(`✓ ${task.file} (${task.edits.length} edit(s))`);
}

console.log(`\n完成:${tasks.length} 个文件 / ${totalEdits} 处替换。`);
console.log('下一步验证:pnpm tsc --noEmit && pnpm vitest run && pnpm eslint .');