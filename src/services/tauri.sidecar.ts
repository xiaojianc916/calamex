import { commands } from '@/bindings/tauri';
import { acpPermissionRequestPayloadSchema } from '@/types/ai/acp-permission.schema';
import { agentSidecarStreamEventPayloadSchema } from '@/types/ai/sidecar.schema';
import type { ITauriService } from '@/types/tauri';
import { assertDesktopRuntime } from '@/utils/platform/desktop-runtime';
import { type ICommandMeta, runCommand } from './tauri.ipc-define';
import { measureAiChatInput } from './tauri.ipc-metrics';
import { loadTauriEvent } from './tauri.ipc-runtime';
import type { IIpcCallOptions } from './tauri.ipc-types';

/**
 * Agent sidecar invoke 层：从手写 Zod 契约迁入 tauri-specta 生成绑定（commands.*）。
 *
 * - 入参 / 出参类型以 Rust 为单一事实源，经 src/bindings/tauri.ts 生成。
 * - 仪表化外壳改用声明式 metadata 表（SIDECAR_COMMAND_META + runCommand），运行期行为与原
 *   手写 callSpectaCommand 逐字段一致：审计 / 超时 / 取消 / 错误归一 / 入参度量。
 * - 流式事件仍由 listen('ai:sidecar-stream') + Zod safeParse 兑底校验。
 */

const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Agent sidecar Tauri 命令的声明式包装元数据表。每条语义与原手写 callSpectaCommand
 * 逐字段对齐，运行期行为不变。
 */
const SIDECAR_COMMAND_META = {
  agentSidecarHealth: {
    command: 'agent_sidecar_health',
    guardHint: '读取 Agent sidecar 健康状态',
    idempotent: true,
    audit: 'sensitive',
    timeoutMs: 10_000,
  },
  agentSidecarRestart: {
    command: 'agent_sidecar_restart',
    guardHint: '重启 Agent sidecar 进程',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  agentSidecarWarmup: {
    command: 'agent_sidecar_warmup',
    guardHint: '预热 Agent sidecar 模型连接',
    audit: 'sensitive',
    timeoutMs: 8_000,
  },
  agentSidecarChat: {
    command: 'agent_sidecar_chat',
    guardHint: '通过 Node sidecar 执行 Agent Ask',
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
  agentSidecarResolveApproval: {
    command: 'agent_sidecar_resolve_approval',
    guardHint: '处理 Agent sidecar 工具审批',
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
  },
  agentSidecarRestoreCheckpoint: {
    command: 'agent_sidecar_restore_checkpoint',
    guardHint: '通过 Node sidecar 恢复 Agent 回滚检查点',
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
  },
  agentSidecarOrchestrate: {
    command: 'agent_sidecar_orchestrate',
    guardHint: 'Start native orchestration workflow via Node sidecar',
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
  agentSidecarOrchestrateResume: {
    command: 'agent_sidecar_orchestrate_resume',
    guardHint: 'Resume Agent sidecar orchestration workflow (approval gate)',
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
  },
} satisfies Record<string, ICommandMeta>;

type TSidecarTauriService = Pick<
  ITauriService,
  | 'agentSidecarHealth'
  | 'agentSidecarRestart'
  | 'agentSidecarWarmup'
  | 'agentSidecarChat'
  | 'agentSidecarResolveApproval'
  | 'agentSidecarRestoreCheckpoint'
  | 'agentSidecarOrchestrate'
  | 'agentSidecarOrchestrateResume'
  | 'onAgentSidecarStream'
  | 'onAcpApproval'
>;

export const sidecarTauriService: TSidecarTauriService = {
  agentSidecarHealth: () =>
    runCommand(SIDECAR_COMMAND_META.agentSidecarHealth, undefined, undefined, () =>
      commands.agentSidecarHealth(),
    ),

  agentSidecarRestart: () =>
    runCommand(SIDECAR_COMMAND_META.agentSidecarRestart, undefined, undefined, () =>
      commands.agentSidecarRestart(),
    ),

  agentSidecarWarmup: () =>
    runCommand(SIDECAR_COMMAND_META.agentSidecarWarmup, undefined, undefined, () =>
      commands.agentSidecarWarmup(),
    ),

  agentSidecarChat(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarChat, payload, options, () =>
      commands.agentSidecarChat(payload),
    );
  },

  agentSidecarResolveApproval(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarResolveApproval, payload, options, () =>
      commands.agentSidecarResolveApproval(payload),
    );
  },

  agentSidecarRestoreCheckpoint(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarRestoreCheckpoint, payload, options, () =>
      commands.agentSidecarRestoreCheckpoint(payload),
    );
  },

  agentSidecarOrchestrate(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarOrchestrate, payload, options, () =>
      commands.agentSidecarOrchestrate(payload),
    );
  },

  agentSidecarOrchestrateResume(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarOrchestrateResume, payload, options, () =>
      commands.agentSidecarOrchestrateResume(payload),
    );
  },

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

  async onAcpApproval(handler) {
    await assertDesktopRuntime('监听 ACP 工具审批请求');
    const { listen } = await loadTauriEvent();
    return listen('ai:sidecar-approval', (event) => {
      const parsed = acpPermissionRequestPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }
      handler(parsed.data);
    });
  },
};
