#!/usr/bin/env node
// scripts/acp-slice-3.mjs — Slice 3 加固增量(对照 main 18a44b34)。
// 全有或全无;--check 干跑。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHECK_ONLY = process.argv.includes('--check');
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
const countOccurrences = (hay, needle) => {
  let n = 0;
  let i = 0;
  for (;;) {
    const idx = hay.indexOf(needle, i);
    if (idx === -1) break;
    n += 1;
    i = idx + needle.length;
  }
  return n;
};

const FILES = [
  {
    file: 'src/types/ai/schema.ts',
    edits: [
      {
        find: `  model: z.string().min(1),
  /**
   * ACP 会话标识。chat 模式走 ACP host 时由后端 \`chat_stream_via_acp\` 回填,
   * 前端据此订阅 \`ai:sidecar-stream\` 上属于本轮的投影事件。legacy 路径不设置,
   * 故为 \`.optional()\`,保持对旧后端的向后兼容。
   */
  sessionId: z.string().min(1).optional(),`,
        replace: `  model: z.string().min(1),
  /**
   * ACP 会话标识。chat 模式走 ACP host 时由后端 \`chat_stream_via_acp\` 回填,
   * 前端据此订阅 \`ai:sidecar-stream\` 上属于本轮的投影事件。legacy 路径不设置,
   * 故为 \`.nullable().optional()\`:对齐生成绑定的 \`Option<String>\` → \`string | null\`,
   * 同时兼容旧后端不回填的情况。
   */
  sessionId: z.string().min(1).nullable().optional(),`,
      },
    ],
  },
  {
    file: 'src/composables/ai/sidecar-stream-listener.ts',
    edits: [
      {
        find: `    onEvent(payload.event);
  });`,
        replace: `    onEvent(payload.event);
  });

/**
 * 在已知 sessionId 之前就订阅 sidecar 流:先缓冲全部帧,bind(sessionId) 后回放匹配帧
 * 并继续转发后续匹配帧。消除「先 await chatStream → 再订阅」之间的丢帧窗口(零竞态)。
 */
export interface IBufferedSidecarSessionStream {
  bind(sessionId: string): void;
  dispose(): void;
}

export const subscribeSidecarStreamWithPrebuffer = async (
  onEvent: (event: TAgentUiEvent) => void,
): Promise<IBufferedSidecarSessionStream> => {
  const buffered: Array<{ sessionId: string; event: TAgentUiEvent }> = [];
  let boundSessionId: string | null = null;

  const unlisten = await aiService.onSidecarStream((payload) => {
    if (boundSessionId === null) {
      buffered.push({ sessionId: payload.sessionId, event: payload.event });
      return;
    }

    if (payload.sessionId !== boundSessionId) {
      return;
    }

    onEvent(payload.event);
  });

  return {
    bind(sessionId: string): void {
      if (boundSessionId !== null) {
        return;
      }

      boundSessionId = sessionId;

      for (const frame of buffered.splice(0)) {
        if (frame.sessionId === sessionId) {
          onEvent(frame.event);
        }
      }
    },
    dispose(): void {
      buffered.length = 0;
      unlisten();
    },
  };
};`,
      },
    ],
  },
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    edits: [
      {
        find: `import { subscribeSidecarSessionStream } from '@/composables/ai/sidecar-stream-listener';`,
        replace: `import {
  subscribeSidecarSessionStream,
  subscribeSidecarStreamWithPrebuffer,
} from '@/composables/ai/sidecar-stream-listener';`,
      },
      {
        find: `    let unlistenSidecarStream: (() => void) | null = null;

    try {
      const stream = await aiService.chatStream({
        threadId,
        messages: requestMessages,
        references,
      });

      activeStreamId.value = stream.streamId;

      const sessionId = stream.sessionId;

      if (!sessionId) {
        throw new Error('AI 流式响应缺少 sessionId,无法订阅 ACP 流。');
      }

      unlistenSidecarStream = await subscribeSidecarSessionStream(sessionId, (event) => {
        liveEventBuffer.push(event);
      });`,
        replace: `    const sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {
      liveEventBuffer.push(event);
    });

    try {
      const stream = await aiService.chatStream({
        threadId,
        messages: requestMessages,
        references,
      });

      activeStreamId.value = stream.streamId;

      const sessionId = stream.sessionId;

      if (!sessionId) {
        throw new Error('AI 流式响应缺少 sessionId,无法订阅 ACP 流。');
      }

      sidecarStream.bind(sessionId);`,
      },
      {
        find: `      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeStreamResolve.value = null;`,
        replace: `      liveEventBuffer.dispose();
      sidecarStream.dispose();
      activeStreamResolve.value = null;`,
      },
    ],
  },
];

const root = process.cwd();
const failures = [];
const plans = [];

for (const entry of FILES) {
  const abs = resolve(root, entry.file);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    failures.push(`${entry.file}: 无法读取 (${err.message})`);
    continue;
  }
  const usedCrlf = raw.includes('\r\n');
  let content = normalizeEol(raw);

  for (let i = 0; i < entry.edits.length; i += 1) {
    const edit = entry.edits[i];
    const find = normalizeEol(edit.find);
    const expected = edit.count ?? 1;
    const actual = countOccurrences(content, find);
    if (actual !== expected) {
      const firstLine = (find.split('\n').find((l) => l.trim() !== '') ?? '').trim();
      const lineHits = content.split('\n').filter((l) => l.includes(firstLine)).length;
      failures.push(
        `${entry.file} edit#${i + 1}: 期望 ${expected} 处, 实际 ${actual} 处。` +
          ` 首行【${firstLine}】出现 ${lineHits} 次` +
          `${lineHits > 0 ? '(空白/邻近文本漂移)' : '(该段不在文件中)'}。`,
      );
      continue;
    }
    content = content.split(find).join(normalizeEol(edit.replace));
  }
  plans.push({ abs, file: entry.file, output: usedCrlf ? content.replace(/\n/g, '\r\n') : content });
}

if (failures.length > 0) {
  for (const f of failures) console.error(`✗ ${f}`);
  console.error('\n✗ 未写入任何文件。');
  process.exit(1);
}
if (CHECK_ONLY) {
  for (const p of plans) console.log(`✓ ${p.file}: 锚点全通过(干跑)。`);
  console.log('\n✓ --check 通过,去掉 --check 即应用。');
  process.exit(0);
}
for (const p of plans) {
  writeFileSync(p.abs, p.output, 'utf8');
  console.log(`✓ 已写入 ${p.file}`);
}
console.log('\n✓ Slice 3 加固应用完成。');