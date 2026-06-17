/**
 * 平铺会话时间线(flat transcript)的投影模型。
 *
 * 设计对齐 Zed `acp_thread::AgentThreadEntry`(UserMessage / AssistantMessage /
 * ToolCall / CompletedPlan / ContextCompaction):整条会话被拍扁成一串自上而下、
 * 按时间顺序排列的条目,每个条目类型独立渲染。工具调用条目持有协议 VM
 * `IAiThreadToolCall`(对标 Zed `ToolCall`),渲染所需的派生信息(图标 / 展示态 /
 * 终端输出 / diff 行数)由 `toAiThreadToolView` 投影,不回灌污染协议契约。
 *
 * 本模型是纯 UI 投影:不改动任何 wire schema,字段全部从既有的 `IAiChatMessage`
 * 推导而来。
 */
import type { IAiContextReference } from '@/types/ai/context';
import type { IAiAgentPatchSummary } from '@/types/ai/patch';
import type { IAiThreadToolCall } from '@/types/ai/thread';

import type { IAiThreadTerminalSnapshot } from './tool-view';

/** Plan 控制条目的阶段。控制条作为时间线中的一条普通条目呈现,而非独立仪表盘。 */
export type TAiThreadPlanPhase = 'awaiting-approval' | 'running';

interface IAiThreadEntryBase {
  /** 全局唯一且稳定的条目 id;用于 v-for key 与逐条展开状态记忆。 */
  id: string;
  /** 来源消息 id;便于回溯、事件透传与按消息分组。 */
  messageId: string;
}

/** 用户消息条目。 */
export interface IAiThreadUserMessageEntry extends IAiThreadEntryBase {
  kind: 'user-message';
  markdown: string;
  references: IAiContextReference[];
}

/** 助手最终文本回复条目(对应 Zed AssistantMessage 的文本块)。 */
export interface IAiThreadAssistantTextEntry extends IAiThreadEntryBase {
  kind: 'assistant-text';
  markdown: string;
  /** 来源消息是否正在流式输出;渲染层据此实现“流式展开,完成后自动折叠”。 */
  streaming: boolean;
}

/** 推理(thinking)条目(对应 Zed AssistantMessage 的 Thought 块)。 */
export interface IAiThreadReasoningEntry extends IAiThreadEntryBase {
  kind: 'reasoning';
  segments: string[];
  isLong: boolean;
  /** 来源消息是否正在流式输出;渲染层据此实现“流式展开,完成后自动折叠”。 */
  streaming: boolean;
}

/**
 * 工具调用条目(对应 Zed ToolCall);持有协议 VM,默认折叠。
 *
 * 渲染契约:`.vue` 经 `toAiThreadToolView(toolCall, { resolveTerminal,
 * isAwaitingApproval })` 派生渲染视图。`terminals` 是本条目铸造的终端快照
 * (键 = `toolCall.content` 中引用的 terminalId);`awaiting` 为 Mastra HITL 等待
 * 决策标志,渲染层据此派生 `awaiting-confirmation`(协议状态集不含该态,不臆造)。
 */
export interface IAiThreadToolCallEntry extends IAiThreadEntryBase {
  kind: 'tool-call';
  toolCall: IAiThreadToolCall;
  terminals: Record<string, IAiThreadTerminalSnapshot>;
  awaiting: boolean;
}

/**
 * Plan 审批 / 运行控制条目。并入时间线,像一条普通消息一样自上而下出现,而不是
 * 独立的执行仪表盘(对应用户要求,也对齐 Zed 把 plan 作为 entry 的取向)。
 */
export interface IAiThreadPlanControlEntry extends IAiThreadEntryBase {
  kind: 'plan-control';
  goal: string;
  references: IAiContextReference[];
  phase: TAiThreadPlanPhase;
}

/** 上下文整理条目(对应 Zed ContextCompaction)。 */
export interface IAiThreadContextCompactionEntry extends IAiThreadEntryBase {
  kind: 'context-compaction';
  text: string;
}

/** 改动文件汇总条目(末尾汇总;具体 diff 行内联在对应工具调用条目里)。 */
export interface IAiThreadChangedFilesSummaryEntry extends IAiThreadEntryBase {
  kind: 'changed-files-summary';
  summary: IAiAgentPatchSummary;
}

/** 平铺时间线条目联合体。 */
export type TAiThreadEntry =
  | IAiThreadUserMessageEntry
  | IAiThreadAssistantTextEntry
  | IAiThreadReasoningEntry
  | IAiThreadToolCallEntry
  | IAiThreadPlanControlEntry
  | IAiThreadContextCompactionEntry
  | IAiThreadChangedFilesSummaryEntry;

export type TAiThreadEntryKind = TAiThreadEntry['kind'];
