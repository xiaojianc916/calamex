import { Agent } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { createMastraModelConfigFromRequest, createMastraObserverModelConfig, createMastraReflectorModelConfig } from '../../models/config.js';
import { createMastraFileLogger } from '../../tools/log.js';
import { createMastraAgentMemory, resolveMastraStorageUrl } from '../context/memory.js';
import { createMastraObservability } from '../workspace.js';
import { DEFAULT_MASTRA_LOG_FILE } from '../types.js';
export const createMastraModelConfig = (model) => model.model;
export const resolveMastraModelConfig = (readModelConfig, requestModelConfig) => createMastraModelConfigFromRequest(requestModelConfig) ?? readModelConfig();
export const createMastraMemoryForModel = (model) => createMastraAgentMemory(resolveMastraStorageUrl(), {
    observer: createMastraModelConfig(createMastraObserverModelConfig(model)),
    reflector: createMastraModelConfig(createMastraReflectorModelConfig(model)),
});
export const defaultCreateAgent = (config) => {
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
    const bridge = agent;
    const resumeStreamBridge = bridge.resumeStream;
    const resumeStream = typeof resumeStreamBridge === 'function'
        ? async (resumeData, options) => resumeStreamBridge.call(bridge, resumeData, options)
        : undefined;
    const approveToolCallBridge = bridge.approveToolCall;
    const approveToolCall = typeof approveToolCallBridge === 'function'
        ? async (options) => resumeStream ? resumeStream({ approved: true }, options) : approveToolCallBridge.call(bridge, options)
        : undefined;
    const declineToolCallBridge = bridge.declineToolCall;
    const declineToolCall = typeof declineToolCallBridge === 'function'
        ? async (options) => resumeStream ? resumeStream({ approved: false }, options) : declineToolCallBridge.call(bridge, options)
        : undefined;
    return {
        stream: async (messages, options) => bridge.stream(messages, options),
        generate: async (messages, options) => bridge.generate(messages, options),
        ...(resumeStream ? { resumeStream } : {}),
        ...(approveToolCall ? { approveToolCall } : {}),
        ...(declineToolCall ? { declineToolCall } : {}),
    };
};
export const defaultCreateStorage = () => new LibSQLStore({
    id: 'agent-sidecar-storage',
    url: resolveMastraStorageUrl(),
});
export const toAgentStreamLike = (streamResult) => ({
    fullStream: streamResult.fullStream,
    ...(streamResult.runId ? { runId: streamResult.runId } : {}),
    ...(streamResult.cleanup ? { cleanup: streamResult.cleanup } : {}),
});
export const createRegisteredAgentHandle = (config, storage, loggerRef) => {
    const fileLogger = createMastraFileLogger(process.env.AGENT_SIDECAR_LOG_FILE ?? DEFAULT_MASTRA_LOG_FILE);
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
        ...(config.tools ? { tools: config.tools } : {}),
        storage: storage,
        logger: fileLogger,
        observability: createMastraObservability(),
    });
    return mastra.getAgentById(agent.id);
};
export const defaultCreateResumableAgentHandle = async (config, storage, loggerRef) => {
    const registeredAgent = createRegisteredAgentHandle(config, storage, loggerRef);
    return {
        agent: {
            stream: async (messages, options) => toAgentStreamLike(await registeredAgent.stream(messages, options)),
            generate: async (messages, options) => registeredAgent.generate(messages, options),
            resumeStream: async (resumeData, options) => toAgentStreamLike(await registeredAgent.resumeStream(resumeData, options)),
            approveToolCall: async (options) => toAgentStreamLike(await registeredAgent.approveToolCall(options)),
            declineToolCall: async (options) => toAgentStreamLike(await registeredAgent.declineToolCall(options)),
        },
    };
};
export const defaultCreateExecutionHandle = async (config, storage, loggerRef) => {
    const fileLogger = createMastraFileLogger(process.env.AGENT_SIDECAR_LOG_FILE ?? DEFAULT_MASTRA_LOG_FILE);
    if (loggerRef) {
        loggerRef.current = fileLogger;
    }
    const baseAgent = new Agent({
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
    const durableAgent = createDurableAgent({ agent: baseAgent });
    const mastra = new Mastra({
        agents: {
            [config.id]: durableAgent,
        },
        ...(config.tools ? { tools: config.tools } : {}),
        storage: storage,
        logger: fileLogger,
        observability: createMastraObservability(),
    });
    const registeredAgent = mastra.getAgentById(baseAgent.id);
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
                    fullStream: streamResult.fullStream,
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
                    fullStream: streamResult.fullStream,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
            declineToolCall: async ({ runId }) => {
                const streamResult = await registeredAgent.resume(runId, { approved: false });
                return {
                    fullStream: streamResult.fullStream,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
            resumeStream: async (resumeData, { runId }) => {
                const streamResult = await registeredAgent.resume(runId, resumeData);
                return {
                    fullStream: streamResult.fullStream,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
        },
        workflow: registeredAgent.getWorkflow(),
    };
};
