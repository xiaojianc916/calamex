// step1-single-toolcall.mjs —— ACP 工具调用单一表示 + Zed 段切分交错（对标 acp_thread.rs）

// ── 1) 协议常量：AssistantMessageChunk = message | thought ──────────────
patchFile('src/types/ai/thread/constants.ts', [
  {
    sentinel: "AI_ASSISTANT_CHUNK_TYPES = ['message', 'thought'] as const;",
    find: "export const AI_ASSISTANT_CHUNK_TYPES = ['message', 'thought', 'tool_call'] as const;",
    replace: "export const AI_ASSISTANT_CHUNK_TYPES = ['message', 'thought'] as const;",
  },
]);

// ── 2) entry.schema：删 tool_call chunk variant + 删 acpToolCalls 字段 ────
patchFile('src/types/ai/thread/entry.schema.ts', [
  {
    sentinel: "  z.object({ type: z.literal('thought'), block: aiThreadContentBlockSchema }),\n]);",
    find:
      "  z.object({ type: z.literal('thought'), block: aiThreadContentBlockSchema }),\n" +
      "  z.object({ type: z.literal('tool_call'), toolCall: aiThreadToolCallSchema }),\n]);",
    replace:
      "  z.object({ type: z.literal('thought'), block: aiThreadContentBlockSchema }),\n]);",
  },
  {
    // 删整段 acpToolCalls 字段（含其上方注释）；sentinel = stream 行后直接接 patches 注释
    sentinel:
      "  stream: aiChatMessageStreamSnapshotSchema.optional().catch(undefined),\n" +
      "  /**\n   * 顶层 patches 往返",
    find:
      "  /**\n" +
      "   * ACP openWorld 后端的工具调用投影（对标 legacy `IAiChatMessage.acpToolCalls`）。\n" +
      "   * 复用本协议层 `aiThreadToolCallSchema`，逆投影原样回挂，免重放 runtimeEvents 重建。\n" +
      "   */\n" +
      "  acpToolCalls: z.array(aiThreadToolCallSchema).optional().catch(undefined),\n",
    replace: "",
  },
]);

// ── 3) reduce 事件：assistant_tool_call → 顶层 acp_tool_call ──────────────
patchFile('src/store/aiThread/events.ts', [
  {
    sentinel: "      kind: 'acp_tool_call';",
    find:
      "  | {\n      kind: 'assistant_tool_call';\n      messageId: string;\n" +
      "      createdAt: string;\n      update: TAcpToolCall | TAcpToolCallUpdate;\n    }",
    replace:
      "  | {\n      kind: 'acp_tool_call';\n" +
      "      createdAt: string;\n      update: TAcpToolCall | TAcpToolCallUpdate;\n    }",
  },
]);

// ── 4) from-sidecar：ACP tool_call(_update) → 顶层 acp_tool_call 事件 ─────
patchFile('src/components/business/ai/thread/projection/from-sidecar-events.ts', [
  {
    sentinel: "          kind: 'acp_tool_call',",
    find:
      "    case 'tool_call':\n    case 'tool_call_update':\n" +
      "      // ACP（Kimi/Codex 等 openWorld 后端）工具调用 UI 事件：作为 assistant_message 的\n" +
      "      // tool_call chunk 落入同一 chunks 流，使「思考/正文/工具」按到达顺序真实交织（对标 Codex）。\n" +
      "      return [\n        {\n          kind: 'assistant_tool_call',\n" +
      "          messageId: options.assistantMessageId,\n          createdAt: options.now,\n" +
      "          update: event.acpUpdate,\n        },\n      ];",
    replace:
      "    case 'tool_call':\n    case 'tool_call_update':\n" +
      "      // ACP（Kimi/Codex 等 openWorld 后端）工具调用 UI 事件：归一为顶层 acp_tool_call reduce\n" +
      "      // 事件，由 reducer 作为独立 tool_call entry 按到达顺序 upsert，与思考/正文真实交织（对标 Zed）。\n" +
      "      return [\n        {\n          kind: 'acp_tool_call',\n" +
      "          createdAt: options.now,\n          update: event.acpUpdate,\n        },\n      ];",
  },
]);

