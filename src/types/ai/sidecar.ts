import type { IAiLanguageModelUsage } from '@/types/ai';
import type { TAcpPlan, TAcpToolCall, TAcpToolCallUpdate } from '@/types/ai/acp-tool-call';
import type { IAiContextReference } from '@/types/ai/context';

/* ============================================================================
 * Mode / role / status enums
 * ========================================================================== */

export const BUILTIN_AGENT_MODES = ['ask', 'plan', 'agent', 'patch', 'review'] as const;
export type TAgentSidecarMode = (typeof BUILTIN_AGENT_MODES)[number];

export type TAgentSidecarMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export const AGENT_PLAN_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'completed',
  'failed',
] as const;
export type TAgentPlanStatus = (typeof AGENT_PLAN_STATUSES)[number];

/**
 * JSON-safe value. 用于 tool input / output 透传。
 *
 * 注意:object 子类型为 `readonly`,但 array 子类型不是 readonly,这是有意的:
 * tool calls 内部常常需要原地构造 list payload(`as TJsonValue`)。如果未来发现
 * caller 端有突变 array 的代码(常见 bug 源),可以收紧成 `readonly TJsonValue[]`。
 */
export type TJsonValue =
  | string
  | number
  | boolean
  | null
  | TJsonValue[]
  | { readonly [key: string]: TJsonValue };

/* ============================================================================
 * Base shapes
 * ========================================================================== */

export interface IAgentSidecarMessage {
  role: TAgentSidecarMessageRole;
  content: string;
}

export interface IAgentSidecarModelConfig {
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}

/* ============================================================================
 * Plan
 * ========================================================================== */

export type TAgentPlanStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type TAgentPlanStepRiskLevel = 'low' | 'medium' | 'high';

export interface IAgentPlanStep {
  id: string;
  title: string;
  goal: string;
  description?: string;
  status: TAgentPlanStepStatus;
  tools: string[];
  files?: string[];
  commands?: string[];
  risks?: string[];
  acceptanceCriteria?: string[];
  riskLevel: TAgentPlanStepRiskLevel;
  requiresApproval: boolean;
  expectedOutput: string;
}

export interface IAgentPlan {
  goal: string;
  summary?: string;
  requiresApproval?: boolean;
  steps: IAgentPlanStep[];
}

export interface IAgentPlanRecord {
  planId: string;
  threadId: string;
  version: number;
  status: TAgentPlanStatus;
  userRequest: string;
  plan: IAgentPlan;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  rejectionReason: string | null;
  errorMessage: string | null;
}

/* ============================================================================
 * Approval / diff
 * ========================================================================== */

export type TToolRiskLevel = 'low' | 'medium' | 'high';

export interface IApprovalRequest {
  id: string;
  toolName: string;
  question: string;
  summary: string;
  riskLevel: TToolRiskLevel;
  reversible: boolean;
  createdAt: string;
}

/**
 * Unified diff hunk. 与 `@/types/ai.ts.IAiPatchHunk` 形状相同,但语义不同:
 * - `IAiPatchHunk` 是 AI 代码生成的 patch hunk(走 apply patch flow)
 * - `IAgentDiffHunk` 是 agent 工具(如 file edit tool)反馈的实际 diff 预览
 *
 * 形状保持兼容,以便互相 cast。
 */
export interface IAgentDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface IDiffFile {
  path: string;
  hunks: IAgentDiffHunk[];
}

/* ============================================================================
 * Ask-user (reverse questioning / Human-in-the-Loop)
 *
 * 前端镜像 builtin-agent `schemas/events.ts` 的 askUser* wire schema,作为单一来源
 * (single source of truth):ask_user 工具挂起时,后端把 askUserRequestSchema 负载随
 * `ask_user_required` UI 事件写进响应信封;前端据此渲染 QuestionPrompt,用户作答后经
 * 扩展方法 `calamex.dev/agent/ask-user/resume` 回灌 outcome + 结构化 answers,续跑同一回合。
 *
 * 取长补短(与组件层 question/types.ts 的设计注记同源):
 * - 问题结构(header / question / type / options / multiSelect / placeholder)取自
 *   Gemini CLI ask_user(google-gemini/gemini-cli, packages/core/src/tools/ask-user.ts);
 * - 结果形态(outcome: 'selected' | 'cancelled' + 每选项稳定 optionId)取自 ACP
 *   request_permission(agentclientprotocol.com/protocol/tool-calls),与本仓库
 *   acp/approval-bridge.ts 的 allow-once / reject-once 同源。
 *
 * 组件层 `@/components/ai-elements/question/types.ts` 从本文件 re-export 这些类型,
 * 不再重复定义(避免双 SoT / 新旧杂糟)。
 * ========================================================================== */

