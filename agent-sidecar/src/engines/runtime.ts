import { MastraRuntime } from './mastra-runtime.js';
import type {
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
} from './runtime-contracts.js';
import type {
    IAgentRuntimeInput,
    IApprovalResolutionInput,
    ICheckpointRestoreInput,
    IPlanApprovalInput,
    IPlanFinishInput,
    IPlanQueryInput,
    IPlanRejectInput,
} from './runtime-input.js';

export type {
    IAgentRuntimeContext,
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
    TAgentRuntimeOutputEvent
} from './runtime-contracts.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const SUPPORTED_AGENT_RUNTIMES = ['mastra'] as const;

export type TAgentRuntimeName = (typeof SUPPORTED_AGENT_RUNTIMES)[number];

export const DEFAULT_AGENT_RUNTIME: TAgentRuntimeName = 'mastra';

// TODO: replace with a build-time injected version (e.g. from package.json).
export const SIDECAR_VERSION = '0.1.0';

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