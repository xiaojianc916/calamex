import type { IAiContextReference } from './ai-context';
import type { TAgentPlanStatus } from './agent-sidecar';
import type { TAiAgentPermissionLevel, TAiAgentToolName } from './ai-tools';
import type { IAiWebFetchInput, IAiWebSearchInput } from './ai-web';
import type { TAiWebSourceEntryStatus, TAiWebSourceType } from './ai-web';

export const AI_AGENT_PLAN_STEP_KINDS = [
  'inspect',
  'search',
  'design',
  'edit',
  'verify',
  'summarize',
] as const;

export const AI_AGENT_PLAN_STEP_STATUSES = [
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
  'cancelled',
] as const;

export const AI_AGENT_PLAN_REFERENCE_TYPES = [
  'file',
  'symbol',
  'diagnostic',
  'web',
  'snapshot',
  'diff',
] as const;

export const AI_AGENT_PLAN_RISK_LEVELS = ['low', 'medium', 'high'] as const;

export const AI_AGENT_TASK_CLASSIFICATIONS = ['simple', 'complex'] as const;

export const AI_AGENT_PERMISSION_SCOPES = ['run', 'session'] as const;

export const AI_AGENT_NETWORK_PERMISSIONS = ['off', 'ask', 'allowed-this-run'] as const;

