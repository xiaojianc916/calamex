export type TAgentMode = 'ask' | 'plan' | 'agent' | 'patch' | 'review';

export interface IAgentMessageInput {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
}

export interface IAgentContextReferenceInput {
    id: string;
    kind: string;
    label: string;
    path: string | null;
    range: {
        startLine: number;
        endLine: number;
    } | null;
    contentPreview: string;
    redacted: boolean;
}

export interface IAgentRuntimeInput {
    sessionId?: string;
    mode: TAgentMode;
    goal: string;
    messages: IAgentMessageInput[];
    workspaceRootPath?: string;
    context?: IAgentContextReferenceInput[];
    threadId?: string;
    planId?: string;
    planVersion?: number;
    planStepId?: string;
}

export interface IApprovalResolutionInput {
    requestId: string;
    decision: string;
    sessionId?: string | undefined;
}

export type TRollbackStepPath = string | string[];

export interface ICheckpointRestoreInput {
    runId: string;
    snapshotId?: string | undefined;
    step?: TRollbackStepPath | undefined;
    sessionId?: string | undefined;
}

export interface IPlanApprovalInput {
    planId: string;
    version: number;
    sessionId?: string | undefined;
}

export interface IPlanQueryInput {
    planId: string;
    version?: number | undefined;
    sessionId?: string | undefined;
}

export interface IPlanRejectInput extends IPlanApprovalInput {
    reason?: string | undefined;
}

export interface IPlanFinishInput extends IPlanApprovalInput {
    status: 'completed' | 'failed';
    errorMessage?: string | undefined;
}
