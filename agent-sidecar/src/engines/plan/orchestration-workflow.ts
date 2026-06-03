import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

/**
 * Phase 1：用原生 Mastra Workflow 收编 plan→execute→validate→replan 主编排。
 *
 * 设计原则（与「彻底替换」终态对齐，但本阶段零行为变更、可 git revert）：
 * - 每个 step 只委托给 `deps` 暴露的现有逻辑（plan / approve / execute / validate / replan / finish）。
 * - 审批门禁用原生 suspend/resume 取代「跨 HTTP 请求 + planWorkflowStore.suspend」。
 * - 本文件暂不被任何运行路径 import；接线在 Phase 2（server.ts + IPlanOrchestrationDeps 实现）。
 *
 * 控制流：
 *   generatePlan → approvalGate(suspend/resume)
 *     → .dountil(executeValidateReplan, 直到 被拒 || 验证通过 || 失败)
 *     → finish
 * executeValidateReplan 单步内部：顺序执行所有 step → validate → 需要则 replan(新版本, cursor 归零)。
 *   （之前用嵌套子 workflow 会触发 exactOptionalPropertyTypes 下 Workflow→Step 类型不兼容，故改为单步 + JS 循环。
 *    Phase 2 可在类型调通后再拆回原生逐步 step。）
 *
 * Phase 2c-2：工具级审批挂起（方案A·统一 resume 通道）。
 * executeValidateReplan 内任一 step 触发工具审批（executeStep 返回 'suspended'）时，
 * 冒泡为 workflow 级 suspend()，把断点（cursor/stepId/requestId）写入 suspendData；
 * 由 server 的 resume 路由（与 plan 审批共用）经 deps.resolveToolApproval 续跑内层 agent。
 * 因 Mastra resume 会整段重跑 execute，本步做成可重入：cursor 从 suspendData 恢复。
 */

// 重规划次数上限，防止验证反复失败时无限循环。
const MAX_REPLANS = 3;

// ---------------------------------------------------------------------------
// 注入接口：Phase 2 由 MastraRuntime 实现（内部仍调用现有 store / 现有 phase 方法）
// ---------------------------------------------------------------------------
export interface IPlanOrchestrationDeps {
	generatePlan(input: { goal: string; threadId: string | null }): Promise<{
		planId: string;
		version: number;
		threadId: string;
		stepIds: string[];
	}>;
	approvePlan(input: { planId: string; version: number }): Promise<void>;
	rejectPlan(input: { planId: string; version: number; reason?: string }): Promise<void>;
	/** 执行单个 step；映射到现有 execute()。'suspended' 表示工具审批等外部等待，并携带待审批工具请求。 */
	executeStep(input: { planId: string; version: number; stepId: string }): Promise<{
		status: 'completed' | 'failed' | 'suspended';
		error?: string;
		/** 'suspended' 时携带待审批工具请求（用于 workflow 级 suspend + resume 续跑）。 */
		approval?: { requestId: string; toolName?: string };
	}>;
	/**
	 * Phase 2c-2：以审批决定续跑被工具审批挂起的步骤（映射到现有 resolveApproval）。
	 * resolveApproval 内部会对称推进 libSQL；链式审批时再次返回 'suspended'。
	 */
	resolveToolApproval(input: {
		planId: string;
		version: number;
		stepId: string;
		requestId: string;
		decision: 'approve' | 'reject';
		reason?: string;
	}): Promise<{
		status: 'completed' | 'failed' | 'suspended';
		error?: string;
		approval?: { requestId: string; toolName?: string };
	}>;
	validate(input: { planId: string; version: number }): Promise<{
		needsReplan: boolean;
		summary: string;
	}>;
	/** 生成新版本计划（delta 应用后），返回新 version + 新 stepIds。 */
	replan(input: { planId: string; version: number }): Promise<{
		planId: string;
		version: number;
		stepIds: string[];
	}>;
	finish(input: { planId: string; version: number; status: 'completed' | 'failed' }): Promise<void>;
}

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
type TCycleContext = z.infer<typeof cycleContextSchema>;

// Phase 2c-2：工具级审批挂起时写入的断点上下文（resume 时经 suspendData 读回）。
type TToolApprovalSuspend = {
	reason: 'tool_external_wait';
	planId: string;
	version: number;
	stepId: string;
	cursor: number;
	requestId?: string;
	toolName?: string;
};

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

// resume 时前端回填的审批决定（plan 审批门与工具级审批共用同构 schema）
const approvalResumeSchema = z.object({
	decision: z.enum(['approve', 'reject']),
	reason: z.string().min(1).optional(),
});

