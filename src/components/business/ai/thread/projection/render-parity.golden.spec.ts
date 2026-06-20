/* ============================================================================
 * 渲染并行真源「黄金等价」表征测试（ADR-0014 收敛阶段 / Step 8）
 *
 * 把「遗留投影」与「数据模型投影」两条渲染管线的可见输出关系钉成契约，作为把
 * reduce/entries 升级为单一前向真源（统一管线）的行为等价闸门。
 *
 *   OLD（遗留路径，双轨期）：
 *     IAiChatMessage[] --buildThreadEntries--> TAiThreadEntry[]
 *   NEW（数据模型路径，前向目标）：
 *     IAiChatMessage[] --legacyThreadToThread--> IAiThread
 *                      --threadEntriesToTimeline--> TAiThreadEntry[]
 *
 * 约定：
 * - 两条管线「条目 id 方案」按设计不同（消息域 \`m1:tool:t1\` vs 条目原生 \`t1\`），
 *   故等价以「可见结构」为准（kind 序列 + 关键渲染字段），不比对 id / messageId。
 * - 已知缺口以 KNOWN-GAP 显式断言「当前确实分叉」，留待前向 brick 收敛后翻转为
 *   等价断言；绝不把缺口悄悄吞掉，也不在此投资注定删除的 legacy-adapter。
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import type { IAiConversationThread } from '@/store/aiConversation';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
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
import type { IAiThreadToolCall } from '@/types/ai/thread';

import { buildThreadEntries } from './build-thread-entries';
import type { TAiThreadEntry } from './entry-types';
import { threadEntriesToTimeline } from './thread-entries-to-timeline';

const ISO = '2026-06-20T00:00:00.000Z';

const makeMessage = (
  id: string,
  role: TAiChatRole,
  overrides: Partial<Omit<IAiChatMessage, 'id' | 'role'>> = {},
): IAiChatMessage => ({
  id,
  role,
  content: '',
  createdAt: ISO,
  references: [],
  ...overrides,
});

const makeThread = (messages: IAiChatMessage[]): IAiConversationThread => ({
  id: 'thread-1',
  title: '会话',
  titleStatus: 'temporary',
  createdAt: ISO,
  updatedAt: ISO,
  messages,
});

const makeEventBase = (id: string, seq: number): Omit<IAgentRuntimeEventBase, 'type'> => ({
  id,
  runId: 'run-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
  timestamp: ISO,
  seq,
  schemaVersion: AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  redacted: true,
  visibility: 'user',
});

/** OLD：遗留 IAiChatMessage[] → 渲染 VM。 */
const renderViaLegacy = (messages: IAiChatMessage[]): TAiThreadEntry[] =>
  buildThreadEntries(messages);

/** NEW：经数据模型（与 reduce 真源同构）→ 渲染 VM。 */
const renderViaEntries = (messages: IAiChatMessage[]): TAiThreadEntry[] =>
  threadEntriesToTimeline(legacyThreadToThread(makeThread(messages)).entries);

const kinds = (entries: TAiThreadEntry[]): string[] => entries.map((entry) => entry.kind);

const first = <K extends TAiThreadEntry['kind']>(
  entries: TAiThreadEntry[],
  kind: K,
): Extract<TAiThreadEntry, { kind: K }> | undefined =>
  entries.find((entry): entry is Extract<TAiThreadEntry, { kind: K }> => entry.kind === kind);

/** tool-call 条目里内联的 diff 文件路径集合。 */
const diffFilePaths = (entry: Extract<TAiThreadEntry, { kind: 'tool-call' }>): string[] =>
  entry.toolCall.content
    .filter((c): c is Extract<typeof c, { type: 'diff' }> => c.type === 'diff')
    .map((c) => c.diff.filePath);

