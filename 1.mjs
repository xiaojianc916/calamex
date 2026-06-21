#!/usr/bin/env node
/**
 * optimize-calamex.mjs  (v3：修复重复插入 + F1/F3/F4/F5，可重复运行)
 *
 * 相比 v2 的关键修复：
 *   - 自愈：开头折叠历史误操作产生的重复 terminalLogger / consola import 块。
 *   - 幂等：插入类改动以「目标声明是否已存在」为标记，而非脆弱的锚点子串判断。
 *
 * 用法（仓库根目录）：
 *   node optimize-calamex.mjs --dry-run
 *   node optimize-calamex.mjs
 *   node optimize-calamex.mjs --revert
 * 改后请跑：pnpm lint && pnpm typecheck && pnpm test
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const REVERT = process.argv.includes('--revert');
const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const L = (...l) => l.join('\n');
const log = [];
const tally = { fixed: 0, applied: 0, skipped: 0, missing: 0 };

function replaceOnce(content, rawFrom, rawTo, label) {
  const [from, to] = REVERT ? [rawTo, rawFrom] : [rawFrom, rawTo];
  if (content.includes(to) && !content.includes(from)) {
    log.push(`  · 跳过(已是目标态) ${label}`);
    tally.skipped++;
    return content;
  }
  if (content.includes(from)) {
    log.push(`  ✔ 应用 ${label}`);
    tally.applied++;
    return content.replace(from, to);
  }
  log.push(`  ✗ 未匹配 ${label}`);
  tally.missing++;
  return content;
}

async function commit(abs, orig, c) {
  if (c === orig) {
    log.push('  = 文件无变化');
    return;
  }
  if (DRY_RUN) {
    log.push('  ~ dry-run：未写入');
    return;
  }
  await writeFile(abs, c, 'utf8');
  log.push('  💾 已写入');
}

// ---- F5：session.ts 去掉自建字面量上的无谓 as 断言 ----
const F5_FROM = L(
  '    return {',
  '      sessionId: this.id,',
  '      runId,',
  '      exitCode,',
  '      finishedAt: new Date().toISOString(),',
  '    } as ITerminalRunCompletedPayload;',
);
const F5_TO = L(
  '    return {',
  '      sessionId: this.id,',
  '      runId,',
  '      exitCode,',
  '      finishedAt: new Date().toISOString(),',
  '    };',
);

// ---- F4：tauri.git.ts 度量区整段（行为完全等价）----
const GIT_MEASURE_FROM = L(
  'const textByteLength = (value: unknown): number => {',
  "  if (typeof value !== 'string' || value.length === 0) return 0;",
  "  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value).length : value.length;",
  '};',
  '',
  'const shallowStringBytes = (value: unknown): number => {',
  "  if (!value || typeof value !== 'object') return textByteLength(value);",
  '  let total = 0;',
  '  for (const fieldValue of Object.values(value as Record<string, unknown>)) {',
  "    if (typeof fieldValue === 'string') {",
  '      total += textByteLength(fieldValue);',
  "    } else if (typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {",
  '      total += 8;',
  '    }',
  '  }',
  '  return total;',
  '};',
  '',
  '// NOTE: 浅层字段遍历度量替代 JSON.stringify，避免对大 payload 的序列化开销。',
  'const measureGitCommitDetailOutput = (output: unknown) => {',
  "  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);",
  '',
  '  const payload = output as {',
  '    files?: Array<Record<string, unknown>>;',
  '    body?: string;',
  '    summary?: string;',
  '    authorName?: string;',
  '    authorEmail?: string;',
  '    authoredAt?: string;',
  '    id?: string;',
  '    shortId?: string;',
  '  };',
  '',
  '  const baseBytes =',
  '    textByteLength(payload.id) +',
  '    textByteLength(payload.shortId) +',
  '    textByteLength(payload.summary) +',
  '    textByteLength(payload.body) +',
  '    textByteLength(payload.authorName) +',
  '    textByteLength(payload.authorEmail) +',
  '    textByteLength(payload.authoredAt);',
  '',
  '  const filesBytes = Array.isArray(payload.files)',
  '    ? payload.files.reduce((total, file) => total + shallowStringBytes(file) + 24, 0)',
  '    : 0;',
  '',
  '  return { bytes: baseBytes + filesBytes + 96 };',
  '};',
  '',
  'const measureGitDiffPayloadOutput = (output: unknown) => {',
  "  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);",
  '',
  '  const payload = output as {',
  '    originalContent?: string;',
  '    modifiedContent?: string;',
  '    relativePath?: string;',
  '    fileName?: string;',
  '    title?: string;',
  '    mode?: string;',
  '    id?: string;',
  '    repositoryRootPath?: string;',
  '    path?: string;',
  '    hunks?: Array<{',
  '      lines?: Array<{',
  '        content?: string;',
  '        tag?: string;',
  '        oldLine?: number | null;',
  '        newLine?: number | null;',
  '      }>;',
  '    }>;',
  '  };',
  '',
  '  let bytes =',
  '    textByteLength(payload.id) +',
  '    textByteLength(payload.repositoryRootPath) +',
  '    textByteLength(payload.path) +',
  '    textByteLength(payload.relativePath) +',
  '    textByteLength(payload.fileName) +',
  '    textByteLength(payload.title) +',
  '    textByteLength(payload.mode) +',
  '    textByteLength(payload.originalContent) +',
  '    textByteLength(payload.modifiedContent) +',
  '    96;',
  '',
  '  if (Array.isArray(payload.hunks)) {',
  '    for (const hunk of payload.hunks) {',
  '      bytes += 32;',
  '      if (!Array.isArray(hunk.lines)) continue;',
  '      for (const line of hunk.lines) {',
  '        bytes += textByteLength(line.content) + textByteLength(line.tag) + 16;',
  '      }',
  '    }',
  '  }',
  '',
  '  return { bytes };',
  '};',
  '',
  '/**',
  ' * git log（提交历史）出参的浅层字节度量。与 measureGitCommitDetailOutput /',
  ' * measureGitDiffPayloadOutput 同口径：只累加已知标量字段与 parentIds/refs 的字节，',
  ' * 避免对整份提交列表做一次纯统计用途的 JSON.stringify。导出以便单测覆盖。',
  ' */',
  'export const measureGitCommitHistoryOutput = (output: unknown) => {',
  "  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);",
  '',
  '  const payload = output as {',
  '    entries?: Array<{',
  '      id?: string;',
  '      shortId?: string;',
  '      summary?: string;',
  '      authorName?: string;',
  '      authorEmail?: string;',
  '      authoredAt?: string;',
  '      parentIds?: string[];',
  '      refs?: Array<Record<string, unknown>>;',
  '    }>;',
  '  };',
  '',
  '  const entriesBytes = Array.isArray(payload.entries)',
  '    ? payload.entries.reduce((total, entry) => {',
  '        let entryBytes =',
  '          textByteLength(entry.id) +',
  '          textByteLength(entry.shortId) +',
  '          textByteLength(entry.summary) +',
  '          textByteLength(entry.authorName) +',
  '          textByteLength(entry.authorEmail) +',
  '          textByteLength(entry.authoredAt) +',
  '          24;',
  '',
  '        if (Array.isArray(entry.parentIds)) {',
  '          for (const parentId of entry.parentIds) {',
  '            entryBytes += textByteLength(parentId) + 8;',
  '          }',
  '        }',
  '',
  '        if (Array.isArray(entry.refs)) {',
  '          for (const ref of entry.refs) {',
  '            entryBytes += shallowStringBytes(ref) + 16;',
  '          }',
  '        }',
  '',
  '        return total + entryBytes;',
  '      }, 0)',
  '    : 0;',
  '',
  '  return { bytes: entriesBytes + 32 };',
  '};',
);

