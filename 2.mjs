#!/usr/bin/env node
/* ============================================================================
 * 3.mjs — Kimi/ACP 工具调用 UI「接线 + 交织」改造 codemod（本地运行，不提交）
 *
 * 根因：Kimi 的 ACP `tool_call` / `tool_call_update` UI 事件在
 *   from-sidecar-events.ts 落到 `default -> []`（被丢弃），既不进 reduce 真源、
 *   也不渲染。本 codemod 把工具调用作为 assistant_message 的第三种 chunk
 *   （message | thought | tool_call）落入同一条 chunks 流，使「思考 / 正文 / 工具」
 *   按到达顺序真实交织（对标 Codex / Zed），并保证持久化与逆投影无损往返。
 *
 * 运行（三部分都贴全后）：
 *   node 3.mjs            # 在仓库根目录
 *   node 2.mjs            # 正交：Write 工具的 diff 渲染（两者都要跑）
 *   pnpm typecheck && pnpm test && pnpm lint
 *   # 若 biome 提示 import 顺序：pnpm exec biome check --write src/
 * ========================================================================== */
import fs from 'node:fs';

/* ---------- harness ------------------------------------------------------- */
const patchFile = (relPath, edits) => {
  if (!fs.existsSync(relPath)) {
    throw new Error(`[3.mjs] missing file: ${relPath}`);
  }
  const raw = fs.readFileSync(relPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let text = raw.split('\r\n').join('\n');

  let applied = 0;
  let skipped = 0;
  for (const edit of edits) {
    if (text.includes(edit.sentinel)) {
      skipped += 1; // 幂等：已改过则跳过
      continue;
    }
    const count = text.split(edit.find).length - 1;
    if (count !== 1) {
      throw new Error(
        `[3.mjs] ${relPath} :: edit "${edit.name}" expected exactly 1 match, found ${count}`,
      );
    }
    // 函数 replacer，避免 $&/$1 等被解释为替换模式
    text = text.replace(edit.find, () => edit.replace);
    applied += 1;
  }

  const out = eol === '\n' ? text : text.split('\n').join(eol);
  if (out !== raw) {
    fs.writeFileSync(relPath, out);
  }
  console.log(`• patched ${relPath} (applied ${applied}, skipped ${skipped})`);
};

const writeNew = (relPath, content) => {
  if (fs.existsSync(relPath)) {
    console.log(`• skip existing ${relPath}`);
    return;
  }
  fs.writeFileSync(relPath, content.endsWith('\n') ? content : `${content}\n`);
  console.log(`• created ${relPath}`);
};

/* ========================================================================== *
 * [1/9] constants.ts — 增加 'tool_call' chunk 类型
 * ========================================================================== */
patchFile('src/types/ai/thread/constants.ts', [
  {
    name: 'AI_ASSISTANT_CHUNK_TYPES += tool_call',
    sentinel: `['message', 'thought', 'tool_call']`,
    find: `export const AI_ASSISTANT_CHUNK_TYPES = ['message', 'thought'] as const;`,
    replace: `export const AI_ASSISTANT_CHUNK_TYPES = ['message', 'thought', 'tool_call'] as const;`,
  },
]);

/* ========================================================================== *
 * [2/9] entry.schema.ts — discriminatedUnion 增加 tool_call 成员
 * （aiThreadToolCallSchema 已在文件顶部 import）
 * ========================================================================== */
patchFile('src/types/ai/thread/entry.schema.ts', [
  {
    name: 'aiThreadAssistantChunkSchema += tool_call variant',
    sentinel: `z.literal('tool_call'), toolCall: aiThreadToolCallSchema`,
    find: [
      `  z.object({ type: z.literal('thought'), block: aiThreadContentBlockSchema }),`,
      `]);`,
    ].join('\n'),
    replace: [
      `  z.object({ type: z.literal('thought'), block: aiThreadContentBlockSchema }),`,
      `  z.object({ type: z.literal('tool_call'), toolCall: aiThreadToolCallSchema }),`,
      `]);`,
    ].join('\n'),
  },
]);

/* ========================================================================== *
 * [3/9] events.ts — 新增 reduce 事件 kind: 'assistant_tool_call'
 * ========================================================================== */
patchFile('src/store/aiThread/events.ts', [
  {
    name: 'import TAcpToolCall / TAcpToolCallUpdate',
    sentinel: `from '@/types/ai/acp-tool-call'`,
    find: `import type { IAiContextReference } from '@/types/ai/context';`,
    replace: [
      `import type { TAcpToolCall, TAcpToolCallUpdate } from '@/types/ai/acp-tool-call';`,
      `import type { IAiContextReference } from '@/types/ai/context';`,
    ].join('\n'),
  },
  {
    name: 'union += assistant_tool_call',
    sentinel: `kind: 'assistant_tool_call';`,
    find: [
      `  | {`,
      `      kind: 'tool_started';`,
    ].join('\n'),
    replace: [
      `  | {`,
      `      kind: 'assistant_tool_call';`,
      `      messageId: string;`,
      `      createdAt: string;`,
      `      update: TAcpToolCall | TAcpToolCallUpdate;`,
      `    }`,
      `  | {`,
      `      kind: 'tool_started';`,
    ].join('\n'),
  },
]);

/* ========================================================================== *
 * [4/9] reduce.ts — import 投影助手 + 守卫 + upsert 函数 + switch 接线
 * ========================================================================== */
patchFile('src/store/aiThread/reduce.ts', [
  {
    name: 'import getAcpToolCallId / reduceAcpToolCall',
    sentinel: `from '@/components/business/ai/thread/projection/from-acp-tool-call'`,
    find: [
      `import type {`,
      `  TAiAssistantChannel,`,
    ].join('\n'),
    replace: [
      `import {`,
      `  getAcpToolCallId,`,
      `  reduceAcpToolCall,`,
      `} from '@/components/business/ai/thread/projection/from-acp-tool-call';`,
      `import type {`,
      `  TAiAssistantChannel,`,
    ].join('\n'),
  },
  {
    name: 'appendAssistantText guard: exclude tool_call chunk',
    sentinel: `last.type !== 'tool_call' && last.type === channel`,
    find: `  if (last && last.type === channel && last.block.type === 'text') {`,
    replace: `  if (last && last.type !== 'tool_call' && last.type === channel && last.block.type === 'text') {`,
  },
  {
    name: 'add upsertAssistantToolCallChunk()',
    sentinel: `function upsertAssistantToolCallChunk(`,
    find: `/* ----- Tool-call upsert (upsert_tool_call) -------------------------------- */`,
    replace: [
      `/* ----- Assistant tool_call chunk upsert (interleaved ACP tool calls) ------ */`,
      `/**`,
      ` * 把 ACP tool_call / tool_call_update 作为 assistant_message 的 chunk 落入同一条`,
      ` * chunks 流，使工具调用与思考/正文按到达顺序交织（对标 Codex/Zed）。按 getAcpToolCallId`,
      ` * 在该 assistant 的 chunks 内 upsert：首帧建 tool_call chunk，后续 update 经`,
      ` * reduceAcpToolCall 原地归并；assistant entry 不存在时按 messageId 先建。`,
      ` */`,
      `function upsertAssistantToolCallChunk(`,
      `  thread: IAiThread,`,
      `  event: TAiThreadReduceEventByKind<'assistant_tool_call'>,`,
      `): IAiThread {`,
      `  const toolCallId = getAcpToolCallId(event.update);`,
      `  if (toolCallId === '') {`,
      `    return thread;`,
      `  }`,
      ``,
      `  const applyTo = (entry: IAiThreadAssistantMessageEntry): IAiThreadAssistantMessageEntry => {`,
      `    const chunkIndex = entry.chunks.findIndex(`,
      `      (chunk) => chunk.type === 'tool_call' && chunk.toolCall.id === toolCallId,`,
      `    );`,
      `    const previousChunk = chunkIndex === -1 ? undefined : entry.chunks[chunkIndex];`,
      `    const previousToolCall =`,
      `      previousChunk && previousChunk.type === 'tool_call' ? previousChunk.toolCall : undefined;`,
      `    const merged = reduceAcpToolCall(previousToolCall, event.update, { now: event.createdAt });`,
      `    const mergedChunk = { type: 'tool_call', toolCall: merged } as IAiThreadAssistantChunk;`,
      `    return chunkIndex === -1`,
      `      ? { ...entry, chunks: [...entry.chunks, mergedChunk] }`,
      `      : { ...entry, chunks: replaceAt(entry.chunks, chunkIndex, mergedChunk) };`,
      `  };`,
      ``,
      `  const index = thread.entries.findIndex(`,
      `    (entry) => entry.type === 'assistant_message' && entry.id === event.messageId,`,
      `  );`,
      `  if (index === -1) {`,
      `    const seeded = applyTo({`,
      `      type: 'assistant_message',`,
      `      id: event.messageId,`,
      `      createdAt: event.createdAt,`,
      `      chunks: [],`,
      `    });`,
      `    return { ...thread, entries: [...thread.entries, seeded] };`,
      `  }`,
      ``,
      `  const current = thread.entries[index] as IAiThreadAssistantMessageEntry;`,
      `  return { ...thread, entries: replaceAt(thread.entries, index, applyTo(current)) };`,
      `}`,
      ``,
      `/* ----- Tool-call upsert (upsert_tool_call) -------------------------------- */`,
    ].join('\n'),
  },
  {
    name: 'reduceThread switch += assistant_tool_call',
    sentinel: `case 'assistant_tool_call':`,
    find: [
      `    case 'assistant_delta':`,
      `    case 'assistant_block':`,
      `      return upsertAssistantChunk(thread, event);`,
    ].join('\n'),
    replace: [
      `    case 'assistant_delta':`,
      `    case 'assistant_block':`,
      `      return upsertAssistantChunk(thread, event);`,
      `    case 'assistant_tool_call':`,
      `      return upsertAssistantToolCallChunk(thread, event);`,
    ].join('\n'),
  },
]);

/* ========================================================================== *
 * [5/9] from-sidecar-events.ts — 接线 ACP tool_call / tool_call_update
 * （原来落到 default -> [] 被丢弃）
 * ========================================================================== */
patchFile('src/components/business/ai/thread/projection/from-sidecar-events.ts', [
  {
    name: 'sidecarEventToReduceEvents: handle tool_call(_update)',
    sentinel: `case 'tool_call_update':`,
    find: [
      `    case 'done':`,
      `      return [{ kind: 'stream_completed' }];`,
      `    case 'error':`,
    ].join('\n'),
    replace: [
      `    case 'tool_call':`,
      `    case 'tool_call_update':`,
      `      // ACP（Kimi/Codex 等 openWorld 后端）工具调用 UI 事件：作为 assistant_message 的`,
      `      // tool_call chunk 落入同一 chunks 流，使「思考/正文/工具」按到达顺序真实交织（对标 Codex）。`,
      `      return [`,
      `        {`,
      `          kind: 'assistant_tool_call',`,
      `          messageId: options.assistantMessageId,`,
      `          createdAt: options.now,`,
      `          update: event.acpUpdate,`,
      `        },`,
      `      ];`,
      `    case 'done':`,
      `      return [{ kind: 'stream_completed' }];`,
      `    case 'error':`,
    ].join('\n'),
  },
]);

/* ========================================================================== *
 * [6/9] thread-entries-to-timeline.ts — 含 tool_call chunk 的回合走「交织投影」
 *   无 tool_call 时保持原有 reasoning+text 投影与稳定 id（a1:reasoning / a1:text）不变。
 * ========================================================================== */
patchFile('src/components/business/ai/thread/projection/thread-entries-to-timeline.ts', [
  {
    name: 'add assistantMessageChunksInterleaved()',
    sentinel: `function assistantMessageChunksInterleaved(`,
    find: `/** 把一条 assistant_message 拆为 reasoning(thought)与 assistant-text(message)两类条目。 */`,
    replace: [
      `/**`,
      ` * 含 tool_call chunk 的 assistant_message：按 chunks 到达顺序逐段投影，使思考、正文、`,
      ` * 工具调用按真实交错铺进平铺时间线（对标 Codex/Zed）。相邻同类文本段合并：连续 thought`,
      ` * 汇成一条 reasoning，连续 message 汇成一条 assistant-text；tool_call 即产出一条 tool-call。`,
      ` * id 以段序号去重（:reasoning:n / :text:n），避免同一消息多段 id 冲突。`,
      ` */`,
      `function assistantMessageChunksInterleaved(`,
      `  entry: IAiThreadAssistantMessageEntry,`,
      `  streaming: boolean,`,
      `): TAiThreadEntry[] {`,
      `  const projected: TAiThreadEntry[] = [];`,
      `  let pendingThoughts: string[] = [];`,
      `  let pendingMessages: string[] = [];`,
      `  let segmentIndex = 0;`,
      ``,
      `  const flushThoughts = (): void => {`,
      `    if (pendingThoughts.length === 0) {`,
      `      return;`,
      `    }`,
      `    const reasoning: IAiThreadReasoningEntry = {`,
      `      kind: 'reasoning',`,
      // 含反引号/${}：用单引号 JS 字符串，使其作为字面量写入 TS 源
      '      id: `${entry.id}:reasoning:${segmentIndex}`,',
      `      messageId: entry.id,`,
      `      segments: pendingThoughts,`,
      `      isLong: pendingThoughts.length > 1,`,
      `      streaming,`,
      `    };`,
      `    projected.push(reasoning);`,
      `    pendingThoughts = [];`,
      `    segmentIndex += 1;`,
      `  };`,
      ``,
      `  const flushMessages = (): void => {`,
      `    if (pendingMessages.length === 0) {`,
      `      return;`,
      `    }`,
      `    const assistantText: IAiThreadAssistantTextEntry = {`,
      `      kind: 'assistant-text',`,
      '      id: `${entry.id}:text:${segmentIndex}`,',
      `      messageId: entry.id,`,
      `      markdown: pendingMessages.join(PARAGRAPH_BREAK),`,
      `      streaming,`,
      `    };`,
      `    projected.push(assistantText);`,
      `    pendingMessages = [];`,
      `    segmentIndex += 1;`,
      `  };`,
      ``,
      `  for (const chunk of entry.chunks) {`,
      `    if (chunk.type === 'tool_call') {`,
      `      flushThoughts();`,
      `      flushMessages();`,
      `      projected.push({`,
      `        kind: 'tool-call',`,
      `        id: chunk.toolCall.id,`,
      `        messageId: entry.id,`,
      `        toolCall: chunk.toolCall,`,
      `        terminals: {},`,
      `        awaiting: false,`,
      `      });`,
      `      continue;`,
      `    }`,
      `    const text = blockToText(chunk.block);`,
      `    if (text.length === 0) {`,
      `      continue;`,
      `    }`,
      `    if (chunk.type === 'thought') {`,
      `      flushMessages();`,
      `      pendingThoughts.push(text);`,
      `    } else {`,
      `      flushThoughts();`,
      `      pendingMessages.push(text);`,
      `    }`,
      `  }`,
      `  flushThoughts();`,
      `  flushMessages();`,
      `  return projected;`,
      `}`,
      ``,
      `/** 把一条 assistant_message 拆为 reasoning(thought)与 assistant-text(message)两类条目。 */`,
    ].join('\n'),
  },
  {
    name: 'assistantMessageToEntries: route to interleaved when tool_call present',
    sentinel: `return assistantMessageChunksInterleaved(entry, streaming);`,
    find: [
      `): TAiThreadEntry[] {`,
      `  const thoughtSegments: string[] = [];`,
    ].join('\n'),
    replace: [
      `): TAiThreadEntry[] {`,
      `  // 含 tool_call chunk 的回合走交织投影：思考/正文/工具按 chunks 到达顺序铺开，`,
      `  // 与 Codex 风格的真实交错一致（无 tool_call 时保持原有 reasoning+text 投影不变）。`,
      `  if (entry.chunks.some((chunk) => chunk.type === 'tool_call')) {`,
      `    return assistantMessageChunksInterleaved(entry, streaming);`,
      `  }`,
      `  const thoughtSegments: string[] = [];`,
    ].join('\n'),
  },
]);

/* ========================================================================== *
 * [7/9] useAiAssistant.ts — 收尾注入正文时「保留交织」
 *   原逻辑：finalText 非空就丢掉所有 message 通道 chunk、只留 thought（tool_call 一并被丢）。
 *   新逻辑：本回合已流式出正文 -> 原样保留 chunks（含 tool_call 交错）；
 *           无任何流式正文 -> 丢 message 通道、保留 thought + tool_call，再以最终答案兜底。
 * ========================================================================== */
patchFile('src/composables/ai/useAiAssistant.ts', [
  {
    name: 'finalize: preserve interleaved chunks (thought + tool_call)',
    sentinel: `const hasStreamedMessageText = entry.chunks.some(`,
    find: [
      `      matchedAssistantEntry = true;`,
      `      // 收尾注入最终正文：丢弃 message 通道增量 chunk（保留 thought），以最终答案为唯一正文，`,
      `      // 杜绝「无 delta -> 正文为空」与「半截增量」。live 帧 finalText 为 null，chunks 原样。`,
      `      const nextChunks: IAiThreadAssistantMessageEntry['chunks'] =`,
      `        finalText !== null`,
      `          ? [`,
      `              ...entry.chunks.filter((chunk) => chunk.type === 'thought'),`,
      `              { type: 'message', block: { type: 'text', text: finalText } },`,
      `            ]`,
      `          : entry.chunks;`,
    ].join('\n'),
    replace: [
      `      matchedAssistantEntry = true;`,
      `      // 保留交织：本回合若已流式出 message 正文，则原样保留 chunks（thought/tool_call/message 真实交错，`,
      `      // 对标 Codex）；仅当无任何流式正文时，才丢 message 通道并以最终答案兜底（保留 thought 与 tool_call）。`,
      `      const hasStreamedMessageText = entry.chunks.some(`,
      `        (chunk) =>`,
      `          chunk.type === 'message' && chunk.block.type === 'text' && chunk.block.text.length > 0,`,
      `      );`,
      `      const nextChunks: IAiThreadAssistantMessageEntry['chunks'] =`,
      `        finalText !== null && !hasStreamedMessageText`,
      `          ? [`,
      `              ...entry.chunks.filter((chunk) => chunk.type !== 'message'),`,
      `              { type: 'message', block: { type: 'text', text: finalText } },`,
      `            ]`,
      `          : entry.chunks;`,
    ].join('\n'),
  },
]);

/* ========================================================================== *
 * [8/9] 持久化往返：让 chunks（含 tool_call 交织）穿过 messages <-> entries 不丢失
 *   A. types/ai/index.ts   —— IAiChatMessage 增加可选 chunks 载体（仅 UI 状态层，schema parse 时 strip）
 *   B. legacy-adapter.ts   —— 双向：优先用 message.chunks 还原 / 回写时挂上 entry.chunks
 * ========================================================================== */
patchFile('src/types/ai/index.ts', [
  {
    name: 'import IAiThreadAssistantChunk',
    sentinel: `IAiThreadAssistantChunk, IAiThreadToolCall`,
    find: `import type { IAiThreadToolCall } from '@/types/ai/thread';`,
    replace: `import type { IAiThreadAssistantChunk, IAiThreadToolCall } from '@/types/ai/thread';`,
  },
  {
    name: 'IAiChatMessage += chunks?',
    sentinel: `chunks?: IAiThreadAssistantChunk[];`,
    find: [
      `  reasoning?: string;`,
      `}`,
    ].join('\n'),
    replace: [
      `  reasoning?: string;`,
      `  /**`,
      `   * assistant chunks 流原样快照（message / thought / tool_call 的交织序列）：仅 UI 状态层使用、`,
      `   * 绝不发到 IPC（schema parse 时被 strip）。承载 entries <-> messages 往返中的交织顺序与 ACP`,
      `   * 工具 chunk，使收尾/水合回写不再丢失工具调用与思考/正文的真实交错。`,
      `   */`,
      `  chunks?: IAiThreadAssistantChunk[];`,
      `}`,
    ].join('\n'),
  },
]);

patchFile('src/store/aiThread/legacy-adapter.ts', [
  {
    name: 'import IAiThreadAssistantChunk',
    sentinel: `  IAiThreadAssistantChunk,`,
    find: [
      `import type {`,
      `  IAiThread,`,
      `  IAiThreadAssistantMessageEntry,`,
    ].join('\n'),
    replace: [
      `import type {`,
      `  IAiThread,`,
      `  IAiThreadAssistantChunk,`,
      `  IAiThreadAssistantMessageEntry,`,
    ].join('\n'),
  },
  {
    name: 'legacyMessageToEntries: prefer message.chunks',
    sentinel: `? message.chunks`,
    find: [
      `  const assistantChunks: IAiThreadAssistantMessageEntry['chunks'] = [`,
      `    ...reasoningChunks,`,
      `    ...messageChunks,`,
      `  ];`,
    ].join('\n'),
    replace: [
      `  // 优先用 message.chunks 原样还原（含 tool_call 交织 + 顺序）；缺省再从 reasoning/content 重建，`,
      `  // 使 messages -> entries 不丢工具 chunk 与思考/正文真实交错（与 threadEntriesToMessages 对称）。`,
      `  const assistantChunks: IAiThreadAssistantMessageEntry['chunks'] =`,
      `    message.chunks && message.chunks.length > 0`,
      `      ? message.chunks`,
      `      : [...reasoningChunks, ...messageChunks];`,
    ].join('\n'),
  },
  {
    name: 'threadEntriesToMessages: carry entry.chunks back onto message',
    sentinel: `{ chunks: entry.chunks }`,
    find: `          ...(reasoning.length > 0 ? { reasoning } : {}),`,
    replace: [
      `          ...(reasoning.length > 0 ? { reasoning } : {}),`,
      `          // chunks 原样回挂（含 tool_call 交织）：使 entries -> messages -> entries 往返保真，`,
      `          // 收尾/水合不丢工具调用与思考/正文交错（reasoning/content 仍并存，供旧读取路径兜底）。`,
      `          ...(entry.chunks.length > 0 ? { chunks: entry.chunks } : {}),`,
    ].join('\n'),
  },
]);

/* ========================================================================== *
 * [9/9] 新增测试（writeNew：文件已存在则跳过，幂等）
 * ========================================================================== */

/* ---- 9a. reduce：assistant_tool_call 归并 + 交织顺序 -------------------- */
writeNew(
  'src/store/aiThread/reduce.acp-tool-chunk.spec.ts',
  `import { describe, expect, it } from 'vitest';

import type { TAcpToolCall } from '@/types/ai/acp-tool-call';
import type { IAiThread } from '@/types/ai/thread';
import type { TAiThreadReduceEvent } from './events';
import { reduceThread, reduceThreadAll } from './reduce';

const baseThread = (): IAiThread => ({
  id: 't1',
  title: 'T',
  titleStatus: 'temporary',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  entries: [],
});

const acpUpdate = (over: Record<string, unknown>): TAcpToolCall =>
  ({ toolCallId: 'tc1', ...over }) as unknown as TAcpToolCall;

describe('reduce / assistant_tool_call chunk', () => {
  it('在 assistant_message 内建出 tool_call chunk', () => {
    const out = reduceThread(baseThread(), {
      kind: 'assistant_tool_call',
      messageId: 'a1',
      createdAt: '2026-01-01T00:00:01.000Z',
      update: acpUpdate({ title: 'Read file', kind: 'read', status: 'in_progress' }),
    });
    expect(out.entries).toHaveLength(1);
    const entry = out.entries[0];
    if (entry.type !== 'assistant_message') throw new Error('expected assistant_message');
    expect(entry.chunks).toHaveLength(1);
    const chunk = entry.chunks[0];
    if (chunk.type !== 'tool_call') throw new Error('expected tool_call chunk');
    expect(chunk.toolCall.id).toBe('tc1');
    expect(chunk.toolCall.title).toBe('Read file');
    expect(chunk.toolCall.status).toBe('in_progress');
  });

  it('思考 / 工具 / 正文按到达顺序交织在同一 chunks 流', () => {
    const events: TAiThreadReduceEvent[] = [
      { kind: 'assistant_delta', messageId: 'a1', createdAt: 'x', channel: 'thought', text: '想一下' },
      { kind: 'assistant_tool_call', messageId: 'a1', createdAt: 'x', update: acpUpdate({ title: 'grep', kind: 'search' }) },
      { kind: 'assistant_delta', messageId: 'a1', createdAt: 'x', channel: 'message', text: '答案' },
    ];
    const out = reduceThreadAll(baseThread(), events);
    expect(out.entries).toHaveLength(1);
    const entry = out.entries[0];
    if (entry.type !== 'assistant_message') throw new Error('expected assistant_message');
    expect(entry.chunks.map((c) => c.type)).toEqual(['thought', 'tool_call', 'message']);
  });

  it('同 toolCallId 的 update 原地归并而非新增 chunk', () => {
    const out = reduceThreadAll(baseThread(), [
      { kind: 'assistant_tool_call', messageId: 'a1', createdAt: 'x', update: acpUpdate({ title: 'edit', kind: 'edit', status: 'in_progress' }) },
      { kind: 'assistant_tool_call', messageId: 'a1', createdAt: 'y', update: acpUpdate({ status: 'completed' }) },
    ]);
    const entry = out.entries[0];
    if (entry.type !== 'assistant_message') throw new Error('expected assistant_message');
    expect(entry.chunks).toHaveLength(1);
    const chunk = entry.chunks[0];
    if (chunk.type !== 'tool_call') throw new Error('expected tool_call chunk');
    expect(chunk.toolCall.status).toBe('completed');
    expect(chunk.toolCall.title).toBe('edit');
  });

  it('缺 toolCallId 的 update 为 no-op（返回原 thread 引用）', () => {
    const before = baseThread();
    const out = reduceThread(before, {
      kind: 'assistant_tool_call',
      messageId: 'a1',
      createdAt: 'x',
      update: {} as unknown as TAcpToolCall,
    });
    expect(out).toBe(before);
  });
});
`,
);

/* ---- 9b. timeline 投影：交织顺序 + 无 tool_call 时稳定 id ---------------- */
writeNew(
  'src/components/business/ai/thread/projection/thread-entries-to-timeline.acp.spec.ts',
  `import { describe, expect, it } from 'vitest';

import type { IAiThreadEntry, IAiThreadToolCall } from '@/types/ai/thread';
import { threadEntriesToTimeline } from './thread-entries-to-timeline';

const toolCall = (id: string): IAiThreadToolCall => ({
  type: 'tool_call',
  id,
  createdAt: 'x',
  title: 'Read',
  kind: 'read',
  status: 'completed',
  content: [],
});

describe('thread-entries-to-timeline / interleaved tool_call chunks', () => {
  it('含 tool_call chunk 的回合按 reasoning -> tool-call -> assistant-text 交织投影', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'a1',
        createdAt: 'x',
        chunks: [
          { type: 'thought', block: { type: 'text', text: '想一下' } },
          { type: 'tool_call', toolCall: toolCall('tc1') },
          { type: 'message', block: { type: 'text', text: '答案' } },
        ],
      },
    ];
    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((item) => item.kind)).toEqual(['reasoning', 'tool-call', 'assistant-text']);
    const toolItem = timeline[1];
    if (toolItem.kind !== 'tool-call') throw new Error('expected tool-call');
    expect(toolItem.toolCall.id).toBe('tc1');
  });

  it('无 tool_call chunk 时保持原有 reasoning/assistant-text 投影与稳定 id', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'a1',
        createdAt: 'x',
        chunks: [
          { type: 'thought', block: { type: 'text', text: '想' } },
          { type: 'message', block: { type: 'text', text: '答' } },
        ],
      },
    ];
    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((item) => item.kind)).toEqual(['reasoning', 'assistant-text']);
    expect(timeline.map((item) => item.id)).toEqual(['a1:reasoning', 'a1:text']);
  });
});
`,
);

/* ---- 9c. legacy 往返：chunks（含 tool_call 交织）保真 -------------------- */
writeNew(
  'src/store/aiThread/legacy-adapter.acp-chunks.spec.ts',
  `import { describe, expect, it } from 'vitest';

import type { IAiChatMessage } from '@/types/ai';
import type { IAiThreadAssistantChunk } from '@/types/ai/thread';
import { legacyMessageToEntries, threadEntriesToMessages } from './legacy-adapter';

const chunks: IAiThreadAssistantChunk[] = [
  { type: 'thought', block: { type: 'text', text: '想一下' } },
  {
    type: 'tool_call',
    toolCall: { type: 'tool_call', id: 'tc1', createdAt: 'x', title: 'Read', kind: 'read', status: 'completed', content: [] },
  },
  { type: 'message', block: { type: 'text', text: '答案' } },
];

describe('legacy-adapter / chunks roundtrip with tool_call', () => {
  it('message.chunks 经 legacyMessageToEntries 原样还原到 assistant_message.chunks', () => {
    const message: IAiChatMessage = {
      role: 'assistant',
      id: 'a1',
      content: '答案',
      createdAt: 'x',
      references: [],
      chunks,
    };
    const entries = legacyMessageToEntries(message);
    const assistant = entries.find((entry) => entry.type === 'assistant_message');
    if (!assistant || assistant.type !== 'assistant_message') throw new Error('expected assistant_message');
    expect(assistant.chunks.map((c) => c.type)).toEqual(['thought', 'tool_call', 'message']);
  });

  it('chunks 经 threadEntriesToMessages -> legacyMessageToEntries 往返保真', () => {
    const messages = threadEntriesToMessages([
      { type: 'assistant_message', id: 'a1', createdAt: 'x', chunks },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.chunks?.map((c) => c.type)).toEqual(['thought', 'tool_call', 'message']);
    const roundTrip = legacyMessageToEntries(messages[0]!);
    const assistant = roundTrip.find((entry) => entry.type === 'assistant_message');
    if (!assistant || assistant.type !== 'assistant_message') throw new Error('expected assistant_message');
    expect(assistant.chunks.map((c) => c.type)).toEqual(['thought', 'tool_call', 'message']);
  });
});
`,
);

console.log('\n✅ 3.mjs done — 9 组源码改动 + 3 个 spec 已落盘（幂等，可重复运行）。');
console.log('   接着跑：node 2.mjs  &&  pnpm typecheck && pnpm test && pnpm lint');
console.log('   若 biome 提示 import 顺序：pnpm exec biome check --write src/');