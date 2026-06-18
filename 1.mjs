#!/usr/bin/env node
// apply-optionc-batch4.mjs
// Option C 收尾(C4): 删除"运行输出捕获"遗留的死代码。
// 在仓库根目录运行:  node apply-optionc-batch4.mjs
//
// 先跑"残留消费者守卫"扫描整个 src/; 若仍有人引用将被移除的符号, 不写入任何文件直接退出。
// 守卫通过后才应用编辑并删除文件。CRLF 安全、逐文件全有或全无、可重复执行(已应用则跳过)。

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { sep } from 'node:path';

const edits = [
  // ---- src/types/terminal/index.ts ----
  {
    file: 'src/types/terminal/index.ts',
    find:
      'export interface ITerminalRunChunkPayload {\n' +
      '  sessionId: string;\n' +
      '  runId: string;\n' +
      '  data: string;\n' +
      '  seq?: number;\n' +
      '}\n\n',
    replace: '',
  },

  // ---- src/store/editor.ts ----
  {
    file: 'src/store/editor.ts',
    find: "import { createTerminalOutputBuffer } from '@/utils/terminal/terminal-output-buffer';\n",
    replace: '',
  },
  {
    file: 'src/store/editor.ts',
    find:
      'const MAX_TERMINAL_OUTPUT_LENGTH = 120_000;\n' +
      'const MAX_TERMINAL_OUTPUT_CHUNK_LENGTH = 4_096;\n',
    replace: '',
  },
  {
    file: 'src/store/editor.ts',
    find:
      '    const terminalOutputBuffer = createTerminalOutputBuffer({\n' +
      '      maxLength: MAX_TERMINAL_OUTPUT_LENGTH,\n' +
      '      maxChunkLength: MAX_TERMINAL_OUTPUT_CHUNK_LENGTH,\n' +
      '    });\n' +
      '    const terminalOutputLength = ref(0);\n' +
      '    const terminalOutputVersion = ref(0);\n',
    replace: '',
  },
  {
    file: 'src/store/editor.ts',
    find:
      '        runHistory.value.length > 0 ||\n' +
      '        terminalOutputLength.value > 0,\n',
    replace: '        runHistory.value.length > 0,\n',
  },
  {
    file: 'src/store/editor.ts',
    find:
      '    // Actions: terminal output\n\n' +
      '    const syncTerminalOutputMetadata = (): void => {\n' +
      '      terminalOutputLength.value = terminalOutputBuffer.length;\n' +
      '      terminalOutputVersion.value += 1;\n' +
      '    };\n\n' +
      '    const getTerminalOutputSnapshot = (): string => terminalOutputBuffer.toString();\n\n' +
      '    const setTerminalOutputChunks = (chunks: readonly string[]): void => {\n' +
      '      terminalOutputBuffer.replaceWithChunks(chunks);\n' +
      '      syncTerminalOutputMetadata();\n' +
      '    };\n\n' +
      '    const appendTerminalOutputChunk = (value: string): void => {\n' +
      '      if (!terminalOutputBuffer.append(value)) {\n' +
      '        return;\n' +
      '      }\n' +
      '      syncTerminalOutputMetadata();\n' +
      '    };\n\n' +
      '    const setTerminalOutput = (value: string): void => {\n' +
      '      terminalOutputBuffer.replaceWithText(value);\n' +
      '      syncTerminalOutputMetadata();\n' +
      '    };\n\n',
    replace: '',
  },
  {
    file: 'src/store/editor.ts',
    isRegex: true,
    find:
      ' {4}/\\*\\* [^\\n]*\\*/\\n' +
      ' {4}const appendTerminalOutput = \\(value: string\\): void => \\{\\n' +
      ' {6}appendTerminalOutputChunk\\(value\\);\\n' +
      ' {4}\\};\\n\\n',
    replace: '',
  },
  {
    file: 'src/store/editor.ts',
    find: '      setTerminalOutputChunks([]);\n',
    replace: '',
  },
  {
    file: 'src/store/editor.ts',
    find:
      '      terminalOutputLength,\n' +
      '      terminalOutputVersion,\n',
    replace: '',
  },
  {
    file: 'src/store/editor.ts',
    find: '      getTerminalOutputSnapshot,\n',
    replace: '',
  },
  {
    file: 'src/store/editor.ts',
    find:
      '      setTerminalOutput,\n' +
      '      appendTerminalOutput,\n',
    replace: '',
  },

  // ---- src/store/editor.store.spec.ts ----
  {
    file: 'src/store/editor.store.spec.ts',
    find:
      '    store.clearLogs();\n' +
      '    expect(store.hasRunArtifacts).toBe(false);\n\n' +
      "    store.setTerminalOutput('hello');\n" +
      '    expect(store.hasRunArtifacts).toBe(true);\n' +
      '  });\n',
    replace:
      '    store.clearLogs();\n' +
      '    expect(store.hasRunArtifacts).toBe(false);\n' +
      '  });\n',
  },
];

const deletes = [
  'src/utils/terminal/terminal-output-buffer.ts',
  'src/utils/terminal/terminal-output-buffer.spec.ts',
];

