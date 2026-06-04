import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
/**
 * Phase 1：用原生 Mastra Workflow 收编 plan→execute→validate→replan 主编排。
 *
 * 设计原则（与「彻底替换」终态对齐）：
 * - 每个 step 只委托给 `deps` 暴露的现有逻辑（plan / approve / execute / validate / replan / finish）。
 * - 审批门禁用原生 suspend/resume 取代「跨 HTTP 请求 + planWorkflowStore.suspend」。
 *
 * 控制流：
 *   generatePlan → approvalGate(suspend/resume)
 *     → .dountil(executeValidateReplan, 直到 被拒 || 验证通过 || 失败)
 *     → finish
 * executeValidateReplan 单步内部：逐步执行所有 step → validate → 需要则 replan(新版本, cursor 归零)。
 *   （之前用嵌套子 workflow 会触发 exactOptionalPropertyTypes 下 Workflow→Step 类型不兼容，故改为单步 + JS 循环。）
 *
 * Phase 2c-2：工具级审批挂起（方案A·统一 resume 通道）。
 * executeValidateReplan 内任一 step 触发工具审批（executeStep 返回 'suspended'）时，
 * 冒泡为 workflow 级 suspend()，把断点（cursor/stepId/requestId）写入 suspendData；
 * 由 server 的 resume 路由（与 plan 审批共用）经 deps.resolveToolApproval 续跑内层 agent。
 *
 * Phase 2d：逐步闸门（step_gate）——原生 suspend/resume 实现「运行/暂停/单步/继续/取消」。
 * 在 while 循环里每个 step 执行前先 suspend({ reason:'step_gate' })，交由前端的恢复策略驱动：
 *   运行=每个闸门自动 resume('continue')；暂停=不恢复（停在下个闸门）；
 *   单步=手动 resume('continue') 一次；继续=恢复自动恢复；取消=resume('cancel')。
 * 因 Mastra resume 会整段重跑 execute，本步做成可重入：cursor 从 suspendData 恢复；
 * 用 gateClearedForCursor 保证一次 'continue' 恰好执行一个 step，然后在下个 cursor 处重新设闸。
 */