/** Gemini ask_user 的问题类型(QuestionType)。 */
export type TQuestionType = 'choice' | 'text' | 'yesno';

/** ACP RequestPermissionOutcome 的判别值。 */
export type TAskUserOutcome = 'selected' | 'cancelled';

/**
 * 单个候选项。
 * - `optionId` 取自 ACP PermissionOption.optionId:稳定标识,原样回传到答案。
 * - `label` / `description` 取自 Gemini QuestionOption:label 为 1-5 词短标签,
 *   description 为简短补充说明。
 */
export interface IQuestionOption {
  optionId: string;
  label: string;
  description?: string;
}

export interface IAskUserQuestion {
  /** 稳定标识,原样回传到对应答案的 questionId。 */
  questionId: string;
  /** 完整问题文本(Gemini: question)。 */
  question: string;
  /** ≤16 字符的 chip 短标签(Gemini: header)。 */
  header: string;
  /** choice(默认)| text | yesno(Gemini: type)。 */
  type: TQuestionType;
  /** choice 型必填,2-4 项;text / yesno 型忽略(Gemini: options)。 */
  options?: IQuestionOption[];
  /** 仅 choice 型有效:true => 多选(checkbox);否则单选(radio)(Gemini: multiSelect)。 */
  multiSelect?: boolean;
  /**
   * 自由填写输入框的占位提示(Gemini: placeholder)。
   * - text 型:作为唯一输入框的提示。
   * - choice / yesno 型:作为选项列表底部「Other」输入框的提示。
   */
  placeholder?: string;
}

export interface IAskUserRequest {
  kind: 'user_question';
  /** 1-4 个问题(对齐 Gemini ask_user 上限)。 */
  questions: IAskUserQuestion[];
}

/** 单题作答。 */
export interface IQuestionAnswer {
  questionId: string;
  /** 已选 optionId(单选时 0-1 个;text 型恒为空)。 */
  optionIds: string[];
  /** 自由填写文本:text 型答案,或 choice/yesno 的「Other」输入(无则省略)。 */
  text?: string;
}

/**
 * 恢复(resume)时上抛的结果,形态对齐 ACP RequestPermissionOutcome:
 * - outcome: 'cancelled'(用户 Esc / 当前回合被取消)=> answers 省略。
 * - outcome: 'selected' => answers 为每题作答。
 */
export interface IAskUserResult {
  outcome: TAskUserOutcome;
  answers?: IQuestionAnswer[];
}

/* ============================================================================
 * Runtime events (backend → frontend, manual discriminated union)
 *
 * ⚠️ 这是高漂移风险区域。新增事件类型务必同步更新:
 *    1. `AGENT_RUNTIME_EVENT_TYPES` 常量
 *    2. 对应 `IAgentXxxEvent` interface
 *    3. `TAgentRuntimeEvent` union
 *    4. backend runtime event contract
 *    5. zod schema runtime base validation
 * ========================================================================== */

export const AGENT_RUNTIME_EVENT_SCHEMA_VERSION = 1 as const;

export const AGENT_RUNTIME_EVENT_TYPES = [
  'agent.run.started',
  'agent.text.delta',
  'agent.reasoning.delta',
  'agent.model.started',
  'agent.model.completed',
  'agent.tool.started',
  'agent.tool.progress',
  'agent.tool.completed',
  'acontext.envelope.injected',
  'acontext.envelope.replaced',
  'acontext.token.checked',
  'acontext.provider_payload.checked',
  'acontext.tool_summary.recorded',
  'acontext.memory.compressed',
  'acontext.context_compaction.started',
  'acontext.context_compaction.updated',
  'acontext.context_compaction.completed',
  'rollback.checkpoint.created',
  'rollback.checkpoint.failed',
  'rollback.restore.started',
  'rollback.restore.completed',
  'rollback.restore.failed',
  'side_effect.recorded',
  'side_effect.warning',
  'agent.message.added',
  'agent.run.completed',
  'agent.run.error',
  'agent.debug',
] as const;

export type TAgentRuntimeEventType = (typeof AGENT_RUNTIME_EVENT_TYPES)[number];

