import { commands } from '@/bindings/tauri';
import { agentSidecarStreamEventPayloadSchema } from '@/types/ai/sidecar.schema';
import type { ITauriService } from '@/types/tauri';
import { assertDesktopRuntime } from '@/utils/desktop-runtime';
import { measureAiChatInput } from './tauri.ipc-metrics';
import { callSpectaCommand, loadTauriEvent } from './tauri.ipc-runtime';
import type { IIpcCallOptions } from './tauri.ipc-types';

/**
 * Agent sidecar invoke 层：从手写 Zod 契约迁入 tauri-specta 生成绑定（commands.*）。
 *
 * - 入参 / 出参类型以 Rust 为单一事实源，经 src/bindings/tauri.ts 生成。
 * - 仍保留薄仪表化外壳（callSpectaCommand：审计 / 超时 / 取消 / 错误归一化）。
 * - 流式事件仍由 listen('ai:sidecar-stream') + Zod safeParse 兜底校验。
 */

const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;

type TSidecarRequest<K extends keyof ITauriService> = Parameters<ITauriService[K]>[0];
type TSidecarResult<K extends keyof ITauriService> = Awaited<ReturnType<ITauriService[K]>>;

const agentSidecarHealthIpc = (
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarHealth'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_health',
      guardHint: '读取 Agent sidecar 健康状态',
      idempotent: true,
      audit: 'sensitive',
      timeoutMs: 10_000,
      signal: options?.signal,
    },
    () => commands.agentSidecarHealth(),
  );

const agentSidecarRestartIpc = (
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarRestart'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_restart',
      guardHint: '重启 Agent sidecar 进程',
      audit: 'sensitive',
      timeoutMs: 30_000,
      signal: options?.signal,
    },
    () => commands.agentSidecarRestart(),
  );

const agentSidecarWarmupIpc = (
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarWarmup'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_warmup',
      guardHint: '预热 Agent sidecar 模型连接',
      audit: 'sensitive',
      timeoutMs: 8_000,
      signal: options?.signal,
    },
    () => commands.agentSidecarWarmup(),
  );

const agentSidecarChatIpc = (
  payload: TSidecarRequest<'agentSidecarChat'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarChat'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_chat',
      guardHint: '通过 Node sidecar 执行 Agent Ask',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      measureInput: measureAiChatInput,
      signal: options?.signal,
    },
    () => commands.agentSidecarChat(payload),
  );

const agentSidecarPlanIpc = (
  payload: TSidecarRequest<'agentSidecarPlan'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarPlan'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_plan',
      guardHint: '通过 Node sidecar 生成 Agent 计划',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      measureInput: measureAiChatInput,
      signal: options?.signal,
    },
    () => commands.agentSidecarPlan(payload),
  );

const agentSidecarPlanApproveIpc = (
  payload: TSidecarRequest<'agentSidecarPlanApprove'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarPlanApprove'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_plan_approve',
      guardHint: '批准 Agent sidecar 计划',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      signal: options?.signal,
    },
    () => commands.agentSidecarPlanApprove(payload),
  );

const agentSidecarPlanQueryIpc = (
  payload: TSidecarRequest<'agentSidecarPlanQuery'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarPlanQuery'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_plan_query',
      guardHint: '读取 Agent sidecar 计划记录',
      idempotent: true,
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      signal: options?.signal,
    },
    () => commands.agentSidecarPlanQuery(payload),
  );

const agentSidecarPlanRejectIpc = (
  payload: TSidecarRequest<'agentSidecarPlanReject'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarPlanReject'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_plan_reject',
      guardHint: '拒绝 Agent sidecar 计划',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      signal: options?.signal,
    },
    () => commands.agentSidecarPlanReject(payload),
  );

const agentSidecarPlanFinishIpc = (
  payload: TSidecarRequest<'agentSidecarPlanFinish'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarPlanFinish'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_plan_finish',
      guardHint: '收口 Agent sidecar 计划状态',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      signal: options?.signal,
    },
    () => commands.agentSidecarPlanFinish(payload),
  );

