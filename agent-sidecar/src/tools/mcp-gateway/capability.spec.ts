import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMcpGatewayToolDescriptor,
  readMcpToolAnnotations,
  resolveMcpToolApprovalDefault,
  resolveMcpToolCapability,
} from './capability.js';

test('resolveMcpToolCapability：server 级无副作用白名单优先于 annotations', () => {
  assert.equal(
    resolveMcpToolCapability('sequential-thinking', { destructiveHint: true }),
    'readonly',
  );
});

test('resolveMcpToolCapability：仅正向 readOnlyHint 免审批，其余 fail-closed', () => {
  assert.equal(resolveMcpToolCapability('github', { readOnlyHint: true }), 'readonly');
  assert.equal(resolveMcpToolCapability('github', { destructiveHint: false }), 'write');
  assert.equal(resolveMcpToolCapability('github', undefined), 'unknown');
});

test('createMcpGatewayToolDescriptor：把 MCP annotations 统一映射到 Calamex descriptor', () => {
  assert.deepEqual(createMcpGatewayToolDescriptor('github', 'list_issues', { readOnlyHint: true }), {
    name: 'mcp:github:list_issues',
    source: 'mcp',
    kind: 'read',
    mutatesState: false,
    requiresApprovalByDefault: false,
    supportsStreamingInput: false,
    requiredCapability: 'tools',
  });

  assert.deepEqual(createMcpGatewayToolDescriptor('github', 'create_issue', undefined), {
    name: 'mcp:github:create_issue',
    source: 'mcp',
    kind: 'other',
    mutatesState: true,
    requiresApprovalByDefault: true,
    supportsStreamingInput: false,
    requiredCapability: 'tools',
  });
});

test('resolveMcpToolApprovalDefault：复用 descriptor 审批默认值', () => {
  assert.equal(resolveMcpToolApprovalDefault('github', 'list_issues', { readOnlyHint: true }), false);
  assert.equal(resolveMcpToolApprovalDefault('github', 'create_issue', { destructiveHint: true }), true);
  assert.equal(resolveMcpToolApprovalDefault('github', 'unknown_tool', undefined), true);
});

test('readMcpToolAnnotations：优先读取 @mastra/mcp 透传的 tool.mcp.annotations', () => {
  assert.deepEqual(readMcpToolAnnotations({
    mcp: { annotations: { readOnlyHint: true } },
    annotations: { destructiveHint: true },
  }), { readOnlyHint: true });

  assert.deepEqual(readMcpToolAnnotations({
    annotations: { destructiveHint: true },
  }), { destructiveHint: true });
});
