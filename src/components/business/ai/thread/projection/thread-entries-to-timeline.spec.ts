import { describe, expect, it } from 'vitest';

import type { IAiAgentPatchSummary } from '@/types/ai/patch';
import type { IAiThreadEntry } from '@/types/ai/thread';

import {
  DEFAULT_CONTEXT_COMPACTION_TEXT,
  threadEntriesToTimeline,
} from './thread-entries-to-timeline';

const ISO = '2026-06-23T00:00:00.000Z';

/** changed-files 汇总用的最小合法 patch 摘要（files 留空，聚焦投影透传行为）。 */
const patchSummary: IAiAgentPatchSummary = {
  id: 'patch-1',
  runId: 'run-1',
  stepId: 'step-1',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  patchRef: 'patch-ref-1',
};

describe('threadEntriesToTimeline · 全 entry 分支特征化（golden）', () => {
  it('user_message：仅拼接文本块（丢弃非文本块），id/messageId/references 落位', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'user_message',
        id: 'u1',
        createdAt: ISO,
        content: [
          { type: 'text', text: '第一段' },
          { type: 'source', url: 'https://zed.dev' },
          { type: 'text', text: '第二段' },
        ],
        references: [],
      },
    ];

    const timeline = threadEntriesToTimeline(entries);

    expect(timeline).toHaveLength(1);
    const item = timeline[0];
    expect(item.kind).toBe('user-message');
    if (item.kind === 'user-message') {
      expect(item.id).toBe('u1');
      expect(item.messageId).toBe('u1');
      expect(item.markdown).toBe('第一段\n\n第二段');
      expect(item.references).toEqual([]);
    }
  });

  it('assistant_message：思考+正文 → reasoning + assistant-text；正文一出现推理即停流', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'a1',
        createdAt: ISO,
        chunks: [
          { type: 'thought', block: { type: 'text', text: '先想一下' } },
          { type: 'thought', block: { type: 'text', text: '再想一下' } },
          { type: 'message', block: { type: 'text', text: '答案。' } },
        ],
      },
    ];

    const timeline = threadEntriesToTimeline(entries, { streamingMessageId: 'a1' });

    expect(timeline.map((entry) => entry.kind)).toEqual(['reasoning', 'assistant-text']);

    const reasoning = timeline[0];
    expect(reasoning.kind).toBe('reasoning');
    if (reasoning.kind === 'reasoning') {
      expect(reasoning.id).toBe('a1:reasoning');
      expect(reasoning.segments).toEqual(['先想一下', '再想一下']);
      expect(reasoning.isLong).toBe(true);
      // 正文已开始 → 推理停止流式（随后由展开逻辑自动折叠）。
      expect(reasoning.streaming).toBe(false);
    }

    const text = timeline[1];
    expect(text.kind).toBe('assistant-text');
    if (text.kind === 'assistant-text') {
      expect(text.id).toBe('a1:text');
      expect(text.markdown).toBe('答案。');
      expect(text.streaming).toBe(true);
    }
  });

  it('assistant_message：仅思考且流式中 → reasoning 持续流式、单段不算长', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'a2',
        createdAt: ISO,
        chunks: [{ type: 'thought', block: { type: 'text', text: '仅思考' } }],
      },
    ];

    const timeline = threadEntriesToTimeline(entries, { streamingMessageId: 'a2' });

    expect(timeline.map((entry) => entry.kind)).toEqual(['reasoning']);
    const reasoning = timeline[0];
    if (reasoning.kind === 'reasoning') {
      expect(reasoning.segments).toEqual(['仅思考']);
      expect(reasoning.isLong).toBe(false);
      expect(reasoning.streaming).toBe(true);
    }
  });

  it('assistant_message：多个正文块并为单条 assistant-text（空行分隔），非流式', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'a3',
        createdAt: ISO,
        chunks: [
          { type: 'message', block: { type: 'text', text: '第一句' } },
          { type: 'message', block: { type: 'text', text: '第二句' } },
        ],
      },
    ];

    const timeline = threadEntriesToTimeline(entries);

    expect(timeline.map((entry) => entry.kind)).toEqual(['assistant-text']);
    const text = timeline[0];
    if (text.kind === 'assistant-text') {
      expect(text.markdown).toBe('第一句\n\n第二句');
      expect(text.streaming).toBe(false);
    }
  });

  it('plan entry 刻意不进平铺时间线（由独立面板渲染）', () => {
    const entries: IAiThreadEntry[] = [{ type: 'plan', id: 'p1', createdAt: ISO, steps: [] }];
    expect(threadEntriesToTimeline(entries)).toHaveLength(0);
  });

  it('plan_control → plan-control：goal/phase/references 落位', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'plan_control',
        id: 'pc1',
        createdAt: ISO,
        goal: '迁移流式渲染',
        references: [],
        phase: 'running',
      },
    ];

    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((entry) => entry.kind)).toEqual(['plan-control']);
    const item = timeline[0];
    if (item.kind === 'plan-control') {
      expect(item.goal).toBe('迁移流式渲染');
      expect(item.phase).toBe('running');
      expect(item.references).toEqual([]);
    }
  });

  it('context_compaction：有 message 用其文案，缺省时回落默认文案', () => {
    const entries: IAiThreadEntry[] = [
      { type: 'context_compaction', id: 'cc1', createdAt: ISO, message: '已整理对话' },
      { type: 'context_compaction', id: 'cc2', createdAt: ISO },
    ];

    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((entry) => entry.kind)).toEqual([
      'context-compaction',
      'context-compaction',
    ]);
    const withMessage = timeline[0];
    const fallback = timeline[1];
    if (withMessage.kind === 'context-compaction') {
      expect(withMessage.text).toBe('已整理对话');
    }
    if (fallback.kind === 'context-compaction') {
      expect(fallback.text).toBe(DEFAULT_CONTEXT_COMPACTION_TEXT);
    }
  });

  it('changed_files → changed-files-summary：summary 原样透传（同一引用）', () => {
    const entries: IAiThreadEntry[] = [
      { type: 'changed_files', id: 'cf1', createdAt: ISO, summary: patchSummary },
    ];

    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((entry) => entry.kind)).toEqual(['changed-files-summary']);
    const item = timeline[0];
    if (item.kind === 'changed-files-summary') {
      expect(item.summary).toBe(patchSummary);
    }
  });

  it('混合序列：严格按 entries 顺序铺开，plan 被跳过且不影响后续次序', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'user_message',
        id: 'u1',
        createdAt: ISO,
        content: [{ type: 'text', text: '问题' }],
        references: [],
      },
      {
        type: 'assistant_message',
        id: 'a1',
        createdAt: ISO,
        chunks: [
          { type: 'thought', block: { type: 'text', text: '想' } },
          { type: 'message', block: { type: 'text', text: '答' } },
        ],
      },
      {
        type: 'tool_call',
        id: 'tc1',
        createdAt: ISO,
        title: '读取',
        kind: 'read',
        status: 'completed',
        content: [],
      },
      { type: 'context_compaction', id: 'cc1', createdAt: ISO },
      { type: 'changed_files', id: 'cf1', createdAt: ISO, summary: patchSummary },
      { type: 'plan', id: 'p1', createdAt: ISO, steps: [] },
      {
        type: 'plan_control',
        id: 'pc1',
        createdAt: ISO,
        goal: '收尾',
        references: [],
        phase: 'awaiting-approval',
      },
    ];

    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((entry) => entry.kind)).toEqual([
      'user-message',
      'reasoning',
      'assistant-text',
      'tool-call',
      'context-compaction',
      'changed-files-summary',
      'plan-control',
    ]);
  });
});
