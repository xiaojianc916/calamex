import { agentPlanDeltaSchema, agentPlanValidationReportSchema, type TAgentPlanDelta, type TAgentPlanStepPatch, type TAgentPlanValidationReport } from '../../schemas/plan-workflow.js';
import { PLAN_STEP_DEFAULTS, agentPlanSchema, agentPlanStepSchema, type TAgentPlan, type TAgentPlanStep } from '../../schemas/plan.js';

export const buildAgentPlanFromPlanSteps = (
    goal: string,
    planSteps: readonly string[],
): TAgentPlan | null => {
    const steps = planSteps
        .map((stepText, index) => {
            const title = stepText.trim();

            if (!title) {
                return null;
            }

            return {
                id: `step-${index + 1}`,
                title,
                goal: title,
                status: 'pending' as const,
                tools: [],
                files: [],
                commands: [],
                risks: [],
                acceptanceCriteria: [],
                ...PLAN_STEP_DEFAULTS,
                expectedOutput: title,
            };
        })
        .filter((step): step is NonNullable<typeof step> => step !== null);

    if (steps.length === 0) {
        return null;
    }

    const parsedPlan = agentPlanSchema.safeParse({
        goal,
        requiresApproval: true,
        steps,
    });

    return parsedPlan.success ? parsedPlan.data : null;
};

export const parseValidationReport = (value: unknown): TAgentPlanValidationReport | null => {
    const parsedReport = agentPlanValidationReportSchema.safeParse(value);
    return parsedReport.success ? parsedReport.data : null;
};

export const parsePlanDelta = (value: unknown): TAgentPlanDelta | null => {
    const parsedDelta = agentPlanDeltaSchema.safeParse(value);
    return parsedDelta.success ? parsedDelta.data : null;
};

export const applyStepPatch = (
    step: TAgentPlanStep,
    patch: TAgentPlanStepPatch,
): TAgentPlanStep => {
    const definedPatch: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
            definedPatch[key] = value;
        }
    }

    return agentPlanStepSchema.parse({
        ...step,
        ...definedPatch,
        status: 'pending',
    });
};

export const applyAgentPlanDelta = (
    plan: TAgentPlan,
    delta: TAgentPlanDelta,
): TAgentPlan | null => {
    const removedIds = new Set(delta.removed);
    const modifiedById = new Map(delta.modified.map((item) => [item.id, item.patch]));
    const addedIds = new Set(delta.added.map((step) => step.id));
    const steps = [
        ...plan.steps
            .filter((step) => !removedIds.has(step.id))
            .map((step) => {
                const patch = modifiedById.get(step.id);
                return patch ? applyStepPatch(step, patch) : step;
            })
            .filter((step) => !addedIds.has(step.id)),
        ...delta.added,
    ];
    const parsedPlan = agentPlanSchema.safeParse({
        ...plan,
        summary: delta.summary,
        steps,
        requiresApproval: true,
    });

    return parsedPlan.success ? parsedPlan.data : null;
};
