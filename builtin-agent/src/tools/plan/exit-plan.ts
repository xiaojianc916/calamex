import { existsSync, readFileSync } from 'node:fs';
import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createJsonToolModelOutput } from '../../engines/budget/budget.js';
import { parsePlanSteps } from './update-plan.js';

/**
 * exit_plan —— 规划循环终止符（方案 A，纯 OpenHands 式 living PLAN.md 的收尾）。
 *
 * 设计取舍（对标成熟实现，不自创逻辑）：
 * - 形态/语义 ← Claude Code `ExitPlanMode`：呈现已成形的计划、标记规划完成并请求从
 *   plan 切到执行（act）。Claude 的 ExitPlanMode 入参即 plan 文本；本仓 plan 已落在
 *   living PLAN.md，故此处只带可选 summary，计划本体由 PLAN.md 承载。
 * - 不自带审批 ← 复用本仓既有审批门（approval_required 事件 → 前端确认 → sidecarResolveApproval
 *   续跑）：exit_plan 仅作为「planning agent 循环」的终止信号，真正的 approve→act 由
 *   既有审批门处理，杜绝双重审批与新旧杂簅。
 * - 交接校验：exit_plan 校验 PLAN.md 已落地且能解析出 ≥1 个 stepId（共用 update-plan 的
 *   parsePlanSteps），保证交给执行阶段时是有效计划；否则报错引导模型先 update_plan 补全。
 * - 编写范式 ← 本仓 ask-user.ts / update-plan.ts。
 */

const exitPlanInputSchema = z.object({
    summary: z
        .string()
        .optional()
        .describe('Optional one-line summary of what the finalized plan accomplishes (PLAN.md holds the full plan).'),
});

export type TExitPlanInput = z.infer<typeof exitPlanInputSchema>;

const exitPlanOutputSchema = z.object({
    ready: z.boolean(),
    path: z.string(),
    stepCount: z.number(),
    steps: z.array(z.string()),
    summary: z.string().optional(),
    display: z.string(),
});

export type TExitPlanResult = z.infer<typeof exitPlanOutputSchema>;

export const createExitPlanTool = (planFilePath: string): ReturnType<typeof createTool> =>
    createTool({
        id: 'exit_plan',
        description: [
            'Finish planning and hand the plan off for execution (exit plan mode).',
            'Call this ONLY after PLAN.md is complete via update_plan and its Steps section lists every actionable step.',
            'The plan itself lives in PLAN.md; pass an optional one-line summary.',
            'After this call, the user is asked to approve switching from planning to execution — do not keep planning.',
        ].join(' '),
        inputSchema: exitPlanInputSchema,
        outputSchema: exitPlanOutputSchema,
        execute: async (inputData) => {
            if (!existsSync(planFilePath)) {
                throw new Error(
                    `exit_plan：PLAN.md 尚不存在（${planFilePath}）。请先用 update_plan 写入计划，并确保有可解析的 Steps。`,
                );
            }

            const content = readFileSync(planFilePath, 'utf-8');
            const steps = parsePlanSteps(content);
            if (steps.length === 0) {
                throw new Error(
                    "exit_plan：PLAN.md 缺少可解析的步骤。请先用 update_plan 在 'Steps' 区以有序列表写出每个步骤（一项一步），再 exit_plan。",
                );
            }

            const summary = inputData.summary?.trim();
            const display = [
                `**Plan ready for execution** (${steps.length} step${steps.length > 1 ? 's' : ''})`,
                ...(summary ? [summary] : []),
            ].join('\n');

            return {
                ready: true,
                path: planFilePath,
                stepCount: steps.length,
                steps,
                ...(summary ? { summary } : {}),
                display,
            };
        },
        toModelOutput: (output) => createJsonToolModelOutput(output),
    });

// 工具装配入口（与 createUpdatePlanTools / createAskUserTools 同构，返回工具记录）。
export const createExitPlanTools = (planFilePath: string): ToolsInput => ({
    exit_plan: createExitPlanTool(planFilePath),
});
