import { describe, expect, it } from 'vitest';

import type { IAiContextReference } from '@/types/ai/context';
import type { IAiThreadEntry } from '@/types/ai/thread';

import {
  DEFAULT_CONTEXT_COMPACTION_TEXT,
  REASONING_LONG_CHAR_THRESHOLD,
  threadEntriesToTimeline,
} from './thread-entries-to-timeline';

const ISO = '2026-06-14T09:00:00.000Z';

describe('threadEntriesToTimeline', () => {
  it('user_message 投影为 user-message, 透传 references', () => {
    const reference: IAiContextReference = {
      id: 'r1',
      kind: 'current-file',
      label: 'foo.ts',
      path: 'src/foo.ts',
      range: null,
      contentPreview: '',
      redacted: false,
    };
    const entries: IAiThreadEntry[] = [
      {
        type: 'user_message',
        id: 'u1',
        createdAt: ISO,
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        references: [reference],
      },
    ];
    const timeline = threadEntriesToTimeline(entries);
    expect(timeline).toHaveLength(1);
    const entry = timeline[0];
    expect(entry.kind).toBe('user-message');
    if (entry.kind === 'user-message') {
      expect(entry.id).toBe('u1');
      expect(entry.messageId).toBe('u1');
      expect(entry.references).toEqual([reference]);
      expect(entry.markdown).toContain('first');
      expect(entry.markdown).toContain('second');
    }
  });

  it('assistant_message 拆为 reasoning + assistant-text, 思维在前', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'a1',
        createdAt: ISO,
        chunks: [
          { type: 'thought', block: { type: 'text', text: 'thinking' } },
          { type: 'message', block: { type: 'text', text: 'answer' } },
        ],
      },
    ];
    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((e) => e.kind)).toEqual(['reasoning', 'assistant-text']);
    const reasoning = timeline[0];
    const text = timeline[1];
    expect(reasoning.id).toBe('a1:reasoning');
    expect(reasoning.messageId).toBe('a1');
    expect(text.id).toBe('a1:text');
    expect(text.messageId).toBe('a1');
    if (reasoning.kind === 'reasoning') {
      expect(reasoning.segments).toEqual(['thinking']);
      expect(reasoning.isLong).toBe(false);
      expect(reasoning.streaming).toBe(false);
    }
    if (text.kind === 'assistant-text') {
      expect(text.markdown).toBe('answer');
      expect(text.streaming).toBe(false);
    }
  });

  it('reasoning 超阈值标记 isLong; streamingMessageId 命中标记 streaming', () => {
    const longText = 'x'.repeat(REASONING_LONG_CHAR_THRESHOLD + 1);
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'a2',
        createdAt: ISO,
        chunks: [{ type: 'thought', block: { type: 'text', text: longText } }],
      },
    ];
    const timeline = threadEntriesToTimeline(entries, { streamingMessageId: 'a2' });
    expect(timeline).toHaveLength(1);
    const reasoning = timeline[0];
    if (reasoning.kind === 'reasoning') {
      expect(reasoning.isLong).toBe(true);
      expect(reasoning.streaming).toBe(true);
    }
  });

  it('tool_call 原样持有协议 VM, terminals 空、awaiting 关', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'tool_call',
        id: 't1',
        createdAt: ISO,
        title: 'Read file',
        kind: 'read',
        status: 'completed',
        content: [],
      },
    ];
    const timeline = threadEntriesToTimeline(entries);
    expect(timeline).toHaveLength(1);
    const entry = timeline[0];
    expect(entry.kind).toBe('tool-call');
    if (entry.kind === 'tool-call') {
      expect(entry.toolCall.id).toBe('t1');
      expect(entry.toolCall.status).toBe('completed');
      expect(entry.terminals).toEqual({});
      expect(entry.awaiting).toBe(false);
    }
  });

  it('plan 条目本片跳过, 不进平铺时间线', () => {
    const entries: IAiThreadEntry[] = [{ type: 'plan', id: 'p1', createdAt: ISO, steps: [] }];
    expect(threadEntriesToTimeline(entries)).toEqual([]);
  });

  it('context_compaction 用 message; 缺省用兜底文案', () => {
    const entries: IAiThreadEntry[] = [
      { type: 'context_compaction', id: 'c1', createdAt: ISO, message: 'compacted' },
      { type: 'context_compaction', id: 'c2', createdAt: ISO },
    ];
    const timeline = threadEntriesToTimeline(entries);
    const first = timeline[0];
    const second = timeline[1];
    if (first.kind === 'context-compaction') {
      expect(first.text).toBe('compacted');
    }
    if (second.kind === 'context-compaction') {
      expect(second.text).toBe(DEFAULT_CONTEXT_COMPACTION_TEXT);
    }
  });

  it('changed_files 投影为末尾汇总条目', () => {
    const summary = {
      id: 'patch-1',
      runId: 'run-1',
      stepId: 'step-1',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      patchRef: 'ref-1',
    };
    const entries: IAiThreadEntry[] = [
      { type: 'changed_files', id: 'cf1', createdAt: ISO, summary },
    ];
    const timeline = threadEntriesToTimeline(entries);
    expect(timeline).toHaveLength(1);
    const entry = timeline[0];
    expect(entry.kind).toBe('changed-files-summary');
    if (entry.kind === 'changed-files-summary') {
      expect(entry.summary).toBe(summary);
    }
  });

  it('混合 entries 保持输入顺序', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'user_message',
        id: 'u1',
        createdAt: ISO,
        content: [{ type: 'text', text: 'hi' }],
        references: [],
      },
      { type: 'plan', id: 'p1', createdAt: ISO, steps: [] },
      {
        type: 'assistant_message',
        id: 'a1',
        createdAt: ISO,
        chunks: [{ type: 'message', block: { type: 'text', text: 'ok' } }],
      },
    ];
    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((e) => e.kind)).toEqual(['user-message', 'assistant-text']);
  });
});