const guardIdentifiers = [
  'createTerminalOutputBuffer',
  'terminalOutputBuffer',
  'getTerminalOutputSnapshot',
  'setTerminalOutputChunks',
  'appendTerminalOutputChunk',
  'setTerminalOutput',
  'appendTerminalOutput',
  'terminalOutputLength',
  'terminalOutputVersion',
  'MAX_TERMINAL_OUTPUT_LENGTH',
  'MAX_TERMINAL_OUTPUT_CHUNK_LENGTH',
  'ITerminalRunChunkPayload',
  'terminal-output-buffer',
];

const norm = (p) => p.split('/').join(sep);
const guardExcluded = new Set(
  [
    'src/store/editor.ts',
    'src/store/editor.store.spec.ts',
    'src/types/terminal/index.ts',
    ...deletes,
  ].map(norm),
);

const walk = (dir, acc) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'target') continue;
    const full = dir + sep + name;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, acc);
    } else if (/\.(ts|tsx|vue|mts|cts|js|mjs)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
};

const runGuard = () => {
  const srcRoot = norm('src');
  if (!existsSync(srcRoot)) {
    console.error('[fail] 找不到 src/ 目录, 请在仓库根目录运行本脚本。');
    process.exit(1);
  }
  const files = walk(srcRoot, []);
  const violations = [];
  for (const f of files) {
    const rel = f.split(sep).join('/');
    if (guardExcluded.has(norm(rel))) continue;
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const id of guardIdentifiers) {
      if (text.includes(id)) {
        const lines = text.split(/\r?\n/);
        lines.forEach((ln, i) => {
          if (ln.includes(id)) violations.push(`${rel}:${i + 1}: ${id}  >>${ln.trim()}`);
        });
      }
    }
  }
  if (violations.length > 0) {
    console.error('[fail] 仍有文件引用将被移除的符号, 已中止 (未改动任何文件):');
    for (const v of violations) console.error('   ' + v);
    console.error('\n请先消除上述引用, 再运行本脚本。');
    process.exit(1);
  }
  console.log('[ok]   残留消费者守卫: 全仓 src/ 无残留引用。');
};

const countLiteral = (text, find) => text.split(find).length - 1;

const applyOne = (text, edit) => {
  if (edit.isRegex) {
    const re = new RegExp(edit.find, 'g');
    const m = text.match(re);
    const n = m ? m.length : 0;
    if (n === 0) return { text, status: 'skip' };
    return { text: text.replace(new RegExp(edit.find, 'g'), () => edit.replace), status: 'ok', n };
  }
  const n = countLiteral(text, edit.find);
  if (n === 1) return { text: text.split(edit.find).join(edit.replace), status: 'ok', n: 1 };
  if (n === 0) {
    if (edit.replace === '' || text.includes(edit.replace)) return { text, status: 'skip' };
    return { text, status: 'fail', n };
  }
  return { text, status: 'fail', n };
};

const groupByFile = (list) => {
  const map = new Map();
  for (const e of list) {
    if (!map.has(e.file)) map.set(e.file, []);
    map.get(e.file).push(e);
  }
  return map;
};

const applyEdits = () => {
  let hadFailure = false;
  for (const [file, fileEdits] of groupByFile(edits)) {
    const path = norm(file);
    if (!existsSync(path)) {
      console.error(`[fail] ${file}  文件不存在`);
      hadFailure = true;
      continue;
    }
    const raw = readFileSync(path, 'utf8');
    const isCRLF = /\r\n/.test(raw);
    let text = isCRLF ? raw.replace(/\r\n/g, '\n') : raw;
    let applied = 0, skipped = 0, failed = 0;
    for (const e of fileEdits) {
      const r = applyOne(text, e);
      if (r.status === 'ok') { text = r.text; applied += 1; }
      else if (r.status === 'skip') { skipped += 1; }
      else { failed += 1; console.error(`[fail] ${file}  某处编辑匹配数异常 (期望 1, 实际 ${r.n})`); }
    }
    if (failed > 0) { console.error(`[fail] ${file}  存在匹配异常, 未写入该文件。`); hadFailure = true; continue; }
    if (applied === 0) { console.log(`[skip] ${file}(已是目标状态, 未写入)`); continue; }
    const out = isCRLF ? text.replace(/\n/g, '\r\n') : text;
    writeFileSync(path, out, 'utf8');
    console.log(`[ok]   ${file}  应用 ${applied} / 跳过 ${skipped}`);
  }
  return !hadFailure;
};

const applyDeletes = () => {
  for (const file of deletes) {
    const path = norm(file);
    if (existsSync(path)) { rmSync(path); console.log(`[del]  ${file}  已删除`); }
    else { console.log(`[skip] ${file}(不存在, 视为已删除)`); }
  }
};

runGuard();
const editsOk = applyEdits();
if (!editsOk) {
  console.error('\n[fail] 编辑阶段存在失败项, 删除阶段已跳过。请回贴上面的 [fail] 行。');
  process.exit(1);
}
applyDeletes();
console.log('\nBatch C4 完成。请运行校验: pnpm vue-tsc --noEmit && pnpm vitest run');
