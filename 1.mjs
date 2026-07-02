#!/usr/bin/env node
// 扩容 tree-sitter 高亮注册表（增量、幂等、不破坏已有语言）。
//   wasm: tree-sitter-wasms（实测存在性）；缺失语言的 scm: nvim-treesitter（MIT）。
//   已存在的 queries/<id>/highlights.scm 一律保留不重下。

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const OUT_DIR = resolve(ROOT, 'src/services/editor/tree-sitter');
const QUERY_DIR = join(OUT_DIR, 'queries');
const REGISTRY_FILE = join(OUT_DIR, 'language-registry.generated.ts');
const NVIM = 'nvim-treesitter/nvim-treesitter';
const NVIM_REFS = ['master', 'main'];

// cmId 必须与 CODEMIRROR_LANGUAGE_LOADERS 的键一致；grammar 为 tree-sitter-wasms 的 out 名；scm 为 nvim 目录名。
const MANIFEST = [
  // —— 已在册（scm 已 vendored，脚本会原样保留）——
  { cmId: 'shell', grammar: 'bash', scm: 'bash', aliases: ['bash', 'sh', 'zsh'] },
  { cmId: 'javascript', grammar: 'javascript', scm: 'javascript', aliases: ['js', 'mjs', 'cjs'] },
  { cmId: 'jsx', grammar: 'javascript', scm: 'javascript', aliases: [] },
  { cmId: 'typescript', grammar: 'typescript', scm: 'typescript', aliases: ['ts', 'mts', 'cts'] },
  { cmId: 'tsx', grammar: 'tsx', scm: 'tsx', aliases: [] },
  { cmId: 'python', grammar: 'python', scm: 'python', aliases: ['py'] },
  { cmId: 'rust', grammar: 'rust', scm: 'rust', aliases: ['rs'] },
  { cmId: 'go', grammar: 'go', scm: 'go', aliases: [] },
  { cmId: 'c', grammar: 'c', scm: 'c', aliases: ['h'] },
  { cmId: 'cpp', grammar: 'cpp', scm: 'cpp', aliases: ['cc', 'cxx', 'hpp'] },
  { cmId: 'java', grammar: 'java', scm: 'java', aliases: [] },
  { cmId: 'json', grammar: 'json', scm: 'json', aliases: ['jsonc'] },
  { cmId: 'html', grammar: 'html', scm: 'html', aliases: ['htm'] },
  { cmId: 'css', grammar: 'css', scm: 'css', aliases: [] },
  { cmId: 'scss', grammar: 'css', scm: 'scss', aliases: [] },
  { cmId: 'ruby', grammar: 'ruby', scm: 'ruby', aliases: ['rb'] },
  { cmId: 'yaml', grammar: 'yaml', scm: 'yaml', aliases: ['yml'] },
  { cmId: 'toml', grammar: 'toml', scm: 'toml', aliases: [] },
  { cmId: 'lua', grammar: 'lua', scm: 'lua', aliases: [] },
  // —— 新增（本地缺 scm 则从 nvim-treesitter 下载）——
  { cmId: 'csharp', grammar: 'c_sharp', scm: 'c_sharp', aliases: ['cs'] },
  { cmId: 'kotlin', grammar: 'kotlin', scm: 'kotlin', aliases: ['kt', 'kts'] },
  { cmId: 'scala', grammar: 'scala', scm: 'scala', aliases: [] },
  { cmId: 'markdown', grammar: 'markdown', scm: 'markdown', aliases: ['md'] },
  { cmId: 'sql', grammar: 'sql', scm: 'sql', aliases: [] },
  { cmId: 'r', grammar: 'r', scm: 'r', aliases: [] },
  { cmId: 'xml', grammar: 'xml', scm: 'xml', aliases: ['svg'] },
  { cmId: 'swift', grammar: 'swift', scm: 'swift', aliases: [] },
  { cmId: 'vue', grammar: 'vue', scm: 'vue', aliases: [] },
];

function ensureTreeSitterWasms() {
  try {
    return dirname(require.resolve('tree-sitter-wasms/package.json'));
  } catch {
    /* 未安装 */
  }
  console.log('· 安装 tree-sitter-wasms…');
  try {
    execSync('pnpm add tree-sitter-wasms', { stdio: 'inherit', cwd: ROOT });
  } catch {
    console.log('· 工作区根需 -w，重试…');
    execSync('pnpm add -w tree-sitter-wasms', { stdio: 'inherit', cwd: ROOT });
  }
  return dirname(require.resolve('tree-sitter-wasms/package.json'));
}

