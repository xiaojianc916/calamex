import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod/v3';
import type { IAgentModelCapabilities } from '../../models/capabilities.js';
import type { IAgentContextReferenceInput } from '../contracts/runtime-input.js';
import { toRecord } from '../shared/utils.js';
import type { IMastraToolBudgetStats, TAcontextTokenEventDraft, TMastraChatMessage } from '../shared/types.js';
import { countJsonChars, countTextChars, estimateInputTokensByChars, stringifyForJson } from '../../text-metrics.js';
import { resolveContextBudgetDecision } from './context-budget-policy.js';
import { resolveContextManagementStrategy } from './context-strategy-policy.js';

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

// z.toJSONSchema is comparatively expensive and the same tool schema is
// converted repeatedly within a single agent run (token estimation in
// createAcontextTokenEventDraft and provider-shape building in
// countProviderToolSchemaChars both walk the same tools). Schema objects are
// stable for a tool's lifetime, so a WeakMap keyed by the schema object lets
// repeated conversions reuse the first result and is reclaimed automatically
// when the tool is gone.
const toolInputSchemaCache = new WeakMap<object, unknown>();

const computeToolInputSchemaForBudget = (schema: unknown): unknown => {
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

export const convertToolInputSchemaForBudget = (schema: unknown): unknown => {
    if (!schema) {
        return EMPTY_TOOL_PARAMETERS;
    }

    if (typeof schema === 'object') {
        const cached = toolInputSchemaCache.get(schema);
        if (cached !== undefined) {
            return cached;
        }
    }

    const converted = computeToolInputSchemaForBudget(schema);

    if (typeof schema === 'object') {
        toolInputSchemaCache.set(schema, converted);
    }

    return converted;
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
    observationalMemoryEnabled?: boolean | undefined;
    semanticRecallEnabled?: boolean | undefined;
    maxSteps: number;
    toolChoice: 'auto' | 'none';
    modelCapabilities?: Pick<IAgentModelCapabilities, 'contextWindowTokens' | 'maxOutputTokens'> | undefined;
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
    const projectedInputTokens = estimateInputTokensByChars(inputText);
    const observationalMemoryEnabled = input.observationalMemoryEnabled ?? false;
    const semanticRecallEnabled = input.semanticRecallEnabled ?? false;
    const contextBudget = input.modelCapabilities
        ? resolveContextBudgetDecision({
            projectedInputTokens,
            capabilities: input.modelCapabilities,
        })
        : null;
    const contextStrategy = contextBudget
        ? resolveContextManagementStrategy({
            contextBudgetDecision: contextBudget.kind,
            mastraMemoryEnabled: input.memoryEnabled,
            observationalMemoryEnabled,
            semanticRecallEnabled,
        })
        : null;

    return {
        type: 'acontext.token.checked',
        visibility: 'debug',
        level: 'info',
        projectedInputTokens,
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
        observationalMemoryEnabled,
        semanticRecallEnabled,
        maxSteps: input.maxSteps,
        toolChoice: input.toolChoice,
        tokenEstimateMethod: 'char_heuristic',
        ...(contextBudget ? {
            contextWindowTokens: contextBudget.contextWindowTokens,
            maxOutputTokens: contextBudget.maxOutputTokens,
            availableInputTokens: contextBudget.availableInputTokens,
            remainingInputTokens: contextBudget.remainingInputTokens,
            compactionRemainingTokenBudget: contextBudget.compactionRemainingTokenBudget,
            compactionSupported: contextBudget.compactionSupported,
            contextBudgetDecision: contextBudget.kind,
            retainedUserMessageByteBudget: contextBudget.retainedUserMessageByteBudget,
        } : {}),
        ...(contextStrategy ? {
            contextManagementOwner: contextStrategy.owner,
            shouldRunZedStyleCompaction: contextStrategy.shouldRunZedStyleCompaction,
            shouldRelyOnMastraMemory: contextStrategy.shouldRelyOnMastraMemory,
            contextManagementReason: contextStrategy.reason,
        } : {}),
    };
};
