import { randomUUID } from 'node:crypto';

import type { IPlanOrchestrationDeps } from './orchestration-workflow.js';
import type { IAgentPlanStore } from './plan-store.js';
import type { IAgentPlanWorkflowStore } from './plan-workflow-store.js';
import type {
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
    TAgentRuntimeOutputEvent,
} from '../contracts/runtime-contracts.js';
import type {
    IAgentRuntimeInput,
    IAgentRuntimeModelConfigInput,
    IApprovalResolutionInput,
} from '../contracts/runtime-input.js';

/**
 * Phase 2：把 Phase-1 的原生 orchestration workflow 接到现有 runtime。
 *
 * 设计（与「彻底替换 plan-store / plan-workflow-store」终态对齐）：
 * - 纯 store 操作（approve / reject / finish）直接调 store，绕开流式响应包装。
 * - 跑 agent 的阶段（plan / execute / validate / replan）调用现有 phase 方法，
 *   随后从 store 读「结构化真值」（plan record 的 steps、workflow state 的
 *   validator / completedStepIds / failedStepIds），而不是脆弱地解析事件流。
 * - 本模块不持有任何运行路径；只有 server.ts 的 `/agent/plan/orchestrate`
 *   在 `AGENT_ORCHESTRATION_WORKFLOW=1` 时才会用到（默认关，旧路径完全不受影响）。
 *
 * Phase 2c-2：工具级审批挂起。executeStep 在 result===null 时从事件流取出待审批
 * 工具的 requestId 透出；resolveToolApproval 映射到 runtime.resolveApproval，由其
 * 续跑内层 agent 并对称推进 libSQL（completeStep/failStep），链式审批时再次返回 null。
 */

type TRuntimePhaseMethod = (
    input: IAgentRuntimeInput,
    options?: IAgentRuntimeRunOptions,
) => Promise<IAgentRuntimeResponse>;

export interface IPlanOrchestrationRuntimeAccess {
    readonly planStore: IAgentPlanStore;
    readonly planWorkflowStore: IAgentPlanWorkflowStore;
    readonly plan: TRuntimePhaseMethod;
    readonly execute: TRuntimePhaseMethod;
    readonly validatePlan: TRuntimePhaseMethod;
    readonly replanPlan: TRuntimePhaseMethod;
    /** Phase 2c-2：以审批决定续跑被工具审批挂起的内层 agent run（映射到 runtime.resolveApproval）。 */
    readonly resolveApproval: (
        input: IApprovalResolutionInput,
        options?: IAgentRuntimeRunOptions,
    ) => Promise<IAgentRuntimeResponse>;
    /** 请求级模型配置；缺省时各 phase 方法回退到 runtime 的 env 配置。 */
    readonly modelConfig?: IAgentRuntimeModelConfigInput | undefined;
}

/**
 * 从一次 execute()/resolveApproval() 的事件流里取出「待审批工具请求」的 requestId。
 * 取最后一个 approval_required 事件（链式审批时对应当前待批的工具）。
 */
const extractPendingApproval = (
    events: ReadonlyArray<TAgentRuntimeOutputEvent>,
): { requestId: string; toolName?: string } | undefined => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event && event.type === 'approval_required') {
            return { requestId: event.request.id, toolName: event.request.toolName };
        }
    }
    return undefined;
};