async function fetchText(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

// 解析 nvim 的 `; inherits: a,b`，把父语言 highlights 静态前置合并（等价 Zed 自包含 scm）。
async function fetchScm(lang, seen = new Set()) {
  if (seen.has(lang)) return '';
  seen.add(lang);
  let text = null;
  for (const ref of NVIM_REFS) {
    text = await fetchText(`{{https://raw.githubusercontent.com/${NVIM}}}/${ref}/queries/${lang}/highlights.scm`);
    if (text != null) break;
  }
  if (text == null) return null;
  let prefix = '';
  const m = text.match(/;+\s*inherits\s*:\s*([a-zA-Z0-9_,]+)/);
  if (m) {
    for (const p of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const inh = await fetchScm(p, seen);
      if (inh) prefix += `; ==== inherited from ${p} ====\n${inh}\n`;
    }
  }
  return `${prefix}${text}`;
}

function writeRegistry(ok) {
  const L = [];
  L.push('// 本文件由 setup-tree-sitter-highlight.mjs 生成，请勿手改。');
  L.push('// wasm 来自 tree-sitter-wasms（预编译）；highlights.scm 来自 nvim-treesitter 或各语法仓库（保留其 OSS 许可）。');
  for (const e of ok) L.push(`import ${e.cmId}_wasm from 'tree-sitter-wasms/out/tree-sitter-${e.grammar}.wasm?url';`);
  for (const e of ok) L.push(`import ${e.cmId}_scm from './queries/${e.cmId}/highlights.scm?raw';`);
  L.push('');
  L.push('export interface ITreeSitterLanguageEntry {');
  L.push('  readonly wasmUrl: string;');
  L.push('  readonly scm: string;');
  L.push('}');
  L.push('');
  L.push('export const TREE_SITTER_LANGUAGES: Readonly<Record<string, ITreeSitterLanguageEntry>> = {');
  for (const e of ok) L.push(`  ${e.cmId}: { wasmUrl: ${e.cmId}_wasm, scm: ${e.cmId}_scm },`);
  L.push('};');
  L.push('');
  L.push('const TS_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {');
  for (const e of ok) for (const a of e.aliases) if (a !== e.cmId) L.push(`  ${a}: '${e.cmId}',`);
  L.push('};');
  L.push('');
  L.push('/** 原始语言标签 -> tree-sitter 语言 id；无覆盖时返回 null。 */');
  L.push('export function resolveTreeSitterLanguageId(language: string): string | null {');
  L.push('  const tag = language.trim().toLowerCase();');
  L.push('  if (Object.hasOwn(TREE_SITTER_LANGUAGES, tag)) {');
  L.push('    return tag;');
  L.push('  }');
  L.push('  return TS_LANGUAGE_ALIASES[tag] ?? null;');
  L.push('}');
  L.push('');
  writeFileSync(REGISTRY_FILE, L.join('\n'), 'utf8');
}

async function main() {
  console.log('='.repeat(60));
  console.log('扩容 tree-sitter 高亮注册表');
  console.log('='.repeat(60));
  const wasmOutDir = join(ensureTreeSitterWasms(), 'out');
  mkdirSync(QUERY_DIR, { recursive: true });

  const ok = [];
  const skipped = [];
  for (const e of MANIFEST) {
    if (!existsSync(join(wasmOutDir, `tree-sitter-${e.grammar}.wasm`))) {
      skipped.push({ id: e.cmId, reason: `缺 wasm ${e.grammar}` });
      continue;
    }
    const scmFile = join(QUERY_DIR, e.cmId, 'highlights.scm');
    let status = 'kept';
    if (!existsSync(scmFile)) {
      const scm = await fetchScm(e.scm);
      if (scm == null) {
        skipped.push({ id: e.cmId, reason: `拉不到 scm ${e.scm}` });
        continue;
      }
      mkdirSync(join(QUERY_DIR, e.cmId), { recursive: true });
      writeFileSync(scmFile, scm, 'utf8');
      status = 'downloaded';
    }
    ok.push(e);
    console.log(`  ✔ ${e.cmId.padEnd(12)} (${status})`);
  }

  writeRegistry(ok);
  console.log('-'.repeat(60));
  console.log(`注册表已重写，共 ${ok.length} 种语言 → ${REGISTRY_FILE}`);
  if (skipped.length) {
    console.log(`跳过 ${skipped.length} 种（自动降级到 Lezer）：`);
    for (const s of skipped) console.log(`  · ${s.id.padEnd(12)} ${s.reason}`);
    console.log('把跳过项发我，我据实核对 tree-sitter-wasms 的真实 grammar 名 / nvim 目录名再修 MANIFEST。');
  }
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});