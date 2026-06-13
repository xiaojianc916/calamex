#!/usr/bin/env node
// scripts/acp-slice-3.mjs  —— 硬化版 Slice 3(零竞态流式)
// chat 全面切到 ACP sidecar 流式消费 + 预缓冲/bind(sessionId) 消除丢帧竞态。
// 删除 createStreamPipeline / onChatStream 依赖,不新旧杂糅。
//
// 用法:
//   node scripts/acp-slice-3.mjs           # 应用(全有或全无:任一锚点不匹配则不写任何文件)
//   node scripts/acp-slice-3.mjs --check   # 干跑,仅校验锚点
//
// 前置:必须在 2b-ii 已应用 + `cargo ... --features acp_client` 绿 + tauri-specta 绑定重生成之后运行。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--check');
const normalizeLf = (s) => s.replace(/\r\n/g, '\n');

/** @type {{file:string, edits:{find:string, replace:string, count:number}[]}[]} */
const PLAN = [
  // ── 1. schema.ts:chat stream payload 增加 sessionId(.nullable().optional() 以匹配 Option<String>→string|null)
  {
    file: 'src/types/ai/schema.ts',
    edits: [
      {
        count: 1,
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
  /** ACP 会话 ID:仅 acp_client 路径回填，前端按 sessionId 过滤 sidecar 流式帧。 */
  sessionId: z.string().min(1).nullable().optional(),
});`,
      },
    ],
  },

  // ── 2. types/ai/index.ts:手写 IAiCancelRequest 增加 threadId
  {
    file: 'src/types/ai/index.ts',
    edits: [
      {
        count: 1,
        find: `export interface IAiCancelRequest {
  streamId: string;
}`,
        replace: `export interface IAiCancelRequest {
  streamId: string;
  /** ACP 路径按 thread 取消；非 acp_client 路径忽略此字段。null 表示无关联 thread。 */
  threadId: string | null;
}`,
      },
    ],
  },

  // ── 3. ai.service.ts:cancel 使用 IAiCancelRequest(import + 方法签名)
  {
    file: 'src/services/ipc/ai.service.ts',
    edits: [
      {
        count: 1,
        find: `  IAiApplyPatchRequest,
  IAiChatRequest,`,
        replace: `  IAiApplyPatchRequest,
  IAiCancelRequest,
  IAiChatRequest,`,
      },
      {
        count: 1,
        find: `  cancel(payload: { streamId: string }): Promise<void> {
    return tauriService.aiCancel(payload);
  },`,
        replace: `  cancel(payload: IAiCancelRequest): Promise<void> {
    return tauriService.aiCancel(payload);
  },`,
      },
    ],
  },

  // ── 4. sidecar-stream-listener.ts:新增零竞态预缓冲订阅
  {
    file: 'src/composables/ai/sidecar-stream-listener.ts',
    edits: [
      {
        count: 1,
        find: `    onEvent(payload.event);
  });`,
        replace: `    onEvent(payload.event);
  });

/**
 * 零竞态订阅句柄:在 sessionId 已知前即挂上全量 onSidecarStream 监听并预缓冲所有帧，
 * 待 bind(sessionId) 后按 sessionId 回放已缓冲的匹配帧 + 转发后续匹配帧。
 */
export interface IBufferedSidecarSessionStream {
  /** 绑定 sessionId:回放已缓冲的匹配帧并开始转发后续匹配帧。仅首次调用生效。 */
  bind: (sessionId: string) => void;
  /** 取消底层订阅并清空缓冲。 */
  dispose: () => void;
}

/**
 * 零竞态订阅 sidecar 流式事件。
 *
 * 用于 chat 模式:sessionId 由后端在 chatStream 返回后才回填，存在"先调用后订阅"窗口。
 * 本函数在 await resolve（底层监听已就绪）时即开始预缓冲所有 session 的帧；
 * 调用方拿到 sessionId 后 bind()，先回放匹配的已缓冲帧再转发后续帧，彻底消除丢帧竞态。
 *
 * 返回的 Promise resolve 为句柄（此时底层监听已就绪，可安全发起 chatStream）。
 */