const GIT_MEASURE_TO = L(
  'const textByteLength = (value: unknown): number => {',
  "  if (typeof value !== 'string' || value.length === 0) return 0;",
  "  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value).length : value.length;",
  '};',
  '',
  'const sumTextBytes = (...values: unknown[]): number =>',
  '  values.reduce<number>((total, value) => total + textByteLength(value), 0);',
  '',
  '// Git 出参浅层字节度量的固定开销常量：把原散落的魔法数字语义化，数值与原实现逐一对齐。',
  'const PAYLOAD_BASE_OVERHEAD_BYTES = 96; // 单个 payload（detail / diff）的固定基准开销',
  'const CONTAINER_OVERHEAD_BYTES = 32; // 容器节点（每个 hunk、提交历史列表）的结构开销',
  'const PER_ITEM_OVERHEAD_BYTES = 24; // 每个 file / 提交 entry 的结构开销',
  'const PER_LEAF_OVERHEAD_BYTES = 16; // 每个 diff line / ref 的结构开销',
  'const SCALAR_FIELD_BYTES = 8; // 单个 number/boolean/parentId 的计量字节',
  '',
  'const shallowStringBytes = (value: unknown): number => {',
  "  if (!value || typeof value !== 'object') return textByteLength(value);",
  '  let total = 0;',
  '  for (const fieldValue of Object.values(value as Record<string, unknown>)) {',
  "    if (typeof fieldValue === 'string') {",
  '      total += textByteLength(fieldValue);',
  "    } else if (typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {",
  '      total += SCALAR_FIELD_BYTES;',
  '    }',
  '  }',
  '  return total;',
  '};',
  '',
  '// NOTE: 浅层字段遍历度量替代 JSON.stringify，避免对大 payload 的序列化开销。',
  'const measureGitCommitDetailOutput = (output: unknown) => {',
  "  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);",
  '',
  '  const payload = output as {',
  '    files?: Array<Record<string, unknown>>;',
  '    body?: string;',
  '    summary?: string;',
  '    authorName?: string;',
  '    authorEmail?: string;',
  '    authoredAt?: string;',
  '    id?: string;',
  '    shortId?: string;',
  '  };',
  '',
  '  const baseBytes = sumTextBytes(',
  '    payload.id,',
  '    payload.shortId,',
  '    payload.summary,',
  '    payload.body,',
  '    payload.authorName,',
  '    payload.authorEmail,',
  '    payload.authoredAt,',
  '  );',
  '',
  '  const filesBytes = Array.isArray(payload.files)',
  '    ? payload.files.reduce(',
  '        (total, file) => total + shallowStringBytes(file) + PER_ITEM_OVERHEAD_BYTES,',
  '        0,',
  '      )',
  '    : 0;',
  '',
  '  return { bytes: baseBytes + filesBytes + PAYLOAD_BASE_OVERHEAD_BYTES };',
  '};',
  '',
  'const measureGitDiffPayloadOutput = (output: unknown) => {',
  "  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);",
  '',
  '  const payload = output as {',
  '    originalContent?: string;',
  '    modifiedContent?: string;',
  '    relativePath?: string;',
  '    fileName?: string;',
  '    title?: string;',
  '    mode?: string;',
  '    id?: string;',
  '    repositoryRootPath?: string;',
  '    path?: string;',
  '    hunks?: Array<{',
  '      lines?: Array<{',
  '        content?: string;',
  '        tag?: string;',
  '        oldLine?: number | null;',
  '        newLine?: number | null;',
  '      }>;',
  '    }>;',
  '  };',
  '',
  '  const scalarBytes = sumTextBytes(',
  '    payload.id,',
  '    payload.repositoryRootPath,',
  '    payload.path,',
  '    payload.relativePath,',
  '    payload.fileName,',
  '    payload.title,',
  '    payload.mode,',
  '    payload.originalContent,',
  '    payload.modifiedContent,',
  '  );',
  '  let bytes = scalarBytes + PAYLOAD_BASE_OVERHEAD_BYTES;',
  '',
  '  if (Array.isArray(payload.hunks)) {',
  '    for (const hunk of payload.hunks) {',
  '      bytes += CONTAINER_OVERHEAD_BYTES;',
  '      if (!Array.isArray(hunk.lines)) continue;',
  '      for (const line of hunk.lines) {',
  '        bytes += textByteLength(line.content) + textByteLength(line.tag) + PER_LEAF_OVERHEAD_BYTES;',
  '      }',
  '    }',
  '  }',
  '',
  '  return { bytes };',
  '};',
  '',
  '/**',
  ' * git log（提交历史）出参的浅层字节度量。与 measureGitCommitDetailOutput /',
  ' * measureGitDiffPayloadOutput 同口径：只累加已知标量字段与 parentIds/refs 的字节，',
  ' * 避免对整份提交列表做一次纯统计用途的 JSON.stringify。导出以便单测覆盖。',
  ' */',
  'export const measureGitCommitHistoryOutput = (output: unknown) => {',
  "  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);",
  '',
  '  const payload = output as {',
  '    entries?: Array<{',
  '      id?: string;',
  '      shortId?: string;',
  '      summary?: string;',
  '      authorName?: string;',
  '      authorEmail?: string;',
  '      authoredAt?: string;',
  '      parentIds?: string[];',
  '      refs?: Array<Record<string, unknown>>;',
  '    }>;',
  '  };',
  '',
  '  const entriesBytes = Array.isArray(payload.entries)',
  '    ? payload.entries.reduce((total, entry) => {',
  '        const scalarBytes = sumTextBytes(',
  '          entry.id,',
  '          entry.shortId,',
  '          entry.summary,',
  '          entry.authorName,',
  '          entry.authorEmail,',
  '          entry.authoredAt,',
  '        );',
  '        let entryBytes = scalarBytes + PER_ITEM_OVERHEAD_BYTES;',
  '',
  '        if (Array.isArray(entry.parentIds)) {',
  '          for (const parentId of entry.parentIds) {',
  '            entryBytes += textByteLength(parentId) + SCALAR_FIELD_BYTES;',
  '          }',
  '        }',
  '',
  '        if (Array.isArray(entry.refs)) {',
  '          for (const ref of entry.refs) {',
  '            entryBytes += shallowStringBytes(ref) + PER_LEAF_OVERHEAD_BYTES;',
  '          }',
  '        }',
  '',
  '        return total + entryBytes;',
  '      }, 0)',
  '    : 0;',
  '',
  '  return { bytes: entriesBytes + CONTAINER_OVERHEAD_BYTES };',
  '};',
);

