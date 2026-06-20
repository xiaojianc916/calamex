#!/usr/bin/env node
// 1.mjs — calamex: 流式 runtimeEvents + patches 往返 + 刷新持久化 修复 (forward-fix @ f633d60d)
// 行为:仅做精确锚点替换;任一锚点命中次数 != 1 则整体中止、不写盘。
import { readFileSync, writeFileSync } from 'node:fs';

function applyEdits(path, edits) {
  let content = readFileSync(path, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const fit = (s) => (eol === '\n' ? s : s.replaceAll('\n', eol));
  for (const [label, findLf, replaceLf] of edits) {
    const find = fit(findLf);
    const replace = fit(replaceLf);
    const count = content.split(find).length - 1;
    if (count !== 1) {
      throw new Error(
        `[${path}] 锚点「${label}」期望命中 1 次,实际 ${count} 次。文件可能已变更,已中止(未写盘)。`,
      );
    }
    content = content.replace(find, () => replace); // 函数式替换:避免 $ 被解释
  }
  writeFileSync(path, content);
  console.log(`✓ ${path}  (${edits.length} 处)`);
}

// ───────────────────────── 1) entry.schema.ts ─────────────────────────
applyEdits('src/types/ai/thread/entry.schema.ts', [
  [
    'import aiPatchSetSchema',
    `import { aiChatMessageStreamSnapshotSchema } from '@/types/ai/schema';`,
    `import { aiChatMessageStreamSnapshotSchema, aiPatchSetSchema } from '@/types/ai/schema';`,
  ],
  [
    'stream .catch',
    `  stream: aiChatMessageStreamSnapshotSchema.optional(),`,
    `  stream: aiChatMessageStreamSnapshotSchema.optional().catch(undefined),`,
  ],
  [
    'acpToolCalls .catch + patches',
    `  acpToolCalls: z.array(aiThreadToolCallSchema).optional(),`,
    `  acpToolCalls: z.array(aiThreadToolCallSchema).optional().catch(undefined),
  /**
   * 顶层 patches 往返(对标 legacy IAiChatMessage.patches):折叠 diff 卡 / 回滚反向 patch 依赖。
   * 复用 ai.schema 的 aiPatchSetSchema 单一真源,使 entries 在持久化与逆投影中无损还原。
   */
  patches: z.array(aiPatchSetSchema).optional(),`,
  ],
]);

// ───────────────────────── 2) legacy-adapter.ts ─────────────────────────
applyEdits('src/store/aiThread/legacy-adapter.ts', [
  [
    'legacyMessageToEntries 存 patches',
    `      ...(message.stream !== undefined ? { stream: message.stream } : {}),
      ...(message.acpToolCalls !== undefined ? { acpToolCalls: message.acpToolCalls } : {}),
    };`,
    `      ...(message.stream !== undefined ? { stream: message.stream } : {}),
      ...(message.acpToolCalls !== undefined ? { acpToolCalls: message.acpToolCalls } : {}),
      ...(message.patches && message.patches.length > 0 ? { patches: [...message.patches] } : {}),
    };`,
  ],
  [
    'threadEntriesToMessages 还原 patches',
    `          ...(entry.stream !== undefined ? { stream: entry.stream } : {}),
          ...(entry.acpToolCalls !== undefined ? { acpToolCalls: entry.acpToolCalls } : {}),
        };`,
    `          ...(entry.stream !== undefined ? { stream: entry.stream } : {}),
          ...(entry.acpToolCalls !== undefined ? { acpToolCalls: entry.acpToolCalls } : {}),
          ...(entry.patches !== undefined ? { patches: entry.patches } : {}),
        };`,
  ],
]);

// ───────────────────────── 3) useAiAssistant.ts ─────────────────────────
applyEdits('src/composables/ai/useAiAssistant.ts', [
  [
    'overlay 富集 stream/patches',
    `    aiThreadStore.overlayStreamingActiveThread(
      buildLiveThreadFromSidecarEvents(events, {
        baseThread: seedThread,
        assistantMessageId,
        now: new Date().toISOString(),
      }),
    );
  };`,
    `    const liveThread = buildLiveThreadFromSidecarEvents(events, {
      baseThread: seedThread,
      assistantMessageId,
      now: new Date().toISOString(),
    });
    // reduce 回放出的 assistant entry 不带 stream(runtimeEvents/token/活动文案),overlay 会以它
    // 覆盖掉 commit 写入的带 stream 版本,导致流式过程中 activeMessages 丢失 stream。用本回合消息
    // 缓冲里同 id 助手消息的 stream/patches 富集该 entry,保留富时间线又不丢流式快照。
    const bufferedAssistant = displayMessages.value.find(
      (message) => message.id === assistantMessageId,
    );
    const enrichedThread =
      bufferedAssistant && (bufferedAssistant.stream || bufferedAssistant.patches?.length)
        ? {
            ...liveThread,
            entries: liveThread.entries.map((entry) =>
              entry.type === 'assistant_message' && entry.id === assistantMessageId
                ? {
                    ...entry,
                    ...(bufferedAssistant.stream ? { stream: bufferedAssistant.stream } : {}),
                    ...(bufferedAssistant.patches && bufferedAssistant.patches.length > 0
                      ? { patches: [...bufferedAssistant.patches] }
                      : {}),
                  }
                : entry,
            ),
          }
        : liveThread;
    aiThreadStore.overlayStreamingActiveThread(enrichedThread);
  };`,
  ],
]);

console.log('\\n完成。请跑:pnpm typecheck && pnpm lint && pnpm test');