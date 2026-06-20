#!/usr/bin/env node
/**
 * Brick 3 — 新建前向单一管线纯组合器（为「实时渲染翻到前向管线」铺接入缝）。
 *
 * 在 projection 层(层次正确:projection→store 单向，避免 store↔projection 循环)
 * 新增 live-thread-from-sidecar.ts：把 sidecarEventToReduceEvents(逐事件规范化)
 * 与 reduceThreadAll(reduce 单写入)串成 buildLiveThreadFromSidecarEvents。
 * 纯函数、零行为变更(暂无 import 方)，可独立单测变绿。
 *
 * 用法：
 *   node 1.mjs            # 创建
 *   node 1.mjs --check    # dry-run，仅打印将创建的文件
 *   node 1.mjs --force    # 已存在且内容不同则覆盖
 *   REPO_ROOT=/path node 1.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const DRY = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');

const BUILDER = `/**
 * 边车事件流 -> 活动线程(entries 真源)的纯前向组合器。
 *
 * 把「逐事件规范化」(sidecarEventToReduceEvents)与「reduce 单写入」(reduceThreadAll)
 * 串成单一前向管线:边车 UI 事件流 flatMap 成 reduce 规范化事件,再整体回放到基线
 * 线程上,得到 entries 模型的活动线程。等价于
 * reduceThreadAll(baseThread, events.flatMap(normalize))，把两步显式串成一条管线，
 * 作为后续「实时渲染从 legacy-adapter 翻到前向管线」的接入缝。
 *
 * 设计取舍:
 * - 纯函数、无副作用、不持状态、不读时钟:now 与 assistantMessageId 由调用方(回合
 *   监听层)注入,保证确定性与可单测。
 * - 仅组合既有纯函数,不复制其逻辑:标题/压缩文案 presenter、工具状态机、chunk 合并
 *   等全部由下游两函数负责,本层只负责「串起来」。
 * - 层次方向:本文件属 projection 层,依赖 store 的 reduce 与同层 normalizer;store
 *   不反向依赖 projection(避免循环依赖)。
 */
import { reduceThreadAll } from '@/store/aiThread/reduce';
import type { TAgentUiEvent } from '@/types/ai/sidecar';
import type { IAiThread } from '@/types/ai/thread';

import { sidecarEventToReduceEvents } from './from-sidecar-events';

export interface IBuildLiveThreadFromSidecarOptions {
  /** 回放基线线程:通常是本回合开始前的活动线程(entries 真源)。 */
  baseThread: IAiThread;
  /** 本回合 assistant 消息 id(正文与思维链共用,见 normalizer)。 */
  assistantMessageId: string;
  /** 顶层无内联时间戳事件(message_delta / done / error)的 createdAt(ISO)。 */
  now: string;
}

/**
 * 把一段边车 UI 事件流前向组合为活动线程。纯函数:不修改入参、无副作用。
 */
export const buildLiveThreadFromSidecarEvents = (
  events: readonly TAgentUiEvent[],
  options: IBuildLiveThreadFromSidecarOptions,
): IAiThread => {
  const reduceEvents = events.flatMap((event) =>
    sidecarEventToReduceEvents(event, {
      now: options.now,
      assistantMessageId: options.assistantMessageId,
    }),
  );
  return reduceThreadAll(options.baseThread, reduceEvents);
};
`;

const SPEC = `import { describe, expect, it } from 'vitest';

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
`;

const files = [
  {
    rel: 'src/components/business/ai/thread/projection/live-thread-from-sidecar.ts',
    content: BUILDER,
  },
  {
    rel: 'src/components/business/ai/thread/projection/live-thread-from-sidecar.spec.ts',
    content: SPEC,
  },
];

let created = 0;
let skipped = 0;
for (const { rel, content } of files) {
  const abs = path.join(REPO_ROOT, rel);
  if (fs.existsSync(abs)) {
    const cur = fs.readFileSync(abs, 'utf8');
    if (cur === content) {
      console.log(`skip (内容一致): ${rel}`);
      skipped += 1;
      continue;
    }
    if (!FORCE) {
      throw new Error(`已存在且内容不同，需 --force 覆盖: ${rel}`);
    }
  }
  if (DRY) {
    console.log(`[check] 将创建: ${rel}`);
    created += 1;
    continue;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  console.log(`created: ${rel}`);
  created += 1;
}
console.log(`\n完成：${created} 建，${skipped} 跳过${DRY ? '（dry-run，未写盘）' : ''}`);