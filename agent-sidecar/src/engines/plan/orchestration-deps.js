import { randomUUID } from 'node:crypto';
/**
 * 从一次 execute()/resolveApproval() 的事件流里取出「待审批工具请求」的 requestId。
 * 取最后一个 approval_required 事件（链式审批时对应当前待批的工具）。
 */
const extractPendingApproval = (events) => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event && event.type === 'approval_required') {
            return { requestId: event.request.id, toolName: event.request.toolName };
        }
    }
    return undefined;
};
export const createMastraPlanOrchestrationDeps = (access) => {
    const baseInput = (mode, goal, extra = {}) => ({
        mode,
        goal,
        messages: [{ role: 'user', content: goal }],
        ...(access.modelConfig ? { modelConfig: access.modelConfig } : {}),
        ...extra,
    });
    // Phase 2.5: wrap the step-provided emit into a phase onEvent option.
    // Omit entirely when absent (exactOptionalPropertyTypes-safe).
    const runOptions = (emit) => (emit ? { onEvent: emit } : undefined);
    return {
        async generatePlan({ goal, threadId }, emit) {
            const planId = randomUUID();
            await access.plan(baseInput('plan', goal, {
                planId,
                ...(threadId ? { threadId } : {}),
            }), runOptions(emit));
            // plan() 内部以传入的 planId 落库；读回拿结构化版本与步骤 id。
            const record = await access.planStore
                .getPlan({ planId })
                .catch((error) => {
                throw new Error(`计划生成失败：未能写入计划 ${planId}（${error instanceof Error ? error.message : String(error)}）。`);
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
            const response = await access.execute(baseInput('agent', goal, {
                planId,
                planVersion: version,
                planStepId: stepId,
                threadId: record.threadId,
            }), runOptions(emit));
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
            const response = await access.validatePlan(baseInput('agent', record.userRequest.trim() || '验证计划执行结果', {
                planId,
                planVersion: version,
                threadId: record.threadId,
            }), runOptions(emit));
            // validatePlan() 通过 reportValidator 把结果写进 workflow state.validator。
            const workflow = await access.planWorkflowStore.getWorkflow({ planId, version });
            return {
                needsReplan: workflow.state.validator.needsReplan,
                summary: workflow.state.validator.summary ?? response.result ?? '验证完成',
            };
        },
        async replan({ planId, version }, emit) {
            const record = await access.planStore.getPlan({ planId, version });
            await access.replanPlan(baseInput('plan', record.userRequest.trim() || '根据验证结果重新规划', {
                planId,
                planVersion: version,
                threadId: record.threadId,
            }), runOptions(emit));
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
