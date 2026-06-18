import {
  type AgentSidecarApprovalResolveRequest_Deserialize,
  type AgentSidecarChatRequest_Deserialize,
  type AgentSidecarCheckpointRestoreRequest_Deserialize,
  type AgentSidecarOrchestrateRequest_Deserialize,
  type AgentSidecarOrchestrateResumeRequest_Deserialize,
  commands,
} from '@/bindings/tauri';
import { acpPermissionRequestPayloadSchema } from '@/types/ai/acp-permission.schema';
import type {
  IAgentSidecarOrchestratePayload,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
} from '@/types/ai/sidecar';
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

/** 30min timeout: AI agent tasks may run long; this is an IPC safety net,
 * not a business timeout. Server has its own task timeout. */
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

/**
 * 入参/出参的 wire(生成绑定) ↔ domain(手写) 桥接说明：
 *
 * tauri-specta 重新生成后，commands.* 的入参采用 `_Deserialize` wire 形状——可空字段为
 * `T | null` 且为必填，枚举退化为 `string`；而 domain 请求类型保留可选 `?:` 字段与字面量联合。
 * 二者互不可赋值，故入参用 `as unknown as X_Deserialize` 桥接。运行期安全：serde 的
 * `Option` + `#[serde(default)]` 使省略/undefined 在反序列化时等价于 null。
 *
 * 出参方面，生成绑定将 `events` 映射为 `unknown[]`、`result` 为 `unknown`，domain 侧分别是
 * `TAgentUiEvent[]` 与 `TJsonValue | null`（domain 可赋值给 wire，故单次 `as` 即可）。实际
 * 事件/结果由前端 Zod schema 兜底校验，类型断言不影响运行期。
 */
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
      commands.agentSidecarChat(payload as unknown as AgentSidecarChatRequest_Deserialize),
    ) as Promise<IAgentSidecarResponsePayload>;
  },

  agentSidecarResolveApproval(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarResolveApproval, payload, options, () =>
      commands.agentSidecarResolveApproval(
        payload as unknown as AgentSidecarApprovalResolveRequest_Deserialize,
      ),
    ) as Promise<IAgentSidecarResponsePayload>;
  },

  agentSidecarRestoreCheckpoint(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarRestoreCheckpoint, payload, options, () =>
      commands.agentSidecarRestoreCheckpoint(
        payload as unknown as AgentSidecarCheckpointRestoreRequest_Deserialize,
      ),
    ) as Promise<IAgentSidecarResponsePayload>;
  },

  agentSidecarOrchestrate(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarOrchestrate, payload, options, () =>
      commands.agentSidecarOrchestrate(
        payload as unknown as AgentSidecarOrchestrateRequest_Deserialize,
      ),
    ) as Promise<IAgentSidecarOrchestratePayload>;
  },

  agentSidecarOrchestrateResume(payload, options?: IIpcCallOptions) {
    return runCommand(SIDECAR_COMMAND_META.agentSidecarOrchestrateResume, payload, options, () =>
      commands.agentSidecarOrchestrateResume(
        payload as unknown as AgentSidecarOrchestrateResumeRequest_Deserialize,
      ),
    ) as Promise<IAgentSidecarOrchestratePayload>;
  },

  async onAgentSidecarStream(handler) {
    await assertDesktopRuntime('监听 Agent sidecar 流式事件');
    const { listen } = await loadTauriEvent();
    return listen('ai:sidecar-stream', (event) => {
      const parsed = agentSidecarStreamEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('[sidecar] stream event schema validation failed', parsed.error);
        }
        return;
      }
      // wire→domain：schema 仅浅校验 ACP tool_call/tool_call_update（acpUpdate 走 passthrough），
      // @agentclientprotocol/sdk 类型为 SoT，校验通过后回断言手写 domain 类型。
      handler(parsed.data as unknown as IAgentSidecarStreamEventPayload);
    });
  },

  async onAcpApproval(handler) {
    await assertDesktopRuntime('监听 ACP 工具审批请求');
    const { listen } = await loadTauriEvent();
    return listen('ai:sidecar-approval', (event) => {
      const parsed = acpPermissionRequestPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('[sidecar] ACP approval schema validation failed', parsed.error);
        }
        return;
      }
      handler(parsed.data);
    });
  },
};
