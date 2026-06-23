import { describe, expect, it } from 'vitest';

import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import { nextToolStatus, reduceThread, reduceThreadAll } from '@/store/aiThread/reduce';
import type { IAiContextReference } from '@/types/ai/context';
import type {
  IAiThread,
  IAiThreadAssistantMessageEntry,
  IAiThreadChangedFilesEntry,
  IAiThreadContextCompactionEntry,
  IAiThreadPlanControlEntry,
  IAiThreadPlanEntry,
  IAiThreadToolCall,
  IAiThreadUserMessageEntry,
} from '@/types/ai/thread';

const ISO = '2026-06-14T09:00:00.000Z';

const createThread = (): IAiThread => ({
  id: 'thread-1',
  title: '重构',
  titleStatus: 'temporary',
  createdAt: ISO,
  updatedAt: ISO,
  entries: [],
});

describe('reduceThread', () => {
  it('回放一整段流：user / 思维+正文交织 / tool / 完成', () => {
    const events: TAiThreadReduceEvent[] = [
      {
        kind: 'user_message',
        id: 'u1',
        createdAt: ISO,
        blocks: [{ type: 'text', text: '为什么丝滑？' }],
      },
      {
        kind: 'assistant_delta',
        messageId: 'a1',
        createdAt: ISO,
        channel: 'thought',
        text: '思考',
      },
      { kind: 'assistant_delta', messageId: 'a1', createdAt: ISO, channel: 'thought', text: '中' },
      {
        kind: 'assistant_delta',
        messageId: 'a1',
        createdAt: ISO,
        channel: 'message',
        text: '根因',
      },
      {
        kind: 'assistant_delta',
        messageId: 'a1',
        createdAt: ISO,
        channel: 'message',
        text: '在数据模型',
      },
      { kind: 'tool_started', id: 't1', createdAt: ISO, title: 'Search', toolKind: 'search' },
      {
        kind: 'tool_progress',
        id: 't1',
        appendContent: [{ type: 'content', block: { type: 'text', text: 'hit' } }],
      },
      { kind: 'tool_completed', id: 't1', ok: true },
      { kind: 'stream_completed' },
    ];

    const result = reduceThreadAll(createThread(), events);

    expect(result.entries.map((e) => e.type)).toEqual([
      'user_message',
      'assistant_message',
      'tool_call',
    ]);

    const assistant = result.entries[1] as IAiThreadAssistantMessageEntry;
    // 同通道连续 delta 合并：2 thought-delta 合 1，2 message-delta 合 1
    expect(assistant.chunks).toHaveLength(2);
    expect(assistant.chunks[0]).toMatchObject({ type: 'thought', block: { text: '思考中' } });
    expect(assistant.chunks[1]).toMatchObject({
      type: 'message',
      block: { text: '根因在数据模型' },
    });

    const tool = result.entries[2] as IAiThreadToolCall;
    expect(tool.status).toBe('completed');
    expect(tool.content).toHaveLength(1);
  });

  it('工具在思考与回答之间到达：回答另起一段，工具不被前置（对标 Zed 段切分）', () => {
    const events: TAiThreadReduceEvent[] = [
      {
        kind: 'assistant_delta',
        messageId: 'a1',
        createdAt: ISO,
        channel: 'thought',
        text: '先想想',
      },
      { kind: 'tool_started', id: 't1', createdAt: ISO, title: 'Read', toolKind: 'read' },
      {
        kind: 'assistant_delta',
        messageId: 'a1',
        createdAt: ISO,
        channel: 'message',
        text: '答案',
      },
    ];

    const result = reduceThreadAll(createThread(), events);

    // 思考段在前、工具居中、回答另起一段在后：严格保持真实到达顺序（修复时序错乱）
    expect(result.entries.map((e) => e.type)).toEqual([
      'assistant_message',
      'tool_call',
      'assistant_message',
    ]);
    const first = result.entries[0] as IAiThreadAssistantMessageEntry;
    const last = result.entries[2] as IAiThreadAssistantMessageEntry;
    expect(first.id).toBe('a1');
    expect(first.chunks).toEqual([{ type: 'thought', block: { type: 'text', text: '先想想' } }]);
    expect(last.id).toBe('a1#1');
    expect(last.chunks).toEqual([{ type: 'message', block: { type: 'text', text: '答案' } }]);
  });

  it('不突变输入（纯函数 / 结构共享）', () => {
    const base = createThread();
    const next = reduceThread(base, {
      kind: 'user_message',
      id: 'u1',
      createdAt: ISO,
      blocks: [{ type: 'text', text: 'hi' }],
    });
    expect(base.entries).toHaveLength(0);
    expect(next.entries).toHaveLength(1);
    expect(next).not.toBe(base);
  });

  it('user_message 透传 references；缺省兜底空数组', () => {
    const ref: IAiContextReference = {
      id: 'r1',
      kind: 'current-file',
      label: 'foo.ts',
      path: 'src/foo.ts',
      range: null,
      contentPreview: '',
      redacted: false,
    };
    const withRefs = reduceThread(createThread(), {
      kind: 'user_message',
      id: 'u1',
      createdAt: ISO,
      blocks: [{ type: 'text', text: 'hi' }],
      references: [ref],
    });
    expect((withRefs.entries[0] as IAiThreadUserMessageEntry).references).toEqual([ref]);

    const withoutRefs = reduceThread(createThread(), {
      kind: 'user_message',
      id: 'u2',
      createdAt: ISO,
      blocks: [],
    });
    expect((withoutRefs.entries[0] as IAiThreadUserMessageEntry).references).toEqual([]);
  });

  it('tool_call 按 id upsert，不重复 append', () => {
    let thread = createThread();
    thread = reduceThread(thread, {
      kind: 'tool_started',
      id: 't1',
      createdAt: ISO,
      title: 'A',
      toolKind: 'read',
    });
    thread = reduceThread(thread, { kind: 'tool_progress', id: 't1' });
    thread = reduceThread(thread, {
      kind: 'tool_started',
      id: 't1',
      createdAt: ISO,
      title: 'A',
      toolKind: 'read',
    });
    expect(thread.entries.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });

  it('终态不可回退：completed 后的 progress 不降级', () => {
    let thread = createThread();
    thread = reduceThread(thread, {
      kind: 'tool_started',
      id: 't1',
      createdAt: ISO,
      title: 'A',
      toolKind: 'execute',
    });
    thread = reduceThread(thread, { kind: 'tool_completed', id: 't1', ok: true });
    thread = reduceThread(thread, { kind: 'tool_progress', id: 't1' });
    expect((thread.entries[0] as IAiThreadToolCall).status).toBe('completed');
  });

  it('tool_completed 携带 title 时刷新展示标题；缺省沿用 started 标题', () => {
    let withTitle = createThread();
    withTitle = reduceThread(withTitle, {
      kind: 'tool_started',
      id: 't1',
      createdAt: ISO,
      title: '正在查看 foo.ts',
      toolKind: 'read',
    });
    withTitle = reduceThread(withTitle, {
      kind: 'tool_completed',
      id: 't1',
      ok: true,
      title: '已查看 foo.ts',
    });
    expect((withTitle.entries[0] as IAiThreadToolCall).title).toBe('已查看 foo.ts');

    let keepTitle = createThread();
    keepTitle = reduceThread(keepTitle, {
      kind: 'tool_started',
      id: 't2',
      createdAt: ISO,
      title: '正在执行 build',
      toolKind: 'execute',
    });
    keepTitle = reduceThread(keepTitle, { kind: 'tool_completed', id: 't2', ok: true });
    expect((keepTitle.entries[0] as IAiThreadToolCall).title).toBe('正在执行 build');
  });

  it('stream_cancelled 把所有非终态 tool 收敛为 canceled', () => {
    let thread = createThread();
    thread = reduceThread(thread, {
      kind: 'tool_started',
      id: 't1',
      createdAt: ISO,
      title: 'A',
      toolKind: 'execute',
    });
    thread = reduceThread(thread, {
      kind: 'tool_started',
      id: 't2',
      createdAt: ISO,
      title: 'B',
      toolKind: 'search',
    });
    thread = reduceThread(thread, { kind: 'tool_completed', id: 't2', ok: true });
    thread = reduceThread(thread, { kind: 'stream_cancelled' });
    expect((thread.entries[0] as IAiThreadToolCall).status).toBe('canceled');
    // 已终态的不受影响
    expect((thread.entries[1] as IAiThreadToolCall).status).toBe('completed');
  });

  it('对不存在的 tool 的 progress 被忽略（不创建条目）', () => {
    const thread = reduceThread(createThread(), { kind: 'tool_progress', id: 'ghost' });
    expect(thread.entries).toHaveLength(0);
  });

  it('plan_updated 创建 plan entry；再次同 id 整体替换 steps（不重复、不挪位、保留 createdAt）', () => {
    let thread = createThread();
    thread = reduceThread(thread, { kind: 'plan_updated', id: 'p1', createdAt: ISO, steps: [] });
    expect(thread.entries.filter((e) => e.type === 'plan')).toHaveLength(1);

    const step: IAiThreadPlanEntry['steps'][number] = {
      id: 's1',
      index: 0,
      title: '读取入口',
      goal: '定位 reduce 写入点',
      kind: 'inspect',
      status: 'pending',
      expectedOutput: '入口清单',
      tools: ['read_file'],
      requiresUserApproval: false,
      riskLevel: 'low',
    };
    thread = reduceThread(thread, {
      kind: 'plan_updated',
      id: 'p1',
      createdAt: '2026-06-14T09:05:00.000Z',
      steps: [step],
    });

    const plans = thread.entries.filter((e) => e.type === 'plan') as IAiThreadPlanEntry[];
    expect(plans).toHaveLength(1);
    expect(plans[0].steps).toHaveLength(1);
    // 保留首次出现的 createdAt，位置稳定
    expect(plans[0].createdAt).toBe(ISO);
  });

  it('context_compaction 追加一条整理条目（带 message）', () => {
    const thread = reduceThread(createThread(), {
      kind: 'context_compaction',
      id: 'c1',
      createdAt: ISO,
      message: '已压缩历史上下文',
    });
    expect(thread.entries).toHaveLength(1);
    const entry = thread.entries[0] as IAiThreadContextCompactionEntry;
    expect(entry.type).toBe('context_compaction');
    expect(entry.message).toBe('已压缩历史上下文');
  });

  it('changed_files 按 id upsert：应用创建、撤销同 id 整体替换 summary 并保留位置', () => {
    let thread = createThread();
    const summary: IAiThreadChangedFilesEntry['summary'] = {
      id: 'patch-1',
      runId: 'run-1',
      stepId: 's1',
      files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, diffRef: 'd1' }],
      totalAdditions: 3,
      totalDeletions: 1,
      patchRef: 'p-ref-1',
    };
    thread = reduceThread(thread, {
      kind: 'changed_files',
      id: 'patch-1',
      createdAt: ISO,
      summary,
    });
    expect(thread.entries.filter((e) => e.type === 'changed_files')).toHaveLength(1);

    const reverted: IAiThreadChangedFilesEntry['summary'] = {
      ...summary,
      revertedAt: '2026-06-14T09:06:00.000Z',
    };
    thread = reduceThread(thread, {
      kind: 'changed_files',
      id: 'patch-1',
      createdAt: '2026-06-14T09:06:00.000Z',
      summary: reverted,
    });

    const changed = thread.entries.filter(
      (e) => e.type === 'changed_files',
    ) as IAiThreadChangedFilesEntry[];
    expect(changed).toHaveLength(1);
    expect(changed[0].summary.revertedAt).toBe('2026-06-14T09:06:00.000Z');
    // 保留首次出现的 createdAt，位置稳定
    expect(changed[0].createdAt).toBe(ISO);
  });

  it('plan_control_updated 创建 plan_control entry；再次同 id 替换 goal/phase/references，保留 createdAt', () => {
    let thread = createThread();
    thread = reduceThread(thread, {
      kind: 'plan_control_updated',
      id: 'pc1',
      createdAt: ISO,
      goal: '迁移流式渲染',
      phase: 'awaiting-approval',
    });
    expect(thread.entries.filter((e) => e.type === 'plan_control')).toHaveLength(1);
    const first = thread.entries[0] as IAiThreadPlanControlEntry;
    expect(first.references).toEqual([]);
    expect(first.phase).toBe('awaiting-approval');

    const ref: IAiContextReference = {
      id: 'r1',
      kind: 'current-file',
      label: 'foo.ts',
      path: 'src/foo.ts',
      range: null,
      contentPreview: '',
      redacted: false,
    };
    thread = reduceThread(thread, {
      kind: 'plan_control_updated',
      id: 'pc1',
      createdAt: '2026-06-14T09:07:00.000Z',
      goal: '迁移流式渲染（运行中）',
      references: [ref],
      phase: 'running',
    });

    const controls = thread.entries.filter(
      (e) => e.type === 'plan_control',
    ) as IAiThreadPlanControlEntry[];
    expect(controls).toHaveLength(1);
    expect(controls[0].goal).toBe('迁移流式渲染（运行中）');
    expect(controls[0].phase).toBe('running');
    expect(controls[0].references).toEqual([ref]);
    // 保留首次出现的 createdAt，位置稳定
    expect(controls[0].createdAt).toBe(ISO);
  });

  it('nextToolStatus 状态机', () => {
    expect(nextToolStatus('pending', 'in_progress')).toBe('in_progress');
    expect(nextToolStatus('in_progress', 'completed')).toBe('completed');
    expect(nextToolStatus('completed', 'in_progress')).toBe('completed');
    expect(nextToolStatus('failed', 'completed')).toBe('failed');
  });
});
