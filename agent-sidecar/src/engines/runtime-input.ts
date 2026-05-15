// -----------------------------------------------------------------------------
// Modes
// -----------------------------------------------------------------------------

/**
 * Runtime modes the agent supports.
 *
 * - `ask`     — single-shot Q&A; no tools, no plan.
 * - `plan`    — produce a structured plan JSON, wait for human approval.
 * - `agent`   — autonomous tool-using execution.
 * - `patch`   — code-mod oriented; emits diffs/patches.
 * - `review`  — code review; emits review comments / verdict.
 */
export const AGENT_MODES = ['ask', 'plan', 'agent', 'patch', 'review'] as const;
export type TAgentMode = (typeof AGENT_MODES)[number];

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

/**
 * One turn of conversation history fed into the runtime.
 *
 * `tool` messages currently only carry `content`; if you later integrate a
 * provider that requires `toolCallId` / `name` (OpenAI / Anthropic), widen
 * this into a discriminated union — see the variant comment below.
 */
export interface IAgentMessageInput {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    /** Required when `role === 'tool'` for OpenAI/Anthropic-compatible providers. */
    toolCallId?: string | undefined;
    /** Optional tool name; useful for some providers' tool message format. */
    name?: string | undefined;
}

// -----------------------------------------------------------------------------
// Context references (selections, files, symbols pinned by the UI)
// -----------------------------------------------------------------------------

/** Discriminator for a context reference's origin. Extend as new sources are added. */
export type TAgentContextReferenceKind =
    | 'file'
    | 'selection'
    | 'symbol'
    | 'diagnostic'
    | 'terminal'
    | 'web'
    | (string & {}); // accept future values without breaking callers

export interface IAgentContextReferenceInput {
    /** Stable id, unique within one runtime request. */
    id: string;
    kind: TAgentContextReferenceKind;
    /** Human-readable label for UI / prompts. */
    label: string;
    /** Workspace-relative path when applicable, else null. */
    path: string | null;
    /**
     * Line range when this reference points at a region of a file.
     * Both `startLine` and `endLine` are **1-based** and **inclusive**.
     * `null` when the whole resource is referenced.
     */
    range: {
        startLine: number;
        endLine: number;
    } | null;
    /**
     * Truncated preview of the referenced content.
     * When `redacted === true` this string is already the post-redaction
     * placeholder; raw content is not exposed.
     */
    contentPreview: string;
    /** True when the original content was redacted (secrets, PII, etc.). */
    redacted: boolean;
}

// -----------------------------------------------------------------------------
// Runtime input
// -----------------------------------------------------------------------------

export interface IAgentRuntimeInput {
    sessionId?: string | undefined;
    mode: TAgentMode;
    /**
     * Task goal in natural language.
     *
     * In `ask` / `agent` modes this often duplicates the last user message in
     * `messages`. When both are provided and they disagree, the runtime
     * treats `goal` as authoritative for system-prompt building.
     */
    goal: string;
    messages: IAgentMessageInput[];
    workspaceRootPath?: string | undefined;
    context?: IAgentContextReferenceInput[] | undefined;
    threadId?: string | undefined;

    /**
     * Plan continuation triple. These three fields are coupled — they must
     * be set together when resuming a plan, and all three must be absent
     * when starting a fresh request.
     *
     * Prefer the nested {@link IAgentRuntimeInput.planContinuation} shape
     * once downstream consumers migrate.
     */
    planId?: string | undefined;
    planVersion?: number | undefined;
    planStepId?: string | undefined;
}

// -----------------------------------------------------------------------------
// Approval / checkpoint inputs
// -----------------------------------------------------------------------------

/** Allowed decisions for an approval request. Extend as approval flows grow. */
export const APPROVAL_DECISIONS = ['approve', 'reject', 'cancel', 'modify'] as const;
export type TApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface IApprovalResolutionInput {
    requestId: string;
    decision: TApprovalDecision;
    sessionId?: string | undefined;
}

/**
 * Path into a nested step tree for rollback (`['step-1', 'sub-2']`).
 * Empty array means "roll back the whole run".
 */
export type TRollbackStepPath = readonly string[];

export interface ICheckpointRestoreInput {
    runId: string;
    snapshotId?: string | undefined;
    step?: TRollbackStepPath | undefined;
    sessionId?: string | undefined;
}

// -----------------------------------------------------------------------------
// Plan-store inputs
// -----------------------------------------------------------------------------

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