import { createRequire } from 'node:module';
import { MastraRuntime } from './rollback.js';
import type {
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
} from './contracts/runtime-contracts.js';
import type {
    IAgentRuntimeInput,
    IAgentRuntimeModelConfigInput,
    IApprovalResolutionInput,
    ICheckpointRestoreInput,
    IPlanApprovalInput,
    IPlanFinishInput,
    IPlanQueryInput,
    IPlanRejectInput,
} from './contracts/runtime-input.js';
import type { TPlanOrchestrationWorkflow } from './plan/orchestration-workflow.js';

export type {
    IAgentRuntimeContext,
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
    TAgentRuntimeOutputEvent
} from './contracts/runtime-contracts.js';

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
    restoreCheckpoint: TRuntimeMethod<ICheckpointRestoreInput>;

    /**
     * 可选：构建原生 Mastra 计划编排 workflow（Phase 2，默认关）。
     * 仅 server.ts 的 `/agent/plan/orchestrate` 在 `AGENT_ORCHESTRATION_WORKFLOW=1`
     * 时使用；不实现时该路由返回 404，旧路径不受影响。
     */
    buildPlanOrchestrationWorkflow?: (
        modelConfig?: IAgentRuntimeModelConfigInput,
    ) => TPlanOrchestrationWorkflow;

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
        `Unsupported AGENT_RUNTIME: \"${configured}\". Expected one of: ${SUPPORTED_AGENT_RUNTIMES.join(', ')}.`,
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
