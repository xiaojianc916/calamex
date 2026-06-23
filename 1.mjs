// 2.mjs — Write 展开对齐 Edit 的 diff 样式 + 代码字体 Consolas
// 锚点幂等 codemod（沿用 1.mjs 约定）：命中必须唯一；已应用则跳过；保留原 EOL(LF/CRLF)。
import { readFileSync, writeFileSync } from 'node:fs';

let failed = false;

function patch(file, edits) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`✗ 读不到文件：${file} — ${e.message}`);
    failed = true;
    return;
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let text = raw.replace(/\r\n/g, '\n');

  for (const { name, find, replace, done } of edits) {
    if (text.includes(done)) {
      console.log(`· 跳过（已应用）：${file} → ${name}`);
      continue;
    }
    const hits = text.split(find).length - 1;
    if (hits !== 1) {
      console.error(`✗ 锚点命中 ${hits} 次（应为 1）：${file} → ${name}`);
      failed = true;
      continue;
    }
    text = text.replace(find, replace);
    console.log(`✓ 已改：${file} → ${name}`);
  }

  const out = eol === '\n' ? text : text.replace(/\n/g, '\r\n');
  if (out !== raw) writeFileSync(file, out, 'utf8');
}

/* ============================ 1) 投影层：合成 Write diff ============================ */

const TOOLCALL = 'src/components/business/ai/thread/projection/from-acp-tool-call.ts';

// 1a) 在「5) 公开 API」段前插入纯函数
const HELPER = [
  '/* ---------- 4.6) Write 工具 diff 合成（对齐 Edit，纯派生） --------------- */',
  '',
  '/**',
  ' * Kimi 的 ACP 适配器（acp-adapter/src/convert.ts displayBlockToAcpContent）只在',
  ' * file_io 同时带 before/after 时才发 diff；Write 的 display 为',
  " * { kind:'file_io', operation:'write', path, content }（agent-core write.ts），",
  ' * 只有整文件 content、无 before/after，故 diff 被丢弃、Write 展开无 diff。但工具',
  ' * 入参经 tool_call.rawInput(= event.args) 透传（events-map.ts',
  ' * toolCallStartToSessionUpdate），含 { path, content }。这里据此把 Write 合成为',
  " * 「全新增」diff（oldText=''），与 Edit 共用同一渲染管线，不改协议语义。",
  ' */',
  'interface IWriteFileInput {',
  '  path: string;',
  '  content: string;',
  '}',
  '',
  'const asWriteFileInput = (rawInput: unknown): IWriteFileInput | null => {',
  "  if (rawInput === null || typeof rawInput !== 'object') return null;",
  '  const view = rawInput as { path?: unknown; content?: unknown };',
  "  return typeof view.path === 'string' && view.path.length > 0 && typeof view.content === 'string'",
  '    ? { path: view.path, content: view.content }',
  '    : null;',
  '};',
  '',
  'const contentHasDiff = (content: readonly IAiThreadToolCallContent[]): boolean =>',
  "  content.some((item) => item.type === 'diff');",
  '',
  '/**',
  ' * kind=edit、内容尚无 diff、且 rawInput 形如 Write 入参时，前置一条「全新增」diff；',
  ' * 否则原样返回。幂等：已含 diff（Edit 原生 / 上一帧已合成）即跳过，避免多帧累加。',
  ' */',
  'const withSynthesizedWriteDiff = (',
  '  toolCallId: string,',
  '  kind: TAiThreadToolKind,',
  '  rawInput: unknown,',
  '  content: IAiThreadToolCallContent[],',
  '): IAiThreadToolCallContent[] => {',
  "  if (kind !== 'edit' || contentHasDiff(content)) return content;",
  '  const write = asWriteFileInput(rawInput);',
  '  if (write === null) return content;',
  '  const diffRef = `acp-write:${encodeURIComponent(toolCallId)}:${encodeURIComponent(write.path)}`;',
  "  const diff = buildDiffContent({ diffRef, filePath: write.path, oldText: '', newText: write.content });",
  '  return [diff, ...content];',
  '};',
  '',
  '',
].join('\n');

const SECTION5 =
  '/* ---------- 5) 公开 API -------------------------------------------------- */';

patch(TOOLCALL, [
  {
    name: '插入 withSynthesizedWriteDiff 纯函数',
    find: SECTION5,
    replace: HELPER + SECTION5,
    done: 'const withSynthesizedWriteDiff =',
  },
  {
    name: '首帧分支包裹 content',
    find: '      content: hasContent ? mapContent(view.content, id) : [],',
    replace: [
      '      content: withSynthesizedWriteDiff(',
      '        id,',
      '        mapKind(view.kind),',
      '        view.rawInput,',
      '        hasContent ? mapContent(view.content, id) : [],',
      '      ),',
    ].join('\n'),
    done: 'mapKind(view.kind),\n        view.rawInput,',
  },
  {
    name: '合并分支包裹 content',
    find: '    content: hasContent ? mapContent(view.content, id) : previous.content,',
    replace: [
      '    content: withSynthesizedWriteDiff(',
      '      id,',
      '      hasKind ? mapKind(view.kind) : previous.kind,',
      '      view.rawInput !== undefined ? view.rawInput : previous.rawInput,',
      '      hasContent ? mapContent(view.content, id) : previous.content,',
      '    ),',
    ].join('\n'),
    done: 'view.rawInput !== undefined ? view.rawInput : previous.rawInput,',
  },
]);

/* ============================ 2) 单测 ============================ */

