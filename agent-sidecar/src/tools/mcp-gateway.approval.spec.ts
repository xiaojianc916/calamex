import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readMcpToolAnnotations,
  requiresMcpToolApproval,
  resolveMcpToolCapability,
} from './mcp-gateway.js';

// 审批判定完全基于 server 在 tools/list 自报的 annotations（经 @mastra/mcp
// 透传到 tool.mcp.annotations），不依赖工具名形态。
describe('resolveMcpToolCapability / requiresMcpToolApproval（基于 annotations，不猜名字）', () => {
  it('server 级无副作用白名单：无需 annotations 即判只读、免审批（信任优先于注解）', () => {
    assert.equal(resolveMcpToolCapability('sequential-thinking', undefined), 'readonly');
    assert.equal(resolveMcpToolCapability('context7', undefined), 'readonly');
    assert.equal(requiresMcpToolApproval('sequential-thinking', undefined), false);
    assert.equal(requiresMcpToolApproval('context7', undefined), false);
    // 即便注解声明 destructive，白名单 server 仍按 server 级信任判只读。
    assert.equal(resolveMcpToolCapability('context7', { destructiveHint: true }), 'readonly');
  });

  it('readOnlyHint === true → 只读、免审批', () => {
    assert.equal(resolveMcpToolCapability('github', { readOnlyHint: true }), 'readonly');
    assert.equal(requiresMcpToolApproval('github', { readOnlyHint: true }), false);
    assert.equal(requiresMcpToolApproval('git', { title: 'Git Status', readOnlyHint: true }), false);
  });

  it('destructiveHint === true → 写、要求审批', () => {
    assert.equal(resolveMcpToolCapability('github', { destructiveHint: true }), 'write');
    assert.equal(requiresMcpToolApproval('github', { destructiveHint: true }), true);
  });

  it('有注解但未声明只读（含字段缺省 / 仅增量写入）→ 按 spec 默认保守判写、要求审批', () => {
    assert.equal(resolveMcpToolCapability('git', {}), 'write');
    assert.equal(resolveMcpToolCapability('git', { readOnlyHint: false }), 'write');
    assert.equal(resolveMcpToolCapability('github', { destructiveHint: false }), 'write');
    assert.equal(requiresMcpToolApproval('git', {}), true);
  });

  it('完全无注解的非白名单 server → 能力未知 → fail-closed 要求审批', () => {
    assert.equal(resolveMcpToolCapability('git', undefined), 'unknown');
    assert.equal(resolveMcpToolCapability('sqlite-mcp', undefined), 'unknown');
    assert.equal(requiresMcpToolApproval('git', undefined), true);
    // 旧名字启发式会把 sqlite-mcp 的 query 误判为只读而绕过审批；现按“未知→审批”兜住。
    assert.equal(requiresMcpToolApproval('sqlite-mcp', undefined), true);
  });
});

describe('readMcpToolAnnotations（从 @mastra/mcp 透传的工具对象读取注解）', () => {
  it('优先读取 tool.mcp.annotations', () => {
    const tool = { id: 't', mcp: { annotations: { readOnlyHint: true, title: 'X' } } };
    assert.deepEqual(readMcpToolAnnotations(tool), { readOnlyHint: true, title: 'X' });
  });

  it('回退读取 tool.annotations', () => {
    const tool = { id: 't', annotations: { destructiveHint: true } };
    assert.deepEqual(readMcpToolAnnotations(tool), { destructiveHint: true });
  });

  it('无注解 / 非对象 → undefined', () => {
    assert.equal(readMcpToolAnnotations({ id: 't' }), undefined);
    assert.equal(readMcpToolAnnotations(undefined), undefined);
    assert.equal(readMcpToolAnnotations(null), undefined);
  });

  it('端到端：未注解工具 → 审批；声明只读工具 → 免审批', () => {
    const writeTool = { id: 'w' };
    const readTool = { id: 'r', mcp: { annotations: { readOnlyHint: true } } };
    assert.equal(requiresMcpToolApproval('git', readMcpToolAnnotations(writeTool)), true);
    assert.equal(requiresMcpToolApproval('git', readMcpToolAnnotations(readTool)), false);
  });
});
