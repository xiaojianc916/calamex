// scripts/perf-f3-drop-hotpath-zod.mjs
// 用法：node scripts/perf-f3-drop-hotpath-zod.mjs
// 作用：把 eventBus.ts 里对每帧 terminal:data 的 Zod safeParse 换成 O(1) 手写窄化守卫。
//       低频控制事件的 Zod 保持不变。纯性能，无行为/UX 变化。
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/domains/terminal/services/eventBus.ts';
let src = readFileSync(FILE, 'utf8');

const OLD = `  const wireTerminalDataListener = (): Promise<UnlistenFn> =>
    listenFn<unknown>(TERMINAL_DATA_EVENT, ({ payload }) => {
      const parsed = terminalDataEventSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn(
          \`[terminal-event] \${TERMINAL_DATA_EVENT} payload 校验失败\`,
          z.treeifyError(parsed.error),
        );
        return;
      }
      emitToHandlers(terminalDataHandlers, parsed.data);
      accumulateAndAck(parsed.data);
    });`;

const NEW = `  // 热路径：terminal:data 是全应用最高频的事件，逐帧 Zod schema 遍历是纯开销且随
  // 输出速率线性增长。契约由 tauri-specta 生成类型保证，这里只做 O(1) 手写窄化守卫
  // （形状不对直接丢弃并告警），不做 schema 校验。低频控制事件仍走 Zod。
  const isTerminalDataEventShape = (value: unknown): value is ITerminalDataEvent => {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.sessionId === 'string' && typeof record.data === 'string';
  };

  const wireTerminalDataListener = (): Promise<UnlistenFn> =>
    listenFn<unknown>(TERMINAL_DATA_EVENT, ({ payload }) => {
      if (!isTerminalDataEventShape(payload)) {
        console.warn(\`[terminal-event] \${TERMINAL_DATA_EVENT} payload 形状非法，已丢弃\`);
        return;
      }
      emitToHandlers(terminalDataHandlers, payload);
      accumulateAndAck(payload);
    });`;

if (!src.includes(OLD)) {
  console.error('✗ 未匹配到目标片段：eventBus.ts 可能已改动，请人工核对后再运行。');
  process.exit(1);
}
src = src.replace(OLD, NEW);
writeFileSync(FILE, src, 'utf8');
console.log('✓ 已替换 terminal:data 热路径校验为 O(1) 守卫。请运行 tsc + vitest 验证。');