const SPEC = 'src/components/business/ai/thread/projection/from-acp-tool-call.spec.ts';

const SPEC_BLOCK = [
  "describe('reduceAcpToolCall — Write 工具合成 diff（对齐 Edit）', () => {",
  "  it('kind=edit 且 rawInput={path,content} → 前置全新增 diff，原文本块保留其后', () => {",
  '    const entry = reduceAcpToolCall(',
  '      undefined,',
  '      toolCall({',
  "        toolCallId: 'w1',",
  "        title: 'Write a.txt',",
  "        kind: 'edit',",
  "        status: 'in_progress',",
  "        rawInput: { path: 'a.txt', content: 'l1\\nl2' },",
  "        content: [{ type: 'content', content: { type: 'text', text: 'args' } }],",
  '      }),',
  '      { now: NOW },',
  '    );',
  '    const diff = entry.content[0];',
  "    expect(diff?.type).toBe('diff');",
  "    if (diff?.type !== 'diff') return;",
  "    expect(diff.diff.filePath).toBe('a.txt');",
  '    expect(diff.diff.hunks[0]?.lines.map((line) => `${line.kind}:${line.content}`)).toEqual([',
  "      'add:l1',",
  "      'add:l2',",
  '    ]);',
  '    expect(entry.content[1]).toEqual({',
  "      type: 'content',",
  "      block: { type: 'text', text: 'args' },",
  '    });',
  '  });',
  '',
  "  it('Edit（已含原生 diff）不重复合成', () => {",
  '    const entry = reduceAcpToolCall(',
  '      undefined,',
  '      toolCall({',
  "        toolCallId: 'e1',",
  "        kind: 'edit',",
  "        rawInput: { path: 'a.txt', old_string: 'foo', new_string: 'bar' },",
  "        content: [{ type: 'diff', path: 'a.txt', oldText: 'foo', newText: 'bar' }],",
  '      }),',
  '      { now: NOW },',
  '    );',
  "    expect(entry.content.filter((c) => c.type === 'diff')).toHaveLength(1);",
  '  });',
  '',
  "  it('非编辑类 / rawInput 形状不符 → 不合成', () => {",
  '    const exec = reduceAcpToolCall(',
  '      undefined,',
  "      toolCall({ toolCallId: 'x', kind: 'execute', rawInput: { path: 'a', content: 'x' } }),",
  '      { now: NOW },',
  '    );',
  '    expect(exec.content).toEqual([]);',
  '    const bad = reduceAcpToolCall(',
  '      undefined,',
  "      toolCall({ toolCallId: 'y', kind: 'edit', rawInput: { path: 'a' } }),",
  '      { now: NOW },',
  '    );',
  '    expect(bad.content).toEqual([]);',
  '  });',
  '',
  "  it('多帧不累加重复 diff（result 替换内容、心跳帧保留旧值）', () => {",
  '    const started = reduceAcpToolCall(',
  '      undefined,',
  '      toolCall({',
  "        toolCallId: 'w2',",
  "        kind: 'edit',",
  "        status: 'in_progress',",
  "        rawInput: { path: 'a.txt', content: 'x' },",
  "        content: [{ type: 'content', content: { type: 'text', text: 'args' } }],",
  '      }),',
  '      { now: NOW },',
  '    );',
  "    expect(started.content.filter((c) => c.type === 'diff')).toHaveLength(1);",
  '    const done = reduceAcpToolCall(',
  '      started,',
  '      toolCallUpdate({',
  "        toolCallId: 'w2',",
  "        status: 'completed',",
  "        content: [{ type: 'content', content: { type: 'text', text: 'Wrote 1 bytes to a.txt' } }],",
  '      }),',
  '    );',
  "    expect(done.content.filter((c) => c.type === 'diff')).toHaveLength(1);",
  "    const beat = reduceAcpToolCall(done, toolCallUpdate({ toolCallId: 'w2', status: 'completed' }));",
  "    expect(beat.content.filter((c) => c.type === 'diff')).toHaveLength(1);",
  '  });',
  '});',
  '',
  '',
].join('\n');

patch(SPEC, [
  {
    name: '追加 Write diff 合成用例',
    find: "describe('getAcpToolCallId', () => {",
    replace: SPEC_BLOCK + "describe('getAcpToolCallId', () => {",
    done: 'Write 工具合成 diff（对齐 Edit）',
  },
]);

/* ============================ 3) 代码字体 Consolas ============================ */

const VUE = 'src/components/business/ai/thread/AiThreadToolCall.vue';

patch(VUE, [
  {
    name: '工具卡作用域内 --font-mono 设为 Consolas',
    find: [
      '.ai-thread-tool-call {',
      '  display: flex;',
      '  min-width: 0;',
      '  flex-direction: column;',
      '  background: transparent;',
      '}',
    ].join('\n'),
    replace: [
      '.ai-thread-tool-call {',
      '  display: flex;',
      '  min-width: 0;',
      '  flex-direction: column;',
      '  background: transparent;',
      '  /* 代码 / diff / 终端字体对齐 Consolas：经 CSS 变量级联到面板内子组件 */',
      "  --font-mono: Consolas, 'Cascadia Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;",
      '}',
    ].join('\n'),
    done: '--font-mono: Consolas',
  },
]);

if (failed) {
  console.error('\n❌ 有锚点未命中或文件缺失，未完成的改动请检查上方日志。');
  process.exit(1);
}
console.log('\n✅ 全部完成。请运行：pnpm lint && pnpm typecheck && pnpm test');