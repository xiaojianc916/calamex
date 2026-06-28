import { Agent } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { createMastraModelConfigFromRequest, createMastraObserverModelConfig, createMastraReflectorModelConfig, type IMastraResolvedModelConfig } from '../../models/config.js';
import { createMastraFileLogger, type IMastraLogToolsRef } from '../../tools/log/index.js';
import { createMastraAgentMemory, resolveMastraStorageUrl } from '../context/memory.js';
import { createMastraObservability } from '../workspace/workspace.js';
import { DEFAULT_MASTRA_LOG_FILE, type IMastraAgentConfig, type IMastraAgentLike, type IMastraAgentStreamLike, type IMastraApprovalOptions, type IMastraDurableAgentLike, type IMastraExecutionHandle, type IMastraRegisteredAgentLike, type IMastraResumableAgentHandle, type IMastraStorageLike, type TMastraStreamChunk, type TMastraToolResumeData } from '../shared/types.js';
import type { IAgentRuntimeModelConfigInput } from '../contracts/runtime-input.js';
import { buildCodingSubAgents, buildSupervisorDelegationInstructions, isSubAgentsEnabled } from './subagents.js';

export const createMastraModelConfig = (
    model: IMastraResolvedModelConfig,
): MastraModelConfig => model.model;

export const resolveMastraModelConfig = (
    readModelConfig: () => IMastraResolvedModelConfig | null,
    requestModelConfig?: IAgentRuntimeModelConfigInput | undefined,
): IMastraResolvedModelConfig | null =>
    createMastraModelConfigFromRequest(requestModelConfig) ?? readModelConfig();

export const createMastraMemoryForModel = (
    model: IMastraResolvedModelConfig,
): ReturnType<typeof createMastraAgentMemory> =>
    createMastraAgentMemory(resolveMastraStorageUrl(), {
        observer: createMastraModelConfig(createMastraObserverModelConfig(model)),
        reflector: createMastraModelConfig(createMastraReflectorModelConfig(model)),
    });

export const defaultCreateAgent = (config: IMastraAgentConfig): IMastraAgentLike => {
    const agent = new Agent({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model,
        ...(config.memory ? { memory: config.memory } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.workspace ? { workspace: config.workspace } : {}),
        ...(config.browser ? { browser: config.browser } : {}),
        ...(config.inputProcessors ? { inputProcessors: config.inputProcessors } : {}),
        ...(config.outputProcessors ? { outputProcessors: config.outputProcessors } : {}),
    });
    const bridge = agent as unknown as IMastraAgentLike;
    const resumeStreamBridge = bridge.resumeStream;
    const resumeStream = typeof resumeStreamBridge === 'function'
        ? async (resumeData: TMastraToolResumeData, options: IMastraApprovalOptions): Promise<IMastraAgentStreamLike> =>
            resumeStreamBridge.call(bridge, resumeData, options)
        : undefined;
    const approveToolCallBridge = bridge.approveToolCall;
    const approveToolCall = typeof approveToolCallBridge === 'function'
        ? async (options: IMastraApprovalOptions): Promise<IMastraAgentStreamLike> =>
            resumeStream ? resumeStream({ approved: true }, options) : approveToolCallBridge.call(bridge, options)
        : undefined;
    const declineToolCallBridge = bridge.declineToolCall;
    const declineToolCall = typeof declineToolCallBridge === 'function'
        ? async (options: IMastraApprovalOptions): Promise<IMastraAgentStreamLike> =>
            resumeStream ? resumeStream({ approved: false }, options) : declineToolCallBridge.call(bridge, options)
        : undefined;

    return {
        stream: async (messages, options) => bridge.stream(messages, options),
        generate: async (messages, options) => bridge.generate(messages, options),
        ...(resumeStream ? { resumeStream } : {}),
        ...(approveToolCall ? { approveToolCall } : {}),
        ...(declineToolCall ? { declineToolCall } : {}),
    };
};

export const defaultCreateStorage = (): IMastraStorageLike => new LibSQLStore({
    id: 'builtin-agent-storage',
    url: resolveMastraStorageUrl(),
});

export const toAgentStreamLike = (streamResult: {
    fullStream: AsyncIterable<unknown>;
    runId?: string;
    cleanup?: () => void;
}): IMastraAgentStreamLike => ({
    fullStream: streamResult.fullStream,
    ...(streamResult.runId ? { runId: streamResult.runId } : {}),
    ...(streamResult.cleanup ? { cleanup: streamResult.cleanup } : {}),
});

export const createRegisteredAgentHandle = (
    config: IMastraAgentConfig,
    storage: IMastraStorageLike,
    loggerRef?: IMastraLogToolsRef,
): IMastraRegisteredAgentLike => {
    const fileLogger = createMastraFileLogger(
        process.env.BUILTIN_AGENT_LOG_FILE ?? DEFAULT_MASTRA_LOG_FILE,
    );
    if (loggerRef) {
        loggerRef.current = fileLogger;
    }
    const agent = new Agent({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model,
        ...(config.memory ? { memory: config.memory } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.workspace ? { workspace: config.workspace } : {}),
        ...(config.browser ? { browser: config.browser } : {}),
        ...(config.inputProcessors ? { inputProcessors: config.inputProcessors } : {}),
        ...(config.outputProcessors ? { outputProcessors: config.outputProcessors } : {}),
    });
    const mastra = new Mastra({
        agents: {
            [config.id]: agent,
        },
        ...(config.tools ? { tools: config.tools as never } : {}),
        storage: storage as never,
        logger: fileLogger,
        observability: createMastraObservability(),
    });

    return mastra.getAgentById(agent.id) as unknown as IMastraRegisteredAgentLike;
};

