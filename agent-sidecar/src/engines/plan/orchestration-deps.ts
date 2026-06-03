import { randomUUID } from 'node:crypto';

import type { IPlanOrchestrationDeps } from './orchestration-workflow.js';
import type { IAgentPlanStore } from './plan-store.js';
import type { IAgentPlanWorkflowStore } from './plan-workflow-store.js';
import type {
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
} from '../contracts/runtime-contracts.js';
import type {
    IAgentRuntimeInput,
    IAgentRuntimeModelConfigInput,
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
    /** 请求级模型配置；缺省时各 phase 方法回退到 runtime 的 env 配置。 */
    readonly modelConfig?: IAgentRuntimeModelConfigInput | undefined;
}

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

    return {
        async generatePlan({ goal, threadId }) {
            const planId = randomUUID();
            await access.plan(
                baseInput('plan', goal, {
                    planId,
                    ...(threadId ? { threadId } : {}),
                }),
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

        async executeStep({ planId, version, stepId }) {
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
            );
            // execute() 仅在「挂起等待外部审批」时返回 result === null。
            if (response.result === null) {
                return { status: 'suspended' };
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

        async validate({ planId, version }) {
            const record = await access.planStore.getPlan({ planId, version });
            const response = await access.validatePlan(
                baseInput('agent', record.userRequest.trim() || '验证计划执行结果', {
                    planId,
                    planVersion: version,
                    threadId: record.threadId,
                }),
            );
            // validatePlan() 通过 reportValidator 把结果写进 workflow state.validator。
            const workflow = await access.planWorkflowStore.getWorkflow({ planId, version });
            return {
                needsReplan: workflow.state.validator.needsReplan,
                summary: workflow.state.validator.summary ?? response.result ?? '验证完成',
            };
        },

        async replan({ planId, version }) {
            const record = await access.planStore.getPlan({ planId, version });
            await access.replanPlan(
                baseInput('plan', record.userRequest.trim() || '根据验证结果重新规划', {
                    planId,
                    planVersion: version,
                    threadId: record.threadId,
                }),
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