async function patchSession() {
  const file = 'src/terminal/session.ts';
  const abs = resolve(ROOT, file);
  let c;
  try {
    c = await readFile(abs, 'utf8');
  } catch {
    log.push(`✗ 读取失败 ${file}`);
    tally.missing++;
    return;
  }
  const orig = c;
  log.push(`\n[${file}]`);

  const IMPORT_ANCHOR = "import { markRaw, nextTick, type Ref, ref, shallowRef } from 'vue';";
  const CONSOLA_IMPORT = "import { consola } from 'consola';\n";
  const ANCHOR = L(
    '// PTY 列宽/行高的合法区间常量：取代散落的魔法数字，集中表达约束。',
    'const TERMINAL_MIN_COLS = 2;',
  );
  const LOGGER_DECL = "const terminalLogger = consola.withTag('terminal');";
  const LOGGER_BLOCK =
    "// 终端会话错误日志统一走 consola（与 IPC 层 consola.withTag('ipc') 同口径）。\n" +
    LOGGER_DECL +
    '\n\n';

  // 0) 自愈：折叠历史误操作产生的重复块（本次 Vite 报错根因）
  while (c.includes(LOGGER_BLOCK + LOGGER_BLOCK)) {
    c = c.replace(LOGGER_BLOCK + LOGGER_BLOCK, LOGGER_BLOCK);
    log.push('  🔧 折叠重复 terminalLogger 块');
    tally.fixed++;
  }
  while (c.includes(CONSOLA_IMPORT + CONSOLA_IMPORT)) {
    c = c.replace(CONSOLA_IMPORT + CONSOLA_IMPORT, CONSOLA_IMPORT);
    log.push('  🔧 折叠重复 consola import');
    tally.fixed++;
  }

  if (!REVERT) {
    // consola import（以「是否已存在」为幂等标记）
    if (c.includes("import { consola } from 'consola'")) {
      log.push('  · 跳过(已存在) consola import');
      tally.skipped++;
    } else if (c.includes(IMPORT_ANCHOR)) {
      c = c.replace(IMPORT_ANCHOR, CONSOLA_IMPORT + IMPORT_ANCHOR);
      log.push('  ✔ 增加 consola import');
      tally.applied++;
    } else {
      log.push('  ✗ 未匹配 import 锚点');
      tally.missing++;
    }
    // terminalLogger 声明（以声明是否已存在为幂等标记，根治重复）
    if (c.includes(LOGGER_DECL)) {
      log.push('  · 跳过(已存在) terminalLogger 声明');
      tally.skipped++;
    } else if (c.includes(ANCHOR)) {
      c = c.replace(ANCHOR, LOGGER_BLOCK + ANCHOR);
      log.push('  ✔ 插入 terminalLogger 声明');
      tally.applied++;
    } else {
      log.push('  ✗ 未匹配 TERMINAL_MIN_COLS 锚点');
      tally.missing++;
    }
  }

  // F1 日志改写（apply / revert 由 replaceOnce 内部按方向处理）
  c = replaceOnce(
    c,
    "      console.warn('终端 live resize 尺寸同步失败', error);",
    "      terminalLogger.warn('终端 live resize 尺寸同步失败', error);",
    'F1 warn#1',
  );
  c = replaceOnce(
    c,
    "      console.warn('终端尺寸同步失败', error);",
    "      terminalLogger.warn('终端尺寸同步失败', error);",
    'F1 warn#2',
  );
  c = replaceOnce(
    c,
    "      console.warn('终端 PTY 尺寸同步失败', { sessionId: this.id, cols, rows, error });",
    "      terminalLogger.warn('终端 PTY 尺寸同步失败', { sessionId: this.id, cols, rows, error });",
    'F1 warn#3',
  );
  // F5
  c = replaceOnce(c, F5_FROM, F5_TO, 'F5 去 as 断言');

  if (REVERT) {
    // 回滚：移除声明与 import（折叠后只剩一份）
    if (c.includes(LOGGER_BLOCK)) {
      c = c.replace(LOGGER_BLOCK, '');
      log.push('  ↩ 移除 terminalLogger 声明');
      tally.applied++;
    }
    if (c.includes(CONSOLA_IMPORT)) {
      c = c.replace(CONSOLA_IMPORT, '');
      log.push('  ↩ 移除 consola import');
      tally.applied++;
    }
  }

  await commit(abs, orig, c);
}

