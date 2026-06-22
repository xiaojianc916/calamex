import { describe, expect, it } from 'vitest';
import {
  inferToolKind,
  legacyMessageToEntries,
  legacyThreadToThread,
} from '@/store/aiThread/legacy-adapter';
import type { IAiAgentPatchSummary, IAiChatMessage } from '@/types/ai';
import type { IAiContextReference } from '@/types/ai/context';
import type { IAiConversationThread } from '@/types/ai/conversation.schema';
import type {
  IAiThreadAssistantMessageEntry,
  IAiThreadToolCall,
  IAiThreadUserMessageEntry,
} from '@/types/ai/thread';

const ISO = '2026-06-14T09:00:00.000Z';

const userMessage = (overrides: Partial<IAiChatMessage> = {}): IAiChatMessage => ({
  id: 'u1',
  role: 'user',
  content: '你好',
  createdAt: ISO,
  references: [],
  ...overrides,
});

describe('legacyMessageToEntries', () => {
  it('user 消息 -> user_message + text block', () => {
    const entries = legacyMessageToEntries(userMessage());
    expect(entries).toHaveLength(1);
    const entry = entries[0] as IAiThreadUserMessageEntry;
    expect(entry.type).toBe('user_message');
    expect(entry.content).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('user 消息透传 references 到 user_message entry', () => {
    const ref: IAiContextReference = {
      id: 'r1',
      kind: 'selection',
      label: 'sel',
      path: 'src/a.ts',
      range: { startLine: 1, endLine: 2 },
      contentPreview: 'x',
      redacted: false,
    };
    const entries = legacyMessageToEntries(userMessage({ references: [ref] }));
    expect((entries[0] as IAiThreadUserMessageEntry).references).toEqual([ref]);
  });

  it('空 user 消息 -> 空 content 数组', () => {
    const entries = legacyMessageToEntries(userMessage({ content: '   ' }));
    expect((entries[0] as IAiThreadUserMessageEntry).content).toEqual([]);
  });

  it('assistant + toolCalls -> tool_call(在前) + assistant_message(在后)', () => {
    const message: IAiChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '最终回答',
      createdAt: ISO,
      references: [],
      toolCalls: [
        {
          id: 't1',
          name: 'search_code',
          status: 'succeeded',
          summary: 'Search code',
          targetPreview: 'src/**',
          detailItems: ['hit a', 'hit b'],
          elapsedMs: 1200,
        },
      ],
    };
    const entries = legacyMessageToEntries(message);
    expect(entries.map((e) => e.type)).toEqual(['tool_call', 'assistant_message']);

    const tool = entries[0] as IAiThreadToolCall;
    expect(tool.id).toBe('t1');
    expect(tool.status).toBe('completed');
    expect(tool.kind).toBe('search');
    expect(tool.title).toBe('Search code');
    expect(tool.content).toHaveLength(3); // targetPreview + 2 detailItems

    const assistant = entries[1] as IAiThreadAssistantMessageEntry;
    expect(assistant.chunks).toEqual([
      { type: 'message', block: { type: 'text', text: '最终回答' } },
    ]);
  });

  it('assistant + reasoning -> thought chunk(在正文 chunk 之前)', () => {
    const entries = legacyMessageToEntries({
      id: 'a-reason',
      role: 'assistant',
      content: '最终回答',
      createdAt: ISO,
      references: [],
      reasoning: '我先分析再作答',
    });
    const assistant = entries[0] as IAiThreadAssistantMessageEntry;
    expect(assistant.type).toBe('assistant_message');
    expect(assistant.chunks).toEqual([
      { type: 'thought', block: { type: 'text', text: '我先分析再作答' } },
      { type: 'message', block: { type: 'text', text: '最终回答' } },
    ]);
  });

  it('状态映射覆盖全部 5 种 legacy 状态', () => {
    const statuses = ['pending', 'running', 'succeeded', 'failed', 'denied'] as const;
    const expected = ['pending', 'in_progress', 'completed', 'failed', 'canceled'];
    const got = statuses.map((status) => {
      const entries = legacyMessageToEntries({
        id: `a-${status}`,
        role: 'assistant',
        content: '',
        createdAt: ISO,
        references: [],
        toolCalls: [{ id: `tc-${status}`, name: 'x', status, summary: 's' }],
      });
      return (entries[0] as IAiThreadToolCall).status;
    });
    expect(got).toEqual(expected);
  });

  it('assistant + changedFilesSummary -> 末尾追加 changed_files entry', () => {
    const summary: IAiAgentPatchSummary = {
      id: 'patch-1',
      runId: 'run-1',
      stepId: 'step-1',
      files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, diffRef: 'd1' }],
      totalAdditions: 3,
      totalDeletions: 1,
      patchRef: 'pr-1',
      appliedAt: '2026-06-14T10:00:00.000Z',
    };
    const entries = legacyMessageToEntries({
      id: 'a1',
      role: 'assistant',
      content: '改完了',
      createdAt: ISO,
      references: [],
      changedFilesSummary: summary,
    });
    expect(entries.map((e) => e.type)).toEqual(['assistant_message', 'changed_files']);
    const changed = entries[1];
    expect(changed?.type).toBe('changed_files');
    if (changed?.type === 'changed_files') {
      expect(changed.id).toBe('patch-1');
      expect(changed.createdAt).toBe('2026-06-14T10:00:00.000Z');
      expect(changed.summary).toBe(summary);
    }
  });

  it('无 appliedAt 时 changed_files.createdAt 回退 message.createdAt；无最终文本仅 changed_files', () => {
    const summary: IAiAgentPatchSummary = {
      id: 'patch-2',
      runId: 'run-1',
      stepId: 'step-1',
      files: [{ path: 'src/b.ts', status: 'added', additions: 1, deletions: 0, diffRef: 'd2' }],
      totalAdditions: 1,
      totalDeletions: 0,
      patchRef: 'pr-2',
    };
    const entries = legacyMessageToEntries({
      id: 'a2',
      role: 'assistant',
      content: '',
      createdAt: ISO,
      references: [],
      changedFilesSummary: summary,
    });
    expect(entries.map((e) => e.type)).toEqual(['changed_files']);
    const changed = entries[0];
    if (changed?.type === 'changed_files') {
      expect(changed.createdAt).toBe(ISO);
    }
  });
  it('changedFilesSummary 时把内联 diff 挂到匹配的 tool_call entry', () => {
    const summary: IAiAgentPatchSummary = {
      id: 'patch-3',
      runId: 'run-1',
      stepId: 'step-1',
      files: [
        { path: 'src/foo.ts', status: 'modified', additions: 2, deletions: 0, diffRef: 'd3' },
      ],
      totalAdditions: 2,
      totalDeletions: 0,
      patchRef: 'pr-3',
    };
    const entries = legacyMessageToEntries({
      id: 'a3',
      role: 'assistant',
      content: '已修改 foo.ts',
      createdAt: ISO,
      references: [],
      toolCalls: [
        {
          id: 't1',
          name: 'write_file',
          status: 'succeeded',
          summary: '编辑 src/foo.ts',
          targetPreview: 'src/foo.ts',
        },
      ],
      changedFilesSummary: summary,
    });
    expect(entries.map((e) => e.type)).toEqual(['tool_call', 'assistant_message', 'changed_files']);
    const tool = entries[0] as IAiThreadToolCall;
    expect(tool.content.some((c) => c.type === 'diff')).toBe(true);
  });

  it('assistant + agentConfirmation -> plan_control(在 assistant_message 之后)', () => {
    const ref: IAiContextReference = {
      id: 'r1',
      kind: 'selection',
      label: 'sel',
      path: 'src/a.ts',
      range: { startLine: 1, endLine: 2 },
      contentPreview: 'x',
      redacted: false,
    };
    const entries = legacyMessageToEntries({
      id: 'a1',
      role: 'assistant',
      content: '方案如下',
      createdAt: ISO,
      references: [],
      agentConfirmation: { goal: '迁移流式渲染', references: [ref], status: 'pending' },
    });
    expect(entries.map((e) => e.type)).toEqual(['assistant_message', 'plan_control']);
    const control = entries[1];
    if (control.type === 'plan_control') {
      expect(control.id).toBe('a1:plan-control');
      expect(control.goal).toBe('迁移流式渲染');
      expect(control.phase).toBe('awaiting-approval');
      expect(control.references).toEqual([ref]);
    }
  });

  it('agentConfirmation.status=running -> phase=running', () => {
    const entries = legacyMessageToEntries({
      id: 'a2',
      role: 'assistant',
      content: '',
      createdAt: ISO,
      references: [],
      agentConfirmation: { goal: 'g', references: [], status: 'running' },
    });
    expect(entries.map((e) => e.type)).toEqual(['plan_control']);
    const control = entries[0];
    if (control.type === 'plan_control') {
      expect(control.phase).toBe('running');
    }
  });

  it('inferToolKind 启发式', () => {
    expect(inferToolKind('read_file')).toBe('read');
    expect(inferToolKind('apply_patch')).toBe('edit');
    expect(inferToolKind('run_command')).toBe('execute');
    expect(inferToolKind('web_fetch')).toBe('fetch');
    expect(inferToolKind('totally_unknown')).toBe('other');
  });
});

describe('legacyThreadToThread', () => {
  it('沿用元信息, 展平 messages 为 entries', () => {
    const thread: IAiConversationThread = {
      id: 'th1',
      title: '标题',
      titleStatus: 'generated',
      createdAt: ISO,
      updatedAt: ISO,
      messages: [
        userMessage(),
        { id: 'a1', role: 'assistant', content: '回答', createdAt: ISO, references: [] },
      ],
    };
    const result = legacyThreadToThread(thread);
    expect(result.id).toBe('th1');
    expect(result.title).toBe('标题');
    expect(result.titleStatus).toBe('generated');
    expect(result.entries.map((e) => e.type)).toEqual(['user_message', 'assistant_message']);
  });
});
