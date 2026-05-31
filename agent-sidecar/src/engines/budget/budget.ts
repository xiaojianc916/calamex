import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import type { IDeepSeekRequestPayloadStats } from '../../models/providers/deepseek-reasoning-fetch.js';
import type { IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { IAgentContextReferenceInput } from '../contracts/runtime-input.js';
import { pushUiEvent, toRecord } from '../utils.js';
import type { IMastraToolBudgetStats, TAcontextProviderPayloadEventDraft, TAcontextTokenEventDraft, TMastraChatMessage, TRuntimeEventFactory } from '../types.js';
import { countJsonChars, countTextChars, estimateInputTokensByChars, stringifyForJson } from '../../text-metrics.js';

// Char/token helpers now live in ../../text-metrics.js. Re-exported here so the
// existing import surface of this module is preserved.
export { countJsonChars, countTextChars, estimateInputTokensByChars };
export const stringifyForBudget = stringifyForJson;

export const createJsonToolModelOutput = (value: unknown): { type: 'json'; value: unknown } => ({
    type: 'json',
    value,
});

export const EMPTY_TOOL_PARAMETERS = {
    type: 'object',
    properties: {},
    additionalProperties: false,
} as const;

export const isZodSchemaLike = (value: unknown): value is z.ZodType<unknown> => {
    const record = toRecord(value);

    return typeof record?.parse === 'function'
        && typeof record?.safeParse === 'function';
};

export const convertToolInputSchemaForBudget = (schema: unknown): unknown => {
    if (!schema) {
        return EMPTY_TOOL_PARAMETERS;
    }

    const schemaRecord = toRecord(schema);
    if (schemaRecord && 'jsonSchema' in schemaRecord) {
        return schemaRecord.jsonSchema;
    }

    if (isZodSchemaLike(schema)) {
        try {
            return z.toJSONSchema(schema);
        } catch {
            return EMPTY_TOOL_PARAMETERS;
        }
    }

    return schema;
};

export const createProviderToolBudgetShape = (
    name: string,
    tool: unknown,
): {
    type: 'function';
    name: string;
    description?: string;
    parameters: unknown;
} => {
    const toolRecord = toRecord(tool);
    const description = typeof toolRecord?.description === 'string'
        ? toolRecord.description
        : undefined;
    const inputSchema = toolRecord && 'inputSchema' in toolRecord
        ? toolRecord.inputSchema
        : toolRecord?.parameters;

    return {
        type: 'function',
        name,
        ...(description ? { description } : {}),
        parameters: convertToolInputSchemaForBudget(inputSchema),
    };
};

export const countProviderToolSchemaChars = (tools: ToolsInput): number =>
    countJsonChars(Object.entries(tools).map(([name, tool]) =>
        createProviderToolBudgetShape(name, tool),
    ));

export const createAcontextTokenEventDraft = (input: {
    systemPrompt: string;
    messages: readonly TMastraChatMessage[];
    contextReferences: readonly IAgentContextReferenceInput[];
    tools: ToolsInput;
    toolStats: IMastraToolBudgetStats;
    workspaceEnabled: boolean;
    browserEnabled: boolean;
    memoryEnabled: boolean;
    maxSteps: number;
    toolChoice: 'auto' | 'none';
}): TAcontextTokenEventDraft => {
    const messagesText = stringifyForBudget(input.messages);
    const toolsText = stringifyForBudget(Object.entries(input.tools).map(([name, tool]) =>
        createProviderToolBudgetShape(name, tool),
    ));
    const systemPromptCharCount = countTextChars(input.systemPrompt);
    const messageCharCount = countTextChars(messagesText);
    const toolSchemaCharCount = input.toolStats.toolSchemaCharCount;
    const contextCharCount = countJsonChars(input.contextReferences);
    const inputText = [
        input.systemPrompt,
        messagesText,
        toolsText,
    ].join('\n');

    return {
        type: 'acontext.token.checked',
        visibility: 'debug',
        level: 'info',
        projectedInputTokens: estimateInputTokensByChars(inputText),
        inputCharCount: systemPromptCharCount + messageCharCount + toolSchemaCharCount,
        systemPromptCharCount,
        messageCharCount,
        contextCharCount,
        toolSchemaCharCount,
        toolCount: input.toolStats.toolCount,
        mcpToolCount: input.toolStats.mcpToolCount,
        mcpServerCount: input.toolStats.mcpServerCount,
        uiContextToolCount: input.toolStats.uiContextToolCount,
        nativeToolCount: input.toolStats.nativeToolCount,
        logToolCount: input.toolStats.logToolCount,
        mcpServerNames: input.toolStats.mcpServerNames,
        toolLoadStrategy: input.toolStats.toolLoadStrategy,
        workspaceEnabled: input.workspaceEnabled,
        browserEnabled: input.browserEnabled,
        memoryEnabled: input.memoryEnabled,
        maxSteps: input.maxSteps,
        toolChoice: input.toolChoice,
        tokenEstimateMethod: 'char_heuristic',
    };
};

export const createAcontextProviderPayloadEventDraft = (
    stats: IDeepSeekRequestPayloadStats,
    requestIndex: number,
): TAcontextProviderPayloadEventDraft => ({
    type: 'acontext.provider_payload.checked',
    visibility: 'debug',
    level: 'info',
    provider: stats.provider,
    ...(stats.model ? { model: stats.model } : {}),
    ...(stats.stream !== undefined ? { stream: stats.stream } : {}),
    requestIndex,
    requestBodyCharCount: stats.requestBodyCharCount,
    projectedInputTokens: stats.projectedInputTokens,
    messageCharCount: stats.messageCharCount,
    systemMessageCharCount: stats.systemMessageCharCount,
    userMessageCharCount: stats.userMessageCharCount,
    assistantMessageCharCount: stats.assistantMessageCharCount,
    toolMessageCharCount: stats.toolMessageCharCount,
    reasoningReplayCharCount: stats.reasoningReplayCharCount,
    toolSchemaCharCount: stats.toolSchemaCharCount,
    toolCount: stats.toolCount,
    responseFormatCharCount: stats.responseFormatCharCount,
    reasoningInjected: stats.reasoningInjected,
    tokenEstimateMethod: 'char_heuristic',
});

export const createDeepSeekPayloadEventSink = (
    events: TAgentRuntimeOutputEvent[],
    options: IAgentRuntimeRunOptions,
): {
    onRequestPayload: (stats: IDeepSeekRequestPayloadStats) => void;
    attachRuntimeEventFactory: (factory: TRuntimeEventFactory) => void;
} => {
    const pending: TAcontextProviderPayloadEventDraft[] = [];
    let runtimeEventFactory: TRuntimeEventFactory | null = null;
    let requestIndex = 0;

    const pushDraft = (draft: TAcontextProviderPayloadEventDraft): void => {
        if (!runtimeEventFactory) {
            pending.push(draft);
            return;
        }

        pushUiEvent(events, runtimeEventFactory(draft), options);
    };

    return {
        onRequestPayload: (stats) => {
            requestIndex += 1;
            pushDraft(createAcontextProviderPayloadEventDraft(stats, requestIndex));
        },
        attachRuntimeEventFactory: (factory) => {
            runtimeEventFactory = factory;

            while (pending.length > 0) {
                const draft = pending.shift();

                if (draft) {
                    pushUiEvent(events, runtimeEventFactory(draft), options);
                }
            }
        },
    };
};
