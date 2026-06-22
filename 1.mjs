#!/usr/bin/env node
// fix-reasoning-roundtrip.mjs —— 让 entries <-> messages 往返对 thought 无损。
// 用法: node fix-reasoning-roundtrip.mjs           (干跑)
//       node fix-reasoning-roundtrip.mjs --apply   (写入)
import { readFileSync, writeFileSync } from 'node:fs';
const APPLY = process.argv.includes('--apply');

const edits = [
  {
    file: 'src/types/ai/index.ts',
    replacements: [
      {
        find: `export interface IAiChatMessage extends IAiChatMessageWire {
  patches?: IAiPatchSet[];
  changedFilesSummary?: IAiAgentPatchSummary;
  acpToolCalls?: IAiThreadToolCall[];
}`,
        to: `export interface IAiChatMessage extends IAiChatMessageWire {
  patches?: IAiPatchSet[];
  changedFilesSummary?: IAiAgentPatchSummary;
  acpToolCalls?: IAiThreadToolCall[];
  /**
   * 思维链(reasoning / 思考过程)纯文本:assistant 思考通道(thought chunks)折叠而成,
   * 仅 UI 状态层使用、绝不发到 IPC(schema parse 时被 strip)。承载 entries <-> messages
   * 往返中的 thought 通道,使任何经 legacyMessageToEntries / threadEntriesToMessages 的
   * 回写都不再丢失思考过程(修复「AI 回复结束后思考过程文本/UI 消失」)。
   */
  reasoning?: string;
}`,
      },
    ],
  },
  {
    file: 'src/store/aiThread/legacy-adapter.ts',
    replacements: [
      {
        find: `  const assistantChunks: IAiThreadAssistantMessageEntry['chunks'] =
    message.content.trim().length > 0
      ? [{ type: 'message', block: { type: 'text', text: message.content } }]
      : [];`,
        to: `  // 思维链(thought)与正文(message)是同一条 chunks 流的两种 variant。从 legacy 消息的
  // reasoning 还原 thought chunk(置于正文之前),使 messages -> entries 不丢思考过程
  // (与 threadEntriesToMessages 的 assistantChunksToReasoning 对称、无损往返)。
  const reasoningText = message.reasoning ?? '';
  const reasoningChunks: IAiThreadAssistantMessageEntry['chunks'] =
    reasoningText.trim().length > 0
      ? [{ type: 'thought', block: { type: 'text', text: reasoningText } }]
      : [];
  const messageChunks: IAiThreadAssistantMessageEntry['chunks'] =
    message.content.trim().length > 0
      ? [{ type: 'message', block: { type: 'text', text: message.content } }]
      : [];
  const assistantChunks: IAiThreadAssistantMessageEntry['chunks'] = [
    ...reasoningChunks,
    ...messageChunks,
  ];`,
      },
      {
        find: `function assistantChunksToText(chunks: IAiThreadAssistantChunks): string {
  return chunks
    .flatMap((chunk) =>
      chunk.type === 'message' && chunk.block.type === 'text' ? [chunk.block.text] : [],
    )
    .join('');
}`,
        to: `function assistantChunksToText(chunks: IAiThreadAssistantChunks): string {
  return chunks
    .flatMap((chunk) =>
      chunk.type === 'message' && chunk.block.type === 'text' ? [chunk.block.text] : [],
    )
    .join('');
}

/**
 * 把 assistant chunks 的思考通道(thought)折叠为纯文本 reasoning(assistantChunksToText 的
 * 思维链对偶)。多段 thought 以空行衔接,对齐渲染层 reasoning 段落拼接,使 entries <-> messages
 * 往返保留思考过程(修复收尾/编辑回写丢失 thought 的 bug)。
 */
function assistantChunksToReasoning(chunks: IAiThreadAssistantChunks): string {
  return chunks
    .flatMap((chunk) =>
      chunk.type === 'thought' && chunk.block.type === 'text' ? [chunk.block.text] : [],
    )
    .join('\\n\\n');
}`,
      },
      {
        find: `      case 'assistant_message': {
        const message: IAiChatMessage = {
          role: 'assistant',
          id: entry.id,
          content: assistantChunksToText(entry.chunks),
          createdAt: entry.createdAt,
          references: [],
          ...(pendingToolCalls.length > 0 ? { toolCalls: pendingToolCalls } : {}),`,
        to: `      case 'assistant_message': {
        const reasoning = assistantChunksToReasoning(entry.chunks);
        const message: IAiChatMessage = {
          role: 'assistant',
          id: entry.id,
          content: assistantChunksToText(entry.chunks),
          createdAt: entry.createdAt,
          references: [],
          ...(reasoning.length > 0 ? { reasoning } : {}),
          ...(pendingToolCalls.length > 0 ? { toolCalls: pendingToolCalls } : {}),`,
      },
    ],
  },
  {
    file: 'src/store/aiThread/legacy-adapter.reverse.spec.ts',
    replacements: [
      {
        find: `    expect(message?.acpToolCalls?.[0]?.id).toBe('acp-1');
  });

  it('skips non-message entries without throwing', () => {`,
        to: `    expect(message?.acpToolCalls?.[0]?.id).toBe('acp-1');
  });

  it('round-trips assistant reasoning(思考过程 thought 通道)', () => {
    const withReasoning: IAiChatMessage = {
      role: 'assistant',
      id: 'a3',
      content: '正文答案',
      createdAt: '2026-01-01T00:00:03.000Z',
      references: [],
      reasoning: '我先分析再作答',
    };
    const entries = legacyMessageToEntries(withReasoning);
    const assistant = entries.find((e) => e.type === 'assistant_message');
    expect(assistant?.type).toBe('assistant_message');
    if (assistant?.type === 'assistant_message') {
      expect(assistant.chunks.map((c) => c.type)).toEqual(['thought', 'message']);
    }
    const [message] = threadEntriesToMessages(entries);
    expect(message?.reasoning).toBe('我先分析再作答');
    expect(message?.content).toBe('正文答案');
  });

  it('skips non-message entries without throwing', () => {`,
      },
    ],
  },
  {
    file: 'src/store/aiThread/legacy-adapter.spec.ts',
    replacements: [
      {
        find: `    const assistant = entries[1] as IAiThreadAssistantMessageEntry;
    expect(assistant.chunks).toEqual([
      { type: 'message', block: { type: 'text', text: '最终回答' } },
    ]);
  });`,
        to: `    const assistant = entries[1] as IAiThreadAssistantMessageEntry;
    expect(assistant.chunks).toEqual([
      { type: 'message', block: { type: 'text', text: '最终回答' } },
    ]);
  });

  it('assistant + reasoning -> thought chunk(在正文 chunk 之前)', () => {
    const entries = legacyMessageToEntries({
      id: 'a-reason',
      role: 'assistant',
      content: '最终回答',
      createdAt: ISO,
      references: [],
      reasoning: '我先分析再作答',
    });
    const assistant = entries[0] as IAiThreadAssistantMessageEntry;
    expect(assistant.type).toBe('assistant_message');
    expect(assistant.chunks).toEqual([
      { type: 'thought', block: { type: 'text', text: '我先分析再作答' } },
      { type: 'message', block: { type: 'text', text: '最终回答' } },
    ]);
  });`,
      },
    ],
  },
];

