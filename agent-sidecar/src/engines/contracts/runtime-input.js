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
export const AGENT_MODES = ['ask', 'plan', 'agent', 'patch', 'review'];
// -----------------------------------------------------------------------------
// Approval / checkpoint inputs
// -----------------------------------------------------------------------------
/** Allowed decisions for an approval request. Extend as approval flows grow. */
export const APPROVAL_DECISIONS = ['approve', 'reject', 'cancel', 'modify'];
