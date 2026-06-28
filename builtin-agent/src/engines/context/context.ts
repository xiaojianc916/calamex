import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TAgentPlanRecord } from '../plan/plan-store.js';
import type { IAgentRuntimeInput } from '../contracts/runtime-input.js';
import { createMastraRequestContext, requestContextToRecord, toJsonValue, toNonEmptyString, toRecord } from '../shared/utils.js';
import type { IMastraWorkflowSnapshotLike, TMastraRequestContext } from '../shared/types.js';

export const createExecutionRequestContext = (
    input: IAgentRuntimeInput,
    systemPrompt: string,
    memory: { thread: string; resource: string },
    approvedPlanRecord?: TAgentPlanRecord,
): TMastraRequestContext => createMastraRequestContext({
    mode: input.mode,
    goal: input.goal,
    systemPrompt,
    workspaceRootPath: input.workspaceRootPath ?? null,
    context: input.context ?? [],
    memoryThreadId: memory.thread,
    memoryResourceId: memory.resource,
    ...(approvedPlanRecord ? {
        planId: approvedPlanRecord.planId,
        planVersion: approvedPlanRecord.version,
        planStepId: input.planStepId ?? null,
        approvedPlan: toJsonValue(approvedPlanRecord.plan),
    } : {}),
});

export const resolveSystemPromptFromSnapshot = (
    snapshot: IMastraWorkflowSnapshotLike,
): string | null => toNonEmptyString(requestContextToRecord(snapshot.requestContext)?.systemPrompt);

export const resolveWorkspaceRootPathFromSnapshot = (
    snapshot: IMastraWorkflowSnapshotLike,
): string | undefined => {
    const value = toNonEmptyString(requestContextToRecord(snapshot.requestContext)?.workspaceRootPath);
    return value ?? undefined;
};

export const extractRestoreResultText = (result: unknown): string | null => {
    const topLevel = toRecord(result);
    const nestedResult = toRecord(topLevel?.result);
    const output = toRecord(nestedResult?.output) ?? toRecord(topLevel?.output);
    return toNonEmptyString(output?.text);
};

export const resolveWorkspaceDirectory = (workspaceRootPath?: string | null): string | null => {
    const configured = toNonEmptyString(workspaceRootPath);

    if (!configured) {
        return null;
    }

    const absolutePath = resolve(configured);

    try {
        if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
            return null;
        }

        return realpathSync(absolutePath);
    } catch {
        return null;
    }
};
