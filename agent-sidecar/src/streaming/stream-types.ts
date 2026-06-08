import { randomUUID } from 'node:crypto';

/**
 * 内部 runtime event 协议版本。
 *
 * 这是 sidecar 内部事件契约（`TAgentRuntimeEvent`），
 * 不是 UI wire envelope（后者由 `events.ts.AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION` 管）。
 */
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

export type TToolRiskLevel = 'low' | 'medium' | 'high';

export type TContextBudgetDecisionKind = 'within_budget' | 'compact_recommended' | 'warn_context_limit';

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
  schemaVersion: typeof AGENT_RUNTIME_EVENT_SCHEMA_VERSION;
  redacted: true;
  visibility: TAgentRuntimeVisibility;
  level?: TAgentRuntimeLevel;
  parentId?: string;
  spanId?: string;
  /**
   * Mastra 官方 trace id（来自 `agent.stream()` / `agent.generate()` 返回值）。
   * 仅在 Mastra 提供时存在；前端可用于深链到 observability 平台查看思考树。
   */
  traceId?: string;
}

// -----------------------------------------------------------------------
// Run lifecycle
// -----------------------------------------------------------------------

export interface IAgentRunStartedEvent extends IAgentRuntimeEventBase {
  type: 'agent.run.started';
  inputPreview?: string;
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

// -----------------------------------------------------------------------
// Streaming output
// -----------------------------------------------------------------------

export interface IAgentTextDeltaEvent extends IAgentRuntimeEventBase {
  type: 'agent.text.delta';
  text: string;
}

export interface IAgentReasoningDeltaEvent extends IAgentRuntimeEventBase {
  type: 'agent.reasoning.delta';
  text: string;
}

// -----------------------------------------------------------------------
// Model
// -----------------------------------------------------------------------

export interface IAgentModelStartedEvent extends IAgentRuntimeEventBase {
  type: 'agent.model.started';
  /** 仅在 Mastra 提供该字段时存在。可用性判定：`event.projectedInputTokens !== undefined`。 */
  projectedInputTokens?: number;
}

export interface IAgentModelCompletedEvent extends IAgentRuntimeEventBase {
  type: 'agent.model.completed';
  ok: boolean;
  stopReason?: string;
  errorMessage?: string;
}

// -----------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------

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
  /** Mastra `toolStreamUpdateEvent.event.data` 的 redact + 截断预览；进度心跳无 data 时可能缺省。 */
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

// -----------------------------------------------------------------------
// Adaptive context (acontext)
// -----------------------------------------------------------------------

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
  /** Payload 阶段已构建完请求体，tokens 必算得出。 */
  projectedInputTokens: number;
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

// -----------------------------------------------------------------------
// Rollback
// -----------------------------------------------------------------------

export interface IAgentCheckpointEvent extends IAgentRuntimeEventBase {
  type: 'rollback.checkpoint.created' | 'rollback.checkpoint.failed';
  snapshotId?: string;
  reason?: string;
  errorMessage?: string;
}

export interface IAgentRollbackEvent extends IAgentRuntimeEventBase {
  type:
  | 'rollback.restore.started'
  | 'rollback.restore.completed'
  | 'rollback.restore.failed';
  snapshotId?: string;
  savedAsLatest?: boolean;
  message?: string;
  errorMessage?: string;
}

// -----------------------------------------------------------------------
// Side effects
// -----------------------------------------------------------------------

export interface IAgentSideEffectEvent extends IAgentRuntimeEventBase {
  type: 'side_effect.recorded' | 'side_effect.warning';
  toolName: string;
  riskLevel: TToolRiskLevel;
  undoAvailable: boolean;
  message: string;
}

// -----------------------------------------------------------------------
// Misc
// -----------------------------------------------------------------------

export interface IAgentMessageEvent extends IAgentRuntimeEventBase {
  type: 'agent.message.added';
  role?: string;
  messageKind?: string;
}

export interface IAgentDebugEvent extends IAgentRuntimeEventBase {
  type: 'agent.debug';
  name: string;
  data?: Record<string, string | number | boolean | null>;
}

// -----------------------------------------------------------------------
// Union + draft
// -----------------------------------------------------------------------

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

// -----------------------------------------------------------------------
// 编译期穷尽性检查：
// AGENT_RUNTIME_EVENT_TYPES 数组与 TAgentRuntimeEvent 联合任一边漏写都会编译失败。
// -----------------------------------------------------------------------

type _MissingInUnion = Exclude<TAgentRuntimeEventType, TAgentRuntimeEvent['type']>;
type _MissingInArray = Exclude<TAgentRuntimeEvent['type'], TAgentRuntimeEventType>;
type _AssertExhaustive =
  [_MissingInUnion, _MissingInArray] extends [never, never]
  ? true
  : {
    missingInUnion: _MissingInUnion;
    missingInArray: _MissingInArray;
  };
const _assertExhaustive: _AssertExhaustive = true;
void _assertExhaustive;

// -----------------------------------------------------------------------
// Draft + factory
// -----------------------------------------------------------------------

type TAgentRuntimeEventBaseKey =
  | 'id'
  | 'runId'
  | 'sessionId'
  | 'agentId'
  | 'timestamp'
  | 'seq'
  | 'schemaVersion'
  | 'redacted';

type TDistributiveOmit<T, K extends PropertyKey> =
  T extends unknown ? Omit<T, K> : never;

export type TAgentRuntimeEventDraft =
  TDistributiveOmit<TAgentRuntimeEvent, TAgentRuntimeEventBaseKey>;

export interface IAgentRuntimeEventContext {
  runId: string;
  sessionId: string;
  agentId: string;
  /** Mastra 官方 trace id；传入后会被写到每个 runtime event 的 `traceId` 字段。 */
  traceId?: string;
  now?: () => string;
}

/**
 * 构造一个 `TAgentRuntimeEvent`。
 *
 * 使用泛型保留调用方处的具体子类型：
 * ```ts
 * const ev = createAgentRuntimeEvent(ctx, 1, {
 *   type: 'agent.tool.started',
 *   visibility: 'user',
 *   toolName: 'x',
 * });
 * // ev 推断为 IAgentToolStartedEvent & IAgentRuntimeEventBase
 * ```
 */
export const createAgentRuntimeEvent = <T extends TAgentRuntimeEventDraft>(
  context: IAgentRuntimeEventContext,
  seq: number,
  draft: T,
): T & IAgentRuntimeEventBase => ({
  id: randomUUID(),
  runId: context.runId,
  sessionId: context.sessionId,
  agentId: context.agentId,
  timestamp: context.now ? context.now() : new Date().toISOString(),
  seq,
  schemaVersion: AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  redacted: true,
  ...(context.traceId ? { traceId: context.traceId } : {}),
  ...draft,
} as T & IAgentRuntimeEventBase);
