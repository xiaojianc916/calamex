import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import type { TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';

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
 *
 * 执行模式（executionMode）：
 * - interactive（默认）：人值守逐步执行——保留 step_gate 与工具审批，但所有 step 跑完即终态，
 *   不做自动 validate+replan 闭环；由用户在每个闸门全程把关。
 *   对标 LangGraph plan-and-execute 的 should_end 条件边（执行后直接 END、不接 replan 节点）
 *   与 Cline 人驱动 plan→act（无自动重规划循环）。
 * - autonomous：自主执行——在 interactive 的基础上，额外启用「validate→按需 replan」闭环（外层 .dountil）。
 * executionMode 在计划生成时随 workflow 输入确定，并贯穿整个 cycleContext（执行期不可变）。
 *
 * 有界重规划环路升级（P1–P4，均在 autonomous 闭环内，interactive 路径不受影响）：
 * - P1（OpenHands critic）：deps.validate 返回 replanViable；验证需重规划但 findings 无一可重试时快速失败。
 * - P2（ADK LoopAgent max_iterations）：maxReplans 为 workflow 输入（默认 MAX_REPLANS=3），贯穿 cycleContext。
 * - P3（ADK escalate）：deps.replan 返回 changed；无实质变化（空 delta / 未生成新版本）时终止避免空转。
 * - P4（增量复用）：重规划后 cursor 从 deps.replan 的 resumeCursor 起跳，跳过前导未改动的已完成步骤。
 */

// 重规划次数默认上限（P2：现可由 workflow 输入 maxReplans 覆盖），防止验证反复失败时无限循环。
const MAX_REPLANS = 3;

// ---------------------------------------------------------------------------
// 注入接口：Phase 2 由 MastraRuntime 实现（内部仍调用现有 store / 现有 phase 方法）
// ---------------------------------------------------------------------------
export type TOrchestrationEmit = (event: TAgentRuntimeOutputEvent) => void;

export interface IPlanOrchestrationDeps {
	generatePlan(input: { goal: string; threadId: string | null }, emit?: TOrchestrationEmit): Promise<{
		planId: string;
		version: number;
		threadId: string;
		stepIds: string[];
	}>;
	approvePlan(input: { planId: string; version: number }): Promise<void>;
	rejectPlan(input: { planId: string; version: number; reason?: string }): Promise<void>;
	/** 执行单个 step；映射到现有 execute()。'suspended' 表示工具审批等外部等待，并携带待审批工具请求。 */
	executeStep(input: { planId: string; version: number; stepId: string }, emit?: TOrchestrationEmit): Promise<{
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
	}, emit?: TOrchestrationEmit): Promise<{
		status: 'completed' | 'failed' | 'suspended';
		error?: string;
		approval?: { requestId: string; toolName?: string };
	}>;
	validate(input: { planId: string; version: number }, emit?: TOrchestrationEmit): Promise<{
		needsReplan: boolean;
		summary: string;
		/** P1：findings 是否存在可重试项；false 表示重规划无法修复，应快速失败。 */
		replanViable: boolean;
	}>;
	/** 生成新版本计划（delta 应用后），返回新 version + 新 stepIds。 */
	replan(input: { planId: string; version: number }, emit?: TOrchestrationEmit): Promise<{
		planId: string;
		version: number;
		stepIds: string[];
		/** P3：本次重规划是否产生实质变化（空 delta / 未生成新版本时为 false）。 */
		changed: boolean;
		/** P4：新版本可跳过的前导「已完成且未改动」步骤数；执行从该 cursor 起跳。 */
		resumeCursor: number;
	}>;
	finish(input: { planId: string; version: number; status: 'completed' | 'failed' }): Promise<void>;
}

export const PLAN_ORCHESTRATION_WORKFLOW_ID = 'calamex-plan-orchestration';

// 执行模式：interactive=人值守逐步执行（默认·轻量门控）；autonomous=自主执行（自动校验+重规划闭环）。
// 取值与前端 src/types/ai/execution-mode.ts 保持一致（两个 package 各自定义，不共享类型）。
const executionModeSchema = z.enum(['interactive', 'autonomous']);

// 在步骤之间流转的统一上下文（每个 step 的 output 即下个 step 的 input）
const cycleContextSchema = z.object({
	planId: z.string().min(1),
	version: z.number().int().positive(),
	threadId: z.string().min(1),
	// 执行模式贯穿整轮编排，执行期不可变（计划生成时确定）。
	executionMode: executionModeSchema,
	// P2：重规划次数上限，随计划生成确定并贯穿整轮（执行期不可变）。
	maxReplans: z.number().int().nonnegative(),
	stepIds: z.array(z.string().min(1)),
	cursor: z.number().int().nonnegative(), // 下一个待执行 step 的下标
	rejected: z.boolean(),
	validationPassed: z.boolean(),
	failed: z.boolean(),
	replanCount: z.number().int().nonnegative(),
	lastSummary: z.string().nullable(),
});
type TCycleContext = z.infer<typeof cycleContextSchema>;

