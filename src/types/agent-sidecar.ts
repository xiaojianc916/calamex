import type { IAiContextReference } from '@/types/ai-context';

export const AGENT_SIDECAR_MODES = [
  'ask',
  'plan',
  'agent',
  'patch',
  'review',
] as const;

export type TAgentSidecarMode = (typeof AGENT_SIDECAR_MODES)[number];

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

export type TJsonValue =
  | string
  | number
  | boolean
  | null
  | TJsonValue[]
  | { readonly [key: string]: TJsonValue };

export interface IAgentSidecarMessage {
  role: TAgentSidecarMessageRole;
  content: string;
}

export interface IAgentPlanStep {
  id: string;
  title: string;
  goal: string;
  description?: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
  tools: string[];
  files?: string[];
  commands?: string[];
  risks?: string[];
  acceptanceCriteria?: string[];
  riskLevel: 'low' | 'medium' | 'high';
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

export interface IApprovalRequest {
  id: string;
  toolName: string;
  question: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
  reversible: boolean;
  createdAt: string;
}

export interface IDiffFile {
  path: string;
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
}

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

export type TAgentUiEvent =
  | { type: 'message_delta'; text: string; phase?: 'stage' | 'final' }
  | { type: 'agent_event'; event: TAgentRuntimeEvent }
  | {
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
  }
  | { type: 'plan_record'; record: IAgentPlanRecord; versions: IAgentPlanRecord[] }
  | { type: 'tool_start'; toolName: string; input: TJsonValue }
  | { type: 'tool_result'; toolName: string; output: TJsonValue }
  | { type: 'approval_required'; request: IApprovalRequest }
  | { type: 'diff_ready'; files: IDiffFile[] }
  | { type: 'done'; result: string }
  | { type: 'error'; message: string };

export interface IAgentSidecarBaseRequest {
  sessionId?: string;
  goal?: string;
  messages: IAgentSidecarMessage[];
  workspaceRootPath?: string | null;
  context: IAiContextReference[];
  threadId?: string;
  planId?: string;
  planVersion?: number;
  planStepId?: string;
}

export interface IAgentSidecarChatRequest extends IAgentSidecarBaseRequest {
  mode?: TAgentSidecarMode;
}

export interface IAgentSidecarPlanRequest extends Omit<IAgentSidecarBaseRequest, 'goal'> {
  goal: string;
}

export interface IAgentSidecarExecuteRequest extends Omit<IAgentSidecarBaseRequest, 'goal'> {
  goal: string;
  planId: string;
  planVersion: number;
  planStepId: string;
}

export interface IAgentSidecarPlanValidateRequest extends Omit<IAgentSidecarBaseRequest, 'planStepId'> {
  planId: string;
  planVersion: number;
}

export interface IAgentSidecarPlanReplanRequest extends Omit<IAgentSidecarBaseRequest, 'goal' | 'planStepId'> {
  goal: string;
  planId: string;
  planVersion: number;
}

export interface IAgentSidecarPlanApproveRequest {
  sessionId?: string;
  planId: string;
  version: number;
}

export interface IAgentSidecarPlanQueryRequest {
  sessionId?: string;
  planId: string;
  version?: number;
}

export interface IAgentSidecarPlanRejectRequest extends IAgentSidecarPlanApproveRequest {
  reason?: string;
}

export interface IAgentSidecarPlanFinishRequest extends IAgentSidecarPlanApproveRequest {
  status: Extract<TAgentPlanStatus, 'completed' | 'failed'>;
  errorMessage?: string;
}

export interface IAgentSidecarApprovalResolveRequest {
  sessionId?: string;
  requestId: string;
  decision: string;
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
  protocolVersion?: string | null;
  implementationVersion?: string | null;
  mcp: {
    configuredServers: number;
    serverNames: string[];
    errors: string[];
  };
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
