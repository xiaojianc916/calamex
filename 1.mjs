#!/usr/bin/env node
// 只读探针：确认把 markdown 搬上 tree-sitter 的前置条件（不改任何文件）。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function hasWasm(grammar) {
  try {
    require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
    return true;
  } catch {
    return false;
  }
}
for (const g of ['markdown', 'markdown_inline']) {
  console.log(`wasm  tree-sitter-${g}.wasm :`, hasWasm(g) ? '✅ 有' : '❌ 缺');
}

const BASES = [
  'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries',
  'https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/main/queries',
];
async function probe(lang, file) {
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/${lang}/${file}`);
      if (res.ok) {
        const t = await res.text();
        return { ok: true, url: `${base}/${lang}/${file}`, bytes: t.length, head: t.split('\n').slice(0, 2).join(' | ') };
      }
    } catch {}
  }
  return { ok: false };
}
for (const [lang, file] of [
  ['markdown', 'highlights.scm'],
  ['markdown', 'injections.scm'],
  ['markdown_inline', 'highlights.scm'],
  ['markdown_inline', 'injections.scm'],
]) {
  const r = await probe(lang, file);
  console.log(`scm   ${lang}/${file} :`, r.ok ? `✅ ${r.bytes}B  (${r.head})` : '❌ 未找到');
}