// 挂起断点上下文（resume 时经 suspendData 读回）。两类挂起共用 stepId/cursor，
// 用 reason 区分：tool_external_wait=工具审批；step_gate=逐步闸门。
type TSuspendBreakpoint =
	| {
			reason: 'tool_external_wait';
			planId: string;
			version: number;
			stepId: string;
			cursor: number;
			requestId?: string;
			toolName?: string;
		}
	| {
			reason: 'step_gate';
			planId: string;
			version: number;
			stepId: string;
			cursor: number;
		};

const workflowInputSchema = z.object({
	goal: z.string().min(1),
	threadId: z.string().min(1).nullable(),
	// 默认 interactive：未携带该字段的旧调用方退化为人值守轻量模式（无自动重规划）。
	executionMode: executionModeSchema.default('interactive'),
	// P2：重规划次数上限，默认 MAX_REPLANS。.default() 保证未携带该字段的旧调用方/服务路由向后兼容。
	maxReplans: z.number().int().nonnegative().default(MAX_REPLANS),
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

type TStepWriter = { write(data: unknown): Promise<unknown> } | undefined;
const createStepEmit = (writer: TStepWriter): TOrchestrationEmit => (event) => {
	try {
		const result = writer?.write(event);
		if (result && typeof result.then === 'function') {
			result.catch(() => {});
		}
	} catch {
		// best-effort streaming: ignore writer errors
	}
};

export const createPlanOrchestrationWorkflow = (deps: IPlanOrchestrationDeps) => {
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
				executionMode: inputData.executionMode,
				maxReplans: inputData.maxReplans,
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
			const suspendData = (stepArgs as { suspendData?: TSuspendBreakpoint }).suspendData;

			const ctx: TCycleContext = inputData;
			if (ctx.rejected) return ctx;

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
				} else if (suspendData.requestId) {
					// 工具审批的 resume：用审批决定续跑被挂起的那一步（内层 agent 由 requestId 定位）。
					const toolDecision = resumeData.decision === 'approve' || resumeData.decision === 'continue'
						? ('approve' as const)
						: ('reject' as const);
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
				const stepId = ctx.stepIds[cursor]!;

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

			const advanced: TCycleContext = { ...ctx, cursor };

			// interactive（默认·人值守）：所有 step 跑完即终态，跳过自动 validate+replan 闭环——
			// 由用户在每个 step_gate 全程把关。对标 LangGraph plan-and-execute 的 should_end 条件边
			// （执行后直接走 END、不接 replan 节点）与 Cline 人驱动 plan→act（无自动重规划循环）。
			if (advanced.executionMode !== 'autonomous') {
				return { ...advanced, validationPassed: true };
			}

			// 2) 验证（autonomous）
			const report = await deps.validate({ planId: advanced.planId, version: advanced.version }, emit);
			if (!report.needsReplan) {
				return { ...advanced, validationPassed: true, lastSummary: report.summary };
			}

			// 2b) 可重构性护栏（P1·OpenHands critic）：findings 不可重试 → 重规划无法修复，快速失败而非空转。
			if (!report.replanViable) {
				return {
					...advanced,
					failed: true,
					lastSummary: `验证未通过且重规划无法修复（findings 不可重试）：${report.summary}`,
				};
			}

			// 3) 需要重规划（autonomous）：先判可配置上限（P2）。
			if (advanced.replanCount >= advanced.maxReplans) {
				return {
					...advanced,
					failed: true,
					lastSummary: `重规划次数超过上限(${advanced.maxReplans})：${report.summary}`,
				};
			}
			const next = await deps.replan({ planId: advanced.planId, version: advanced.version }, emit);

			// 3b) 无进展护栏（P3·ADK escalate）：重规划未产生实质变化（空 delta 或未生成新版本）→ 终止避免空转。
			if (!next.changed) {
				return {
					...advanced,
					failed: true,
					lastSummary: `重规划无实质变化（无进展），终止以避免空转：${report.summary}`,
				};
			}

			// 3c) 增量复用（P4）：cursor 从 resumeCursor 起跳，跳过新版本中前导且未改动的已完成步骤。
			return {
				...advanced,
				version: next.version,
				stepIds: next.stepIds,
				cursor: next.resumeCursor,
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