async function patchPlain(file, pairs) {
  const abs = resolve(ROOT, file);
  let c;
  try {
    c = await readFile(abs, 'utf8');
  } catch {
    log.push(`✗ 读取失败 ${file}`);
    tally.missing++;
    return;
  }
  const orig = c;
  log.push(`\n[${file}]`);
  for (const p of pairs) c = replaceOnce(c, p.from, p.to, p.label);
  await commit(abs, orig, c);
}

await patchSession();
await patchPlain('src/utils/core/fuzzy-score.ts', [
  {
    from: '  return CHAR_CLASS_NAMES[CHAR_CLASS_LUT[code]]!;',
    to: "  return CHAR_CLASS_NAMES[CHAR_CLASS_LUT[code]] ?? 'nonword';",
    label: 'F3 去 ! 非空断言',
  },
]);
await patchPlain('src/services/tauri.git.ts', [
  { from: GIT_MEASURE_FROM, to: GIT_MEASURE_TO, label: 'F4 度量函数去重' },
]);

console.log(log.join('\n'));
console.log(
  `\n模式：${REVERT ? 'revert' : 'apply'}${DRY_RUN ? ' + dry-run' : ''}  统计：fixed=${tally.fixed} applied=${tally.applied} skipped=${tally.skipped} missing=${tally.missing}`,
);
if (!DRY_RUN && tally.missing === 0) {
  console.log('完成。请运行：pnpm lint && pnpm typecheck && pnpm test');
}
process.exit(tally.missing > 0 ? 1 : 0);