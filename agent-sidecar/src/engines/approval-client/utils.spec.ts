import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    decodeApprovalRequestId,
    encodeApprovalRequestId,
    isApprovedDecision,
} from './utils.js';

describe('isApprovedDecision', () => {
    it('approves the canonical affirmative contract decision', () => {
        assert.equal(isApprovedDecision('approve'), true);
        assert.equal(isApprovedDecision('approved'), true);
    });

    it('accepts the UI affirmative aliases defensively', () => {
        assert.equal(isApprovedDecision('allow'), true);
        assert.equal(isApprovedDecision('allow-once'), true);
        assert.equal(isApprovedDecision('allow-run'), true);
    });

    it('normalizes case and surrounding whitespace', () => {
        assert.equal(isApprovedDecision('  APPROVE '), true);
        assert.equal(isApprovedDecision('Allow-Once'), true);
    });

    it('declines the canonical negative contract decision', () => {
        assert.equal(isApprovedDecision('reject'), false);
    });

    it('fails closed for cancel and modify (regression for the old fail-open deny-list)', () => {
        assert.equal(isApprovedDecision('cancel'), false);
        assert.equal(isApprovedDecision('modify'), false);
    });

    it('fails closed for unknown, empty, or malformed decisions', () => {
        assert.equal(isApprovedDecision(''), false);
        assert.equal(isApprovedDecision('   '), false);
        assert.equal(isApprovedDecision('maybe'), false);
        assert.equal(isApprovedDecision('yolo'), false);
        assert.equal(isApprovedDecision('skip'), false);
        assert.equal(isApprovedDecision('stop'), false);
    });
});

describe('approval request id round-trip', () => {
    it('encodes and decodes runId, toolCallId, and path', () => {
        const requestId = encodeApprovalRequestId('run-1', 'tool-1', 'src/a.ts');
        assert.deepEqual(decodeApprovalRequestId(requestId), {
            runId: 'run-1',
            toolCallId: 'tool-1',
            path: 'src/a.ts',
        });
    });

    it('omits an empty path when encoding', () => {
        const requestId = encodeApprovalRequestId('run-2', 'tool-2');
        assert.deepEqual(decodeApprovalRequestId(requestId), {
            runId: 'run-2',
            toolCallId: 'tool-2',
        });
    });

    it('returns null for ids without the approval token prefix', () => {
        assert.equal(decodeApprovalRequestId('not-an-approval-id'), null);
    });
});
