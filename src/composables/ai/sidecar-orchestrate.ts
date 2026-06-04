import {
  extractSidecarChangedFilePaths,
  hasSidecarFileMutationEvent,
  mapSidecarEventsToToolCalls,
  mapSidecarPlanToTaskSteps,
  mapSidecarToolNameToAiToolName,
  resolveSidecarOfficialUsage,
} from '@/composables/ai/sidecar-events';
import { aiService } from '@/services/ipc/ai.service';
import type {
  IAiAgentPlanMetadata,
  IAiLanguageModelUsage,
  IAiTaskPlanStep,
  IAiToolCall,
  IAiToolConfirmationRequest,
} from '@/types/ai';
import type {
  IAgentPlan,
  IAgentSidecarOrchestratePayload,
  TAgentUiEvent,
} from '@/types/ai/sidecar';

/* ============================================================================
 * Native orchestration (Mastra createWorkflow) frontend driver.
 *
 * 取代分段式 plan/execute/validate/replan/finish + resolveApproval 通道：单条
 * orchestrate workflow run 在服务端跑 plan -> 审批门(suspend) -> execute ->
 * validate -> replan -> finish；前端只需 start + (按需)resume，并消费经由
 * `ai:sidecar-stream` 窗口事件流式推送的 TAgentUiEvent。
 *
 * 关键事实（与 server.ts / orchestrate.rs 一致）：
 *  - start  -> sidecarOrchestrate({ sessionId, goal, threadId? })，事件以调用方
 *    传入的 sessionId 打标，可按 sessionId 过滤订阅。
 *  - resume -> sidecarOrchestrateResume({ runId, decision, reason? })，resume 请求
 *    无 sessionId 字段，Rust 内部用随机 sessionId 打标，前端不可知；编排在面板内
 *    单实例运行，故 resume 期间订阅全部 sidecar 流事件（不按 sessionId 过滤）。
 *  - workflow 仅在 approval-gate 挂起：plan_ready 之后挂起 = 等待计划审批；
 *    approval_required 之后挂起 = 等待工具审批。done/error 即终态。
 * ========================================================================== */

type TPlanReadyEvent = Extract<TAgentUiEvent, { type: 'plan_ready' }>;
type TApprovalEvent = Extract<TAgentUiEvent, { type: 'approval_required' }>;
type TDoneEvent = Extract<TAgentUiEvent, { type: 'done' }>;
type TErrorEvent = Extract<TAgentUiEvent, { type: 'error' }>;
type TMessageDeltaEvent = Extract<TAgentUiEvent, { type: 'message_delta' }>;

// 与 sidecar-events.ts 内 TOOL_CONFIRMATION_OPTIONS 保持一致的审批选项。
const ORCHESTRATION_CONFIRMATION_OPTIONS: IAiToolConfirmationRequest['options'] = [
  { id: 'allow-once', label: '允许', tone: 'primary' },
  { id: 'stop', label: '拒绝', tone: 'danger' },
];

const hasMeaningfulText = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

// 镜像 sidecar-events.ts 内部的 planReadyToMetadata（该函数未导出）。
const toPlanMetadata = (event: TPlanReadyEvent): IAiAgentPlanMetadata => ({
  planId: event.planId,
  ...(event.threadId ? { threadId: event.threadId } : {}),
  version: event.version,
  status: event.status,
  ...(event.createdAt ? { createdAt: event.createdAt } : {}),
  ...(event.updatedAt ? { updatedAt: event.updatedAt } : {}),
  ...(event.approvedAt !== undefined ? { approvedAt: event.approvedAt } : {}),
  ...(event.executedAt !== undefined ? { executedAt: event.executedAt } : {}),
  ...(event.rejectionReason !== undefined ? { rejectionReason: event.rejectionReason } : {}),
  ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
  ...(event.plan.summary ? { summary: event.plan.summary } : {}),
  ...(event.plan.requiresApproval !== undefined
    ? { requiresApproval: event.plan.requiresApproval }
    : {}),
});

