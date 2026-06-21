// b2-final-content-and-tokens.mjs —— Step B2（dry-run 默认；--apply 落盘；无 .bak；全或全不；CRLF/LF 无关）
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const FILE = 'src/composables/ai/useAiAssistant.ts';

const EDITS = [
  // (1) 引入 entries 类型（按字母序插在 @/types/ai/sidecar 与 @/types/editor 之间）
  {
    find: `} from '@/types/ai/sidecar';
import type {
  IActiveRunSummary,`,
    replace: `} from '@/types/ai/sidecar';
import type { IAiThreadAssistantMessageEntry, IAiThreadEntry } from '@/types/ai/thread';
import type {
  IActiveRunSummary,`,
  },
  // (2) ISidecarLiveRenderState 增加可选 finalContent
  {
    find: `  interface ISidecarLiveRenderState {
    stream: NonNullable<IAiChatMessage['stream']>;
    patches: IAiChatMessage['patches'];
  }`,
    replace: `  interface ISidecarLiveRenderState {
    stream: NonNullable<IAiChatMessage['stream']>;
    patches: IAiChatMessage['patches'];
    // 收尾注入的最终回答正文（live 帧不传）：reduce 无 delta 时也把最终答案落进权威 entries。
    finalContent?: string;
  }`,
  },
  // (3) enrich：注入最终正文 + 缺失时补建 assistant entry
  {
    find: `    const hasPatches = Boolean(liveRenderState.patches && liveRenderState.patches.length > 0);
    const enrichedThread = {
      ...liveThread,
      entries: liveThread.entries.map((entry) =>
        entry.type === 'assistant_message' && entry.id === assistantMessageId
          ? {
              ...entry,
              stream: liveRenderState.stream,
              ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),
            }
          : entry,
      ),
    };
    aiThreadStore.overlayStreamingActiveThread(enrichedThread);`,
    replace: `    const hasPatches = Boolean(liveRenderState.patches && liveRenderState.patches.length > 0);
    const finalContentRaw = liveRenderState.finalContent;
    const finalText =
      typeof finalContentRaw === 'string' && finalContentRaw.length > 0 ? finalContentRaw : null;
    let matchedAssistantEntry = false;
    const entries = liveThread.entries.map((entry) => {
      if (entry.type !== 'assistant_message' || entry.id !== assistantMessageId) {
        return entry;
      }
      matchedAssistantEntry = true;
      // 收尾注入最终正文：丢弃 message 通道增量 chunk（保留 thought），以最终答案为唯一正文，
      // 杜绝「无 delta -> 正文为空」与「半截增量」。live 帧 finalText 为 null，chunks 原样。
      const nextChunks: IAiThreadAssistantMessageEntry['chunks'] =
        finalText !== null
          ? [
              ...entry.chunks.filter((chunk) => chunk.type === 'thought'),
              { type: 'message', block: { type: 'text', text: finalText } },
            ]
          : entry.chunks;
      return {
        ...entry,
        chunks: nextChunks,
        stream: liveRenderState.stream,
        ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),
      };
    });
    // reduce 因本回合无 assistant delta/block 而未建 assistant entry 时（直接给最终答案、
    // 或仅 done 带正文），收尾按 assistantMessageId 补建一条，保证最终正文/stream/token 落地。
    if (!matchedAssistantEntry && finalText !== null) {
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
    const enrichedThread = {
      ...liveThread,
      entries,
    };
    aiThreadStore.overlayStreamingActiveThread(enrichedThread);`,
  },
  // (4) finalStream 补顶层 token 扁平字段 + 收尾把 finalContent 传给注入
  {
    find: `      ...(streamMetadata.streamTokenSnapshot ? { usage: streamMetadata.streamTokenSnapshot } : {}),
    };
    updateLiveThreadFromSidecarEvents(ctx.assistantMessageId, ctx.threadId, payload.events, {
      stream: finalStream,
      patches: patchState?.patches,
    });`,
    replace: `      // token 用量：除 usage VM 外，同时补齐顶层扁平字段，供消费侧两种读法都命中。
      ...(streamMetadata.streamTokenSnapshot
        ? {
            usage: streamMetadata.streamTokenSnapshot,
            inputTokens: streamMetadata.streamTokenSnapshot.inputTokens,
            outputTokens: streamMetadata.streamTokenSnapshot.outputTokens,
            totalTokens: streamMetadata.streamTokenSnapshot.totalTokens,
          }
        : {}),
    };
    updateLiveThreadFromSidecarEvents(ctx.assistantMessageId, ctx.threadId, payload.events, {
      stream: finalStream,
      patches: patchState?.patches,
      // 最终回答正文经收尾注入落进权威 entries（唯一真源）。
      finalContent: projection.content,
    });`,
  },
];

const raw = readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');

let ok = true;
for (const [i, e] of EDITS.entries()) {
  const n = text.split(e.find).length - 1;
  if (n !== 1) {
    console.error(`✗ 第 ${i + 1} 处锚点命中 ${n} 次（应为 1）`);
    ok = false;
  }
}
if (!ok) {
  console.error('—— 中止，未写任何文件。');
  process.exit(1);
}
if (!APPLY) {
  console.log('✓ 干跑通过（CRLF/LF 已归一）：4 处锚点各命中 1 次。加 --apply 落盘。');
  process.exit(0);
}
for (const e of EDITS) text = text.replace(e.find, e.replace);
writeFileSync(FILE, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log('✓ 已写 useAiAssistant.ts（4 处，保留原 EOL）。请跑 vitest + typecheck。');