// 重规划次数上限，防止验证反复失败时无限循环。
const MAX_REPLANS = 3;
export const PLAN_ORCHESTRATION_WORKFLOW_ID = 'calamex-plan-orchestration';
// 在步骤之间流转的统一上下文（每个 step 的 output 即下个 step 的 input）
const cycleContextSchema = z.object({
    planId: z.string().min(1),
    version: z.number().int().positive(),
    threadId: z.string().min(1),
    stepIds: z.array(z.string().min(1)),
    cursor: z.number().int().nonnegative(), // 下一个待执行 step 的下标
    rejected: z.boolean(),
    validationPassed: z.boolean(),
    failed: z.boolean(),
    replanCount: z.number().int().nonnegative(),
    lastSummary: z.string().nullable(),
});
const workflowInputSchema = z.object({
    goal: z.string().min(1),
    threadId: z.string().min(1).nullable(),
});
const workflowOutputSchema = z.object({
    planId: z.string().min(1),
    version: z.number().int().positive(),
    finalStatus: z.enum(['completed', 'failed', 'rejected']),
    summary: z.string().nullable(),
});
// resume 时前端回填的决定。三处挂起共用此同构 schema：
// - 计划审批门：approve / reject（cancel 视同 reject）
// - 工具级审批：approve / reject（cancel 视同 reject 并中止）
// - 逐步闸门：continue（放行下一步）/ cancel（中止整轮执行）
const resumeDecisionSchema = z.object({
    decision: z.enum(['approve', 'reject', 'continue', 'cancel']),
    reason: z.string().min(1).optional(),
});
const createStepEmit = (writer) => (event) => {
    try {
        const result = writer?.write(event);
        if (result && typeof result.then === 'function') {
            result.catch(() => { });
        }
    }
    catch {
        // best-effort streaming: ignore writer errors
    }
};
export const createPlanOrchestrationWorkflow = (deps) => {
    const generatePlanStep = createStep({
        id: 'generate-plan',
        inputSchema: workflowInputSchema,
        outputSchema: cycleContextSchema,
        execute: async ({ inputData, writer }) => {
            const emit = createStepEmit(writer);
            const plan = await deps.generatePlan({
                goal: inputData.goal,
                threadId: inputData.threadId,
            }, emit);
            return {
                ...plan,
                cursor: 0,
                rejected: false,
                validationPassed: false,
                failed: false,
                replanCount: 0,
                lastSummary: null,
            };
        },
    });
    const approvalGateStep = createStep({
        id: 'approval-gate',
        inputSchema: cycleContextSchema,
        outputSchema: cycleContextSchema,
        resumeSchema: resumeDecisionSchema,
        execute: async ({ inputData, resumeData, suspend }) => {
            if (!resumeData) {
                await suspend({
                    reason: 'plan_approval',
                    planId: inputData.planId,
                    version: inputData.version,
                });
                return inputData; // 挂起后此返回值不被消费
            }
            // 计划审批门：reject / cancel 都按拒绝处理；approve / continue 视为批准。
            if (resumeData.decision === 'reject' || resumeData.decision === 'cancel') {
                await deps.rejectPlan({
                    planId: inputData.planId,
                    version: inputData.version,
                    ...(resumeData.reason ? { reason: resumeData.reason } : {}),
                });
                return { ...inputData, rejected: true };
            }
            await deps.approvePlan({ planId: inputData.planId, version: inputData.version });
            return inputData;
        },
    });
    // 一轮「逐步执行所有 step → 验证 → 需要则重规划」。外层 .dountil 控制重规划循环。
    // 可重入：工具审批 / 逐步闸门 suspend 后 resume 会整段重跑 execute，
    // 断点 cursor 从 suspendData 恢复；挂起的那一步用 resolveToolApproval 续跑或按闸门放行（不重复执行）。
    const executeValidateReplanStep = createStep({
        id: 'execute-validate-replan',
        inputSchema: cycleContextSchema,
        outputSchema: cycleContextSchema,
        resumeSchema: resumeDecisionSchema,
        execute: async (stepArgs) => {
            const { inputData, resumeData, suspend, writer } = stepArgs;
            const emit = createStepEmit(writer);
            // suspendData 未必出现在当前 @mastra/core 版本的 execute 形参类型里，
            // 防御性读取（运行时由 Mastra 注入；缺失则降级为从 inputData.cursor 重跑）。
            const suspendData = stepArgs.suspendData;
            const ctx = inputData;
            if (ctx.rejected)
                return ctx;
            let cursor = ctx.cursor;
            // 当前 cursor 的「步骤前闸门」是否已被本次 resume 放行。
            // 放行后本调用执行恰好一个 step，随后在下个 cursor 处重新设闸（gate 复位为 false）。
            let gateClearedForCursor = false;
            // resume 起点：从 suspendData 恢复断点 cursor（execute 整段重跑，本地状态已丢）。
            if (resumeData && suspendData && typeof suspendData.cursor === 'number') {
                cursor = suspendData.cursor;
                if (suspendData.reason === 'step_gate') {
                    // 逐步闸门的 resume：cancel→中止整轮；其它(continue/approve)→放行当前 step。
                    if (resumeData.decision === 'cancel') {
                        return { ...ctx, cursor, failed: true, lastSummary: '用户取消了执行。' };
                    }
                    gateClearedForCursor = true;
                }
                else if (suspendData.requestId) {
                    // 工具审批的 resume：用审批决定续跑被挂起的那一步（内层 agent 由 requestId 定位）。
                    const toolDecision = resumeData.decision === 'approve' || resumeData.decision === 'continue'
                        ? 'approve'
                        : 'reject';
                    const resolved = await deps.resolveToolApproval({
                        planId: ctx.planId,
                        version: ctx.version,
                        stepId: suspendData.stepId,
                        requestId: suspendData.requestId,
                        decision: toolDecision,
                        ...(resumeData.reason ? { reason: resumeData.reason } : {}),
                    }, emit);
                    if (resolved.status === 'failed') {
                        return { ...ctx, cursor, failed: true, lastSummary: resolved.error ?? '工具审批续跑失败' };
                    }
                    if (resolved.status === 'suspended') {
                        // 链式审批：又有工具待批，于同一 cursor 再次挂起。
                        await suspend({
                            reason: 'tool_external_wait',
                            planId: ctx.planId,
                            version: ctx.version,
                            stepId: suspendData.stepId,
                            cursor,
                            ...(resolved.approval?.requestId ? { requestId: resolved.approval.requestId } : {}),
                            ...(resolved.approval?.toolName ? { toolName: resolved.approval.toolName } : {}),
                        });
                        return { ...ctx, cursor }; // 挂起后此返回值不被消费
                    }
                    // 用户在工具审批处选择 cancel：拒绝已完成，中止整轮执行。
                    if (resumeData.decision === 'cancel') {
                        return { ...ctx, cursor: cursor + 1, failed: true, lastSummary: '用户取消了执行。' };
                    }
                    // completed：该步完成，推进游标；下一 step 仍需先过闸门。
                    cursor = cursor + 1;
                }
            }
            // 1) 逐步执行剩余 steps：每个 step 执行前先过「步骤前闸门」(step_gate)。
            while (cursor < ctx.stepIds.length) {
                const stepId = ctx.stepIds[cursor];
                // 步骤前闸门：除非本次 resume 刚放行了当前 cursor，否则在此挂起，
                // 交由前端恢复策略（运行/暂停/单步/继续/取消）驱动。
                if (!gateClearedForCursor) {
                    await suspend({
                        reason: 'step_gate',
                        planId: ctx.planId,
                        version: ctx.version,
                        stepId,
                        cursor,
                    });
                    return { ...ctx, cursor }; // 挂起后此返回值不被消费
                }
                const result = await deps.executeStep({
                    planId: ctx.planId,
                    version: ctx.version,
                    stepId,
                }, emit);
                if (result.status === 'failed') {
                    return { ...ctx, cursor, failed: true, lastSummary: result.error ?? '执行失败' };
                }
                if (result.status === 'suspended') {
                    // 工具审批冒泡为 workflow 级 suspend，断点写入 suspendData，
                    // 由统一 resume 通道经 resolveToolApproval 续跑内层 agent。
                    await suspend({
                        reason: 'tool_external_wait',
                        planId: ctx.planId,
                        version: ctx.version,
                        stepId,
                        cursor,
                        ...(result.approval?.requestId ? { requestId: result.approval.requestId } : {}),
                        ...(result.approval?.toolName ? { toolName: result.approval.toolName } : {}),
                    });
                    return { ...ctx, cursor }; // 挂起后此返回值不被消费
                }
                cursor = cursor + 1;
                gateClearedForCursor = false; // 下一个 step 重新设闸
            }
            const advanced = { ...ctx, cursor };
            // 2) 验证
            const report = await deps.validate({ planId: advanced.planId, version: advanced.version }, emit);
            if (!report.needsReplan) {
                return { ...advanced, validationPassed: true, lastSummary: report.summary };
            }
            // 3) 需要重规划
            if (advanced.replanCount >= MAX_REPLANS) {
                return {
                    ...advanced,
                    failed: true,
                    lastSummary: `重规划次数超过上限(${MAX_REPLANS})：${report.summary}`,
                };
            }
            const next = await deps.replan({ planId: advanced.planId, version: advanced.version }, emit);
            return {
                ...advanced,
                version: next.version,
                stepIds: next.stepIds,
                cursor: 0,
                replanCount: advanced.replanCount + 1,
                validationPassed: false,
                lastSummary: report.summary,
            };
        },
    });
    const finishStep = createStep({
        id: 'finish',
        inputSchema: cycleContextSchema,
        outputSchema: workflowOutputSchema,
        execute: async ({ inputData }) => {
            const finalStatus = inputData.rejected
                ? 'rejected'
                : inputData.validationPassed
                    ? 'completed'
                    : 'failed';
            if (!inputData.rejected) {
                await deps.finish({
                    planId: inputData.planId,
                    version: inputData.version,
                    status: finalStatus === 'completed' ? 'completed' : 'failed',
                });
            }
            return {
                planId: inputData.planId,
                version: inputData.version,
                finalStatus,
                summary: inputData.lastSummary,
            };
        },
    });
    return createWorkflow({
        id: PLAN_ORCHESTRATION_WORKFLOW_ID,
        inputSchema: workflowInputSchema,
        outputSchema: workflowOutputSchema,
    })
        .then(generatePlanStep)
        .then(approvalGateStep)
        .dountil(executeValidateReplanStep, async ({ inputData }) => inputData.rejected || inputData.validationPassed || inputData.failed)
        .then(finishStep)
        .commit();
};