// 镜像 sidecar-events.ts 内部的 mapSidecarApprovalToToolConfirmation（该函数未导出）。
const toToolConfirmation = (
  event: TApprovalEvent,
  labelId: string,
): IAiToolConfirmationRequest => ({
  id: event.request.id,
  runId: `sidecar:${labelId}`,
  stepId: `sidecar:${event.request.id}`,
  toolName: mapSidecarToolNameToAiToolName(event.request.toolName),
  question: event.request.question,
  summary: event.request.summary,
  riskLevel: event.request.riskLevel,
  impact: event.request.summary,
  reversible: event.request.reversible,
  createdAt: event.request.createdAt,
  options: ORCHESTRATION_CONFIRMATION_OPTIONS,
});

export interface IOrchestrateProjection {
  /** plan_ready 事件携带的计划（未生成时为 null）。 */
  plan: IAgentPlan | null;
  /** 从 plan_ready 投影出的计划元数据（planId/version/status 等）。 */
  planMetadata: IAiAgentPlanMetadata | null;
  /** 计划步骤（映射到 ai-agent 域的 IAiTaskPlanStep）。 */
  steps: IAiTaskPlanStep[];
  /** 工具调用时间线（含运行时事件归并）。 */
  toolCalls: IAiToolCall[];
  /** done 事件的最终回答文本（无则 null）。 */
  finalAnswer: string | null;
  /** 面向消息气泡的展示文本（错误 / 最终回答 / 最新增量 / 空）。 */
  assistantContent: string;
  /** error 事件文本（无则 null）。 */
  errorMessage: string | null;
  /** approval_required -> 工具确认请求（无则 null）。 */
  pendingConfirmation: IAiToolConfirmationRequest | null;
  /** 被改动的文件路径（去重、归一）。 */
  changedFilePaths: string[];
  /** 是否出现写盘类工具事件。 */
  hasFileMutations: boolean;
  /** done 事件携带的官方用量（无则 null）。 */
  usage: IAiLanguageModelUsage | null;
  /** 是否已到终态（done 或 error）。 */
  isDone: boolean;
  /** 是否在等待审批（计划审批门或工具审批门挂起，且未终态）。 */
  isAwaitingApproval: boolean;
}

/**
 * 把一段 orchestrate / resume 流事件投影成 UI 可直接消费的结构。纯函数，可在
 * 流式回调里反复调用以驱动实时 UI，也可在调用结束后对全量事件再投影一次。
 *
 * @param labelId 用于给工具确认与用量解析打标的标识（start 用 sessionId，
 *                resume 用 runId）。
 */
export const projectOrchestrateEvents = (
  events: readonly TAgentUiEvent[],
  labelId: string,
): IOrchestrateProjection => {
  const planReady =
    events.find((event): event is TPlanReadyEvent => event.type === 'plan_ready') ?? null;
  const approval =
    events.find((event): event is TApprovalEvent => event.type === 'approval_required') ?? null;
  const errorEvent = events.find((event): event is TErrorEvent => event.type === 'error') ?? null;
  let doneEvent: TDoneEvent | null = null;
  let latestDelta: TMessageDeltaEvent | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!doneEvent && event?.type === 'done') {
      doneEvent = event;
    }
    if (!latestDelta && event?.type === 'message_delta') {
      latestDelta = event;
    }
    if (doneEvent && latestDelta) {
      break;
    }
  }

  const plan = planReady?.plan ?? null;
  const finalAnswer = doneEvent && hasMeaningfulText(doneEvent.result) ? doneEvent.result : null;
  const errorMessage = errorEvent?.message ?? null;
  const pendingConfirmation = approval ? toToolConfirmation(approval, labelId) : null;
  const usageResolution = resolveSidecarOfficialUsage({
    sessionId: labelId,
    events: [...events],
    result: null,
  });
  const assistantContent = errorMessage
    ? `Agent 执行失败：${errorMessage}`
    : (finalAnswer ?? (hasMeaningfulText(latestDelta?.text) ? latestDelta.text : ''));

  return {
    plan,
    planMetadata: planReady ? toPlanMetadata(planReady) : null,
    steps: plan ? mapSidecarPlanToTaskSteps(plan) : [],
    toolCalls: mapSidecarEventsToToolCalls(events),
    finalAnswer,
    assistantContent,
    errorMessage,
    pendingConfirmation,
    changedFilePaths: extractSidecarChangedFilePaths(events),
    hasFileMutations: hasSidecarFileMutationEvent(events),
    usage: usageResolution.usage,
    isDone: Boolean(doneEvent) || Boolean(errorEvent),
    isAwaitingApproval: !doneEvent && !errorEvent && Boolean(approval ?? planReady),
  };
};

