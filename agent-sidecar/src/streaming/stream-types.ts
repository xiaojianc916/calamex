import { randomUUID } from 'node:crypto';

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
  'acontext.tool_summary.recorded',
  'acontext.memory.compressed',
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
  projectedInputTokens?: number;
  projectedInputTokensAvailable: boolean;
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
  dataPreview: string;
}

export interface IAgentToolCompletedEvent extends IAgentRuntimeEventBase {
  type: 'agent.tool.completed';
  toolUseId?: string;
  toolName: string;
  ok: boolean;
  resultPreview?: string;
  errorMessage?: string;
}

export interface IAgentAcontextEnvelopeEvent extends IAgentRuntimeEventBase {
  type: 'acontext.envelope.injected' | 'acontext.envelope.replaced';
  envelopeCharCount: number;
  systemPromptCharCount: number;
  injectedAt: 'beforeInvocation' | 'beforeModelCall';
}

export interface IAgentAcontextTokenEvent extends IAgentRuntimeEventBase {
  type: 'acontext.token.checked';
  projectedInputTokens?: number;
  projectedInputTokensAvailable: boolean;
  inputCharCount?: number;
  systemPromptCharCount?: number;
  messageCharCount?: number;
  contextCharCount?: number;
  toolSchemaCharCount?: number;
  toolCount?: number;
  mcpToolCount?: number;
  uiContextToolCount?: number;
  nativeToolCount?: number;
  logToolCount?: number;
  workspaceEnabled?: boolean;
  browserEnabled?: boolean;
  memoryEnabled?: boolean;
  maxSteps?: number;
  toolChoice?: 'auto' | 'none';
  tokenEstimateMethod?: 'char_heuristic';
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
  | IAgentAcontextToolSummaryEvent
  | IAgentAcontextMemoryCompressedEvent
  | IAgentCheckpointEvent
  | IAgentRollbackEvent
  | IAgentSideEffectEvent
  | IAgentMessageEvent
  | IAgentRunCompletedEvent
  | IAgentRunErrorEvent
  | IAgentDebugEvent;

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
  now?: () => string;
}

export const createAgentRuntimeEvent = (
  context: IAgentRuntimeEventContext,
  seq: number,
  draft: TAgentRuntimeEventDraft,
): TAgentRuntimeEvent => ({
  id: randomUUID(),
  runId: context.runId,
  sessionId: context.sessionId,
  agentId: context.agentId,
  timestamp: context.now ? context.now() : new Date().toISOString(),
  seq,
  schemaVersion: AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  redacted: true,
  ...draft,
}) as TAgentRuntimeEvent;
