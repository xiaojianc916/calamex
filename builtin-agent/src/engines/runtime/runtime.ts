import { createRequire } from 'node:module';
import { MastraRuntime } from './composition.js';
import type {
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
} from '../contracts/runtime-contracts.js';
import type {
    IAgentRuntimeInput,
    IApprovalResolutionInput,
    IAskUserResolutionInput,
    ICheckpointRestoreInput,
    IPlanApprovalInput,
    IPlanFinishInput,
    IPlanQueryInput,
    IPlanRejectInput,
} from '../contracts/runtime-input.js';

export type {
    IAgentRuntimeContext,
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
    TAgentRuntimeOutputEvent
} from '../contracts/runtime-contracts.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const SUPPORTED_AGENT_RUNTIMES = ['mastra'] as const;

export type TAgentRuntimeName = (typeof SUPPORTED_AGENT_RUNTIMES)[number];

export const DEFAULT_AGENT_RUNTIME: TAgentRuntimeName = 'mastra';

/**
 * Sidecar 版本号。优先从 package.json 读取，保证与发布版本一致；
 * 读取失败时回退到占位值，不影响启动。
 */
const resolveSidecarVersion = (): string => {
    try {
        const requireFromHere = createRequire(import.meta.url);
        const pkg = requireFromHere('../../package.json') as { version?: unknown };
        return typeof pkg.version === 'string' && pkg.version.trim().length > 0
            ? pkg.version
            : '0.0.0-unknown';
    } catch {
        return '0.0.0-unknown';
    }
};

export const SIDECAR_VERSION = resolveSidecarVersion();

// -----------------------------------------------------------------------------
// Runtime contract
// -----------------------------------------------------------------------------

/** Shared signature for every runtime entry-point method. */
export type TRuntimeMethod<TInput> = (
    input: TInput,
    options?: IAgentRuntimeRunOptions,
) => Promise<IAgentRuntimeResponse>;

/**
 * Surface implemented by every concrete agent runtime (Mastra today, others later).
 *
 * Notes on semantics:
 * - `chat` / `plan` / `execute` all accept the same `IAgentRuntimeInput`. The
 *   method name fixes the intended mode; if `input.mode` disagrees with the
 *   method, the runtime treats the method as authoritative. Prefer setting
 *   `input.mode` consistently so request logs read sensibly.
 * - `validatePlan` / `replanPlan` currently accept the full `IAgentRuntimeInput`
 *   for parity, but only `planId` / `planVersion` (and `goal` for replan) are
 *   meaningful. Implementations should ignore unrelated fields.
 */
export interface IAgentSidecarRuntime {
    readonly name: TAgentRuntimeName;
    readonly version: string;

    chat: TRuntimeMethod<IAgentRuntimeInput>;
    plan: TRuntimeMethod<IAgentRuntimeInput>;
    execute: TRuntimeMethod<IAgentRuntimeInput>;
    validatePlan: TRuntimeMethod<IAgentRuntimeInput>;
    replanPlan: TRuntimeMethod<IAgentRuntimeInput>;

    approvePlan: TRuntimeMethod<IPlanApprovalInput>;
    getPlan: TRuntimeMethod<IPlanQueryInput>;
    rejectPlan: TRuntimeMethod<IPlanRejectInput>;
    finishPlan: TRuntimeMethod<IPlanFinishInput>;

    resolveApproval: TRuntimeMethod<IApprovalResolutionInput>;

    /**
     * 可选：恢复一个被 ask_user（HITL 反向提问）挂起的工具调用。携带用户回填的
     * outcome + 结构化 answers（见 IAskUserResolutionInput），运行时原样经
     * agent.resumeStream 回灌挂起工具续跑同一回合。与 resolveApproval 互补：后者
     * 仅承载 approve/reject 二元裁决，无法表达多问多选 + 自由文本的富答案。不实现时
     * 对应带外扩展方法返回 methodNotFound（与 modelChat 同约定）。
     */
    resolveAskUser?: TRuntimeMethod<IAskUserResolutionInput>;

    restoreCheckpoint: TRuntimeMethod<ICheckpointRestoreInput>;

    /**
     * 可选：原始模型透传（仿 Zed 独立模型请求）。
     * 一次性、无工具、无记忆、不读历史、不套 agent 系统提示；调用方 messages（含 system）
     * 原样下发给模型，承载标题生成 / 行内补全 / 连接测试等「工具型」模型调用——这些调用
     * 不应被 ask 模式自建的 Calamex 助手人格污染（见 engines/prompts/system-prompt.ts）。
     * 仅带外扩展方法 `calamex.dev/model/chat` 使用；不实现时该扩展返回 methodNotFound，
     * agent 会话主流程不受影响。
     */
    modelChat?: TRuntimeMethod<IAgentRuntimeInput>;

    /**
     * 可选的优雅关闭钩子：释放运行时持有的长生命周期资源（如 MCP 子进程）。
     * 进程退出或收到终止信号时调用。
     */
    dispose?: () => Promise<void>;
}

// -----------------------------------------------------------------------------
// Configuration & factory
// -----------------------------------------------------------------------------

type TRuntimeEnv = Record<string, string | undefined>;

const isSupportedRuntimeName = (value: string): value is TAgentRuntimeName =>
    (SUPPORTED_AGENT_RUNTIMES as readonly string[]).includes(value);

export const resolveConfiguredRuntimeName = (
    env: TRuntimeEnv = process.env,
): TAgentRuntimeName => {
    const configured = env.AGENT_RUNTIME?.trim().toLowerCase();
    if (!configured) {
        return DEFAULT_AGENT_RUNTIME;
    }
    if (isSupportedRuntimeName(configured)) {
        return configured;
    }
    throw new Error(
        `Unsupported AGENT_RUNTIME: "${configured}". Expected one of: ${SUPPORTED_AGENT_RUNTIMES.join(', ')}.`,
    );
};

export interface ICreateRuntimeOptions {
    /** Override the runtime name; defaults to env-derived value. */
    runtime?: TAgentRuntimeName;
    /** Environment map; defaults to `process.env`. */
    env?: TRuntimeEnv;
    /**
     * Forwarded to the concrete runtime constructor. Shape depends on the
     * runtime; pass-through is left untyped here so adding a new runtime
     * doesn't churn this file.
     */
    runtimeOptions?: unknown;
}

export const createConfiguredRuntime = (
    options: ICreateRuntimeOptions = {},
): IAgentSidecarRuntime => {
    const runtime =
        options.runtime ?? resolveConfiguredRuntimeName(options.env ?? process.env);

    switch (runtime) {
        case 'mastra':
            return new MastraRuntime(/* options.runtimeOptions */);
        default: {
            // Exhaustive check: adding a new entry to SUPPORTED_AGENT_RUNTIMES
            // without a matching case here will fail the compile.
            const exhaustive: never = runtime;
            throw new Error(`Unhandled runtime: ${String(exhaustive)}`);
        }
    }
};
