/* ============================================================================
 * 边车 UI 事件 → 实时 IAiThread 组装（ADR-0014 Step 5b，纯函数）
 *
 * 把「本回合到目前为止的全部 TAgentUiEvent」叠加到一个基线 thread 之上，得到
 * 流式进行中的 IAiThread 投影：先经 5a 的 sidecarEventToReduceEvents 把每条边车
 * 事件规范化为 0..n 条 reduce 事件，再交给纯函数 reduceThreadAll 回放。
 *
 * 设计取舍：
 * - baseThread 由监听层在回合开始时快照（含此前消息 + 本回合 user message；空的
 *   assistant 占位不产生 entry），故组装结果是「完整线程」，可直接覆盖 store 的
 *   liveThread（activeThread = liveThread ?? 旧投影）。
 * - 累计事件整份重放：reduceThread 结构共享、按 id upsert，重放幂等，未变 entry
 *   保持原引用，契合渲染层稳定 key。
 * - 纯函数、无 I/O、无副作用、不订阅：接线（设置 liveThread / 翻 renderFromEntries）
 *   留待 5b 监听层一刀，便于独立单测与回退。
 * ========================================================================== */
import { sidecarEventToReduceEvents } from '@/components/business/ai/thread/projection';
import { reduceThreadAll } from '@/store/aiThread/reduce';
import type { TAgentUiEvent } from '@/types/ai/sidecar';
import type { IAiThread } from '@/types/ai/thread';

export interface IBuildLiveThreadOptions {
  /** 回合开始时快照的基线线程（此前消息 + 本回合 user message）。 */
  baseThread: IAiThread;
  /** 本回合 assistant 消息 id（正文与思维链共用，同监听层占位消息 id）。 */
  assistantMessageId: string;
  /** 顶层无内联时间戳事件（message_delta / done / error）的 createdAt（ISO）。 */
  now?: string;
}

/**
 * 把本回合累计边车事件叠加到基线线程，得到流式进行中的 IAiThread。
 * 纯函数：不修改入参、无副作用；空事件（或全部不被消费）时原样返回 baseThread。
 */
export const buildLiveThreadFromSidecarEvents = (
  events: readonly TAgentUiEvent[],
  options: IBuildLiveThreadOptions,
): IAiThread => {
  const now = options.now ?? new Date().toISOString();
  // 去重：同名工具若已有运行时遥测（agent.tool.*），丢弃旧粗粒度 tool_start/tool_result，
  // 避免同一工具产生重复 tool_call 条目（运行时通路语义更全，优先保留）。
  const runtimeToolNames = new Set<string>();
  for (const event of events) {
    if (event.type !== 'agent_event') {
      continue;
    }
    const runtime = event.event;
    if (
      runtime.type === 'agent.tool.started' ||
      runtime.type === 'agent.tool.completed' ||
      runtime.type === 'agent.tool.progress'
    ) {
      if (typeof runtime.toolName === 'string' && runtime.toolName.length > 0) {
        runtimeToolNames.add(runtime.toolName);
      }
    }
  }
  const reduceEvents = events.flatMap((event) => {
    if (
      (event.type === 'tool_start' || event.type === 'tool_result') &&
      runtimeToolNames.has(event.toolName)
    ) {
      return [];
    }
    return sidecarEventToReduceEvents(event, {
      now,
      assistantMessageId: options.assistantMessageId,
    });
  });
  return reduceThreadAll(options.baseThread, reduceEvents);
};
