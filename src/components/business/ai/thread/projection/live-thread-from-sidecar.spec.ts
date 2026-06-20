import { describe, expect, it } from 'vitest';

import type { TAgentRuntimeEvent, TAgentUiEvent } from '@/types/ai/sidecar';
import type {
  IAiThread,
  IAiThreadAssistantMessageEntry,
  IAiThreadToolCall,
} from '@/types/ai/thread';

import { buildLiveThreadFromSidecarEvents } from './live-thread-from-sidecar';

const NOW = '2026-06-20T00:00:00.000Z';
const TS = '2026-06-20T01:02:03.000Z';

const baseThread = (): IAiThread => ({
  id: 'thread-1',
  title: '迁移',
  titleStatus: 'temporary',
  createdAt: NOW,
  updatedAt: NOW,
  entries: [],
});

const makeBase = (id: string) => ({
  id,
  runId: 'run-1',
  sessionId: 'sess-1',
  agentId: 'agent-1',
  timestamp: TS,
  seq: 1,
  schemaVersion: 1 as const,
  redacted: true as const,
  visibility: 'user' as const,
});

const wrap = (event: TAgentRuntimeEvent): TAgentUiEvent => ({ type: 'agent_event', event });

describe('buildLiveThreadFromSidecarEvents', () => {
  it('空事件流:原样回放基线线程(entries 不变)', () => {
    const result = buildLiveThreadFromSidecarEvents([], {
      baseThread: baseThread(),
      assistantMessageId: 'assistant-1',
      now: NOW,
    });
    expect(result.id).toBe('thread-1');
    expect(result.entries).toEqual([]);
  });

  it('组合 normalizer + reduce:文本增量(同 messageId 合并) + 工具起止 → assistant_message + tool_call', () => {
    const events: TAgentUiEvent[] = [
      wrap({ ...makeBase('e1'), type: 'agent.text.delta', text: '答' }),
      wrap({ ...makeBase('e1b'), type: 'agent.text.delta', text: '案' }),
      wrap({
        ...makeBase('e2'),
        type: 'agent.tool.started',
        toolUseId: 'tool-1',
        toolName: 'read_file',
      }),
      wrap({
        ...makeBase('e3'),
        type: 'agent.tool.completed',
        toolUseId: 'tool-1',
        toolName: 'read_file',
        ok: true,
      }),
    ];

    const result = buildLiveThreadFromSidecarEvents(events, {
      baseThread: baseThread(),
      assistantMessageId: 'assistant-1',
      now: NOW,
    });

    expect(result.entries.map((entry) => entry.type)).toEqual(['assistant_message', 'tool_call']);

    // 两条同 assistantMessageId 的文本增量合并为单一 assistant_message(证明 options 贯穿)。
    const assistants = result.entries.filter(
      (entry): entry is IAiThreadAssistantMessageEntry => entry.type === 'assistant_message',
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].chunks[0]).toMatchObject({ type: 'message', block: { text: '答案' } });

    const tool = result.entries[1] as IAiThreadToolCall;
    expect(tool.id).toBe('tool-1');
    expect(tool.status).toBe('completed');
    // 标题由 presenter 派生(非空);完成态状态机由 reduce 负责。
    expect(tool.title.length).toBeGreaterThan(0);
  });

  it('纯函数:不原地突变入参基线线程', () => {
    const base = baseThread();
    buildLiveThreadFromSidecarEvents(
      [wrap({ ...makeBase('e1'), type: 'agent.text.delta', text: 'hi' })],
      { baseThread: base, assistantMessageId: 'assistant-1', now: NOW },
    );
    expect(base.entries).toHaveLength(0);
  });
});
