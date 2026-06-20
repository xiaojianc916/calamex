#!/usr/bin/env node
// align-mastra-parts-to-ai-sdk.mjs  (v2: 换行/缩进无关)
// 把 agent-sidecar 手写的消息 part 影子类型改为复用 AI SDK 官方类型。
// 用法（仓库根目录执行）：
//   node align-mastra-parts-to-ai-sdk.mjs --check   # 干跑
//   node align-mastra-parts-to-ai-sdk.mjs           # 写入
// 写入后：pnpm install && pnpm --dir agent-sidecar typecheck
// 回滚：git checkout -- agent-sidecar/src/engines/shared/types.ts agent-sidecar/package.json

import { readFile, writeFile } from 'node:fs/promises';
import { argv, cwd, exit } from 'node:process';
import { resolve } from 'node:path';

const CHECK = argv.includes('--check');
const ROOT = cwd();
const TYPES_PATH = resolve(ROOT, 'agent-sidecar/src/engines/shared/types.ts');
const PKG_PATH = resolve(ROOT, 'agent-sidecar/package.json');

const AI_IMPORT = `import type { TextPart, ImagePart, FilePart } from 'ai';`;
const AI_DEP_RANGE = '^5.0.0';

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (msg) => { console.error(`✗ ${msg}`); exit(1); };

// 每个手写 part 类型：[类型名, 官方别名]。正则用 \{[^}]*\} 容忍任意缩进/换行（内部无嵌套花括号）。
const PARTS = [
  ['TMastraTextPart', 'TextPart'],
  ['TMastraImagePart', 'ImagePart'],
  ['TMastraFilePart', 'FilePart'],
];

async function patchTypes() {
  const original = await readFile(TYPES_PATH, 'utf8');
  const EOL = original.includes('\r\n') ? '\r\n' : '\n';
  const COMMENT =
    `// 复用 AI SDK 官方消息 part 类型（与 @mastra/core 同源），避免本地影子拷贝随 SDK 升级静默漂移。${EOL}` +
    `// 注意：官方 FilePart.data / ImagePart.image 为 DataContent | URL，比原 string | URL 更宽。`;

  let next = original;
  const changes = [];

  // 1) 注入 type-only import（幂等）：插在最后一条 import 语句之后
  if (next.includes(AI_IMPORT)) {
    changes.push('types/import: 已存在，跳过');
  } else {
    let end = -1;
    const re = /^import[^\n]*?;\r?$/gm;
    for (let m; (m = re.exec(next)) !== null; ) end = m.index + m[0].length;
    if (end < 0) fail('找不到任何 import 语句，无法定位插入点');
    next = `${next.slice(0, end)}${EOL}${AI_IMPORT}${next.slice(end)}`;
    changes.push('types/import: 已注入 ai 官方 part 类型');
  }

  // 2) 三个手写 part 类型 → 官方别名（幂等、正则匹配）
  for (const [name, alias] of PARTS) {
    const aliasLine = `export type ${name} = ${alias};`;
    if (next.includes(aliasLine)) { changes.push(`types/${name}: 已是别名，跳过`); continue; }
    const re = new RegExp(`export type ${name} = \\{[^}]*\\};`);
    if (!re.test(next)) fail(`找不到手写类型 ${name}（可能已改动），请人工核对 types.ts`);
    const replacement = name === 'TMastraTextPart' ? `${COMMENT}${EOL}${aliasLine}` : aliasLine;
    next = next.replace(re, replacement);
    changes.push(`types/${name}: 已替换为 ${alias} 别名`);
  }

  return { changed: next !== original, changes, next };
}

async function patchPkg() {
  const original = await readFile(PKG_PATH, 'utf8');
  const EOL = original.includes('\r\n') ? '\r\n' : '\n';
  const pkg = JSON.parse(original);
  if (pkg.devDependencies?.ai || pkg.dependencies?.ai) {
    return { changed: false, changes: ['pkg: ai 依赖已存在，跳过'], next: original };
  }
  const merged = { ...(pkg.devDependencies ?? {}), ai: AI_DEP_RANGE };
  pkg.devDependencies = Object.fromEntries(
    Object.keys(merged).sort(byCodePoint).map((k) => [k, merged[k]]),
  );
  let next = `${JSON.stringify(pkg, null, 2)}\n`;
  if (EOL === '\r\n') next = next.replace(/\n/g, '\r\n'); // 保留原文件换行风格
  return { changed: next !== original, changes: [`pkg: devDependencies 新增 "ai": "${AI_DEP_RANGE}"`], next };
}

async function main() {
  const t = await patchTypes();
  const p = await patchPkg();
  for (const c of [...t.changes, ...p.changes]) console.log(`• ${c}`);

  if (CHECK) { console.log('\n[--check] 干跑，未写入任何文件。'); return; }
  if (t.changed) await writeFile(TYPES_PATH, t.next, 'utf8');
  if (p.changed) await writeFile(PKG_PATH, p.next, 'utf8');
  console.log('\n✓ 写入完成。请执行：pnpm install && pnpm --dir agent-sidecar typecheck');
}

main().catch((e) => fail(e?.stack ?? String(e)));