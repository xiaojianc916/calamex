import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveApprovalRisk } from './responses.js';

test('deriveApprovalRisk：不可逆的 git 操作判定为 high / 不可逆', () => {
    for (const toolName of ['git_push', 'push_files', 'merge_pull_request', 'delete_file']) {
        const risk = deriveApprovalRisk({ toolName });
        assert.equal(risk.riskLevel, 'high', toolName);
        assert.equal(risk.reversible, false, toolName);
    }
});

test('deriveApprovalRisk：会读取网关工具的参数（mcp_call_tool）', () => {
    const risk = deriveApprovalRisk({
        toolName: 'mcp_call_tool',
        args: { server: 'git', tool: 'execute_command', command: 'rm -rf build' },
    });
    assert.equal(risk.riskLevel, 'high');
    assert.equal(risk.reversible, false);
});

test('deriveApprovalRisk：普通写操作判定为可逆的 medium', () => {
    const risk = deriveApprovalRisk({ toolName: 'create_or_update_file', args: { path: 'a.txt' } });
    assert.equal(risk.riskLevel, 'medium');
    assert.equal(risk.reversible, true);
});

test('deriveApprovalRisk：只读操作判定为 low', () => {
    const risk = deriveApprovalRisk({ toolName: 'get_file_contents', args: { path: 'a.txt' } });
    assert.equal(risk.riskLevel, 'low');
    assert.equal(risk.reversible, true);
});
