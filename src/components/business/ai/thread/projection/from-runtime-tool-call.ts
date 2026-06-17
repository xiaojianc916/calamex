/**
 * 运行时任务节点 → 协议 VM 适配器(ADR-20260617 B 方案,slice 5b)。
 *
 * Mastra 运行时把工具活动表达为 `ITaskNodeItem`(已含图标 / 中文文案 / 终端重建
 * 等复杂派生)。本纯函数把它收敛到协议 VM `IAiThreadToolCall`(对标 Zed
 * `ToolCall`),与 ACP 路径(from-acp-*)汇流到同一渲染投影 `toAiThreadToolView`,
 * 从而退役旧渲染 VM。
 *
 * 设计取舍(对齐 Zed,不自创启发式):
 * - 图标由 `kind` 派生:协议 VM 不持 toolName,kind 驱动是唯一干净解,且与 ACP
 *   路径一致;故此处只需把 runtime kind 收敛到协议 ToolKind(见 tool-kind)。
 * - 标题取 `node.action`:运行时 presenter 产出的单段中文文案已折入资源名,直接
 *   作为 Zed `label`,不再从 rawInput 反解动词 / 参数(退役 buildZedToolLabel)。
 * - 终端:运行时把输出内联在节点上,这里改注册到终端快照表(键 `${id}:terminal`),
 *   协议 content 仅持引用,与 Zed `Terminal` 实体一致,亦对接 D7 终端流。
 * - 等待决策(Mastra HITL)经 `awaiting` 标志上抛,由渲染层派生
 *   `awaiting-confirmation`,不臆造协议状态(Zed 等待权限时工具停在 pending)。
 */
import {
  type ITaskNodeItem,
  type TTaskStatus,
  WAITING_DECISION_LABEL,
} from '@/components/business/ai/plan/runtime-timeline';
import type {
  IAiThreadToolCall,
  IAiThreadToolCallContent,
  TAiThreadToolCallStatus,
} from '@/types/ai/thread';

import { RUNTIME_KIND_TO_TOOL_KIND } from './tool-kind';
import type { IAiThreadTerminalSnapshot } from './tool-view';

/** runtime 任务状态 → 协议工具状态(runtime 无 canceled)。 */
const RUNTIME_STATUS_TO_TOOL_STATUS: Record<TTaskStatus, TAiThreadToolCallStatus> = {
  pending: 'pending',
  running: 'in_progress',
  succeeded: 'completed',
  failed: 'failed',
};

const isNonEmpty = (value: string | undefined): value is string => Boolean(value?.trim());

/** Mastra 等待决策:节点处于 shimmer 且文案为等待标签(对应 Zed WaitingForConfirmation)。 */
const isAwaitingDecision = (node: ITaskNodeItem): boolean =>
  node.shimmerAction === true && node.action === WAITING_DECISION_LABEL;

export interface IFromRuntimeToolCallOptions {
  /** 协议 VM 必填的创建时间;运行时节点无时间戳,由来源消息时间注入(不臆造)。 */
  createdAt: string;
}

export interface IRuntimeToolCallProjection {
  toolCall: IAiThreadToolCall;
  /** 本次调用铸造的终端快照(键 = content 中引用的 terminalId)。 */
  terminals: Record<string, IAiThreadTerminalSnapshot>;
  /** Mastra 等待决策态:由渲染层据此派生 awaiting-confirmation。 */
  awaiting: boolean;
}

/** 把运行时任务节点投影为协议工具调用 + 终端快照 + 等待态。纯函数,可独立单测。 */
export const fromRuntimeToolCall = (
  node: ITaskNodeItem,
  options: IFromRuntimeToolCallOptions,
): IRuntimeToolCallProjection => {
  const id = node.toolUseId ?? node.id;
  const terminals: Record<string, IAiThreadTerminalSnapshot> = {};
  const content: IAiThreadToolCallContent[] = [];

  if (isNonEmpty(node.terminalOutput)) {
    const terminalId = `${id}:terminal`;
    terminals[terminalId] = {
      title: node.terminalTitle ?? 'Terminal',
      output: node.terminalOutput,
      streaming: node.terminalStreaming ?? false,
    };
    content.push({ type: 'terminal', terminalId });
  }

  for (const source of node.webSearchSources ?? []) {
    content.push({
      type: 'content',
      block: { type: 'source', url: source.url, title: source.displayUrl },
    });
  }

  const toolCall: IAiThreadToolCall = {
    type: 'tool_call',
    id,
    createdAt: options.createdAt,
    title: node.action,
    kind: RUNTIME_KIND_TO_TOOL_KIND[node.kind],
    status: RUNTIME_STATUS_TO_TOOL_STATUS[node.status],
    content,
    ...(isNonEmpty(node.rawInput) ? { rawInput: node.rawInput } : {}),
    ...(isNonEmpty(node.rawOutput) ? { rawOutput: node.rawOutput } : {}),
  };

  return { toolCall, terminals, awaiting: isAwaitingDecision(node) };
};
