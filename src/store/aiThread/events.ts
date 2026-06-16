/* ============================================================================
 * AI Thread reduce 事件（ADR-0013）
 *
 * 这是 reduce 层的输入：ACP `SessionUpdate` / 边车运行时事件的“前端
 * 规范化镜像”。边车监听层（ADR-0014 Step 5）负责把 `TAgentUiEvent` /
 * `TAgentRuntimeEvent` 映射为本处的规范化事件，再喂给纯函数 reducer。
 *
 * 为什么是手写联合而非 Zod：该类型是纯前端内部边界（不跨 IPC /
 * event wire），与 `TAgentUiEvent` 同性质，按项目惯例不为内部类型建 schema。
 * ========================================================================== */
import type {
  IAiThreadContentBlock,
  IAiThreadToolCallContent,
  TAiThreadToolKind,
} from '@/types/ai/thread';

/** 线程级流式状态（由 store 层持有，不进持久化 Thread）。 */
export type TAiThreadStreamStatus = 'idle' | 'streaming' | 'completed' | 'cancelled' | 'error';

/** 助手消息通道：正文 / 思维链。 */
export type TAiAssistantChannel = 'message' | 'thought';

/**
 * 规范化 reduce 事件联合。语义对齐 Zed session-update 分发：
 * - `assistant_delta` → push_assistant_content_block(content, channel==='thought')
 * - `tool_*` → upsert_tool_call(按 id)
 */
export type TAiThreadReduceEvent =
  | {
      kind: 'user_message';
      id: string;
      createdAt: string;
      blocks: IAiThreadContentBlock[];
    }
  | {
      kind: 'assistant_delta';
      messageId: string;
      createdAt: string;
      channel: TAiAssistantChannel;
      text: string;
    }
  | {
      kind: 'assistant_block';
      messageId: string;
      createdAt: string;
      channel: TAiAssistantChannel;
      block: IAiThreadContentBlock;
    }
  | {
      kind: 'tool_started';
      id: string;
      createdAt: string;
      title: string;
      toolKind: TAiThreadToolKind;
      status?: 'pending' | 'in_progress';
    }
  | {
      kind: 'tool_progress';
      id: string;
      appendContent?: IAiThreadToolCallContent[];
    }
  | {
      kind: 'tool_completed';
      id: string;
      ok: boolean;
      appendContent?: IAiThreadToolCallContent[];
    }
  | { kind: 'tool_canceled'; id: string }
  | { kind: 'stream_completed' }
  | { kind: 'stream_cancelled' }
  | { kind: 'stream_error'; message: string };

/** 按 `kind` 字面量取窄类型。 */
export type TAiThreadReduceEventByKind<TKind extends TAiThreadReduceEvent['kind']> = Extract<
  TAiThreadReduceEvent,
  { kind: TKind }
>;
