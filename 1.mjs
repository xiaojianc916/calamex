import { readFileSync, writeFileSync } from 'node:fs';

const edits = [
  {
    file: 'src/store/aiThread/legacy-adapter.ts',
    replacements: [
      {
        find: `    if (pendingToolCalls.length === 0) {
      return;
    }
    messages.push({
      role: 'assistant',
      id: pendingToolCalls[0]!.id + ':assistant',
      content: '',
      createdAt: pendingToolCreatedAt ?? new Date().toISOString(),
      references: [],
      toolCalls: pendingToolCalls,
    });
    pendingToolCalls = [];
    pendingToolCreatedAt = null;
  };`,
        to: `    if (pendingToolCalls.length === 0) {
      return;
    }
    // 实时流式先建 assistant_message（正文增量）再来 tool_call entry，使工具排在 assistant 之后。
    // 此时把尾随工具并入紧邻的、尚无 toolCalls 的前一条 assistant（对齐旧模型「一条 assistant 持有本回合工具」），
    // 否则才另起一条合成 assistant。
    const lastMessage = messages.at(-1);
    if (lastMessage && lastMessage.role === 'assistant' && lastMessage.toolCalls === undefined) {
      lastMessage.toolCalls = pendingToolCalls;
      pendingToolCalls = [];
      pendingToolCreatedAt = null;
      return;
    }
    messages.push({
      role: 'assistant',
      id: pendingToolCalls[0]!.id + ':assistant',
      content: '',
      createdAt: pendingToolCreatedAt ?? new Date().toISOString(),
      references: [],
      toolCalls: pendingToolCalls,
    });
    pendingToolCalls = [];
    pendingToolCreatedAt = null;
  };`,
      },
    ],
  },
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    replacements: [
      {
        find: `    // 收尾注入的最终回答正文（live 帧不传）：reduce 无 delta 时也把最终答案落进权威 entries。
    finalContent?: string;
  }`,
        to: `    // 收尾注入的最终回答正文（live 帧不传）：reduce 无 delta 时也把最终答案落进权威 entries。
    finalContent?: string;
    // 收尾注入的内联 diff 汇总：作为 changed_files entry 落库，逆投影回挂到该 assistant。
    changedFilesSummary?: IAiAgentPatchSummary | null;
  }`,
      },
      {
        find: `    if (!matchedAssistantEntry && finalText !== null) {
      const appendedEntry: IAiThreadEntry = {
        type: 'assistant_message',
        id: assistantMessageId,
        createdAt: new Date().toISOString(),
        chunks: [{ type: 'message', block: { type: 'text', text: finalText } }],
        stream: liveRenderState.stream,
        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),
      };
      entries.push(appendedEntry);
    }
    const enrichedThread = {`,
        to: `    if (!matchedAssistantEntry) {
      // reduce 未建 assistant entry（无 delta / 纯工具或 patch 帧）时也补一条，保证 stream/token/patches/正文落地；
      // 无最终正文则用空 chunks 占位（流式中的工具/patch 帧据此挂载），逆投影把尾随工具并入本条。
      const appendedEntry: IAiThreadEntry = {
        type: 'assistant_message',
        id: assistantMessageId,
        createdAt: new Date().toISOString(),
        chunks:
          finalText !== null
            ? [{ type: 'message', block: { type: 'text', text: finalText } }]
            : [],
        stream: liveRenderState.stream,
        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),
      };
      entries.push(appendedEntry);
    }
    // 内联 diff 汇总作为 changed_files entry 落库；逆投影把它回挂到最近一条 assistant 消息。
    const liveChangedFilesSummary = liveRenderState.changedFilesSummary;
    if (liveChangedFilesSummary) {
      const changedFilesEntry: IAiThreadEntry = {
        type: 'changed_files',
        id: liveChangedFilesSummary.id,
        createdAt: liveChangedFilesSummary.appliedAt ?? new Date().toISOString(),
        summary: liveChangedFilesSummary,
      };
      entries.push(changedFilesEntry);
    }
    const enrichedThread = {`,
      },
      {
        find: `      // 最终回答正文经收尾注入落进权威 entries（唯一真源）。
      finalContent: projection.assistantContent,
    });`,
        to: `      // 最终回答正文经收尾注入落进权威 entries（唯一真源）。
      finalContent: projection.assistantContent,
      changedFilesSummary: patchState?.changedFilesSummary ?? undefined,
    });`,
      },
      {
        find: `      ...(runtimeEvents.length ? { runtimeEvents } : {}),
      ...(tokenSnapshot ? { usage: tokenSnapshot } : {}),
    };

    return { stream, patches: livePatchState?.patches };`,
        to: `      ...(runtimeEvents.length ? { runtimeEvents } : {}),
      // token 用量：usage VM 之外同时补齐顶层扁平字段，供消费侧两种读法都命中（与收尾 finalStream 对齐）。
      ...(tokenSnapshot
        ? {
            usage: tokenSnapshot,
            inputTokens: tokenSnapshot.inputTokens,
            outputTokens: tokenSnapshot.outputTokens,
            totalTokens: tokenSnapshot.totalTokens,
          }
        : {}),
    };

    return { stream, patches: livePatchState?.patches };`,
      },
    ],
  },
];

let ok = true;
const plans = [];
for (const { file, replacements } of edits) {
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  for (const { find, to } of replacements) {
    const n = text.split(find).length - 1;
    if (n !== 1) {
      console.error(`✗ ${file}: 锚点命中 ${n} 次（应为 1）\n--- 锚点头 ---\n${find.slice(0, 100)}`);
      ok = false;
      continue;
    }
    text = text.replace(find, to);
  }
  plans.push({ file, crlf, text });
}

if (!ok) {
  console.error('有锚点未命中，全部中止，未写入任何文件。');
  process.exit(1);
}

if (process.argv.includes('--apply')) {
  for (const { file, crlf, text } of plans) {
    writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text);
    console.log(`✓ 已写入 ${file}`);
  }
} else {
  console.log('✓ 干跑通过：全部锚点各命中 1 次。加 --apply 写入。');
}