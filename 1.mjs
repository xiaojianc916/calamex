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