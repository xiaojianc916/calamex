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

export const DEFAULT_AGENT_RUNTIME = 'mastra' as const;
export const SUPPORTED_AGENT_RUNTIMES = ['mastra'] as const;
export const SIDECAR_VERSION = '0.1.0';

export type TAgentRuntimeName = (typeof SUPPORTED_AGENT_RUNTIMES)[number];

export interface IAgentSidecarRuntime {
    readonly name: string;
    readonly version?: string;
    chat(
        input: IAgentRuntimeInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
    plan(
        input: IAgentRuntimeInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
    execute(
        input: IAgentRuntimeInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
    approvePlan(
        input: IPlanApprovalInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
    getPlan(
        input: IPlanQueryInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
    rejectPlan(
        input: IPlanRejectInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
    finishPlan(
        input: IPlanFinishInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
    resolveApproval(
        input: IApprovalResolutionInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
    restoreCheckpoint(
        input: ICheckpointRestoreInput,
        options?: IAgentRuntimeRunOptions,
    ): Promise<IAgentRuntimeResponse>;
}

type TRuntimeEnv = Record<string, string | undefined>;

export const resolveConfiguredRuntimeName = (
    env: TRuntimeEnv = process.env,
): TAgentRuntimeName => {
    const configured = env.AGENT_RUNTIME?.trim().toLowerCase();

    if (!configured) {
        return DEFAULT_AGENT_RUNTIME;
    }

    if (configured === 'mastra') {
        return configured;
    }

    throw new Error(`Unsupported AGENT_RUNTIME: ${configured}`);
};

export const createConfiguredRuntime = (
    env: TRuntimeEnv = process.env,
): IAgentSidecarRuntime => {
    const runtime = resolveConfiguredRuntimeName(env);

    switch (runtime) {
        case 'mastra':
            return new MastraRuntime();
    }
};
