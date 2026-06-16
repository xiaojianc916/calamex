import { Buffer } from 'node:buffer';
import { APPROVAL_TOKEN_PREFIX, toRecord } from '../shared/utils.js';

export interface IEncodedApprovalRequestPayload {
    runId: string;
    toolCallId: string;
    path?: string | undefined;
}

export const extractApprovalToolPath = (args: unknown): string | undefined => {
    const path = toRecord(args)?.path;
    return typeof path === 'string' && path.trim().length > 0 ? path : undefined;
};

export const encodeApprovalRequestId = (
    runId: string,
    toolCallId: string,
    path?: string,
): string => {
    const encoded = Buffer.from(JSON.stringify({
        runId,
        toolCallId,
        ...(typeof path === 'string' && path.trim().length > 0 ? { path } : {}),
    } satisfies IEncodedApprovalRequestPayload), 'utf8').toString('base64url');

    return `${APPROVAL_TOKEN_PREFIX}${encoded}`;
};

export const decodeApprovalRequestId = (
    requestId: string,
): IEncodedApprovalRequestPayload | null => {
    if (!requestId.startsWith(APPROVAL_TOKEN_PREFIX)) {
        return null;
    }

    try {
        const parsed = JSON.parse(
            Buffer.from(requestId.slice(APPROVAL_TOKEN_PREFIX.length), 'base64url').toString('utf8'),
        ) as { runId?: unknown; toolCallId?: unknown; path?: unknown };

        return typeof parsed.runId === 'string' && typeof parsed.toolCallId === 'string'
            ? {
                runId: parsed.runId,
                toolCallId: parsed.toolCallId,
                ...(typeof parsed.path === 'string' && parsed.path.trim().length > 0
                    ? { path: parsed.path }
                    : {}),
            }
            : null;
    } catch {
        return null;
    }
};

export const getChunkRunId = (chunk: unknown): string | null => {
    const runId = toRecord(chunk)?.runId;
    return typeof runId === 'string' && runId.trim().length > 0 ? runId : null;
};

/**
 * Affirmative approval tokens. This is an ALLOW-LIST and the gate is
 * fail-closed: any decision that is not explicitly listed here is treated as
 * NOT approved, so the pending dangerous tool call is declined instead of
 * executed.
 *
 * The canonical sidecar contract decisions are `approve | reject | cancel |
 * modify` (see APPROVAL_DECISIONS in engines/contracts/runtime-input.ts). Only
 * `approve` is affirmative; `reject`, `cancel`, and `modify` must NOT proceed.
 * The UI confirmation ids `allow-once` / `allow-run` / `allow` are also
 * accepted defensively, in case a caller forwards the raw confirmation id
 * without first mapping it to `approve`.
 *
 * NOTE: This used to be a deny-list, which fail-OPEN: `cancel`, `modify`, and
 * any unknown/empty decision were incorrectly treated as approved. Keep this an
 * allow-list so that new or unexpected decision values default to "deny".
 */
const APPROVED_DECISION_TOKENS: ReadonlySet<string> = new Set([
    'approve',
    'approved',
    'allow',
    'allow-once',
    'allow-run',
]);

export const isApprovedDecision = (decision: string): boolean =>
    APPROVED_DECISION_TOKENS.has(decision.trim().toLowerCase());