export const createPlanOrchestrationWorkflow = (deps: IPlanOrchestrationDeps) => {
	const generatePlanStep = createStep({
		id: 'generate-plan',
		inputSchema: workflowInputSchema,
		outputSchema: cycleContextSchema,
		execute: async ({ inputData }) => {
			const plan = await deps.generatePlan({
				goal: inputData.goal,
				threadId: inputData.threadId,
			});
			return {
				...plan,
				cursor: 0,
				rejected: false,
				validationPassed: false,
				failed: false,
				replanCount: 0,
				lastSummary: null,
			} satisfies TCycleContext;
		},
	});

	const approvalGateStep = createStep({
		id: 'approval-gate',
		inputSchema: cycleContextSchema,
		outputSchema: cycleContextSchema,
		resumeSchema: approvalResumeSchema,
		execute: async ({ inputData, resumeData, suspend }) => {
			if (!resumeData) {
				await suspend({
					reason: 'plan_approval',
					planId: inputData.planId,
					version: inputData.version,
				});
				return inputData; // 挂起后此返回值不被消费
			}
			if (resumeData.decision === 'reject') {
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

	// 一轮「顺序执行所有 step → 验证 → 需要则重规划」。外层 .dountil 控制重规划循环。
	// Phase 2c-2：本步可重入——工具审批 suspend 后 resume 会整段重跑 execute，
	// 断点 cursor 从 suspendData 恢复，挂起的那一步用 resolveToolApproval 续跑（不重复执行）。
	const executeValidateReplanStep = createStep({
		id: 'execute-validate-replan',
		inputSchema: cycleContextSchema,
		outputSchema: cycleContextSchema,
		resumeSchema: approvalResumeSchema,
		execute: async (stepArgs) => {
			const { inputData, resumeData, suspend } = stepArgs;
			// suspendData 未必出现在当前 @mastra/core 版本的 execute 形参类型里，
			// 防御性读取（运行时由 Mastra 注入；缺失则降级为从 inputData.cursor 重跑）。
			const suspendData = (stepArgs as { suspendData?: TToolApprovalSuspend }).suspendData;

			const ctx: TCycleContext = inputData;
			if (ctx.rejected) return ctx;

			// resume 起点：从 suspendData 恢复断点 cursor（execute 整段重跑，本地状态已丢）。
			let cursor = ctx.cursor;
			if (resumeData && suspendData && typeof suspendData.cursor === 'number') {
				cursor = suspendData.cursor;

				if (suspendData.requestId) {
					// 用审批决定续跑被挂起的那一步（内层 agent 由 requestId 定位）。
					const resolved = await deps.resolveToolApproval({
						planId: ctx.planId,
						version: ctx.version,
						stepId: suspendData.stepId,
						requestId: suspendData.requestId,
						decision: resumeData.decision,
						...(resumeData.reason ? { reason: resumeData.reason } : {}),
					});
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
					// completed：该步完成，推进游标后继续顺序执行剩余步骤。
					cursor = cursor + 1;
				}
			}

			// 1) 顺序执行剩余 steps
			while (cursor < ctx.stepIds.length) {
				const stepId = ctx.stepIds[cursor]!;
				const result = await deps.executeStep({
					planId: ctx.planId,
					version: ctx.version,
					stepId,
				});
				if (result.status === 'failed') {
					return { ...ctx, cursor, failed: true, lastSummary: result.error ?? '执行失败' };
				}
				if (result.status === 'suspended') {
					// Phase 2c-2：工具审批冒泡为 workflow 级 suspend，断点写入 suspendData，
					// 由统一 resume 通道（方案A）经 resolveToolApproval 续跑内层 agent。
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
			}

			const advanced: TCycleContext = { ...ctx, cursor };

			// 2) 验证
			const report = await deps.validate({ planId: advanced.planId, version: advanced.version });
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
			const next = await deps.replan({ planId: advanced.planId, version: advanced.version });
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
				? ('rejected' as const)
				: inputData.validationPassed
					? ('completed' as const)
					: ('failed' as const);
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
		.dountil(
			executeValidateReplanStep,
			async ({ inputData }) => inputData.rejected || inputData.validationPassed || inputData.failed,
		)
		.then(finishStep)
		.commit();
};

/** Phase 2 接线用：committed workflow 的类型别名（供 runtime 接口 / server 路由引用）。 */
export type TPlanOrchestrationWorkflow = ReturnType<typeof createPlanOrchestrationWorkflow>;