export const createMastraPlanOrchestrationDeps = (
    access: IPlanOrchestrationRuntimeAccess,
): IPlanOrchestrationDeps => {
    const baseInput = (
        mode: IAgentRuntimeInput['mode'],
        goal: string,
        extra: Partial<IAgentRuntimeInput> = {},
    ): IAgentRuntimeInput => ({
        mode,
        goal,
        messages: [{ role: 'user', content: goal }],
        ...(access.modelConfig ? { modelConfig: access.modelConfig } : {}),
        ...extra,
    });

    // Phase 2.5: wrap the step-provided emit into a phase onEvent option.
    // Omit entirely when absent (exactOptionalPropertyTypes-safe).
    const runOptions = (
        emit?: (event: TAgentRuntimeOutputEvent) => void,
    ): IAgentRuntimeRunOptions | undefined => (emit ? { onEvent: emit } : undefined);

    return {
        async generatePlan({ goal, threadId }, emit) {
            const planId = randomUUID();
            await access.plan(
                baseInput('plan', goal, {
                    planId,
                    ...(threadId ? { threadId } : {}),
                }),
                runOptions(emit),
            );
            // plan() 内部以传入的 planId 落库；读回拿结构化版本与步骤 id。
            const record = await access.planStore
                .getPlan({ planId })
                .catch((error: unknown) => {
                    throw new Error(
                        `计划生成失败：未能写入计划 ${planId}（${
                            error instanceof Error ? error.message : String(error)
                        }）。`,
                    );
                });
            return {
                planId: record.planId,
                version: record.version,
                threadId: record.threadId,
                stepIds: record.plan.steps.map((step) => step.id),
            };
        },

        async approvePlan({ planId, version }) {
            const record = await access.planStore.approvePlan({ planId, version });
            await access.planWorkflowStore.approvePlan(record);
        },

        async rejectPlan({ planId, version, reason }) {
            const record = await access.planStore.rejectPlan({
                planId,
                version,
                ...(reason ? { reason } : {}),
            });
            await access.planWorkflowStore.rejectPlan(record, reason);
        },

        async executeStep({ planId, version, stepId }, emit) {
            const record = await access.planStore.getPlan({ planId, version });
            const step = record.plan.steps.find((candidate) => candidate.id === stepId);
            const goal = step ? `${step.title}：${step.goal}` : `执行计划步骤 ${stepId}`;
            const response = await access.execute(
                baseInput('agent', goal, {
                    planId,
                    planVersion: version,
                    planStepId: stepId,
                    threadId: record.threadId,
                }),
                runOptions(emit),
            );
            // execute() 仅在「挂起等待外部审批」时返回 result === null。
            if (response.result === null) {
                const approval = extractPendingApproval(response.events);
                return { status: 'suspended', ...(approval ? { approval } : {}) };
            }
            // 成功与否的权威记录在 workflow state：completeStep 写入 completedStepIds，
            // failStep 写入 failedStepIds（completeStep 会反向清除 failedStepIds）。
            const workflow = await access.planWorkflowStore
                .getWorkflow({ planId, version })
                .catch(() => null);
            if (workflow?.state.completedStepIds.includes(stepId)) {
                return { status: 'completed' };
            }
            return {
                status: 'failed',
                error: workflow?.errorMessage ?? response.result ?? '步骤执行失败',
            };
        },

        async resolveToolApproval({ planId, version, stepId, requestId, decision }, emit) {
            const record = await access.planStore.getPlan({ planId, version }).catch(() => null);
            const response = await access.resolveApproval({
                requestId,
                decision,
                planId,
                planVersion: version,
                planStepId: stepId,
                ...(record?.threadId ? { threadId: record.threadId } : {}),
            }, runOptions(emit));
            // 链式审批：又一个工具待批，resolveApproval 与 execute() 一致返回 result === null。
            if (response.result === null) {
                const approval = extractPendingApproval(response.events);
                return { status: 'suspended', ...(approval ? { approval } : {}) };
            }
            // resolveApproval 内部已对称推进 libSQL（completeStep/failStep）；据 workflow state 判真值。
            const workflow = await access.planWorkflowStore
                .getWorkflow({ planId, version })
                .catch(() => null);
            if (workflow?.state.completedStepIds.includes(stepId)) {
                return { status: 'completed' };
            }
            return {
                status: 'failed',
                error: workflow?.errorMessage ?? response.result ?? '工具审批续跑后步骤未完成',
            };
        },

        async validate({ planId, version }, emit) {
            const record = await access.planStore.getPlan({ planId, version });
            const response = await access.validatePlan(
                baseInput('agent', record.userRequest.trim() || '验证计划执行结果', {
                    planId,
                    planVersion: version,
                    threadId: record.threadId,
                }),
                runOptions(emit),
            );
            // validatePlan() 通过 reportValidator 把结果写进 workflow state.validator。
            const workflow = await access.planWorkflowStore.getWorkflow({ planId, version });
            return {
                needsReplan: workflow.state.validator.needsReplan,
                summary: workflow.state.validator.summary ?? response.result ?? '验证完成',
            };
        },

        async replan({ planId, version }, emit) {
            const record = await access.planStore.getPlan({ planId, version });
            await access.replanPlan(
                baseInput('plan', record.userRequest.trim() || '根据验证结果重新规划', {
                    planId,
                    planVersion: version,
                    threadId: record.threadId,
                }),
                runOptions(emit),
            );
            // replanPlan() 以同一 planId 写入新版本；getPlan(无 version) 取最新版本。
            const latest = await access.planStore.getPlan({ planId });
            return {
                planId,
                version: latest.version,
                stepIds: latest.plan.steps.map((step) => step.id),
            };
        },

        async finish({ planId, version, status }) {
            await access.planStore.finishPlan({ planId, version, status });
            await access.planWorkflowStore.finishPlan({ planId, version, status });
        },
    };
};