export const AI_AGENT_RUN_STATUSES = [
  'waiting-for-plan-approval',
  'running-plan',
  'running-step',
  'waiting-for-tool-confirmation',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

export const AI_AGENT_TIMELINE_ITEM_TYPES = [
  'step',
  'tool-result',
  'web-source',
] as const;

export const AI_AGENT_TIMELINE_ITEM_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const;

export const AI_TOOL_CONFIRMATION_OPTION_IDS = [
  'allow-once',
  'allow-run',
  'skip',
  'stop',
  'view-details',
] as const;

export const AI_TOOL_CONFIRMATION_DECISIONS = [
  'allow-once',
  'allow-run',
  'skip',
  'stop',
] as const;

export const AI_TOOL_CONFIRMATION_OPTION_TONES = [
  'primary',
  'secondary',
  'danger',
] as const;

export type TAiAgentPlanStepKind = (typeof AI_AGENT_PLAN_STEP_KINDS)[number];
export type TAiAgentPlanStepStatus = (typeof AI_AGENT_PLAN_STEP_STATUSES)[number];
export type TAiAgentPlanReferenceType = (typeof AI_AGENT_PLAN_REFERENCE_TYPES)[number];
export type TAiAgentPlanRiskLevel = (typeof AI_AGENT_PLAN_RISK_LEVELS)[number];
export type TAiAgentTaskClassification = (typeof AI_AGENT_TASK_CLASSIFICATIONS)[number];
export type TAiAgentPermissionScope = (typeof AI_AGENT_PERMISSION_SCOPES)[number];
export type TAiAgentNetworkPermission = (typeof AI_AGENT_NETWORK_PERMISSIONS)[number];
export type TAiAgentRunStatus = (typeof AI_AGENT_RUN_STATUSES)[number];
export type TAiAgentTimelineItemType = (typeof AI_AGENT_TIMELINE_ITEM_TYPES)[number];
export type TAiAgentTimelineItemStatus = (typeof AI_AGENT_TIMELINE_ITEM_STATUSES)[number];
export type TAiToolConfirmationOptionId = (typeof AI_TOOL_CONFIRMATION_OPTION_IDS)[number];
export type TAiToolConfirmationDecision = (typeof AI_TOOL_CONFIRMATION_DECISIONS)[number];
export type TAiToolConfirmationOptionTone = (typeof AI_TOOL_CONFIRMATION_OPTION_TONES)[number];

export interface IAiAgentPlanReference {
  type: TAiAgentPlanReferenceType;
  label: string;
  uri: string;
}

export interface IAiRunCommandToolInput {
  command: string;
  reason: string;
  cwdPolicy: 'workspace-root';
  timeoutMs?: number;
}

export interface IAiStageFileToolInput {
  paths: string[];
  reason: string;
}

export interface IAiCreateCommitToolInput {
  message: string;
  reason: string;
  allowEmpty?: boolean;
}

export interface IAiProposePatchToolInput {
  path: string;
  originalContent: string;
  updatedContent: string;
  summary: string;
}

export interface IAiPatchHunkToolInput {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface IAiPatchFileToolInput {
  path: string;
  originalHash: string;
  hunks: IAiPatchHunkToolInput[];
}

export interface IAiPatchSetToolInput {
  summary: string;
  files: IAiPatchFileToolInput[];
}

export interface IAiApplyPatchMetadataToolInput {
  taskId?: string | null;
  turnId?: string | null;
  reason?: string | null;
  toolCallId?: string | null;
  confirmedByUser?: boolean | null;
  agentRunId?: string | null;
  agentStepId?: string | null;
}

export interface IAiAutoApplyPatchToolInput {
  patch: IAiPatchSetToolInput;
  metadata?: IAiApplyPatchMetadataToolInput | null;
}

export interface IAiAgentToolInputs {
  webSearch?: IAiWebSearchInput;
  webFetch?: IAiWebFetchInput;
  proposePatch?: IAiProposePatchToolInput;
  autoApplyPatch?: IAiAutoApplyPatchToolInput;
  runCommand?: IAiRunCommandToolInput;
  stageFile?: IAiStageFileToolInput;
  createCommit?: IAiCreateCommitToolInput;
}

export interface IAiTaskPlanStep {
  id: string;
  index: number;
  title: string;
  goal: string;
  description?: string;
  kind: TAiAgentPlanStepKind;
  status: TAiAgentPlanStepStatus;
  expectedOutput: string;
  tools: TAiAgentToolName[];
  files?: string[];
  commands?: string[];
  risks?: string[];
  acceptanceCriteria?: string[];
  toolInputs?: IAiAgentToolInputs;
  references?: IAiAgentPlanReference[];
  isActive?: boolean;
  requiresUserApproval: boolean;
  riskLevel: TAiAgentPlanRiskLevel;
  rollbackStrategy?: string;
}

export interface IAiAgentPlanRequest {
  goal: string;
  context: IAiContextReference[];
}

export interface IAiAgentPlanPayload {
  steps: IAiTaskPlanStep[];
}

export interface IAiAgentPlanMetadata {
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
  summary?: string;
  requiresApproval?: boolean;
}

export interface IAiAgentPlanVersionSummary extends IAiAgentPlanMetadata {
  userRequest?: string;
}

export interface IAiAgentClassifyTaskRequest {
  goal: string;
  context: IAiContextReference[];
}

export interface IAiAgentClassifyTaskPayload {
  classification: TAiAgentTaskClassification;
  shouldEnterPlanMode: boolean;
  reason: string;
}

export interface IAiAgentApprovePlanRequest {
  goal: string;
  steps: IAiTaskPlanStep[];
}

export interface IAiAgentApprovePlanPayload {
  approvedAt: string;
  stepCount: number;
}

export interface IAiAgentRun {
  id: string;
  goal: string;
  status: TAiAgentRunStatus;
  steps: IAiTaskPlanStep[];
  currentStepId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface IAiAgentStepWebSourceSummary {
  id: string;
  title: string;
  url: string;
  sourceType: TAiWebSourceType;
  status: TAiWebSourceEntryStatus;
  queryPreview: string;
  fetchedAt: string;
  textRef?: string;
  excerpt?: string;
}

export interface IAiAgentStepToolResultSummary {
  id: string;
  runId: string;
  stepId: string;
  toolName: TAiAgentToolName;
  status: 'succeeded' | 'failed';
  summary: string;
  startedAt: string;
  endedAt: string;
  outputRef?: string;
}

export interface IAiAgentStepDetail {
  runId: string;
  stepId: string;
  webSources: IAiAgentStepWebSourceSummary[];
  toolResults: IAiAgentStepToolResultSummary[];
  updatedAt: string;
}

export interface IAiAgentStepFinalAnswer {
  id: string;
  runId: string;
  stepId: string;
  content: string;
  createdAt: string;
}

export interface IAiAgentTimelineItem {
  id: string;
  runId: string;
  stepId: string;
  type: TAiAgentTimelineItemType;
  title: string;
  status: TAiAgentTimelineItemStatus;
  createdAt: string;
  subtitle?: string;
  detailRef?: string;
}

export interface IAiAgentRunPlanRequest {
  goal: string;
  steps: IAiTaskPlanStep[];
  context: IAiContextReference[];
}

export interface IAiAgentRunStepRequest {
  runId: string;
  stepId?: string;
  skipToolExecution?: boolean;
}

export interface IAiAgentRunIdRequest {
  runId: string;
}

export interface IAiAgentRunPayload {
  run: IAiAgentRun;
}

export interface IAiAgentListRunsPayload {
  runs: IAiAgentRun[];
}

export interface IAiAgentSetNetworkPermissionRequest {
  permission: TAiAgentNetworkPermission;
}

export interface IAiAgentNetworkPermissionPayload {
  permission: TAiAgentNetworkPermission;
}

export interface IAiAgentPermissionState {
  level: TAiAgentPermissionLevel;
  scope: TAiAgentPermissionScope;
  grantedAt: string;
  expiresAt?: string;
  allowedHighRiskTools: TAiAgentToolName[];
}

export interface IAiToolConfirmationOption {
  id: TAiToolConfirmationOptionId;
  label: string;
  tone?: TAiToolConfirmationOptionTone;
}

export interface IAiToolConfirmationRequest {
  id: string;
  runId: string;
  stepId: string;
  toolName: TAiAgentToolName;
  question: string;
  summary: string;
  riskLevel: TAiAgentPlanRiskLevel;
  impact?: string;
  reversible: boolean;
  createdAt: string;
  options: IAiToolConfirmationOption[];
}

export interface IAiAgentResolveToolConfirmationRequest {
  runId: string;
  confirmationId: string;
  decision: TAiToolConfirmationDecision;
}
