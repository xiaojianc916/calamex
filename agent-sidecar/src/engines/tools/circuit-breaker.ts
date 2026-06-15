import type { ToolsInput } from '@mastra/core/agent';
import { MAX_CONSECUTIVE_SIMILAR_TOOL_ERRORS } from '../types.js';
import { isExecutableToolLike, toNonEmptyString, toRecord } from '../utils.js';

// 为同一类工具的连续失败设熔断阈值，避免模型对同一失败反复重试浪费上下文与时间。
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
        wrappedTool.execute = async (inputData: unknown, ...rest: unknown[]): Promise<unknown> => {
            const failureBucket = resolveToolFailureBucket(toolName, inputData);
            const failureCount = consecutiveErrorCounts.get(failureBucket) ?? 0;

            if (failureCount >= MAX_CONSECUTIVE_SIMILAR_TOOL_ERRORS) {
                throw new Error(
                    `同类工具 ${failureBucket} 已连续失败 ${failureCount} 次，已停止继续尝试。请更换工具、调整参数或先分析失败原因。`,
                );
            }

            try {
                const result = await tool.execute(inputData, ...rest);
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
