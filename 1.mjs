// b1-tool-name.mjs —— Step B1（dry-run 默认；--apply 落盘；无 .bak；全或全不；CRLF/LF 无关）
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

const EDITS = [
  // (1) events.ts：tool_started reduce 事件变体加 name?
  {
    file: 'src/store/aiThread/events.ts',
    find: `      kind: 'tool_started';
      id: string;
      createdAt: string;
      title: string;
      toolKind: TAiThreadToolKind;
      status?: 'pending' | 'in_progress';`,
    replace: `      kind: 'tool_started';
      id: string;
      createdAt: string;
      title: string;
      /** 工具原始名（raw toolName）：渲染层 name 用它，区别于语义化展示 title。 */
      name?: string;
      toolKind: TAiThreadToolKind;
      status?: 'pending' | 'in_progress';`,
  },
  // (2) from-sidecar-events.ts：agent.tool.started 贯通原始 toolName 为 name
  {
    file: 'src/components/business/ai/thread/projection/from-sidecar-events.ts',
    find: `          title: describeToolAction(event, event.toolName).action,
          toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(event.toolName)],`,
    replace: `          title: describeToolAction(event, event.toolName).action,
          // 工具原始名（raw toolName）原样贯通到 reduce；渲染层 name 用它而非语义化 title。
          ...(event.toolName ? { name: event.toolName } : {}),
          toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(event.toolName)],`,
  },
  // (3) reduce.ts：upsertToolCall 建条目分支带上 name
  {
    file: 'src/store/aiThread/reduce.ts',
    find: `      type: 'tool_call',
      id: event.id,
      createdAt: event.createdAt,
      title: event.title,
      kind: event.toolKind,
      status: event.status ?? 'in_progress',
      content: [],`,
    replace: `      type: 'tool_call',
      id: event.id,
      createdAt: event.createdAt,
      title: event.title,
      ...(event.name !== undefined ? { name: event.name } : {}),
      kind: event.toolKind,
      status: event.status ?? 'in_progress',
      content: [],`,
  },
  // (4) reduce.ts：applyToolEvent 的 tool_started 分支保留 / 刷新 name
  {
    file: 'src/store/aiThread/reduce.ts',
    find: `    case 'tool_started':
      return {
        ...current,
        title: event.title || current.title,
        kind: event.toolKind ?? current.kind,
        status: nextToolStatus(current.status, event.status ?? 'in_progress'),
      };`,
    replace: `    case 'tool_started':
      return {
        ...current,
        title: event.title || current.title,
        name: event.name ?? current.name,
        kind: event.toolKind ?? current.kind,
        status: nextToolStatus(current.status, event.status ?? 'in_progress'),
      };`,
  },
];

// 行尾无关：读入归一为 \n 匹配；写回按各文件原始 EOL 还原。全部命中 1 次才落盘。
const cache = new Map();
const load = (f) => {
  if (!cache.has(f)) {
    const raw = readFileSync(f, 'utf8');
    cache.set(f, { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n') });
  }
  return cache.get(f);
};
let ok = true;
for (const [i, e] of EDITS.entries()) {
  const n = load(e.file).text.split(e.find).length - 1;
  if (n !== 1) {
    console.error(`✗ 第 ${i + 1} 处（${e.file}）锚点命中 ${n} 次（应为 1）`);
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
for (const e of EDITS) {
  const o = cache.get(e.file);
  o.text = o.text.replace(e.find, e.replace);
}
for (const [f, o] of cache) {
  writeFileSync(f, o.crlf ? o.text.replace(/\n/g, '\r\n') : o.text);
}
console.log('✓ 已写 events.ts / from-sidecar-events.ts / reduce.ts（共 4 处，保留各文件原 EOL）。请跑 vitest + typecheck。');