export const defaultCreateResumableAgentHandle = async (
    config: IMastraAgentConfig,
    storage: IMastraStorageLike,
    loggerRef?: IMastraLogToolsRef,
): Promise<IMastraResumableAgentHandle> => {
    const registeredAgent = createRegisteredAgentHandle(config, storage, loggerRef);

    return {
        agent: {
            stream: async (messages, options) => toAgentStreamLike(await registeredAgent.stream(messages, options)),
            generate: async (messages, options) => registeredAgent.generate(messages, options),
            resumeStream: async (resumeData, options) =>
                toAgentStreamLike(await registeredAgent.resumeStream(resumeData, options)),
            approveToolCall: async (options) =>
                toAgentStreamLike(await registeredAgent.approveToolCall(options)),
            declineToolCall: async (options) =>
                toAgentStreamLike(await registeredAgent.declineToolCall(options)),
        },
    };
};

export const defaultCreateExecutionHandle = async (
    config: IMastraAgentConfig,
    storage: IMastraStorageLike,
    loggerRef?: IMastraLogToolsRef,
): Promise<IMastraExecutionHandle> => {
    const fileLogger = createMastraFileLogger(
        process.env.BUILTIN_AGENT_LOG_FILE ?? DEFAULT_MASTRA_LOG_FILE,
    );
    if (loggerRef) {
        loggerRef.current = fileLogger;
    }
    // 官方 Supervisor 子 agent（默认关，AGENT_SUBAGENTS 开启）：把规划/改码/审查/检索
    // 四个子 agent 以 Agent.agents 形态挂到主 agent 上，子 agent 以「工具」形式被委派。
    // 仅在 autonomous 执行路径生效；关闭时下方 baseAgent 与原实现完全一致，可随时 git revert。
    const subAgents = isSubAgentsEnabled()
        ? buildCodingSubAgents({
            model: config.model,
            ...(config.memory ? { memory: config.memory } : {}),
            ...(config.tools ? { tools: config.tools } : {}),
            ...(config.workspace ? { workspace: config.workspace } : {}),
            ...(config.browser ? { browser: config.browser } : {}),
        })
        : undefined;
    // 官方文档：supervisor 靠自身 instructions + 子 agent description 决定委派。
    // 开启子 agent 时把委派说明追加到主 agent 指令尾部，使其真正会去委派；
    // 关闭时指令与原来完全一致。
    const instructions = subAgents
        ? `${config.instructions}\n\n${buildSupervisorDelegationInstructions()}`
        : config.instructions;
    const baseAgent = new Agent({
        id: config.id,
        name: config.name,
        instructions,
        model: config.model,
        ...(config.memory ? { memory: config.memory } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.workspace ? { workspace: config.workspace } : {}),
        ...(config.browser ? { browser: config.browser } : {}),
        ...(config.inputProcessors ? { inputProcessors: config.inputProcessors } : {}),
        ...(config.outputProcessors ? { outputProcessors: config.outputProcessors } : {}),
        ...(subAgents ? { agents: subAgents } : {}),
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    const mastra = new Mastra({
        agents: {
            [config.id]: durableAgent,
        },
        ...(config.tools ? { tools: config.tools as never } : {}),
        storage: storage as never,
        logger: fileLogger,
        observability: createMastraObservability(),
    });
    const registeredAgent = mastra.getAgentById(baseAgent.id) as unknown as IMastraDurableAgentLike;

    return {
        agent: {
            stream: async (messages, options) => {
                const streamResult = await registeredAgent.stream(messages, {
                    ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
                    ...(options?.runId ? { runId: options.runId } : {}),
                    ...(options?.maxSteps ? { maxSteps: options.maxSteps } : {}),
                    ...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
                    ...(options?.memory ? { memory: options.memory } : {}),
                    ...(options?.requestContext ? { requestContext: options.requestContext } : {}),
                });

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<TMastraStreamChunk>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
            generate: async () => {
                throw new Error('Durable execution handle does not support generate().');
            },
            approveToolCall: async ({ runId }) => {
                const streamResult = await registeredAgent.resume(runId, { approved: true });

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<TMastraStreamChunk>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
            declineToolCall: async ({ runId }) => {
                const streamResult = await registeredAgent.resume(runId, { approved: false });

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<TMastraStreamChunk>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
            resumeStream: async (resumeData, { runId }) => {
                const streamResult = await registeredAgent.resume(runId, resumeData);

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<TMastraStreamChunk>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
        },
        workflow: registeredAgent.getWorkflow(),
    };
};
