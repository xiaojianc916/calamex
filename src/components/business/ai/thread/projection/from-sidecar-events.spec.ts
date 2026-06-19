import { describe, expect, it } from 'vitest';

import { classifyRuntimeToolKind } from '@/constants/ai/runtime-tools';
import type { TAgentRuntimeEvent, TAgentUiEvent } from '@/types/ai/sidecar';

import { sidecarEventToReduceEvents } from './from-sidecar-events';
import { RUNTIME_KIND_TO_TOOL_KIND } from './tool-kind';

const OPTIONS = { now: '2026-06-19T00:00:00.000Z', assistantMessageId: 'assistant-1' };
const TS = '2026-06-19T01:02:03.000Z';

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

describe('sidecarEventToReduceEvents', () => {
  it('正文增量 → assistant_delta(message)', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('e1'), type: 'agent.text.delta', text: '你好' }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'assistant_delta',
        messageId: 'assistant-1',
        createdAt: TS,
        channel: 'message',
        text: '你好',
      },
    ]);
  });

  it('思维链增量 → assistant_delta(thought)', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('e1'), type: 'agent.reasoning.delta', text: '思考' }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'assistant_delta',
        messageId: 'assistant-1',
        createdAt: TS,
        channel: 'thought',
        text: '思考',
      },
    ]);
  });

  it('空文本增量被忽略', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('e1'), type: 'agent.text.delta', text: '' }),
        OPTIONS,
      ),
    ).toEqual([]);
  });

  it('工具开始 → tool_started（kind 由工具名经单一映射表派生）', () => {
    const toolName = 'read_file';
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('e1'), type: 'agent.tool.started', toolUseId: 'tool-1', toolName }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_started',
        id: 'tool-1',
        createdAt: TS,
        title: toolName,
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(toolName)],
        status: 'in_progress',
      },
    ]);
  });

  it('缺 toolUseId 时回退到事件 id', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('evt-x'), type: 'agent.tool.started', toolName: 'grep' }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_started',
        id: 'evt-x',
        createdAt: TS,
        title: 'grep',
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind('grep')],
        status: 'in_progress',
      },
    ]);
  });

  it('工具完成(ok) → tool_completed', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'agent.tool.completed',
          toolUseId: 'tool-1',
          toolName: 'read_file',
          ok: true,
        }),
        OPTIONS,
      ),
    ).toEqual([{ kind: 'tool_completed', id: 'tool-1', ok: true }]);
  });

  it('工具取消(status=cancelled) → tool_canceled', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'agent.tool.completed',
          toolUseId: 'tool-1',
          toolName: 'read_file',
          ok: false,
          status: 'cancelled',
        }),
        OPTIONS,
      ),
    ).toEqual([{ kind: 'tool_canceled', id: 'tool-1' }]);
  });

  it('工具完成(ok, 有 resultPreview) → tool_completed 附 Output 内容块', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'agent.tool.completed',
          toolUseId: 'tool-1',
          toolName: 'read_file',
          ok: true,
          resultPreview: '读到 42 行',
        }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_completed',
        id: 'tool-1',
        ok: true,
        appendContent: [{ type: 'content', block: { type: 'text', text: '读到 42 行' } }],
      },
    ]);
  });

  it('工具失败 → tool_completed(ok:false) 附 errorMessage 内容块', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'agent.tool.completed',
          toolUseId: 'tool-1',
          toolName: 'read_file',
          ok: false,
          errorMessage: '文件不存在',
        }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_completed',
        id: 'tool-1',
        ok: false,
        appendContent: [{ type: 'content', block: { type: 'text', text: '文件不存在' } }],
      },
    ]);
  });

  it('工具进度(有 dataPreview) → tool_progress 附内容块', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'agent.tool.progress',
          toolUseId: 'tool-1',
          dataPreview: '已扫描 10 个文件',
        }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_progress',
        id: 'tool-1',
        appendContent: [{ type: 'content', block: { type: 'text', text: '已扫描 10 个文件' } }],
      },
    ]);
  });

  it('上下文压缩完成 → context_compaction', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'acontext.context_compaction.completed',
          compactionId: 'cmp-1',
          reason: 'budget',
          summaryCharCount: 10,
        }),
        OPTIONS,
      ),
    ).toEqual([{ kind: 'context_compaction', id: 'cmp-1', createdAt: TS }]);
  });

  it('回合完成 / 错误（运行时事件）', () => {
    expect(
      sidecarEventToReduceEvents(wrap({ ...makeBase('e1'), type: 'agent.run.completed' }), OPTIONS),
    ).toEqual([{ kind: 'stream_completed' }]);
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('e2'), type: 'agent.run.error', errorMessage: 'boom' }),
        OPTIONS,
      ),
    ).toEqual([{ kind: 'stream_error', message: 'boom' }]);
  });

  it('顶层 message_delta / done / error', () => {
    expect(sidecarEventToReduceEvents({ type: 'message_delta', text: 'hi' }, OPTIONS)).toEqual([
      {
        kind: 'assistant_delta',
        messageId: 'assistant-1',
        createdAt: OPTIONS.now,
        channel: 'message',
        text: 'hi',
      },
    ]);
    expect(sidecarEventToReduceEvents({ type: 'done', result: 'ok' }, OPTIONS)).toEqual([
      { kind: 'stream_completed' },
    ]);
    expect(sidecarEventToReduceEvents({ type: 'error', message: 'bad' }, OPTIONS)).toEqual([
      { kind: 'stream_error', message: 'bad' },
    ]);
  });

  it('暂不覆盖的事件返回空数组', () => {
    expect(sidecarEventToReduceEvents({ type: 'mode_update', modeId: 'm1' }, OPTIONS)).toEqual([]);
    expect(sidecarEventToReduceEvents({ type: 'diff_ready', files: [] }, OPTIONS)).toEqual([]);
    expect(
      sidecarEventToReduceEvents(wrap({ ...makeBase('e1'), type: 'agent.run.started' }), OPTIONS),
    ).toEqual([]);
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('e2'), type: 'agent.tool.progress', toolUseId: 'tool-1' }),
        OPTIONS,
      ),
    ).toEqual([]);
  });
});
