import type { ToolsInput } from '@mastra/core/agent';
import type { MastraBrowser } from '@mastra/core/browser';
import type { AnyWorkspace } from '@mastra/core/workspace';
import { createMcpGatewayRunBundle, type McpGatewayMetricBuffer, type McpGatewayWarmPool } from '../../tools/mcp-gateway.js';
import { createMastraLogTools, type IMastraLogToolsRef } from '../../tools/log.js';
import { createMastraTimeTools } from '../../tools/time.js';
import type { IAgentContextReferenceInput, IAgentRuntimeInput } from '../contracts/runtime-input.js';
import { countProviderToolSchemaChars } from '../budget/budget.js';
import { createMastraBrowser, createMastraToolLoadPlan, createMastraWorkspace } from '../workspace.js';
import type { IMastraMcpBundle, IMastraToolBudgetStats, TMastraToolProfile } from '../types.js';
import { createToolErrorCircuitBreaker } from './circuit-breaker.js';
import { createUiContextTools } from './read-current-file.js';

// 工具层装配入口：MCP 网关 + UI 上下文（read_current_file）+ 原生时间 + 日志工具，
// 统一套上「同类连续失败熔断」。各工具实现各自独立成文件（read-current-file / circuit-breaker /
// ../tools/time / ../tools/log / ../tools/mcp-gateway），本文件只负责编排与预算统计。
export { createUiContextTools, findCurrentFileReference } from './read-current-file.js';
export { createToolErrorCircuitBreaker, resolveToolFailureBucket } from './circuit-breaker.js';

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