export type TAgentRuntimeVisibility = 'user' | 'debug';
export type TAgentRuntimeLevel = 'debug' | 'info' | 'warn' | 'error';
export type TContextBudgetDecisionKind =
  | 'within_budget'
  | 'compact_recommended'
  | 'warn_context_limit';
export type TContextManagementOwner =
  | 'mastra_memory'
  | 'zed_style_compaction'
  | 'runtime_warning'
  | 'none';
export type TContextCompactionReason = 'budget' | 'manual' | 'provider_native';

export interface IAgentRuntimeEventBase {
  id: string;
  type: TAgentRuntimeEventType;
  runId: string;
  sessionId: string;
  agentId: string;
  timestamp: string;
  seq: number;
  /**
   * 当前协议版本固定为 `1`。未来发布 v2 时,需要把这里改成
   * `1 | 2` 联合并在每个 event 上分别打 schemaVersion 区分。
   */
  schemaVersion: typeof AGENT_RUNTIME_EVENT_SCHEMA_VERSION;
  redacted: true;
  visibility: TAgentRuntimeVisibility;
  level?: TAgentRuntimeLevel;
  parentId?: string;
  spanId?: string;
  /**
   * Mastra 官方 trace id（来自 `agent.stream()` / `agent.generate()` 返回值）。
   * 仅在 Mastra 提供时存在；前端可用于深链到 observability 平台。
   */
  traceId?: string;
}

export interface IAgentRunStartedEvent extends IAgentRuntimeEventBase {
  type: 'agent.run.started';
  inputPreview?: string;
}

export interface IAgentTextDeltaEvent extends IAgentRuntimeEventBase {
  type: 'agent.text.delta';
  text: string;
}

export interface IAgentReasoningDeltaEvent extends IAgentRuntimeEventBase {
  type: 'agent.reasoning.delta';
  text: string;
}

export interface IAgentModelStartedEvent extends IAgentRuntimeEventBase {
  type: 'agent.model.started';
  /** 仅在 Mastra 提供该字段时存在。可用性判定：`event.projectedInputTokens !== undefined`。 */
  projectedInputTokens?: number;
  /** @deprecated backend 不再发送；保留为 optional 以兼容旧会话快照。 */
  projectedInputTokensAvailable?: boolean;
}

export interface IAgentModelCompletedEvent extends IAgentRuntimeEventBase {
  type: 'agent.model.completed';
  ok: boolean;
  stopReason?: string;
  errorMessage?: string;
}

export interface IAgentToolStartedEvent extends IAgentRuntimeEventBase {
  type: 'agent.tool.started';
  toolUseId?: string;
  toolName: string;
  inputPreview?: string;
  riskLevel?: TToolRiskLevel;
}

export interface IAgentToolProgressEvent extends IAgentRuntimeEventBase {
  type: 'agent.tool.progress';
  toolUseId?: string;
  toolName?: string;
  /** Mastra 进度事件可能只是心跳;无 data 时该字段缺省。 */
  dataPreview?: string;
}

export interface IAgentToolCompletedEvent extends IAgentRuntimeEventBase {
  type: 'agent.tool.completed';
  toolUseId?: string;
  toolName: string;
  ok: boolean;
  resultPreview?: string;
  errorMessage?: string;
  /** Mastra `result.status` 的原始字符串（如 `'success'` / `'error'` / `'cancelled'`）。 */
  status?: string;
}

export interface IAgentAcontextEnvelopeEvent extends IAgentRuntimeEventBase {
  type: 'acontext.envelope.injected' | 'acontext.envelope.replaced';
  envelopeCharCount: number;
  systemPromptCharCount: number;
  injectedAt: 'beforeInvocation' | 'beforeModelCall';
}

export interface IAgentAcontextTokenEvent extends IAgentRuntimeEventBase {
  type: 'acontext.token.checked';
  /** 仅在估算可用时存在。 */
  projectedInputTokens?: number;
  /** @deprecated backend 不再发送；保留为 optional 以兼容旧会话快照。 */
  projectedInputTokensAvailable?: boolean;
  inputCharCount?: number;
  systemPromptCharCount?: number;
  messageCharCount?: number;
  contextCharCount?: number;
  toolSchemaCharCount?: number;
  toolCount?: number;
  mcpToolCount?: number;
  mcpServerCount?: number;
  mcpServerNames?: string[];
  uiContextToolCount?: number;
  nativeToolCount?: number;
  logToolCount?: number;
  toolLoadStrategy?: string;
  workspaceEnabled?: boolean;
  browserEnabled?: boolean;
  memoryEnabled?: boolean;
  observationalMemoryEnabled?: boolean;
  semanticRecallEnabled?: boolean;
  maxSteps?: number;
  toolChoice?: 'auto' | 'none';
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  availableInputTokens?: number;
  remainingInputTokens?: number;
  compactionRemainingTokenBudget?: number;
  compactionSupported?: boolean;
  contextBudgetDecision?: TContextBudgetDecisionKind;
  contextManagementOwner?: TContextManagementOwner;
  shouldRunZedStyleCompaction?: boolean;
  shouldRelyOnMastraMemory?: boolean;
  contextManagementReason?: string;
  retainedUserMessageByteBudget?: number;
  tokenEstimateMethod?: 'char_heuristic';
}

