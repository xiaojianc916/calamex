import type { ToolsInput } from '@mastra/core/agent';
import type { MastraBrowser } from '@mastra/core/browser';
import { createTool } from '@mastra/core/tools';
import type { AnyWorkspace } from '@mastra/core/workspace';
import { z } from 'zod';
import { compactModelOutput, truncateModelOutputText } from '../../models/output-budget.js';
import { createMcpGatewayRunBundle, type McpGatewayMetricBuffer, type McpGatewayWarmPool } from '../../tools/mcp-gateway.js';
import { createMastraLogTools, type IMastraLogToolsRef } from '../../tools/log.js';
import { createMastraTimeTools } from '../../tools/time.js';
import type { IAgentContextReferenceInput, IAgentRuntimeInput } from '../contracts/runtime-input.js';
import { createJsonToolModelOutput, countProviderToolSchemaChars } from '../budget/budget.js';
import { createMastraBrowser, createMastraWorkspace } from '../workspace.js';
import { CURRENT_FILE_TOOL_CONTENT_MAX_CHARS, CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS, MAX_CONSECUTIVE_SIMILAR_TOOL_ERRORS, type IMastraMcpBundle, type IMastraToolBudgetStats, type TMastraToolProfile } from '../types.js';
import { isExecutableToolLike, toNonEmptyString, toRecord } from '../utils.js';
import { createMastraToolLoadPlan } from '../workspace.js';
import { formatWithLineNumbers } from './read-file-format.js';

export const findCurrentFileReference = (
    contextReferences: readonly IAgentContextReferenceInput[] = [],
): IAgentContextReferenceInput | null =>
    contextReferences.find((reference) => reference.kind === 'current-file') ?? null;

export const createUiContextTools = (
    contextReferences: readonly IAgentContextReferenceInput[] = [],
): Record<string, ReturnType<typeof createTool>> => {
    const currentFile = findCurrentFileReference(contextReferences);

    if (!currentFile) {
        return {};
    }

    return {
        read_current_file: createTool({
            id: 'read_current_file',
            description: 'Read a line-numbered preview of the current editor file (cat -n style: line numbers reflect the file\u0027s real line numbers). Use only when the user asks about the current file. Takes no arguments; output is capped \u2014 use the workspace read_file tool to load the full file or a specific line range.',
            inputSchema: z.object({}).passthrough(),
            execute: async () => {
                const preview = truncateModelOutputText(
                    currentFile.contentPreview,
                    CURRENT_FILE_TOOL_CONTENT_MAX_CHARS,
                    { includeNotice: false },
                );
                // 行号锚定到文件真实行号：引用自带行区间时以其起始行为基准，否则从第 1 行起。
                // 与 Zed read_file 的 cat -n 输出对齐，便于据此用 start_line/end_line 精确续读或编辑。
                const baseLine = currentFile.range?.startLine ?? 1;

                return {
                    path: currentFile.path,
                    label: currentFile.label,
                    range: currentFile.range,
                    redacted: currentFile.redacted,
                    content: formatWithLineNumbers(preview.text, baseLine),
                    truncated: preview.truncated,
                    originalCharCount: preview.originalCharCount,
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

export const resolveToolFailureBucket = (
    toolName: string,
    inputData: unknown,
): string => {
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

export const createToolErrorCircuitBreaker = (
    tools: ToolsInput,
): ToolsInput => {
    const consecutiveErrorCounts = new Map<string, number>();
    const wrappedTools: ToolsInput = {};

    for (const [toolName, tool] of Object.entries(tools)) {
        if (!isExecutableToolLike(tool)) {
            wrappedTools[toolName] = tool;
            continue;
        }

        const wrappedTool = { ...tool };
        wrappedTool.execute = async (inputData: unknown): Promise<unknown> => {
            const failureBucket = resolveToolFailureBucket(toolName, inputData);
            const failureCount = consecutiveErrorCounts.get(failureBucket) ?? 0;

            if (failureCount >= MAX_CONSECUTIVE_SIMILAR_TOOL_ERRORS) {
                throw new Error(
                    `同类工具 ${failureBucket} 已连续失败 ${failureCount} 次，已停止继续尝试。请更换工具、调整参数或先分析失败原因。`,
                );
            }

            try {
                const result = await tool.execute(inputData);
                consecutiveErrorCounts.delete(failureBucket);
                return result;
            } catch (error) {
                consecutiveErrorCounts.set(failureBucket, failureCount + 1);
                throw error;
            }
        };
        wrappedTools[toolName] = wrappedTool;
    }

    return wrappedTools;
};

export const loadMastraMcpTools = async (
    mcpGatewayPool: McpGatewayWarmPool,
    workspaceRootPath?: string,
    loggerRef?: IMastraLogToolsRef,
    contextReferences: readonly IAgentContextReferenceInput[] = [],
    profile: TMastraToolProfile = 'write',
    input: Pick<IAgentRuntimeInput, 'goal' | 'messages' | 'mode' | 'planId' | 'planStepId'> = {
        mode: 'ask',
        goal: '',
        messages: [],
    },
): Promise<{
    bundle: IMastraMcpBundle;
    tools: ToolsInput;
    hasTools: boolean;
    toolStats: IMastraToolBudgetStats;
    mcpGatewayMetrics: McpGatewayMetricBuffer;
    workspace: AnyWorkspace | undefined;
    browser: MastraBrowser | undefined;
}> => {
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
    const rawTools: ToolsInput = {
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
