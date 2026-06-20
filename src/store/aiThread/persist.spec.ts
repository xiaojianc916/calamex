import { describe, expect, it } from 'vitest';

import { salvageHydratedThreadEntries } from '@/store/aiThread/persist';
import { AI_THREAD_PERSIST_VERSION, aiThreadPersistSchema } from '@/types/ai/thread/persist.schema';

const ISO = '2026-06-19T09:00:00.000Z';

const validThread = (id: string) => ({
  id,
  title: '线程 ' + id,
  titleStatus: 'generated',
  createdAt: ISO,
  updatedAt: ISO,
  entries: [
    {
      type: 'user_message',
      id: id + '-u1',
      createdAt: ISO,
      content: [{ type: 'text', text: '你好' }],
    },
    {
      type: 'assistant_message',
      id: id + '-a1',
      createdAt: ISO,
      chunks: [{ type: 'message', block: { type: 'text', text: '回答' } }],
    },
  ],
});

describe('aiThreadPersistSchema', () => {
  it('校验完整持久化信封并保留 version', () => {
    const parsed = aiThreadPersistSchema.parse({
      version: 1,
      activeThreadId: 't1',
      threads: [validThread('t1')],
    });
    expect(parsed.version).toBe(1);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.activeThreadId).toBe('t1');
  });

  it('version 缺省 / 非法兑底为当前版本', () => {
    const missing = aiThreadPersistSchema.parse({ activeThreadId: null, threads: [] });
    expect(missing.version).toBe(1);
    const invalid = aiThreadPersistSchema.parse({ version: -3, activeThreadId: null, threads: [] });
    expect(invalid.version).toBe(1);
  });

  it('无损持久化 assistant_message.stream 与 tool_call.name（Approach B）', () => {
    const parsed = aiThreadPersistSchema.parse({
      version: AI_THREAD_PERSIST_VERSION,
      activeThreadId: 't1',
      threads: [
        {
          id: 't1',
          title: '线程 t1',
          titleStatus: 'generated',
          createdAt: ISO,
          updatedAt: ISO,
          entries: [
            {
              type: 'tool_call',
              id: 'tc1',
              createdAt: ISO,
              name: 'read_project_file',
              title: '读取文件',
              kind: 'read',
              status: 'completed',
              content: [],
            },
            {
              type: 'assistant_message',
              id: 'a1',
              createdAt: ISO,
              chunks: [{ type: 'message', block: { type: 'text', text: '答案' } }],
              stream: { status: 'completed', activityText: '读取中' },
            },
          ],
        },
      ],
    });
    const thread = parsed.threads[0];
    const tool = thread?.entries[0];
    const assistant = thread?.entries[1];
    expect(tool?.type).toBe('tool_call');
    if (tool?.type === 'tool_call') {
      expect(tool.name).toBe('read_project_file');
    }
    expect(assistant?.type).toBe('assistant_message');
    if (assistant?.type === 'assistant_message') {
      expect(assistant.stream?.status).toBe('completed');
    }
  });
});

describe('salvageHydratedThreadEntries', () => {
  it('丢弃单条非法 entry, 保留同线程其余 entries', () => {
    const thread = validThread('t1');
    const salvaged = salvageHydratedThreadEntries(
      [
        {
          ...thread,
          entries: [
            thread.entries[0],
            { type: 'mystery', id: 'bad', createdAt: ISO },
            thread.entries[1],
          ],
        },
      ],
      't1',
    );
    expect(salvaged).not.toBeNull();
    expect(salvaged?.threads).toHaveLength(1);
    expect(salvaged?.threads[0]?.entries).toHaveLength(2);
    expect(salvaged?.activeThreadId).toBe('t1');
  });

  it('丢弃元信息非法的线程, 保留其余线程', () => {
    const bad = { ...validThread('bad'), title: '' };
    const salvaged = salvageHydratedThreadEntries([bad, validThread('good')], 'good');
    expect(salvaged?.threads.map((t) => t.id)).toEqual(['good']);
  });

  it('全部不可救援返回 null', () => {
    expect(salvageHydratedThreadEntries('not-an-array', null)).toBeNull();
    expect(salvageHydratedThreadEntries([{ nope: true }], null)).toBeNull();
  });

  it('非法 activeThreadId 归一化为 null', () => {
    const salvaged = salvageHydratedThreadEntries([validThread('t1')], '   ');
    expect(salvaged?.activeThreadId).toBeNull();
  });
});