export interface IAgentAcontextProviderPayloadEvent extends IAgentRuntimeEventBase {
  type: 'acontext.provider_payload.checked';
  provider: 'deepseek';
  model?: string;
  stream?: boolean;
  requestIndex: number;
  requestBodyCharCount: number;
  projectedInputTokens: number;
  /** @deprecated backend 不再发送；保留为 optional 以兼容旧会话快照。 */
  projectedInputTokensAvailable?: true;
  messageCharCount: number;
  systemMessageCharCount: number;
  userMessageCharCount: number;
  assistantMessageCharCount: number;
  toolMessageCharCount: number;
  reasoningReplayCharCount: number;
  toolSchemaCharCount: number;
  toolCount: number;
  responseFormatCharCount: number;
  reasoningInjected: boolean;
  tokenEstimateMethod: 'char_heuristic';
}

export interface IAgentAcontextToolSummaryEvent extends IAgentRuntimeEventBase {
  type: 'acontext.tool_summary.recorded';
  toolName: string;
  summaryCharCount: number;
  largeResult: boolean;
}

export interface IAgentAcontextMemoryCompressedEvent extends IAgentRuntimeEventBase {
  type: 'acontext.memory.compressed';
  operationType: 'observation' | 'reflection';
  tokensActivated?: number;
  observationTokens?: number;
  messagesActivated?: number;
  chunksActivated?: number;
  durationMs?: number;
  triggeredBy?: 'threshold' | 'ttl' | 'provider_change';
}

export interface IAgentAcontextContextCompactionStartedEvent extends IAgentRuntimeEventBase {
  type: 'acontext.context_compaction.started';
  compactionId: string;
  reason: TContextCompactionReason;
  sourceMessageCount?: number;
  projectedInputTokens?: number;
  remainingInputTokens?: number;
}

export interface IAgentAcontextContextCompactionUpdatedEvent extends IAgentRuntimeEventBase {
  type: 'acontext.context_compaction.updated';
  compactionId: string;
  summaryDeltaCharCount: number;
  summaryCharCount: number;
}

export interface IAgentAcontextContextCompactionCompletedEvent extends IAgentRuntimeEventBase {
  type: 'acontext.context_compaction.completed';
  compactionId: string;
  reason: TContextCompactionReason;
  summaryCharCount: number;
  retainedUserMessageByteBudget?: number;
  sourceMessageCount?: number;
}

export interface IAgentCheckpointEvent extends IAgentRuntimeEventBase {
  type: 'rollback.checkpoint.created' | 'rollback.checkpoint.failed';
  snapshotId?: string;
  reason?: string;
  errorMessage?: string;
}

export interface IAgentRollbackEvent extends IAgentRuntimeEventBase {
  type: 'rollback.restore.started' | 'rollback.restore.completed' | 'rollback.restore.failed';
  snapshotId?: string;
  savedAsLatest?: boolean;
  message?: string;
  errorMessage?: string;
}

export interface IAgentSideEffectEvent extends IAgentRuntimeEventBase {
  type: 'side_effect.recorded' | 'side_effect.warning';
  toolName: string;
  riskLevel: TToolRiskLevel;
  undoAvailable: boolean;
  message: string;
}

export interface IAgentMessageEvent extends IAgentRuntimeEventBase {
  type: 'agent.message.added';
  role?: string;
  messageKind?: string;
}

export interface IAgentRunCompletedEvent extends IAgentRuntimeEventBase {
  type: 'agent.run.completed';
  stopReason?: string;
  outputPreview?: string;
}

export interface IAgentRunErrorEvent extends IAgentRuntimeEventBase {
  type: 'agent.run.error';
  errorMessage: string;
}

export interface IAgentDebugEvent extends IAgentRuntimeEventBase {
  type: 'agent.debug';
  name: string;
  data?: Record<string, string | number | boolean | null>;
}

