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
import type { TAcpToolCall, TAcpToolCallUpdate } from '@/types/ai/acp-tool-call';
import type { IAiContextReference } from '@/types/ai/context';
import type {
  IAiThreadChangedFilesEntry,
  IAiThreadContentBlock,
  IAiThreadPlanControlEntry,
  IAiThreadPlanEntry,
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
 * - `plan_updated` → 按 id upsert plan entry（整体替换 steps，位置稳定）
 * - `plan_control_updated` → 按 id upsert plan_control entry（替换 goal/phase/references，位置稳定）
 * - `context_compaction` → 追加 context_compaction entry
 */
export type TAiThreadReduceEvent =
  | {
      kind: 'user_message';
      id: string;
      createdAt: string;
      blocks: IAiThreadContentBlock[];
      references?: IAiContextReference[];
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
      kind: 'assistant_tool_call';
      messageId: string;
      createdAt: string;
      update: TAcpToolCall | TAcpToolCallUpdate;
    }
  | {
      kind: 'tool_started';
      id: string;
      createdAt: string;
      title: string;
      /** 工具原始名（raw toolName）：渲染层 name 用它，区别于语义化展示 title。 */
      name?: string;
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
      /** 完成阶段的展示标题（presenter「已完成 / 失败」措辞）；缺省则沿用 tool_started 标题。 */
      title?: string;
      appendContent?: IAiThreadToolCallContent[];
    }
  | { kind: 'tool_canceled'; id: string }
  | {
      kind: 'plan_updated';
      id: string;
      createdAt: string;
      steps: IAiThreadPlanEntry['steps'];
    }
  | {
      kind: 'plan_control_updated';
      id: string;
      createdAt: string;
      goal: string;
      references?: IAiContextReference[];
      phase: IAiThreadPlanControlEntry['phase'];
    }
  | {
      kind: 'context_compaction';
      id: string;
      createdAt: string;
      message?: string;
    }
  | {
      kind: 'changed_files';
      id: string;
      createdAt: string;
      summary: IAiThreadChangedFilesEntry['summary'];
    }
  | { kind: 'stream_completed' }
  | { kind: 'stream_cancelled' }
  | { kind: 'stream_error'; message: string };

/** 按 `kind` 字面量取窄类型。 */
export type TAiThreadReduceEventByKind<TKind extends TAiThreadReduceEvent['kind']> = Extract<
  TAiThreadReduceEvent,
  { kind: TKind }
>;
