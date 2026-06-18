import { describe, expect, it } from 'vitest';

import type { ITaskNodeItem } from '@/components/business/ai/plan/runtime-timeline';
import { WAITING_DECISION_LABEL } from '@/components/business/ai/plan/runtime-timeline';

import { fromRuntimeToolCall } from './from-runtime-tool-call';

const baseNode = (overrides: Partial<ITaskNodeItem> = {}): ITaskNodeItem => ({
  id: 'node-1',
  kind: 'read',
  icon: 'file',
  action: '已查看 a.ts',
  tags: [],
  status: 'succeeded',
  ...overrides,
});

const opts = { createdAt: '2026-06-17T00:00:00.000Z' };

describe('fromRuntimeToolCall', () => {
  it('映射 id / 标题 / kind / 状态 / createdAt', () => {
    const { toolCall } = fromRuntimeToolCall(
      baseNode({ kind: 'write', toolUseId: 'tu-1', action: '编辑完成 a.ts', status: 'running' }),
      opts,
    );
    expect(toolCall).toMatchObject({
      type: 'tool_call',
      id: 'tu-1',
      createdAt: '2026-06-17T00:00:00.000Z',
      title: '编辑完成 a.ts',
      kind: 'edit',
      status: 'in_progress',
      content: [],
    });
  });

  it('无 toolUseId 时 id 回退到节点 id', () => {
    expect(fromRuntimeToolCall(baseNode({ id: 'n9' }), opts).toolCall.id).toBe('n9');
  });

  it('内联终端输出注册进快照表,content 仅留引用', () => {
    const res = fromRuntimeToolCall(
      baseNode({
        toolUseId: 'tu',
        terminalOutput: 'hello',
        terminalTitle: 'bash',
        terminalStreaming: true,
      }),
      opts,
    );
    expect(res.toolCall.content).toEqual([{ type: 'terminal', terminalId: 'tu:terminal' }]);
    expect(res.terminals).toEqual({
      'tu:terminal': { title: 'bash', output: 'hello', streaming: true },
    });
  });

  it('无终端输出时不产生终端内容', () => {
    const res = fromRuntimeToolCall(baseNode({ terminalOutput: '' }), opts);
    expect(res.toolCall.content).toEqual([]);
    expect(res.terminals).toEqual({});
  });

  it('webSearchSources → source 内容块', () => {
    const res = fromRuntimeToolCall(
      baseNode({
        kind: 'network',
        webSearchSources: [{ url: 'https://a', host: 'a', displayUrl: 'a.com' }],
      }),
      opts,
    );
    expect(res.toolCall.content).toEqual([
      { type: 'content', block: { type: 'source', url: 'https://a', title: 'a.com' } },
    ]);
  });

  it('rawInput/rawOutput 仅非空透传', () => {
    const res = fromRuntimeToolCall(baseNode({ rawInput: '{"a":1}', rawOutput: '   ' }), opts);
    expect(res.toolCall.rawInput).toBe('{"a":1}');
    expect(res.toolCall.rawOutput).toBeUndefined();
  });

  it('等待决策返回 awaiting 标志', () => {
    expect(
      fromRuntimeToolCall(baseNode({ shimmerAction: true, action: WAITING_DECISION_LABEL }), opts)
        .awaiting,
    ).toBe(true);
    expect(fromRuntimeToolCall(baseNode(), opts).awaiting).toBe(false);
  });

  it('状态与 kind 覆盖映射', () => {
    expect(fromRuntimeToolCall(baseNode({ status: 'pending' }), opts).toolCall.status).toBe(
      'pending',
    );
    expect(fromRuntimeToolCall(baseNode({ status: 'failed' }), opts).toolCall.status).toBe(
      'failed',
    );
    expect(fromRuntimeToolCall(baseNode({ kind: 'terminal' }), opts).toolCall.kind).toBe('execute');
    expect(fromRuntimeToolCall(baseNode({ kind: 'browser' }), opts).toolCall.kind).toBe('fetch');
    expect(fromRuntimeToolCall(baseNode({ kind: 'git' }), opts).toolCall.kind).toBe('other');
    expect(fromRuntimeToolCall(baseNode({ kind: 'search' }), opts).toolCall.kind).toBe('search');
  });
});