export type TAgentRuntimeEvent =
  | IAgentRunStartedEvent
  | IAgentTextDeltaEvent
  | IAgentReasoningDeltaEvent
  | IAgentModelStartedEvent
  | IAgentModelCompletedEvent
  | IAgentToolStartedEvent
  | IAgentToolProgressEvent
  | IAgentToolCompletedEvent
  | IAgentAcontextEnvelopeEvent
  | IAgentAcontextTokenEvent
  | IAgentAcontextProviderPayloadEvent
  | IAgentAcontextToolSummaryEvent
  | IAgentAcontextMemoryCompressedEvent
  | IAgentAcontextContextCompactionStartedEvent
  | IAgentAcontextContextCompactionUpdatedEvent
  | IAgentAcontextContextCompactionCompletedEvent
  | IAgentCheckpointEvent
  | IAgentRollbackEvent
  | IAgentSideEffectEvent
  | IAgentMessageEvent
  | IAgentRunCompletedEvent
  | IAgentRunErrorEvent
  | IAgentDebugEvent;

/**
 * 用于从 union 中按 `type` 字面量取窄类型,例如:
 *
 *     const e: TAgentRuntimeEventByType<'agent.tool.started'> = ...
 *     //   ^ IAgentToolStartedEvent
 */
export type TAgentRuntimeEventByType<TType extends TAgentRuntimeEventType> = Extract<
  TAgentRuntimeEvent,
  { type: TType }
>;

// 编译期穷尽性检查：事件常量数组与 discriminated union 任一边漏写都会编译失败。
type _MissingRuntimeEventInUnion = Exclude<TAgentRuntimeEventType, TAgentRuntimeEvent['type']>;
type _MissingRuntimeEventInArray = Exclude<TAgentRuntimeEvent['type'], TAgentRuntimeEventType>;
type _AssertRuntimeEventsExhaustive = [
  _MissingRuntimeEventInUnion,
  _MissingRuntimeEventInArray,
] extends [never, never]
  ? true
  : {
      missingInUnion: _MissingRuntimeEventInUnion;
      missingInArray: _MissingRuntimeEventInArray;
    };
const _assertRuntimeEventsExhaustive: _AssertRuntimeEventsExhaustive = true;
void _assertRuntimeEventsExhaustive;

/* ============================================================================
 * UI events (sidecar response stream)
 * ========================================================================== */

export type TAgentUiEventDone = {
  type: 'done';
  result: string;
  /** @deprecated 使用 `usage.inputTokens`(由 wire schema 派生)。 */
  inputTokens?: number;
  /** @deprecated 使用 `usage.outputTokens`(由 wire schema 派生)。 */
  outputTokens?: number;
  /** @deprecated 使用 `usage.totalTokens`(由 wire schema 派生)。 */
  totalTokens?: number;
  usage?: IAiLanguageModelUsage | null;
};

export type TAgentUiEventPlanReady = {
  type: 'plan_ready';
  planId: string;
  threadId?: string;
  version: number;
  status: TAgentPlanStatus;
  createdAt?: string;
  updatedAt?: string;
  approvedAt?: string | null;
  executedAt?: string | null;
  rejectionReason?: string | null;
  errorMessage?: string | null;
  plan: IAgentPlan;
};

/* ----------------------------------------------------------------------------
 * ACP-native 工具调用 UI 事件（ADR-20260617 · D1/D2）
 *
 * 与 Mastra 域的 `agent_event` 平级的「第二语言」：外部 ACP agent（如 Kimi）经
 * Rust host(`src-tauri/src/acp/ui_event.rs`) 最小透传，ACP `session/update` 的
 * `tool_call` / `tool_call_update` 原始负载以 `acpUpdate` 整体挂载，**不**伪造
 * Mastra 遥测 base 字段（runId / agentId / timestamp / seq / schemaVersion …）。
 * `acpUpdate` 直接复用 `@agentclientprotocol/sdk` 的 SessionUpdate 变体（见
 * `@/types/ai/acp-tool-call`）。前端 ACL 据此按 `toolCallId` 归一到 thread 协议 VM。
 * -------------------------------------------------------------------------- */
export type TAgentUiEventToolCall = {
  type: 'tool_call';
  acpUpdate: TAcpToolCall;
};

export type TAgentUiEventToolCallUpdate = {
  type: 'tool_call_update';
  acpUpdate: TAcpToolCallUpdate;
};

