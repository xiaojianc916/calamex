import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMastraRequestContext, requestContextToRecord, toJsonValue, toNonEmptyString, toRecord } from '../utils.js';
export const createExecutionRequestContext = (input, systemPrompt, memory, approvedPlanRecord) => createMastraRequestContext({
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
export const resolveSystemPromptFromSnapshot = (snapshot) => toNonEmptyString(requestContextToRecord(snapshot.requestContext)?.systemPrompt);
export const resolveWorkspaceRootPathFromSnapshot = (snapshot) => {
    const value = toNonEmptyString(requestContextToRecord(snapshot.requestContext)?.workspaceRootPath);
    return value ?? undefined;
};
export const extractRestoreResultText = (result) => {
    const topLevel = toRecord(result);
    const nestedResult = toRecord(topLevel?.result);
    const output = toRecord(nestedResult?.output) ?? toRecord(topLevel?.output);
    return toNonEmptyString(output?.text);
};
export const resolveWorkspaceDirectory = (workspaceRootPath) => {
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
    }
    catch {
        return null;
    }
};
