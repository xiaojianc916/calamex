import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { compactModelOutput, truncateModelOutputText } from '../../models/output-budget.js';
import { createMcpGatewayRunBundle } from '../../tools/mcp-gateway.js';
import { createMastraLogTools } from '../../tools/log.js';
import { createMastraTimeTools } from '../../tools/time.js';
import { createJsonToolModelOutput, countProviderToolSchemaChars } from '../budget/budget.js';
import { createMastraBrowser, createMastraWorkspace } from '../workspace.js';
import { CURRENT_FILE_TOOL_CONTENT_MAX_CHARS, CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS, MAX_CONSECUTIVE_SIMILAR_TOOL_ERRORS } from '../types.js';
import { isExecutableToolLike, toNonEmptyString, toRecord } from '../utils.js';
import { createMastraToolLoadPlan } from '../workspace.js';
export const findCurrentFileReference = (contextReferences = []) => contextReferences.find((reference) => reference.kind === 'current-file') ?? null;
export const createUiContextTools = (contextReferences = []) => {
    const currentFile = findCurrentFileReference(contextReferences);
    if (!currentFile) {
        return {};
    }
    return {
        read_current_file: createTool({
            id: 'read_current_file',
            description: 'Read the current editor file preview only when the user asks about the current file. Takes no arguments; output is capped, use mastra_workspace_read_file with line ranges when more content is needed.',
            inputSchema: z.object({}).passthrough(),
            execute: async () => {
                const content = truncateModelOutputText(currentFile.contentPreview, CURRENT_FILE_TOOL_CONTENT_MAX_CHARS);
                return {
                    path: currentFile.path,
                    label: currentFile.label,
                    range: currentFile.range,
                    redacted: currentFile.redacted,
                    content: content.text,
                    truncated: content.truncated,
                    originalCharCount: content.originalCharCount,
                };
            },
            toModelOutput: (output) => createJsonToolModelOutput(compactModelOutput(output, {
                maxTotalChars: CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS,
                maxStringChars: CURRENT_FILE_TOOL_CONTENT_MAX_CHARS,
                maxArrayItems: 10,
                maxObjectKeys: 20,
                maxDepth: 4,
            })),
        }),
    };
};
export const resolveToolFailureBucket = (toolName, inputData) => {
    if (toolName === 'mcp_call_tool') {
        const record = toRecord(inputData);
        const serverName = toNonEmptyString(record?.serverName) ?? 'unknown-server';
        const delegatedToolName = toNonEmptyString(record?.toolName) ?? 'unknown-tool';
        return `${toolName}:${serverName}:${delegatedToolName}`;
    }
    if (toolName === 'mcp_list_tools') {
        const record = toRecord(inputData);
        const serverName = toNonEmptyString(record?.serverName) ?? 'all';
        return `${toolName}:${serverName}`;
    }
    return toolName;
};
export const createToolErrorCircuitBreaker = (tools) => {
    const consecutiveErrorCounts = new Map();
    const wrappedTools = {};
    for (const [toolName, tool] of Object.entries(tools)) {
        if (!isExecutableToolLike(tool)) {
            wrappedTools[toolName] = tool;
            continue;
        }
        const wrappedTool = { ...tool };
        wrappedTool.execute = async (inputData) => {
            const failureBucket = resolveToolFailureBucket(toolName, inputData);
            const failureCount = consecutiveErrorCounts.get(failureBucket) ?? 0;
            if (failureCount >= MAX_CONSECUTIVE_SIMILAR_TOOL_ERRORS) {
                throw new Error(`同类工具 ${failureBucket} 已连续失败 ${failureCount} 次，已停止继续尝试。请更换工具、调整参数或先分析失败原因。`);
            }
            try {
                const result = await tool.execute(inputData);
                consecutiveErrorCounts.delete(failureBucket);
                return result;
            }
            catch (error) {
                consecutiveErrorCounts.set(failureBucket, failureCount + 1);
                throw error;
            }
        };
        wrappedTools[toolName] = wrappedTool;
    }
    return wrappedTools;
};
export const loadMastraMcpTools = async (mcpGatewayPool, workspaceRootPath, loggerRef, contextReferences = [], profile = 'write', input = {
    mode: 'ask',
    goal: '',
    messages: [],
}) => {
    const toolLoadPlan = createMastraToolLoadPlan(input, workspaceRootPath, contextReferences);
    const bundle = createMcpGatewayRunBundle();
    const workspace = toolLoadPlan.workspaceEnabled
        ? await createMastraWorkspace(workspaceRootPath, profile)
        : undefined;
    const browser = toolLoadPlan.browserEnabled ? createMastraBrowser() : undefined;
    const mcpGatewayMetrics = mcpGatewayPool.createMetricBuffer();
    const mcpGatewayTools = mcpGatewayPool.createTools({
        ...(workspaceRootPath ? { workspaceRootPath } : {}),
        profile,
        metricSink: mcpGatewayMetrics,
    });
    const uiContextTools = createUiContextTools(contextReferences);
    const nativeTimeTools = createMastraTimeTools();
    const logTools = loggerRef ? createMastraLogTools(loggerRef) : {};
    const rawTools = {
        ...mcpGatewayTools,
        ...uiContextTools,
        ...nativeTimeTools,
        ...logTools,
    };
    const tools = createToolErrorCircuitBreaker(rawTools);
    return {
        bundle,
        tools,
        hasTools: Object.keys(tools).length > 0,
        toolStats: {
            toolCount: Object.keys(tools).length,
            mcpToolCount: Object.keys(mcpGatewayTools).length,
            mcpServerCount: 0,
            mcpServerNames: [],
            uiContextToolCount: Object.keys(uiContextTools).length,
            nativeToolCount: Object.keys(nativeTimeTools).length + (workspace ? 1 : 0),
            logToolCount: Object.keys(logTools).length,
            toolSchemaCharCount: countProviderToolSchemaChars(tools),
            toolLoadStrategy: toolLoadPlan.strategy,
        },
        mcpGatewayMetrics,
        workspace,
        browser,
    };
};