// ── 5) reduce.ts：Zed push 规则 + 顶层 acp_tool_call upsert（4 处） ───────
patchFile('src/store/aiThread/reduce.ts', [
  // 5a 文本合并去掉 tool_call 兜底判别（chunks 只剩 message|thought）
  {
    sentinel: "  if (last && last.type === channel &&",
    find:
      "  if (last && last.type !== 'tool_call' && last.type === channel && last.block.type === 'text') {",
    replace: "  if (last && last.type === channel && last.block.type === 'text') {",
  },
  // 5b upsertAssistantChunk 改为 Zed push_assistant_content_block
  {
    sentinel: '对标 Zed push_assistant_content_block：仅当',
    find:
      "function upsertAssistantChunk(\n  thread: IAiThread,\n" +
      "  event: TAiThreadReduceEventByKind<'assistant_delta' | 'assistant_block'>,\n): IAiThread {\n" +
      "  const index = thread.entries.findIndex(\n" +
      "    (entry) => entry.type === 'assistant_message' && entry.id === event.messageId,\n  );\n\n" +
      "  const applyTo = (entry: IAiThreadAssistantMessageEntry): IAiThreadAssistantMessageEntry =>\n" +
      "    event.kind === 'assistant_delta'\n" +
      "      ? appendAssistantText(entry, event.channel, event.text)\n" +
      "      : pushAssistantBlock(entry, event.channel, event.block);\n\n" +
      "  if (index === -1) {\n    const seeded = applyTo({\n      type: 'assistant_message',\n" +
      "      id: event.messageId,\n      createdAt: event.createdAt,\n      chunks: [],\n    });\n" +
      "    return { ...thread, entries: [...thread.entries, seeded] };\n  }\n\n" +
      "  const current = thread.entries[index] as IAiThreadAssistantMessageEntry;\n" +
      "  return { ...thread, entries: replaceAt(thread.entries, index, applyTo(current)) };\n}",
    replace:
      "function upsertAssistantChunk(\n  thread: IAiThread,\n" +
      "  event: TAiThreadReduceEventByKind<'assistant_delta' | 'assistant_block'>,\n): IAiThread {\n" +
      "  const applyTo = (entry: IAiThreadAssistantMessageEntry): IAiThreadAssistantMessageEntry =>\n" +
      "    event.kind === 'assistant_delta'\n" +
      "      ? appendAssistantText(entry, event.channel, event.text)\n" +
      "      : pushAssistantBlock(entry, event.channel, event.block);\n\n" +
      "  // 对标 Zed push_assistant_content_block：仅当「最后一条」entry 是 assistant_message 时并入当前段，\n" +
      "  // 否则（其间已插入 tool_call 等 entry，或新回合）另起一段。这样思考/正文/工具按真实到达顺序交错，\n" +
      "  // 工具调用永远落在它实际发生的位置（修复正文被吸到工具之前的错乱）。\n" +
      "  const lastIndex = thread.entries.length - 1;\n" +
      "  const last = lastIndex >= 0 ? thread.entries[lastIndex] : undefined;\n" +
      "  if (last && last.type === 'assistant_message') {\n" +
      "    return { ...thread, entries: replaceAt(thread.entries, lastIndex, applyTo(last)) };\n  }\n\n" +
      "  // 段 id：同回合（messageId）首段沿用 messageId，后续段追加 #n，保证事件回放期确定且唯一。\n" +
      "  const turnSegmentCount = thread.entries.filter(\n" +
      "    (entry) =>\n      entry.type === 'assistant_message' &&\n" +
      "      (entry.id === event.messageId || entry.id.startsWith(`${event.messageId}#`)),\n  ).length;\n" +
      "  const segmentId =\n" +
      "    turnSegmentCount === 0 ? event.messageId : `${event.messageId}#${turnSegmentCount}`;\n" +
      "  const seeded = applyTo({\n    type: 'assistant_message',\n    id: segmentId,\n" +
      "    createdAt: event.createdAt,\n    chunks: [],\n  });\n" +
      "  return { ...thread, entries: [...thread.entries, seeded] };\n}",
  },
  // 5c 删 upsertAssistantToolCallChunk，换成顶层 upsertAcpToolCall（upsert_tool_call 语义）
  {
    sentinel: 'function upsertAcpToolCall(',
    find:
      "/* ----- Assistant tool_call chunk upsert (interleaved ACP tool calls) ------ */\n" +
      "/**\n" +
      " * 把 ACP tool_call / tool_call_update 作为 assistant_message 的 chunk 落入同一条\n" +
      " * chunks 流，使工具调用与思考/正文按到达顺序交织（对标 Codex/Zed）。按 getAcpToolCallId\n" +
      " * 在该 assistant 的 chunks 内 upsert：首帧建 tool_call chunk，后续 update 经\n" +
      " * reduceAcpToolCall 原地归并；assistant entry 不存在时按 messageId 先建。\n" +
      " */\n" +
      "function upsertAssistantToolCallChunk(\n  thread: IAiThread,\n" +
      "  event: TAiThreadReduceEventByKind<'assistant_tool_call'>,\n): IAiThread {\n" +
      "  const toolCallId = getAcpToolCallId(event.update);\n" +
      "  if (toolCallId === '') {\n    return thread;\n  }\n\n" +
      "  const applyTo = (entry: IAiThreadAssistantMessageEntry): IAiThreadAssistantMessageEntry => {\n" +
      "    const chunkIndex = entry.chunks.findIndex(\n" +
      "      (chunk) => chunk.type === 'tool_call' && chunk.toolCall.id === toolCallId,\n    );\n" +
      "    const previousChunk = chunkIndex === -1 ? undefined : entry.chunks[chunkIndex];\n" +
      "    const previousToolCall =\n" +
      "      previousChunk && previousChunk.type === 'tool_call' ? previousChunk.toolCall : undefined;\n" +
      "    const merged = reduceAcpToolCall(previousToolCall, event.update, { now: event.createdAt });\n" +
      "    const mergedChunk = { type: 'tool_call', toolCall: merged } as IAiThreadAssistantChunk;\n" +
      "    return chunkIndex === -1\n" +
      "      ? { ...entry, chunks: [...entry.chunks, mergedChunk] }\n" +
      "      : { ...entry, chunks: replaceAt(entry.chunks, chunkIndex, mergedChunk) };\n  };\n\n" +
      "  const index = thread.entries.findIndex(\n" +
      "    (entry) => entry.type === 'assistant_message' && entry.id === event.messageId,\n  );\n" +
      "  if (index === -1) {\n    const seeded = applyTo({\n      type: 'assistant_message',\n" +
      "      id: event.messageId,\n      createdAt: event.createdAt,\n      chunks: [],\n    });\n" +
      "    return { ...thread, entries: [...thread.entries, seeded] };\n  }\n\n" +
      "  const current = thread.entries[index] as IAiThreadAssistantMessageEntry;\n" +
      "  return { ...thread, entries: replaceAt(thread.entries, index, applyTo(current)) };\n}",
    replace:
      "/* ----- ACP tool_call upsert (top-level, interleaved by arrival) ----------- */\n" +
      "/**\n" +
      " * ACP tool_call / tool_call_update 归一为顶层 tool_call entry（对标 Zed upsert_tool_call）：\n" +
      " * 按 getAcpToolCallId 在 entries 中 upsert——首帧追加到末尾（落在真实发生位置），后续 update\n" +
      " * 经 reduceAcpToolCall 原地归并，绝不重复追加。与思考/正文的交错由「追加末尾 + Zed 段切分」得到。\n" +
      " */\n" +
      "function upsertAcpToolCall(\n  thread: IAiThread,\n" +
      "  event: TAiThreadReduceEventByKind<'acp_tool_call'>,\n): IAiThread {\n" +
      "  const toolCallId = getAcpToolCallId(event.update);\n" +
      "  if (toolCallId === '') {\n    return thread;\n  }\n\n" +
      "  const index = thread.entries.findIndex(\n" +
      "    (entry) => entry.type === 'tool_call' && entry.id === toolCallId,\n  );\n" +
      "  if (index === -1) {\n" +
      "    const created = reduceAcpToolCall(undefined, event.update, { now: event.createdAt });\n" +
      "    return { ...thread, entries: [...thread.entries, created] };\n  }\n\n" +
      "  const previous = thread.entries[index] as IAiThreadToolCall;\n" +
      "  const merged = reduceAcpToolCall(previous, event.update, { now: previous.createdAt });\n" +
      "  return { ...thread, entries: replaceAt(thread.entries, index, merged) };\n}",
  },
  // 5d reducer switch 改派发
  {
    sentinel: "    case 'acp_tool_call':\n      return upsertAcpToolCall(thread, event);",
    find: "    case 'assistant_tool_call':\n      return upsertAssistantToolCallChunk(thread, event);",
    replace: "    case 'acp_tool_call':\n      return upsertAcpToolCall(thread, event);",
  },
]);