/* ----------------------------------------------------------------------------
 * ACP-native 计划 UI 事件（ADR-20260617 · D2）
 *
 * 与 tool_call 同源的「第二语言」：sidecar 把运行时 agent.plan.updated 投影为 ACP
 * session/update 的 plan 快照（见 builtin-agent/src/acp/from-runtime-event.ts），
 * Rust host(src-tauri/src/acp/ui_event.rs) 最小透传，plan 原始负载以 acpUpdate 整体
 * 挂载（**不**伪造 Mastra 信封 plan_ready/plan_record 的富字段）。acpUpdate 直接复用
 * @agentclientprotocol/sdk 的 SessionUpdate 'plan' 变体（见 @/types/ai/acp-tool-call）。
 * 每帧为全量快照；前端 ACL（projection/from-acp-plan）据此整体归一为 plan 步骤 VM。
 * -------------------------------------------------------------------------- */
export type TAgentUiEventPlan = {
  type: 'plan';
  acpUpdate: TAcpPlan;
};

/* ----------------------------------------------------------------------------
 * ACP 可用斜杠命令 VM（ADR-20260617 · D7-④）
 *
 * 投影 ACP session/update 的 available_commands_update（外部 agent 声明本会话可用的
 * 斜杠命令，见 Rust host src-tauri/src/acp/ui_event.rs）。事件逐字透传 ACP
 * availableCommands 原始数组（TJsonValue[]，不在 Rust 侧造结构），前端 ACL
 * （components/business/ai/thread/projection/from-acp-available-commands）归一为此
 * VM；UI 只消费该结构，不直接触碰 ACP 原始负载。
 * -------------------------------------------------------------------------- */
export interface IAcpAvailableCommand {
  name: string;
  description: string;
  /** ACP AvailableCommandInput.hint（非结构化输入提示），无则省略。 */
  inputHint?: string;
}

export interface IAcpAvailableCommandsState {
  commands: IAcpAvailableCommand[];
}

export type TAgentUiEventAvailableCommandsUpdate = {
  type: 'available_commands_update';
  /** ACP available_commands_update 的原始 availableCommands 数组，逐字透传，前端 ACL 归一。 */
  availableCommands: TJsonValue[];
};

/* ----------------------------------------------------------------------------
 * ACP 回合用量 UI 事件（ADR-20260617 · D7-⑦）
 *
 * 投影 ACP session/update 的 usage_update（外部 agent 上报本回合 token 用量，见 Rust host
 * src-tauri/src/acp/ui_event.rs）。事件逐字透传 ACP usage 原始对象（TJsonValue，不在 Rust
 * 侧解读/折算），前端 ACL（components/business/ai/thread/projection/from-acp-usage）经
 * aiLanguageModelUsageSchema safeParse 为共享 IAiLanguageModelUsage VM（与 done.usage 同一
 * SoT schema，避免双 SoT）；UI 只消费该结构，不直接触碰 ACP 原始负载。
 * -------------------------------------------------------------------------- */
export type TAgentUiEventUsageUpdate = {
  type: 'usage_update';
  /** ACP usage_update 的原始 usage 对象，逐字透传，前端 ACL 归一。 */
  usage: TJsonValue;
};

/* ----------------------------------------------------------------------------
 * ACP 会话配置项选择器 VM（ADR-20260617 · D7-③-c 扩展：config_options 协议）
 *
 * 投影 ACP session/new|load 的 configOptions（SessionConfigOption[]）与 session/update
 * 的 config_option_update（携带完整 configOptions 快照，非单值增量）。前端 ACL
 * （components/business/ai/thread/projection/from-acp-session-config-options）从
 * ai_get_session_config_options 的原始 configOptions 解析；config_option_update UI 事件
 * 以完整数组整体替换 state。VM 与 ACP wire 解耦：UI 只消费此结构，不直接触碰原始负载。
 *
 * 形状对齐 agent-client-protocol-schema 0.13.6 序列化 wire（camelCase）：
 *   SessionConfigOption = { id, name, description?, category?, type:'select', currentValue, options }
 *     （type/currentValue/options 来自 flatten 的 SessionConfigKind::Select）
 *   SessionConfigSelectOption = { value, name, description?, _meta? }
 *   SessionConfigSelectGroup  = { group, name, options[] }
 *   options 为 Ungrouped(SessionConfigSelectOption[]) | Grouped(SessionConfigSelectGroup[]) 联合；
 *     VM 将分组拍平为单一 options 列表，分组名记到 option.group。
 *   category 为 'mode' | 'model' | 'thought_level' | 自定义字符串；未知/缺省时省略。
 * -------------------------------------------------------------------------- */
