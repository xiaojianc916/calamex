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
 *
 * 有界重规划环路升级（均在 AGENT_ORCHESTRATION_WORKFLOW 开关之后）：
 * - 缺陷修复：autonomous 重规划产出的新版本在 plan-store 为 pending_approval，而
 *   execute() 的 prepareExecution 门禁要求 approved／执行中，导致重规划后首个重执行
 *   步骤必然门禁失败。replan 在此直接批准新版本（人已批准 autonomous 执行，
 *   replanner 输出直接回流执行器，对标 LangGraph plan-and-execute）。
 * - P1 viability（借鉴 OpenHands critic）：validate 从 ValidatorReported findings 推导
 *   replanViable；有 findings 且无一可重试 → 重规划无法修复 → 调用方快速失败。
 * - P3 no-progress（借鉴 ADK escalate）：replan 从 ReplanIssued delta 推导 changed；
 *   空 delta（或未生成新版本）→ changed=false → 调用方终止空转。
 * - P4 incremental reuse：replan 返回 resumeCursor，并把「前导且未改动」的已完成步骤
 *   结转到新版本（completeStep），令环路跳过未变更且已成功的步骤。
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

            // P1 可重构性判定（借鉴 OpenHands critic）：validator findings 只存在 ValidatorReported
            // 事件里（state.validator 只保留 status/summary/needsReplan）。从事件流取最近一条报告，
            // 若存在 findings 且无一可重试，则重规划不可能修复 → 让调用方快速失败而非空转。
            const events = await access.planWorkflowStore
                .listEvents({ planId, version })
                .catch(() => []);
            let findings: ReadonlyArray<{ retryable: boolean }> = [];
            for (let index = events.length - 1; index >= 0; index -= 1) {
                const event = events[index]?.event;
                if (event && event.type === 'ValidatorReported') {
                    findings = event.report.findings;
                    break;
                }
            }
            const replanViable = findings.length === 0 ? true : findings.some((finding) => finding.retryable);

            return {
                needsReplan: workflow.state.validator.needsReplan,
                summary: workflow.state.validator.summary ?? response.result ?? '验证完成',
                replanViable,
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
            const priorStepIds = record.plan.steps.map((step) => step.id);

            // 无新版本：replanPlan 内部出错或未产出，视为无进展，交由 workflow 终止（P3）。
            if (latest.version === version) {
                return { planId, version, stepIds: priorStepIds, changed: false, resumeCursor: 0 };
            }

            const nextStepIds = latest.plan.steps.map((step) => step.id);

            // 从「上一版本」事件流取 ReplanIssued 的 delta，判定是否真有实质变化（P3 无进展护栏），
            // 并据此推导可跳过的前导「已完成且未改动」步骤（P4 cursor 幂等复用）。
            const priorEvents = await access.planWorkflowStore
                .listEvents({ planId, version })
                .catch(() => []);
            let delta:
                | { added: ReadonlyArray<unknown>; modified: ReadonlyArray<{ id: string }>; removed: ReadonlyArray<string> }
                | null = null;
            for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
                const event = priorEvents[index]?.event;
                if (event && event.type === 'ReplanIssued' && event.toVersion === latest.version) {
                    delta = {
                        added: event.delta.added,
                        modified: event.delta.modified,
                        removed: event.delta.removed,
                    };
                    break;
                }
            }

            const changed = delta
                ? delta.added.length > 0 || delta.modified.length > 0 || delta.removed.length > 0
                : true; // 找不到 delta 时保守视为有变化，避免误判无进展而终止。

            // 自主闭环：人已批准 autonomous 执行，重规划产出的新版本无需二次人审，
            // 直接在此批准（对标 LangGraph plan-and-execute：replanner 输出直接回流执行器）。
            // 这同时修复了「新版本停留 pending_approval 导致 prepareExecution 门禁必然失败」的缺陷。
            await access.planStore.approvePlan({ planId, version: latest.version });
            await access.planWorkflowStore.approvePlan(latest);

            // P4：把「前导且在新版本中未被改动」的已完成步骤结转到新版本，cursor 跳过它们，
            // 避免对未变更且已成功的步骤做无谓重跑（对标增量重规划的幂等复用）。
            let resumeCursor = 0;
            if (changed) {
                const priorWorkflow = await access.planWorkflowStore
                    .getWorkflow({ planId, version })
                    .catch(() => null);
                const priorCompleted = new Set(priorWorkflow?.state.completedStepIds ?? []);
                const changedIds = new Set<string>([
                    ...(delta?.modified.map((modified) => modified.id) ?? []),
                    ...(delta?.removed ?? []),
                ]);
                for (const stepId of nextStepIds) {
                    if (priorCompleted.has(stepId) && !changedIds.has(stepId)) {
                        // 新版本 workflow 刚创建时 completedStepIds 为空，需将已完成状态结转，
                        // 否则 validator 会误以为这些步骤未执行。completeStep 在 waiting_approval/approved
                        // （均属 ACTIVE_STATUSES）下可用，且已完成时幂等返回。
                        await access.planWorkflowStore
                            .completeStep({ planId, version: latest.version, stepId })
                            .catch(() => undefined);
                        resumeCursor += 1;
                    } else {
                        break;
                    }
                }
            }

            return {
                planId,
                version: latest.version,
                stepIds: nextStepIds,
                changed,
                resumeCursor,
            };
        },

        async finish({ planId, version, status }) {
            await access.planStore.finishPlan({ planId, version, status });
            await access.planWorkflowStore.finishPlan({ planId, version, status });
        },
    };
};