export const subscribeSidecarStreamWithPrebuffer = async (
  onEvent: (event: TAgentUiEvent) => void,
): Promise<IBufferedSidecarSessionStream> => {
  const buffered: { sessionId: string; event: TAgentUiEvent }[] = [];
  let boundSessionId: string | null = null;
  let isDisposed = false;

  const unlisten = await aiService.onSidecarStream((payload) => {
    if (isDisposed) {
      return;
    }

    if (boundSessionId === null) {
      buffered.push({ sessionId: payload.sessionId, event: payload.event });
      return;
    }

    if (payload.sessionId !== boundSessionId) {
      return;
    }

    onEvent(payload.event);
  });

  return {
    bind: (sessionId) => {
      if (isDisposed || boundSessionId !== null) {
        return;
      }

      boundSessionId = sessionId;

      for (const item of buffered) {
        if (item.sessionId === sessionId) {
          onEvent(item.event);
        }
      }

      buffered.length = 0;
    },
    dispose: () => {
      if (isDisposed) {
        return;
      }

      isDisposed = true;
      buffered.length = 0;
      unlisten();
    },
  };
};`,
      },
    ],
  },

  // ── 5. useAiAssistant.ts:移除 legacy pipeline、引入预缓冲、重写 executeAiRequest、cancel 带 threadId
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    edits: [
      // 5a 移除 createStreamPipeline import
      {
        count: 1,
        find: `} from './useAiAssistant.stream';
import { createStreamPipeline } from './useAiAssistant.stream-pipeline';`,
        replace: `} from './useAiAssistant.stream';`,
      },
      // 5b 引入预缓冲订阅
      {
        count: 1,
        find: `import { subscribeSidecarSessionStream } from '@/composables/ai/sidecar-stream-listener';`,
        replace: `import {
  subscribeSidecarSessionStream,
  subscribeSidecarStreamWithPrebuffer,
} from '@/composables/ai/sidecar-stream-listener';`,
      },
      // 5c 重写 executeAiRequest:复用 sidecar 消费 + 预缓冲/bind 零竞态
      {
        count: 1,
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
    errorMessage.value = '';
    isSending.value = true;
    const targetThreadId = threadId;
    activeBufferedThreadId.value = targetThreadId;

    const assistantMessageId = createMessageId('assistant');
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

      if (doneEvent || errorEvent) {
        settle();
      }
    });

    // 零竞态:先挂上全量 sidecar 流式监听并预缓冲，待 chatStream 回填 sessionId 后再 bind，
    // 彻底消除"先调用 chatStream、后订阅"窗口内的首帧丢失。
    const sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {
      liveEventBuffer.push(event);
    });

    try {
      const stream = await aiService.chatStream({
        threadId,
        messages: requestMessages,
        references,
      });

      activeStreamId.value = stream.streamId;

      if (!stream.sessionId) {
        throw new Error(
          'AI 流式响应缺少 sessionId，无法建立 ACP 流式订阅（请确认后端已启用 acp_client）。',
        );
      }

      sidecarStream.bind(stream.sessionId);

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
      sidecarStream.dispose();
      commitDisplayMessagesToStore(targetThreadId);

      activeStreamResolve.value = null;
      activeStreamId.value = null;
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }
  };`,
      },
      // 5d stopCurrentRequest:cancel 带上 threadId
      {
        count: 1,
        find: `    if (streamId) {
      void aiService.cancel({ streamId });
    }`,
        replace: `    if (streamId) {
      void aiService.cancel({ streamId, threadId: targetThreadId ?? null });
    }`,
      },
    ],
  },
];

// ── 全有或全无:先全部在内存里校验+应用,任一失败则不落盘 ───────────────
const results = [];
let failed = false;

for (const { file, edits } of PLAN) {
  const abs = resolve(process.cwd(), file);
  let original;
  try {
    original = readFileSync(abs, 'utf8');
  } catch (err) {
    console.error(`✗ 读取失败: ${file} (${err.message})`);
    failed = true;
    continue;
  }

  const usesCrlf = original.includes('\r\n');
  let working = normalizeLf(original);
  const notes = [];
  let fileOk = true;

  for (const [i, edit] of edits.entries()) {
    const find = normalizeLf(edit.find);
    const occurrences = working.split(find).length - 1;
    if (occurrences !== edit.count) {
      console.error(
        `✗ ${file} edit#${i + 1}: 期望 ${edit.count} 处匹配, 实际 ${occurrences} 处。`,
      );
      failed = true;
      fileOk = false;
      break;
    }
    working = working.split(find).join(normalizeLf(edit.replace));
    notes.push(`edit#${i + 1}✓`);
  }

  if (fileOk) {
    results.push({ abs, file, output: usesCrlf ? working.replace(/\n/g, '\r\n') : working, notes });
  }
}

if (failed) {
  console.error('\n✗ 有锚点未匹配,未写入任何文件。请确认在 2b-ii 应用且绑定重生成之后运行,或核对锚点。');
  process.exit(1);
}

if (DRY_RUN) {
  console.log(results.map((r) => `校验 ${r.file}: ${r.notes.join(', ')}`).join('\n'));
  console.log('\n✓ 全部锚点校验通过(未写盘)。');
  process.exit(0);
}

for (const r of results) {
  writeFileSync(r.abs, r.output, 'utf8');
}
console.log(results.map((r) => `已写入 ${r.file}: ${r.notes.join(', ')}`).join('\n'));
console.log('\n✓ 硬化版 Slice 3 全部编辑已应用。');