export interface IAcpSessionConfigSelectOption {
  value: string;
  name: string;
  description?: string;
  /** 分组标签（来自 SessionConfigSelectGroup.name）；未分组时省略。 */
  group?: string;
}

export interface IAcpSessionConfigOption {
  id: string;
  name: string;
  description?: string;
  /** UX-only 语义类别：'mode' | 'model' | 'thought_level' | 自定义；未知/缺省时省略。 */
  category?: string;
  currentValue: string;
  options: IAcpSessionConfigSelectOption[];
}

/**
 * ACP 会话配置项发现状态(v3 · 唯一标准管线 / 判别式状态机)。
 *
 * 取代旧 `IAcpSessionConfigOptionsState`。配置项发现归一为单一事件驱动管线:
 * `ensure_session` 握手 + 统一 `config_option_update` 事件通道(握手快照 / 延迟通知 /
 * set 响应全集都汇入同一 sink),不再有 get 工作区与 host 轮询。UI 按此判别式渲染:
 * - idle:尚未发起握手。
 * - discovering:已握手,短等首帧 configOptions。
 * - unavailable:该 backend 不公示 configOptions(或握手失败);选择器锁定并给原因。
 * - ready:已拿到 configOptions 全集(可能为空数组 = 已公示但无可选项)。
 */
export type TAcpSessionConfigOptions =
  | { kind: 'idle' }
  | { kind: 'discovering' }
  | { kind: 'unavailable'; reason: string; message?: string }
  | { kind: 'ready'; configOptions: IAcpSessionConfigOption[] };

export type TAgentUiEventConfigOptionUpdate = {
  type: 'config_option_update';
  /** ACP config_option_update 的原始 configOptions 数组（完整快照），逐字透传，前端 ACL 归一。 */
  configOptions: TJsonValue[];
};

export type TAgentUiEvent =
  | { type: 'message_delta'; text: string; phase?: 'stage' | 'final' }
  | { type: 'agent_event'; event: TAgentRuntimeEvent }
  | TAgentUiEventPlanReady
  | { type: 'plan_record'; record: IAgentPlanRecord; versions: IAgentPlanRecord[] }
  | { type: 'tool_start'; toolName: string; input: TJsonValue }
  | { type: 'tool_result'; toolName: string; output: TJsonValue }
  | TAgentUiEventToolCall
  | TAgentUiEventToolCallUpdate
  | TAgentUiEventPlan
  | TAgentUiEventAvailableCommandsUpdate
  | TAgentUiEventUsageUpdate
  | TAgentUiEventConfigOptionUpdate
  | { type: 'approval_required'; request: IApprovalRequest }
  | { type: 'ask_user_required'; requestId: string; request: IAskUserRequest }
  | { type: 'diff_ready'; files: IDiffFile[] }
  | TAgentUiEventDone
  | { type: 'error'; message: string };

/** 同 runtime 事件,按 `type` 字面量取窄类型。 */
export type TAgentUiEventByType<TType extends TAgentUiEvent['type']> = Extract<
  TAgentUiEvent,
  { type: TType }
>;

/* ============================================================================
 * Sidecar request / response
 * ========================================================================== */

export interface IAgentSidecarBaseRequest {
  sessionId?: string;
  goal?: string;
  messages: IAgentSidecarMessage[];
  workspaceRootPath?: string | null;
  context: IAiContextReference[];
  modelConfig?: IAgentSidecarModelConfig;
  threadId?: string;
  planId?: string;
  planVersion?: number;
  planStepId?: string;
}

export interface IAgentSidecarChatRequest extends IAgentSidecarBaseRequest {
  /**
   * 未指定时由 backend 默认 `'ask'`(无工具仅对话)。
   * 任何 `mode` 切换都会触发 session 重置:确保 caller 一致地传同一 `mode`。
   */
  mode?: TAgentSidecarMode;
}

/**
 * approval resolve 用 `Partial<IAgentSidecarBaseRequest>`,把所有 base 字段都
 * 变成 optional(包括 `messages` / `context`)。这是有意的:resolve 调用一般
 * 只需要 sessionId + requestId + decision,不重复发完整 chat payload。
 *
 * 缺点:类型层失去对 `messages` 必填的保护。如有需要可以拆成两条 request 类型。
 */
