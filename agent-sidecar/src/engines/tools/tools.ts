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
import { createAskUserTools } from './ask-user.js';
import { createUpdatePlanTools, resolvePlanFilePath } from './update-plan.js';
import { createExitPlanTools } from './exit-plan.js';

// 工具层装配入口：MCP 网关 + UI 上下文（read_current_file）+ 反向提问（ask_user, 仅 plan/agent）
// + 规划工具（update_plan / exit_plan, 仅 plan）+ 原生时间 + 日志工具，统一套上「同类连续失败熔断」。
// 各工具实现各自独立成文件（read-current-file / ask-user / update-plan / exit-plan / circuit-breaker /
// ../tools/time / ../tools/log / ../tools/mcp-gateway），本文件只负责编排与预算统计。
export { createUiContextTools, findCurrentFileReference } from './read-current-file.js';
export { createAskUserTools } from './ask-user.js';
export type { TAskUserInput, TAskUserRequest, TAskUserResult, TSurfacedQuestion, TQuestionType, TAskUserOutcome } from './ask-user.js';
export { createUpdatePlanTools, resolvePlanFilePath } from './update-plan.js';
export type { TUpdatePlanInput, TUpdatePlanResult } from './update-plan.js';
export { createExitPlanTools } from './exit-plan.js';
export type { TExitPlanInput, TExitPlanResult } from './exit-plan.js';
export { createToolErrorCircuitBreaker, resolveToolFailureBucket } from './circuit-breaker.js';

// ask_user（AI 反向提问 / HITL）仅在 plan 与 agent 模式启用：
// 这两类是「人值守的多步执行」模式，反向提问才有意义；ask（轻量对话）与 patch/review 不挂载。
const isAskUserEnabledMode = (mode: IAgentRuntimeInput['mode']): boolean =>
    mode === 'plan' || mode === 'agent';

// 规划工具（update_plan 写 living PLAN.md + exit_plan 终止规划、交接执行）仅在 plan 模式启用：
// 对标 OpenHands get_planning_tools —— 规划阶段专属工具，agent/ask/patch/review 不挂载。
const isPlanToolEnabledMode = (mode: IAgentRuntimeInput['mode']): boolean =>
    mode === 'plan';

export const loadMastraMcpTools = async (
    mcpGatewayPool: McpGatewayWarmPool,
    workspaceRootPath?: string,
    loggerRef?: IMastraLogToolsRef,
    contextReferences: readonly IAgentContextReferenceInput[] = [],
    profile: TMastraToolProfile = 'write',
    input: Pick<IAgentRuntimeInput, 'goal' | 'messages' | 'mode' | 'threadId' | 'planId' | 'planStepId'> = {
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
    // 反向提问工具：仅 plan/agent 模式挂载（其余模式为空记录，nativeToolCount 自然计入 0）。
    const askUserTools = isAskUserEnabledMode(input.mode) ? createAskUserTools() : {};
    // 规划工具：仅 plan 模式挂载。update_plan / exit_plan 共用同一 PLAN.md 路径（写入与解析必须一致）；
    // 路径优先落在工作区内，且工具自带独立 fs 写权限，绕过 readonly workspace（PlanningFileEditorTool 模型）。
    const planTools = isPlanToolEnabledMode(input.mode)
        ? ((): ToolsInput => {
              const planFilePath = resolvePlanFilePath({
                  workspaceRootPath,
                  threadId: input.threadId,
              });
              return {
                  ...createUpdatePlanTools(planFilePath),
                  ...createExitPlanTools(planFilePath),
              };
          })()
        : {};
    const nativeTimeTools = createMastraTimeTools();
    const logTools = loggerRef ? createMastraLogTools(loggerRef) : {};
    const rawTools: ToolsInput = {
        ...mcpGatewayTools,
        ...uiContextTools,
        ...askUserTools,
        ...planTools,
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
            nativeToolCount:
                Object.keys(nativeTimeTools).length +
                Object.keys(askUserTools).length +
                Object.keys(planTools).length +
                (workspace ? 1 : 0),
            logToolCount: Object.keys(logTools).length,
            toolSchemaCharCount: countProviderToolSchemaChars(tools),
            toolLoadStrategy: toolLoadPlan.strategy,
        },
        mcpGatewayMetrics,
        workspace,
        browser,
    };
};