// ── 6) legacy-adapter：entry 不再承载 acpToolCalls（正/逆投影各一处） ─────
patchFile('src/store/aiThread/legacy-adapter.ts', [
  {
    sentinel: "  if (assistantChunks.length > 0 || message.stream !== undefined) {",
    find:
      "  if (\n    assistantChunks.length > 0 ||\n    message.stream !== undefined ||\n" +
      "    (message.acpToolCalls?.length ?? 0) > 0\n  ) {\n" +
      "    const assistantEntry: IAiThreadAssistantMessageEntry = {\n      type: 'assistant_message',\n" +
      "      id: message.id,\n      createdAt: message.createdAt,\n      chunks: assistantChunks,\n" +
      "      ...(message.stream !== undefined ? { stream: message.stream } : {}),\n" +
      "      ...(message.acpToolCalls !== undefined ? { acpToolCalls: message.acpToolCalls } : {}),\n" +
      "      ...(message.patches && message.patches.length > 0 ? { patches: [...message.patches] } : {}),\n" +
      "    };",
    replace:
      "  if (assistantChunks.length > 0 || message.stream !== undefined) {\n" +
      "    const assistantEntry: IAiThreadAssistantMessageEntry = {\n      type: 'assistant_message',\n" +
      "      id: message.id,\n      createdAt: message.createdAt,\n      chunks: assistantChunks,\n" +
      "      ...(message.stream !== undefined ? { stream: message.stream } : {}),\n" +
      "      ...(message.patches && message.patches.length > 0 ? { patches: [...message.patches] } : {}),\n" +
      "    };",
  },
  {
    sentinel:
      "          ...(entry.stream !== undefined ? { stream: entry.stream } : {}),\n" +
      "          ...(entry.patches !== undefined ? { patches: entry.patches } : {}),",
    find:
      "          ...(entry.stream !== undefined ? { stream: entry.stream } : {}),\n" +
      "          ...(entry.acpToolCalls !== undefined ? { acpToolCalls: entry.acpToolCalls } : {}),\n" +
      "          ...(entry.patches !== undefined ? { patches: entry.patches } : {}),",
    replace:
      "          ...(entry.stream !== undefined ? { stream: entry.stream } : {}),\n" +
      "          ...(entry.patches !== undefined ? { patches: entry.patches } : {}),",
  },
]);