let allOk = true;
const planned = [];
for (const edit of edits) {
  const raw = readFileSync(edit.file, 'utf8');
  const crlf = raw.includes('\r\n');
  const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  for (const { find } of edit.replacements) {
    const count = text.split(find).length - 1;
    if (count !== 1) {
      allOk = false;
      console.error(`✗ ${edit.file}: 期望 1 处匹配,实际 ${count} 处\n--- find ---\n${find}\n------------`);
    }
  }
  planned.push({ edit, crlf, text });
}
if (!allOk) {
  console.error('\n有匹配未命中(文件可能已改动)。未写入任何文件。');
  process.exit(1);
}
for (const { edit, crlf, text } of planned) {
  let next = text;
  for (const { find, to } of edit.replacements) next = next.replace(find, () => to);
  const out = crlf ? next.replace(/\n/g, '\r\n') : next;
  if (APPLY) { writeFileSync(edit.file, out, 'utf8'); console.log(`✓ 已写入 ${edit.file}`); }
  else console.log(`(dry-run) 将更新 ${edit.file}(${edit.replacements.length} 处)`);
}
console.log(APPLY ? '\n完成。请运行 pnpm vitest run 与 pnpm -s vue-tsc --noEmit。' : '\n干跑完成。加 --apply 写入。');