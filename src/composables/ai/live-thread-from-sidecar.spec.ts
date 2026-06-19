import { describe, expect, it } from 'vitest';

import { buildLiveThreadFromSidecarEvents } from '@/composables/ai/live-thread-from-sidecar';
import type { TAgentUiEvent } from '@/types/ai/sidecar';
import type { IAiThread, IAiThreadAssistantMessageEntry, IAiThreadEntry } from '@/types/ai/thread';

const ISO = '2026-06-19T00:00:00.000Z';

const createBaseThread = (entries: IAiThreadEntry[] = []): IAiThread => ({
  id: 'thread-1',
  title: '实时线程',
  titleStatus: 'temporary',
  createdAt: ISO,
  updatedAt: ISO,
  entries,
});

describe('buildLiveThreadFromSidecarEvents', () => {
  it('把 message_delta 增量叠加为单条 assistant_message，done 收尾', () => {
    const events: TAgentUiEvent[] = [
      { type: 'message_delta', text: '根因' },
      { type: 'message_delta', text: '在数据模型' },
      { type: 'done', result: '根因在数据模型' },
    ];

    const result = buildLiveThreadFromSidecarEvents(events, {
      baseThread: createBaseThread(),
      assistantMessageId: 'a1',
      now: ISO,
    });

    expect(result.entries.map((entry) => entry.type)).toEqual(['assistant_message']);
    const assistant = result.entries[0] as IAiThreadAssistantMessageEntry;
    expect(assistant.id).toBe('a1');
    expect(assistant.chunks).toHaveLength(1);
    expect(assistant.chunks[0]).toMatchObject({
      type: 'message',
      block: { text: '根因在数据模型' },
    });
  });

  it('保留基线线程的既有 entries（此前消息在前，本回合 assistant 在后）', () => {
    const base = createBaseThread([
      {
        type: 'user_message',
        id: 'u1',
        createdAt: ISO,
        content: [{ type: 'text', text: '为什么？' }],
      },
    ]);

    const result = buildLiveThreadFromSidecarEvents([{ type: 'message_delta', text: '因为' }], {
      baseThread: base,
      assistantMessageId: 'a1',
      now: ISO,
    });

    expect(result.entries.map((entry) => entry.type)).toEqual([
      'user_message',
      'assistant_message',
    ]);
  });

  it('不修改入参（纯函数 / 结构共享）', () => {
    const base = createBaseThread();
    const result = buildLiveThreadFromSidecarEvents([{ type: 'message_delta', text: 'hi' }], {
      baseThread: base,
      assistantMessageId: 'a1',
      now: ISO,
    });
    expect(base.entries).toHaveLength(0);
    expect(result).not.toBe(base);
  });

  it('无可消费事件时原样返回基线线程', () => {
    const base = createBaseThread();
    const result = buildLiveThreadFromSidecarEvents([{ type: 'message_delta', text: '' }], {
      baseThread: base,
      assistantMessageId: 'a1',
      now: ISO,
    });
    expect(result).toBe(base);
  });
});