// ── 7) useAiAssistant：去 acpToolCalls 富集，stream/最终答案落到「最后一段」 ──
patchFile('src/composables/ai/useAiAssistant.ts', [
  // 7a 删未用 import（用与前一行的新相邻关系作 sentinel）
  {
    sentinel: "} from '@/components/business/ai/edit/patch-summary';\nimport {\n  buildAskUserResumeRequest,",
    find:
      "} from '@/components/business/ai/edit/patch-summary';\n" +
      "import { reduceAcpUiEventsToToolCalls } from '@/components/business/ai/thread/projection';\n" +
      "import {\n  buildAskUserResumeRequest,",
    replace:
      "} from '@/components/business/ai/edit/patch-summary';\n" +
      "import {\n  buildAskUserResumeRequest,",
  },
  // 7b 删 acpToolCalls 折叠计算
  {
    sentinel: "liveRenderState.patches.length > 0);\n    const finalContentRaw = liveRenderState.finalContent;",
    find:
      "    const hasPatches = Boolean(liveRenderState.patches && liveRenderState.patches.length > 0);\n" +
      "    // ACP tool_call / tool_call_update（reduce 层有意不覆盖）：用既有 ACP 累加器折叠为完整\n" +
      "    // IAiThreadToolCall[]，挂到本回合 assistant entry 的 acpToolCalls（schema 既有字段、legacy\n" +
      "    // 双向往返无损），交由 threadEntriesToTimeline 展开为工具卡。空数组则不写该字段。\n" +
      "    const acpToolCalls = reduceAcpUiEventsToToolCalls(events, {\n      now: new Date().toISOString(),\n    });\n" +
      "    const acpToolCallsPatch = acpToolCalls.length > 0 ? { acpToolCalls } : {};\n" +
      "    const finalContentRaw = liveRenderState.finalContent;",
    replace:
      "    const hasPatches = Boolean(liveRenderState.patches && liveRenderState.patches.length > 0);\n" +
      "    const finalContentRaw = liveRenderState.finalContent;",
  },
  // 7c 富集逻辑：定位本回合所有 assistant 段，只增益「最后一段」
  {
    sentinel: "    const turnSegmentIndices = liveThread.entries.flatMap(",
    find:
      "    let matchedAssistantEntry = false;\n" +
      "    const entries = liveThread.entries.map((entry) => {\n" +
      "      if (entry.type !== 'assistant_message' || entry.id !== assistantMessageId) {\n" +
      "        return entry;\n      }\n      matchedAssistantEntry = true;\n" +
      "      // 保留交织：本回合若已流式出 message 正文，则原样保留 chunks（thought/tool_call/message 真实交错，\n" +
      "      // 对标 Codex）；仅当无任何流式正文时，才丢 message 通道并以最终答案兜底（保留 thought 与 tool_call）。\n" +
      "      const hasStreamedMessageText = entry.chunks.some(\n" +
      "        (chunk) =>\n" +
      "          chunk.type === 'message' && chunk.block.type === 'text' && chunk.block.text.length > 0,\n      );\n" +
      "      const nextChunks: IAiThreadAssistantMessageEntry['chunks'] =\n" +
      "        finalText !== null && !hasStreamedMessageText\n          ? [\n" +
      "              ...entry.chunks.filter((chunk) => chunk.type !== 'message'),\n" +
      "              { type: 'message', block: { type: 'text', text: finalText } },\n            ]\n" +
      "          : entry.chunks;\n      return {\n        ...entry,\n        chunks: nextChunks,\n" +
      "        stream: liveRenderState.stream,\n" +
      "        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),\n" +
      "        ...acpToolCallsPatch,\n      };\n    });",
    replace:
      "    // 本回合的 assistant_message 段（Zed 多段：messageId / messageId#n）。stream/patches/最终答案\n" +
      "    // 兜底只增益「最后一段」（最终答复所在段），与顶层 tool_call entry 的单一表示互不干扰。\n" +
      "    const turnSegmentIndices = liveThread.entries.flatMap((entry, idx) =>\n" +
      "      entry.type === 'assistant_message' &&\n" +
      "      (entry.id === assistantMessageId || entry.id.startsWith(`${assistantMessageId}#`))\n" +
      "        ? [idx]\n        : [],\n    );\n" +
      "    const lastSegmentIndex = turnSegmentIndices.at(-1) ?? -1;\n" +
      "    const matchedAssistantEntry = lastSegmentIndex >= 0;\n" +
      "    // 本回合是否已流式出任意 message 正文（跨所有段）：是则保留已交错的 chunks，不再注入最终答案。\n" +
      "    const hasStreamedMessageText = turnSegmentIndices.some((idx) => {\n" +
      "      const segment = liveThread.entries[idx] as IAiThreadAssistantMessageEntry;\n" +
      "      return segment.chunks.some(\n" +
      "        (chunk) =>\n" +
      "          chunk.type === 'message' && chunk.block.type === 'text' && chunk.block.text.length > 0,\n      );\n    });\n" +
      "    const entries = liveThread.entries.map((entry, idx) => {\n" +
      "      if (entry.type !== 'assistant_message' || idx !== lastSegmentIndex) {\n" +
      "        return entry;\n      }\n" +
      "      const nextChunks: IAiThreadAssistantMessageEntry['chunks'] =\n" +
      "        finalText !== null && !hasStreamedMessageText\n" +
      "          ? [...entry.chunks, { type: 'message', block: { type: 'text', text: finalText } }]\n" +
      "          : entry.chunks;\n      return {\n        ...entry,\n        chunks: nextChunks,\n" +
      "        stream: liveRenderState.stream,\n" +
      "        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),\n      };\n    });",
  },
  // 7d 补建合成段去掉 acpToolCallsPatch
  {
    sentinel:
      "        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),\n      };\n      entries.push(appendedEntry);",
    find:
      "        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),\n" +
      "        ...acpToolCallsPatch,\n      };\n      entries.push(appendedEntry);",
    replace:
      "        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),\n      };\n      entries.push(appendedEntry);",
  },
]);