export interface IAgentSidecarApprovalResolveRequest extends Partial<IAgentSidecarBaseRequest> {
  sessionId?: string;
  requestId: string;
  decision: string;
}

/**
 * ask_user 反向提问恢复请求。镜像 `IAgentSidecarApprovalResolveRequest` 的
 * 「Partial base + requestId」结构,但以 outcome + 结构化 answers 取代 decision ——
 * 对应后端 agentAskUserResumeParamsSchema(= agentChatParamsSchema + requestId +
 * outcome + answers?)与扩展方法 `calamex.dev/agent/ask-user/resume`。
 *
 * outcome: 'cancelled' 时省略 answers(用户 Esc / 回合取消);'selected' 时 answers
 * 为每题作答(空答案数组等价于用户跳过全部问题,语义合法)。
 */
export interface IAgentSidecarAskUserResumeRequest extends Partial<IAgentSidecarBaseRequest> {
  sessionId?: string;
  requestId: string;
  outcome: TAskUserOutcome;
  answers?: IQuestionAnswer[];
}

export type TAgentSidecarRollbackStepPath = string | string[];

export interface IAgentSidecarCheckpointRestoreRequest {
  sessionId?: string;
  runId: string;
  snapshotId?: string;
  step?: TAgentSidecarRollbackStepPath;
}

export interface IAgentSidecarHealthPayload {
  ok: boolean;
  status: string;
  engine: string;
  version: string | null;
  /**
   * Optional + nullable 双编码:未知/未协商 vs 显式 null,需要语义统一。
   * 当前实现:backend 缺省不发该字段(undefined);显式发 null 表示协商失败。
   */
  protocolVersion?: string | null;
  implementationVersion?: string | null;
  mcp: {
    configuredServers: number;
    serverNames: string[];
    errors: string[];
  };
}

export interface IAgentSidecarWarmupPayload {
  ok: boolean;
  providerId: string | null;
  origin: string | null;
  statusCode: number | null;
  durationMs: number;
  skipped: boolean;
  reason?: string | null;
}

export interface IAgentSidecarResponsePayload {
  sessionId: string;
  events: TAgentUiEvent[];
  result: string | null;
}

export interface IAgentSidecarStreamEventPayload {
  sessionId: string;
  seq: number;
  event: TAgentUiEvent;
}

/* ============================================================================
 * 外部 ACP 编码 agent（Kimi / Codex，ADR-0015）发送契约
 *
 * 镜像 Rust 契约 src-tauri/src/commands/contracts/builtin_agent.rs 的
 * AgentBackendKind / AgentExternalChatRequest / AgentExternalChatResultPayload
 * （serde rename_all = "camelCase"）。外部 agent 只实现标准 session/prompt，不接收
 * 逐请求 model_config（凭据由其自身 CLI 自管）；过程增量经 session/update 帧走既有
 * sidecar 流投影，本结果仅承载会话标识 + 回合终止原因。
 * ========================================================================== */

export type TAgentBackendKind = 'builtin' | 'kimi' | 'codex';

/**
 * 随标准 session/prompt 一并送达的上下文附件（文本类）。镜像 Rust 契约
 * src-tauri/src/commands/contracts/builtin_agent.rs 的 AgentPromptAttachment
 * （serde rename_all = "camelCase"）。宿主为每个附件构造一个 ACP embedded resource 内容块
 * （协议首选的上下文注入方式），与用户正文并列送达，而非拼进正文字符串。
 */
export interface IAgentPromptAttachment {
  name: string;
  uri: string;
  text: string;
  mimeType?: string;
}

export interface IAgentExternalChatRequest {
  backend: TAgentBackendKind;
  text: string;
  threadId?: string;
  workspaceRootPath?: string | null;
  /**
   * 前端预生成的流式关联键（形如 sidecar:assistantMessageId）。Rust 宿主据此把外部 agent
   * session/update 帧的 session_id 由 ACP 会话 UUID 重写为该键，使前端
   * subscribeSidecarSessionStream 能在回合进行中实时收帧（而非末尾一次性渲染）。
   * 缺省时后端回退到 ACP 会话 id。
   */
  sessionId?: string;
  /**
   * 本回合随附的上下文附件（文本类）。宿主为每个附件构造一个 ACP embedded resource 内容块并与
   * 正文并列送达。缺省/省略等价于无附件。
   */
  attachments?: IAgentPromptAttachment[];
}

export interface IAgentExternalChatResultPayload {
  sessionId: string;
  stopReason: string;
}
