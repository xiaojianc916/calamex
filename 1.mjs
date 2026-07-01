// fix-cargo-dev-profile.mjs — 仓库根目录 node 跑
import { readFileSync, writeFileSync } from 'node:fs';

// 1) 从 src-tauri/Cargo.toml 删掉被忽略的 [profile.dev]（连同其注释）
const SUB = 'src-tauri/Cargo.toml';
let sub = readFileSync(SUB, 'utf8');
const subEol = sub.includes('\r\n') ? '\r\n' : '\n';
const subIdx = sub.indexOf('[profile.dev]');
if (subIdx !== -1) {
  const head = sub.slice(0, subIdx).split(subEol);
  while (head.length) {
    const last = head[head.length - 1];
    if (last.trim() === '' || last.trimStart().startsWith('#')) head.pop();
    else break;
  }
  writeFileSync(SUB, head.join(subEol) + subEol);
  console.log('[ok] 已从 src-tauri/Cargo.toml 移除被忽略的 [profile.dev]');
} else {
  console.log('[skip] src-tauri 已无 [profile.dev]');
}

// 2) 加到 workspace 根 Cargo.toml（若尚无）
const ROOT = 'Cargo.toml';
let root = readFileSync(ROOT, 'utf8');
const rootEol = root.includes('\r\n') ? '\r\n' : '\n';
if (root.includes('[profile.dev]')) {
  console.log('[skip] 根 Cargo.toml 已有 [profile.dev]');
} else {
  const block = [
    '',
    '# 降低 dev(debug) 构建的内存/时间开销（profile 必须放 workspace 根，否则被 cargo 忽略）。',
    '# 默认 debug=2 会让 calamex 二进制 LLVM 代码生成占大量内存，tauri dev 下易 OOM；',
    '# line-tables-only 仍保留 panic 栈行号。',
    '[profile.dev]',
    'debug = "line-tables-only"',
    '',
    '# 依赖不需要调试信息，进一步降低峰值内存与磁盘占用。',
    '[profile.dev.package."*"]',
    'debug = false',
    '',
  ].join(rootEol);
  root = root.replace(/[\s\uFEFF]*$/, '') + rootEol + block;
  writeFileSync(ROOT, root);
  console.log('[ok] 已在 workspace 根追加 [profile.dev]（现在真正生效）');
}