// ───────────────────────── codemod harness（粘到 2.mjs 最顶部）─────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 在单个文件内做幂等的精确替换。
 * - edits: Array<{ sentinel?, find, replace }>
 * - sentinel 命中（改后才存在的子串）⇒ 视为已应用，跳过（可重复运行）
 * - 否则要求 find 在文件内「恰好出现 1 次」，否则报错并指出是哪一处
 * - 自动适配文件的换行风格（LF / CRLF），保持 EOL 不变
 */
function patchFile(relPath, edits) {
  const abs = resolve(process.cwd(), relPath);
  const original = readFileSync(abs, 'utf8');
  const usesCRLF = original.includes('\r\n');
  const toEol = (s) => (usesCRLF ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));

  let content = original;
  let applied = 0;
  let skipped = 0;

  edits.forEach((edit, i) => {
    const sentinel = edit.sentinel != null ? toEol(edit.sentinel) : null;
    const find = toEol(edit.find);
    const replace = toEol(edit.replace);

    if (sentinel && content.includes(sentinel)) {
      skipped += 1;
      return;
    }
    const count = content.split(find).length - 1;
    if (count !== 1) {
      throw new Error(
        `[${relPath}] 第 ${i + 1} 处编辑：期望 find 命中 1 次，实际命中 ${count} 次。` +
          `（命中 0 多半是该文件已被改过/字节与预期不符；命中 >1 需要更长的 find 上下文）`,
      );
    }
    content = content.replace(find, replace);
    applied += 1;
  });

  if (content !== original) {
    writeFileSync(abs, content, 'utf8');
  }
  console.log(`✓ ${relPath} — applied ${applied}, skipped ${skipped}`);
}

/** 整文件覆盖写（目录不存在则递归创建）。本身幂等。 */
function writeNew(relPath, content) {
  const abs = resolve(process.cwd(), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  console.log(`✓ ${relPath} — written`);
}
// ──────────────────────────────── harness 结束 ────────────────────────────────