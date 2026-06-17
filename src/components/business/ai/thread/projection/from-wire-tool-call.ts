/**
 * Wire 工具调用 → 协议 VM 适配器(ADR-20260617 B 方案,slice 5c)。
 *
 * 适用于无运行时事件且非 ACP 的 chat / 旧 sidecar 路径:assistant 消息上的
 * `message.toolCalls`(`IAiToolCall`)直接映射为协议 VM `IAiThreadToolCall`,与
 * runtime / ACP 两路汇流到同一渲染投影。
 *
 * wire 工具调用不携带内联内容 / 终端 / diff(那些属于运行时与 ACP 源),故
 * `content` 恒为空;返回纯 `IAiThreadToolCall`(无终端可铸 / 无等待态)。
 *
 * 设计取舍:
 * - kind:wire 仅有 `name`,经 `classifyRuntimeToolKind` 得 runtime kind 再经
 *   `RUNTIME_KIND_TO_TOOL_KIND` 收敛(与 runtime 路径同表),图标由 kind 派生。
 * - title:`summary` 非空则用之,否则回退到工具名。退役 buildZedToolLabel
 *   从参数反解启发式标题。
 * - status:wire 独有 `denied` 按 Zed 语义归为 `canceled`(协议状态集不含
 *   denied;用户拒绝近于"未执行而取消",非"执行出错")。
 */
import { classifyRuntimeToolKind } from '@/constants/ai/runtime-tools';
import type { IAiToolCall } from '@/types/ai';
import type { IAiThreadToolCall, TAiThreadToolCallStatus } from '@/types/ai/thread';

import { RUNTIME_KIND_TO_TOOL_KIND } from './tool-kind';

/** wire 工具状态 → 协议工具状态。denied → canceled(Zed 无独立 denied 态)。 */
const WIRE_STATUS_TO_TOOL_STATUS: Record<IAiToolCall['status'], TAiThreadToolCallStatus> = {
  pending: 'pending',
  running: 'in_progress',
  succeeded: 'completed',
  failed: 'failed',
  denied: 'canceled',
};

export interface IFromWireToolCallOptions {
  /** 协议 VM 必填的创建时间;wire 工具调用无时间戳,由来源消息时间注入。 */
  createdAt: string;
}

/** 把 wire 工具调用投影为协议工具调用。纯函数,可独立单测。 */
export const fromWireToolCall = (
  toolCall: IAiToolCall,
  options: IFromWireToolCallOptions,
): IAiThreadToolCall => {
  const summary = toolCall.summary.trim();
  return {
    type: 'tool_call',
    id: toolCall.id,
    createdAt: options.createdAt,
    title: summary.length > 0 ? summary : toolCall.name,
    kind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(toolCall.name)],
    status: WIRE_STATUS_TO_TOOL_STATUS[toolCall.status],
    content: [],
  };
};
