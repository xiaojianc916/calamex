import { describe, expect, it } from 'vitest';

import type { IAiChatMessage, TAiChatRole } from '@/types/ai';
import type { IAiAgentPatchSummary } from '@/types/ai/patch';
import {
  AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  type IAgentAcontextContextCompactionCompletedEvent,
  type IAgentReasoningDeltaEvent,
  type IAgentRuntimeEventBase,
  type IAgentToolCompletedEvent,
  type IAgentToolStartedEvent,
} from '@/types/ai/sidecar';

import { buildThreadEntries } from './build-thread-entries';
import type { IAiThreadToolCallEntry } from './entry-types';

const makeMessage = (
  id: string,
  role: TAiChatRole,
  overrides: Partial<Omit<IAiChatMessage, 'id' | 'role'>> = {},
): IAiChatMessage => ({
  id,
  role,
  content: '',
  createdAt: '2026-06-08T00:00:00.000Z',
  references: [],
  ...overrides,
});

const makeEventBase = (id: string, seq: number): Omit<IAgentRuntimeEventBase, 'type'> => ({
  id,
  runId: 'run-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
  timestamp: '2026-06-08T00:00:00.000Z',
  seq,
  schemaVersion: AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  redacted: true,
  visibility: 'user',
});

const findToolCallEntry = (
  entries: ReturnType<typeof buildThreadEntries>,
): IAiThreadToolCallEntry | undefined =>
  entries.find((entry): entry is IAiThreadToolCallEntry => entry.kind === 'tool-call');

describe('buildThreadEntries', () => {
  it('投影用户消息与助手文本为平铺条目', () => {
    const entries = buildThreadEntries([
      makeMessage('m1', 'user', { content: '帮我改一下登录逻辑' }),
      makeMessage('m2', 'assistant', { content: '好的,已经完成。' }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(['user-message', 'assistant-text']);
    expect(entries[0]).toMatchObject({ kind: 'user-message', markdown: '帮我改一下登录逻辑' });
  });

  it('跳过空白用户消息以及 system / tool 角色', () => {
    const entries = buildThreadEntries([
      makeMessage('m1', 'user', { content: '   ' }),
      makeMessage('m2', 'system', { content: '系统提示' }),
      makeMessage('m3', 'tool', { content: '工具结果' }),
    ]);

    expect(entries).toEqual([]);
  });

  it('从运行时事件展开推理、工具调用与上下文整理条目', () => {
    const reasoning: IAgentReasoningDeltaEvent = {
      ...makeEventBase('evt-reasoning', 0),
      type: 'agent.reasoning.delta',
      text: '先读取文件,再决定修改方案。',
    };
    const toolStarted: IAgentToolStartedEvent = {
      ...makeEventBase('evt-tool-started', 1),
      type: 'agent.tool.started',
      toolUseId: 'tool-use-1',
      toolName: 'read_file',
      inputPreview: 'src/foo.ts',
    };
    const toolCompleted: IAgentToolCompletedEvent = {
      ...makeEventBase('evt-tool-completed', 2),
      type: 'agent.tool.completed',
      toolUseId: 'tool-use-1',
      toolName: 'read_file',
      ok: true,
      resultPreview: '文件内容',
    };
    const compaction: IAgentAcontextContextCompactionCompletedEvent = {
      ...makeEventBase('evt-compaction', 3),
      type: 'acontext.context_compaction.completed',
      compactionId: 'compaction-1',
      reason: 'budget',
      summaryCharCount: 1200,
    };

    const entries = buildThreadEntries([
      makeMessage('m1', 'assistant', {
        content: '已读取并理解相关文件。',
        stream: {
          status: 'completed',
          runtimeEvents: [reasoning, toolStarted, toolCompleted, compaction],
        },
      }),
    ]);

    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('tool-call');
    expect(kinds).toContain('context-compaction');
    expect(kinds[kinds.length - 1]).toBe('assistant-text');
    expect(findToolCallEntry(entries)?.status).toBe('succeeded');
  });

  it('在缺少运行时事件时映射 wire 工具调用(Chat 模式)', () => {
    const entries = buildThreadEntries([
      makeMessage('m1', 'assistant', {
        content: '完成。',
        toolCalls: [
          {
            id: 't1',
            name: 'read_file',
            status: 'succeeded',
            summary: '已查看 foo.ts',
            targetPreview: 'src/foo.ts',
          },
        ],
      }),
    ]);

    expect(findToolCallEntry(entries)).toMatchObject({
      kind: 'tool-call',
      title: '已查看 foo.ts',
      status: 'succeeded',
      toolName: 'read_file',
    });
  });

  it('把改动文件内联挂到写入类工具调用,并保留末尾汇总条目', () => {
    const summary: IAiAgentPatchSummary = {
      id: 'patch-1',
      runId: 'run-1',
      stepId: 'step-1',
      files: [
        {
          path: 'src/foo.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          diffRef: 'diff-1',
        },
      ],
      totalAdditions: 3,
      totalDeletions: 1,
      patchRef: 'patch-ref-1',
    };

    const entries = buildThreadEntries([
      makeMessage('m1', 'assistant', {
        content: '已修改 foo.ts。',
        toolCalls: [
          {
            id: 't1',
            name: 'write_file',
            status: 'succeeded',
            summary: '编辑完成 foo.ts',
            targetPreview: 'src/foo.ts',
          },
        ],
        changedFilesSummary: summary,
      }),
    ]);

    const toolEntry = findToolCallEntry(entries);
    expect(toolEntry?.content).toHaveLength(1);
    expect(toolEntry?.content[0]).toMatchObject({ type: 'diff', patchSummaryId: 'patch-1' });
    expect(entries.some((entry) => entry.kind === 'changed-files-summary')).toBe(true);
  });

  it('从 agentConfirmation 生成 Plan 控制条目', () => {
    const entries = buildThreadEntries([
      makeMessage('m1', 'assistant', {
        content: '这是我的执行计划。',
        agentConfirmation: {
          goal: '重构登录模块',
          references: [],
          status: 'pending',
        },
      }),
    ]);

    expect(entries.find((entry) => entry.kind === 'plan-control')).toMatchObject({
      kind: 'plan-control',
      phase: 'awaiting-approval',
    });
  });
});