export type TOrchestrateLiveHandler = (
  events: readonly TAgentUiEvent[],
  projection: IOrchestrateProjection,
  labelId: string,
) => void;

export interface IOrchestrateRunResult {
  /** 最终 {runId, result} 载荷（result 为原始 TJsonValue）。 */
  payload: IAgentSidecarOrchestratePayload;
  /** 本次 start / resume 收集到的全部流事件（按到达顺序）。 */
  events: TAgentUiEvent[];
  /** 对全量事件的终态投影。 */
  projection: IOrchestrateProjection;
}

const createOrchestrationSessionId = (): string => `sidecar-orchestrate:${crypto.randomUUID()}`;

/**
 * 启动一次原生编排 run：跑到计划审批门挂起（plan_ready + suspend）或终态，
 * 期间把流事件交给 onLiveEvents 驱动实时 UI，结束后返回 {payload, events, projection}。
 */
export const startOrchestration = async (args: {
  goal: string;
  threadId?: string | null;
  onLiveEvents?: TOrchestrateLiveHandler;
}): Promise<IOrchestrateRunResult> => {
  const sessionId = createOrchestrationSessionId();
  const events: TAgentUiEvent[] = [];
  const unlisten = await aiService.onSidecarStream((payload) => {
    if (payload.sessionId !== sessionId) {
      return;
    }
    events.push(payload.event);
    args.onLiveEvents?.(events, projectOrchestrateEvents(events, sessionId), sessionId);
  });

  let payload: IAgentSidecarOrchestratePayload;
  try {
    payload = await aiService.sidecarOrchestrate({
      sessionId,
      goal: args.goal,
      ...(args.threadId ? { threadId: args.threadId } : {}),
    });
  } finally {
    unlisten();
  }

  return { payload, events, projection: projectOrchestrateEvents(events, sessionId) };
};

/**
 * 恢复一个被审批门挂起的编排 run（approve / reject）：跑到下一个审批门挂起或终态。
 * resume 流事件的 sessionId 是 Rust 内部随机、前端不可知，编排在面板内单实例运行，
 * 故订阅全部 sidecar 流事件（不按 sessionId 过滤），并以 runId 作为打标标识。
 */
export const resumeOrchestration = async (args: {
  runId: string;
  decision: 'approve' | 'reject';
  reason?: string;
  onLiveEvents?: TOrchestrateLiveHandler;
}): Promise<IOrchestrateRunResult> => {
  const events: TAgentUiEvent[] = [];
  const unlisten = await aiService.onSidecarStream((payload) => {
    events.push(payload.event);
    args.onLiveEvents?.(events, projectOrchestrateEvents(events, args.runId), args.runId);
  });

  let payload: IAgentSidecarOrchestratePayload;
  try {
    payload = await aiService.sidecarOrchestrateResume({
      runId: args.runId,
      decision: args.decision,
      ...(args.reason ? { reason: args.reason } : {}),
    });
  } finally {
    unlisten();
  }

  return { payload, events, projection: projectOrchestrateEvents(events, args.runId) };
};
