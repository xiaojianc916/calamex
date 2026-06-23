import { describe, expect, it } from 'vitest';

import {
  aiThreadAssistantChunkSchema,
  aiThreadEntrySchema,
  aiThreadSchema,
  aiThreadToolCallSchema,
  aiThreadToolKindSchema,
  aiThreadUserMessageEntrySchema,
} from '@/types/ai/thread';

const ISO = '2026-06-14T09:00:00.000Z';

describe('AI thread entry schema', () => {
  it('校验一个完整线程：user / assistant(正文+思维交织) / tool_call / plan', () => {
    const thread = aiThreadSchema.parse({
      id: 'thread-1',
      title: '重构流式渲染',
      titleStatus: 'generated',
      createdAt: ISO,
      updatedAt: ISO,
      entries: [
        {
          type: 'user_message',
          id: 'u1',
          createdAt: ISO,
          content: [{ type: 'text', text: '为什么别人的 UI 那么丝滑？' }],
        },
        {
          type: 'assistant_message',
          id: 'a1',
          createdAt: ISO,
          chunks: [
            { type: 'thought', block: { type: 'text', text: '先检索对比方案' } },
            { type: 'message', block: { type: 'text', text: '根因在数据模型与编排。' } },
            { type: 'message', block: { type: 'source', url: 'https://zed.dev' } },
          ],
        },
        {
          type: 'tool_call',
          id: 'tc1',
          createdAt: ISO,
          title: 'Search code',
          kind: 'search',
          status: 'in_progress',
          content: [
            { type: 'content', block: { type: 'text', text: 'acp_thread.rs' } },
            { type: 'terminal', terminalId: 'term-1' },
          ],
        },
        {
          type: 'plan',
          id: 'p1',
          createdAt: ISO,
          steps: [],
        },
      ],
    });

    expect(thread.entries).toHaveLength(4);
    const assistant = thread.entries[1];
    expect(assistant.type).toBe('assistant_message');
    if (assistant.type === 'assistant_message') {
      // 正文与思维链按到达顺序交织在同一条 chunks 流
      expect(assistant.chunks.map((chunk) => chunk.type)).toEqual([
        'thought',
        'message',
        'message',
      ]);
    }
  });

  it('user_message references 缺省兜底为空数组，提供则解析透传', () => {
    const withDefault = aiThreadUserMessageEntrySchema.parse({
      type: 'user_message',
      id: 'u1',
      createdAt: ISO,
      content: [],
    });
    expect(withDefault.references).toEqual([]);

    const parsed = aiThreadUserMessageEntrySchema.parse({
      type: 'user_message',
      id: 'u2',
      createdAt: ISO,
      content: [],
      references: [
        {
          id: 'r1',
          kind: 'current-file',
          label: 'foo.ts',
          path: 'src/foo.ts',
          range: null,
          contentPreview: '',
          redacted: false,
        },
      ],
    });
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]).toMatchObject({ id: 'r1', kind: 'current-file' });
  });

  it('plan_control 解析 goal/phase, references 缺省兜底空数组', () => {
    const parsed = aiThreadEntrySchema.parse({
      type: 'plan_control',
      id: 'pc1',
      createdAt: ISO,
      goal: '迁移流式渲染',
      phase: 'awaiting-approval',
    });
    expect(parsed.type).toBe('plan_control');
    if (parsed.type === 'plan_control') {
      expect(parsed.goal).toBe('迁移流式渲染');
      expect(parsed.phase).toBe('awaiting-approval');
      expect(parsed.references).toEqual([]);
    }
  });

  it('plan_control 拒绝非法 phase', () => {
    expect(() =>
      aiThreadEntrySchema.parse({
        type: 'plan_control',
        id: 'pc2',
        createdAt: ISO,
        goal: 'x',
        phase: 'done',
      }),
    ).toThrow();
  });

  it('拒绝非法的工具调用状态', () => {
    expect(() =>
      aiThreadToolCallSchema.parse({
        type: 'tool_call',
        id: 'tc-bad',
        createdAt: ISO,
        title: 'X',
        kind: 'search',
        status: 'running', // 不在五态集合内（应为 in_progress）
        content: [],
      }),
    ).toThrow();
  });

  it('未知工具种类兑底为 other', () => {
    expect(aiThreadToolKindSchema.parse('totally-unknown-kind')).toBe('other');
  });

  it('chunk 判别联合按 type 区分 message / thought（拒绝 tool_call chunk）', () => {
    const thought = aiThreadAssistantChunkSchema.parse({
      type: 'thought',
      block: { type: 'text', text: '思考中' },
    });
    expect(thought.type).toBe('thought');
    // 单一表示：工具调用只作为顶层 tool_call entry，chunk 联合不再接受 tool_call
    expect(() =>
      aiThreadAssistantChunkSchema.parse({ type: 'tool_call', block: { type: 'text', text: 'x' } }),
    ).toThrow();
  });

  it('entry 联合拒绝未知 type', () => {
    expect(() => aiThreadEntrySchema.parse({ type: 'mystery', id: 'x', createdAt: ISO })).toThrow();
  });

  it('assistant_message 接受可选 stream 快照，tool_call 接受原始 name', () => {
    const parsed = aiThreadEntrySchema.parse({
      type: 'assistant_message',
      id: 'a1',
      createdAt: ISO,
      chunks: [{ type: 'message', block: { type: 'text', text: '答案' } }],
      stream: {
        status: 'completed',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    });
    expect(parsed.type).toBe('assistant_message');
    if (parsed.type === 'assistant_message') {
      expect(parsed.stream?.status).toBe('completed');
    }

    const tool = aiThreadToolCallSchema.parse({
      type: 'tool_call',
      id: 'tc1',
      createdAt: ISO,
      name: 'read_project_file',
      title: '读取文件',
      kind: 'read',
      status: 'completed',
      content: [],
    });
    expect(tool.name).toBe('read_project_file');
  });
});