const agentSidecarPlanValidateIpc = (
  payload: TSidecarRequest<'agentSidecarPlanValidate'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarPlanValidate'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_plan_validate',
      guardHint: '验证 Agent sidecar 计划执行结果',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      measureInput: measureAiChatInput,
      signal: options?.signal,
    },
    () => commands.agentSidecarPlanValidate(payload),
  );

const agentSidecarPlanReplanIpc = (
  payload: TSidecarRequest<'agentSidecarPlanReplan'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarPlanReplan'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_plan_replan',
      guardHint: '根据验证结果重新生成 Agent sidecar 计划',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      measureInput: measureAiChatInput,
      signal: options?.signal,
    },
    () => commands.agentSidecarPlanReplan(payload),
  );

const agentSidecarExecuteIpc = (
  payload: TSidecarRequest<'agentSidecarExecute'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarExecute'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_execute',
      guardHint: '通过 Node sidecar 执行 Agent 任务',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      measureInput: measureAiChatInput,
      signal: options?.signal,
    },
    () => commands.agentSidecarExecute(payload),
  );

const agentSidecarResolveApprovalIpc = (
  payload: TSidecarRequest<'agentSidecarResolveApproval'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarResolveApproval'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_resolve_approval',
      guardHint: '处理 Agent sidecar 工具审批',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      signal: options?.signal,
    },
    () => commands.agentSidecarResolveApproval(payload),
  );

const agentSidecarRestoreCheckpointIpc = (
  payload: TSidecarRequest<'agentSidecarRestoreCheckpoint'>,
  options?: IIpcCallOptions,
): Promise<TSidecarResult<'agentSidecarRestoreCheckpoint'>> =>
  callSpectaCommand(
    {
      command: 'agent_sidecar_restore_checkpoint',
      guardHint: '通过 Node sidecar 恢复 Agent 回滚检查点',
      audit: 'sensitive',
      timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
      input: payload,
      signal: options?.signal,
    },
    () => commands.agentSidecarRestoreCheckpoint(payload),
  );

type TSidecarTauriService = Pick<
  ITauriService,
  | 'agentSidecarHealth'
  | 'agentSidecarRestart'
  | 'agentSidecarWarmup'
  | 'agentSidecarChat'
  | 'agentSidecarPlan'
  | 'agentSidecarPlanApprove'
  | 'agentSidecarPlanQuery'
  | 'agentSidecarPlanReject'
  | 'agentSidecarPlanFinish'
  | 'agentSidecarPlanValidate'
  | 'agentSidecarPlanReplan'
  | 'agentSidecarExecute'
  | 'agentSidecarResolveApproval'
  | 'agentSidecarRestoreCheckpoint'
  | 'onAgentSidecarStream'
>;

export const sidecarTauriService: TSidecarTauriService = {
  agentSidecarHealth: () => agentSidecarHealthIpc(),

  agentSidecarRestart: () => agentSidecarRestartIpc(),

  agentSidecarWarmup: () => agentSidecarWarmupIpc(),

  agentSidecarChat: agentSidecarChatIpc,

  agentSidecarPlan: agentSidecarPlanIpc,

  agentSidecarPlanApprove: agentSidecarPlanApproveIpc,

  agentSidecarPlanQuery: agentSidecarPlanQueryIpc,

  agentSidecarPlanReject: agentSidecarPlanRejectIpc,

  agentSidecarPlanFinish: agentSidecarPlanFinishIpc,

  agentSidecarPlanValidate: agentSidecarPlanValidateIpc,

  agentSidecarPlanReplan: agentSidecarPlanReplanIpc,

  agentSidecarExecute: agentSidecarExecuteIpc,

  agentSidecarResolveApproval: agentSidecarResolveApprovalIpc,

  agentSidecarRestoreCheckpoint: agentSidecarRestoreCheckpointIpc,

  async onAgentSidecarStream(handler) {
    await assertDesktopRuntime('监听 Agent sidecar 流式事件');
    const { listen } = await loadTauriEvent();
    return listen('ai:sidecar-stream', (event) => {
      const parsed = agentSidecarStreamEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }
      handler(parsed.data);
    });
  },
};
