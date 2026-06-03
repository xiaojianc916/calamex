import { agentSidecarStreamEventPayloadSchema } from '@/types/ai/sidecar.schema';
import type { ITauriService } from '@/types/tauri';
import { assertDesktopRuntime } from '@/utils/desktop-runtime';
import { tauriContracts } from './tauri.contracts';
import { defineContractIpc, definePayloadIpc } from './tauri.ipc-factory';
import { measureAiChatInput } from './tauri.ipc-metrics';
import { loadTauriEvent } from './tauri.ipc-runtime';

const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;

const agentSidecarHealthIpc = defineContractIpc(
  'agent_sidecar_health',
  '读取 Agent sidecar 健康状态',
  tauriContracts.agentSidecarHealth,
  { idempotent: true, audit: 'sensitive', timeoutMs: 10_000 },
);

const agentSidecarRestartIpc = defineContractIpc(
  'agent_sidecar_restart',
  '重启 Agent sidecar 进程',
  tauriContracts.agentSidecarRestart,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const agentSidecarWarmupIpc = defineContractIpc(
  'agent_sidecar_warmup',
  '预热 Agent sidecar 模型连接',
  tauriContracts.agentSidecarWarmup,
  { audit: 'sensitive', timeoutMs: 8_000 },
);

const agentSidecarChatIpc = definePayloadIpc(
  'agent_sidecar_chat',
  '通过 Node sidecar 执行 Agent Ask',
  tauriContracts.agentSidecarChat,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarPlanIpc = definePayloadIpc(
  'agent_sidecar_plan',
  '通过 Node sidecar 生成 Agent 计划',
  tauriContracts.agentSidecarPlan,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarPlanApproveIpc = definePayloadIpc(
  'agent_sidecar_plan_approve',
  '批准 Agent sidecar 计划',
  tauriContracts.agentSidecarPlanApprove,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarPlanQueryIpc = definePayloadIpc(
  'agent_sidecar_plan_query',
  '读取 Agent sidecar 计划记录',
  tauriContracts.agentSidecarPlanQuery,
  { idempotent: true, audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarPlanRejectIpc = definePayloadIpc(
  'agent_sidecar_plan_reject',
  '拒绝 Agent sidecar 计划',
  tauriContracts.agentSidecarPlanReject,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarPlanFinishIpc = definePayloadIpc(
  'agent_sidecar_plan_finish',
  '收口 Agent sidecar 计划状态',
  tauriContracts.agentSidecarPlanFinish,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarPlanValidateIpc = definePayloadIpc(
  'agent_sidecar_plan_validate',
  '验证 Agent sidecar 计划执行结果',
  tauriContracts.agentSidecarPlanValidate,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarPlanReplanIpc = definePayloadIpc(
  'agent_sidecar_plan_replan',
  '根据验证结果重新生成 Agent sidecar 计划',
  tauriContracts.agentSidecarPlanReplan,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarExecuteIpc = definePayloadIpc(
  'agent_sidecar_execute',
  '通过 Node sidecar 执行 Agent 任务',
  tauriContracts.agentSidecarExecute,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarResolveApprovalIpc = definePayloadIpc(
  'agent_sidecar_resolve_approval',
  '处理 Agent sidecar 工具审批',
  tauriContracts.agentSidecarResolveApproval,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarRestoreCheckpointIpc = definePayloadIpc(
  'agent_sidecar_restore_checkpoint',
  '通过 Node sidecar 恢复 Agent 回滚检查点',
  tauriContracts.agentSidecarRestoreCheckpoint,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
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
  agentSidecarHealth: () => agentSidecarHealthIpc(undefined),

  agentSidecarRestart: () => agentSidecarRestartIpc(undefined),

  agentSidecarWarmup: () => agentSidecarWarmupIpc(undefined),

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
