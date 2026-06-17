/* ============================================================================
 * ACP UI 事件流 → 协议 VM 工具调用累加器（ADR-20260617）
 *
 * 在 `reduceAcpToolCall`（单条 ACP update → `IAiThreadToolCall`）之上的**折叠层**：
 * 把与 Mastra `agent_event` 平级的「第二语言」——`TAgentUiEvent` 中的
 * `tool_call` / `tool_call_update`（负载以 `acpUpdate` 整体挂载，见
 * `@/types/ai/sidecar`）——按 ACP `toolCallId` 收敛成一条**有序**的
 * `IAiThreadToolCall[]`，供 `build-thread-entries` / 渲染层消费。
 *
 * 设计：
 *  ① **不可变**：`applyAcpUiEvent` 返回新累加器；非 ACP 事件 / 缺 `toolCallId` 时
 *     原样返回同一引用（便于 Vue 响应与 `reconcile-thread-entries` 的结构共享/memo）。
 *  ② **createdAt 稳定**：首次见到某 `toolCallId` 时由 `reduceAcpToolCall` 赋値，
 *     后续合并保留（所以生产环节要持久化同一累加器、增量 apply，而非每帧重建）。
 *  ③ **保序**：`order` 记录首次出现顺序；后续 update 不重排。
 *
 * 不伪造 Mastra 遥测 base 字段；不抢占 Mastra 路径（`runtimeEvents` / `message.toolCalls`
 * 依旧）。纯函数，不改入参。
 * ========================================================================== */

import type { TAcpToolCall, TAcpToolCallUpdate } from '@/types/ai/acp-tool-call';
import type { TAgentUiEvent } from '@/types/ai/sidecar';
import type { IAiThreadToolCall } from '@/types/ai/thread';
import type { IReduceAcpToolCallOptions } from './from-acp-tool-call';
import { getAcpToolCallId, reduceAcpToolCall } from './from-acp-tool-call';

type TAcpToolCallUiEvent = Extract<TAgentUiEvent, { type: 'tool_call' | 'tool_call_update' }>;

const isAcpToolCallUiEvent = (event: TAgentUiEvent): event is TAcpToolCallUiEvent =>
  event.type === 'tool_call' || event.type === 'tool_call_update';

const getAcpUpdate = (event: TAcpToolCallUiEvent): TAcpToolCall | TAcpToolCallUpdate =>
  event.acpUpdate;

/** 按 `toolCallId` 收敛的不可变累加器状态。 */
export interface IAcpToolCallAccumulator {
  /** 首次出现顺序的 toolCallId 列表。 */
  readonly order: readonly string[];
  /** toolCallId → 当前归并结果。 */
  readonly byId: ReadonlyMap<string, IAiThreadToolCall>;
}

/** 创建空累加器（生产环节：每会话 / 每消息一个，随流增量 apply）。 */
export const createAcpToolCallAccumulator = (): IAcpToolCallAccumulator => ({
  order: [],
  byId: new Map(),
});

/**
 * 应用单条 UI 事件。非 ACP 工具事件、或缺 `toolCallId` 时原样返回同一引用（no-op）。
 * 否则返回一个新累加器，不修改入参。
 */
export const applyAcpUiEvent = (
  accumulator: IAcpToolCallAccumulator,
  event: TAgentUiEvent,
  options?: IReduceAcpToolCallOptions,
): IAcpToolCallAccumulator => {
  if (!isAcpToolCallUiEvent(event)) {
    return accumulator;
  }
  const update = getAcpUpdate(event);
  const id = getAcpToolCallId(update);
  if (id === '') {
    return accumulator;
  }
  const previous = accumulator.byId.get(id);
  const reduced = reduceAcpToolCall(previous, update, options);
  const byId = new Map(accumulator.byId);
  byId.set(id, reduced);
  const order = previous === undefined ? [...accumulator.order, id] : accumulator.order;
  return { order, byId };
};

/** 累加器 → 按首次出现顺序的 `IAiThreadToolCall[]`。 */
export const selectAcpToolCalls = (accumulator: IAcpToolCallAccumulator): IAiThreadToolCall[] => {
  const calls: IAiThreadToolCall[] = [];
  for (const id of accumulator.order) {
    const call = accumulator.byId.get(id);
    if (call !== undefined) {
      calls.push(call);
    }
  }
  return calls;
};

/**
 * 一次性折叠（供非流式响应投影 / 单测）：对一批 UI 事件按 `toolCallId` 归并。
 * 注意：传入统一的 `options.now` 以保证本次折叠内 `createdAt` 一致；流式场景应
 * 用增量 `applyAcpUiEvent` 保持跨帧稳定。
 */
export const reduceAcpUiEventsToToolCalls = (
  events: readonly TAgentUiEvent[],
  options?: IReduceAcpToolCallOptions,
): IAiThreadToolCall[] => {
  let accumulator = createAcpToolCallAccumulator();
  for (const event of events) {
    accumulator = applyAcpUiEvent(accumulator, event, options);
  }
  return selectAcpToolCalls(accumulator);
};
