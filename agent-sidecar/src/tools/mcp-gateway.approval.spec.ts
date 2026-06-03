import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requiresMcpToolApproval } from './mcp-gateway.js';

describe('requiresMcpToolApproval (fail-closed)', () => {
  it('requires approval for unknown / unclassified tools (the bypass that was open)', () => {
    assert.equal(requiresMcpToolApproval('git', 'frobnicate'), true);
    assert.equal(requiresMcpToolApproval('hooks-mcp', 'do_something_weird'), true);
  });

  it('requires approval for a destructive sqlite query the old name heuristic missed', () => {
    assert.equal(requiresMcpToolApproval('sqlite-mcp', 'query'), true);
  });

  it('requires approval for known write operations', () => {
    assert.equal(requiresMcpToolApproval('git', 'git_commit'), true);
    assert.equal(requiresMcpToolApproval('git', 'commit'), true);
    assert.equal(requiresMcpToolApproval('github', 'create_issue'), true);
    assert.equal(requiresMcpToolApproval('github', 'merge_pull_request'), true);
  });

  it('skips approval for clearly read-only tool names', () => {
    assert.equal(requiresMcpToolApproval('git', 'git_status'), false);
    assert.equal(requiresMcpToolApproval('git', 'log'), false);
    assert.equal(requiresMcpToolApproval('github', 'get_file_contents'), false);
    assert.equal(requiresMcpToolApproval('github', 'search_repositories'), false);
    assert.equal(requiresMcpToolApproval('probe', 'search_code'), false);
  });

  it('skips approval for side-effect-free servers', () => {
    assert.equal(requiresMcpToolApproval('sequential-thinking', 'sequentialthinking'), false);
    assert.equal(requiresMcpToolApproval('context7', 'resolve-library-id'), false);
    assert.equal(requiresMcpToolApproval('context7', 'get-library-docs'), false);
  });

  it('errs toward approval when a read-ish github name collides with the coarse write pattern', () => {
    // list_branches contains 'branch' -> over-approval is the SAFE failure mode.
    assert.equal(requiresMcpToolApproval('github', 'list_branches'), true);
  });
});