describe('渲染黄金等价 — 已对齐部分（前向收敛后必须持续成立）', () => {
  it('纯文本会话：两条管线 kind 序列与文本一致', () => {
    const messages = [
      makeMessage('u1', 'user', { content: '帮我改登录逻辑' }),
      makeMessage('a1', 'assistant', { content: '已完成。' }),
    ];
    const legacy = renderViaLegacy(messages);
    const entries = renderViaEntries(messages);

    expect(kinds(legacy)).toEqual(['user-message', 'assistant-text']);
    expect(kinds(entries)).toEqual(kinds(legacy));
    expect(first(legacy, 'user-message')?.markdown).toBe('帮我改登录逻辑');
    expect(first(entries, 'user-message')?.markdown).toBe('帮我改登录逻辑');
    expect(first(legacy, 'assistant-text')?.markdown).toBe('已完成。');
    expect(first(entries, 'assistant-text')?.markdown).toBe('已完成。');
  });

  it('wire 工具调用 + 改动汇总：kind 序列一致，内联 diff 均挂到工具行', () => {
    const summary: IAiAgentPatchSummary = {
      id: 'patch-1',
      runId: 'run-1',
      stepId: 'step-1',
      files: [
        { path: 'src/foo.ts', status: 'modified', additions: 3, deletions: 1, diffRef: 'diff-1' },
      ],
      totalAdditions: 3,
      totalDeletions: 1,
      patchRef: 'patch-ref-1',
    };
    const messages = [
      makeMessage('a1', 'assistant', {
        content: '已修改 foo.ts。',
        toolCalls: [
          {
            id: 't1',
            name: 'write_file',
            status: 'succeeded',
            summary: '编辑 foo.ts',
            targetPreview: 'src/foo.ts',
          },
        ],
        changedFilesSummary: summary,
      }),
    ];
    const legacy = renderViaLegacy(messages);
    const entries = renderViaEntries(messages);

    expect(kinds(legacy)).toEqual(['tool-call', 'assistant-text', 'changed-files-summary']);
    expect(kinds(entries)).toEqual(kinds(legacy));
    expect(diffFilePaths(first(legacy, 'tool-call')!)).toContain('src/foo.ts');
    expect(diffFilePaths(first(entries, 'tool-call')!)).toContain('src/foo.ts');
    expect(first(legacy, 'changed-files-summary')?.summary.id).toBe('patch-1');
    expect(first(entries, 'changed-files-summary')?.summary.id).toBe('patch-1');
  });

  it('agentConfirmation 投影为 plan-control（goal / phase 一致）', () => {
    const messages = [
      makeMessage('a1', 'assistant', {
        content: '执行计划如下。',
        agentConfirmation: { goal: '重构登录模块', references: [], status: 'pending' },
      }),
    ];
    const legacy = renderViaLegacy(messages);
    const entries = renderViaEntries(messages);

    expect(first(legacy, 'plan-control')?.goal).toBe('重构登录模块');
    expect(first(entries, 'plan-control')?.goal).toBe('重构登录模块');
    expect(first(legacy, 'plan-control')?.phase).toBe('awaiting-approval');
    expect(first(entries, 'plan-control')?.phase).toBe('awaiting-approval');
  });
});

describe('渲染黄金等价 — 已知缺口（前向归一器收敛后翻转为等价断言）', () => {
  it('KNOWN-GAP：runtimeEvents 的推理/工具/上下文整理仅 OLD 产出，NEW 暂缺', () => {
    const reasoning: IAgentReasoningDeltaEvent = {
      ...makeEventBase('evt-reasoning', 0),
      type: 'agent.reasoning.delta',
      text: '先读文件再改。',
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
    const messages = [
      makeMessage('a1', 'assistant', {
        content: '已读取并理解。',
        stream: {
          status: 'completed',
          runtimeEvents: [reasoning, toolStarted, toolCompleted, compaction],
        },
      }),
    ];
    const legacy = renderViaLegacy(messages);
    const entries = renderViaEntries(messages);

    expect(kinds(legacy)).toEqual(
      expect.arrayContaining(['reasoning', 'tool-call', 'context-compaction', 'assistant-text']),
    );
    // legacy-adapter 不消费 runtimeEvents：NEW 仅保留最终文本。前向 brick 收敛后此断言翻转。
    expect(kinds(entries)).toEqual(['assistant-text']);
  });

  it('KNOWN-GAP：acpToolCalls 仅 OLD 产出工具条目，NEW 暂缺', () => {
    const acp: IAiThreadToolCall = {
      type: 'tool_call',
      id: 'a',
      createdAt: ISO,
      title: 'Read file',
      kind: 'read',
      status: 'completed',
      content: [],
    };
    const messages = [makeMessage('a1', 'assistant', { content: 'done', acpToolCalls: [acp] })];
    const legacy = renderViaLegacy(messages);
    const entries = renderViaEntries(messages);

    expect(kinds(legacy)).toEqual(['tool-call', 'assistant-text']);
    // legacy-adapter 不消费 acpToolCalls：NEW 仅保留最终文本。前向 brick 收敛后此断言翻转。
    expect(kinds(entries)).toEqual(['assistant-text']);
  });
});
