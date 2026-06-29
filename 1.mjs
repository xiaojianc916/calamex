// 3.mjs —— 清理 useShellWorkbenchView.spec.ts 里残留的 analyze mock 字段
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/app/composables/useShellWorkbenchView.spec.ts';

const raw = readFileSync(FILE, 'utf8');
const isCRLF = raw.includes('\r\n');
const norm = raw.replace(/\r\n/g, '\n');

// 要删除的三行（按 trim 后整行相等匹配，每行必须恰好命中一次）
const needles = [
  'activeDiagnostics: [],',
  'activeScriptAnalysis: { diagnostics: [] },',
  'setDocumentAnalysis: vi.fn(),',
];

const lines = norm.split('\n');
const kept = [];
const hits = Object.fromEntries(needles.map((n) => [n, 0]));

for (const line of lines) {
  const t = line.trim();
  const matched = needles.find((n) => n === t);
  if (matched) {
    hits[matched] += 1;
    continue; // 整行丢弃
  }
  kept.push(line);
}

// 命中校验：每行必须正好删 1 处，否则中止、不写盘
for (const n of needles) {
  if (hits[n] !== 1) {
    throw new Error(`[中止] 锚点命中异常: "${n}" 命中 ${hits[n]} 次（期望 1）。请把该文件相关行贴回来。`);
  }
}

let out = kept.join('\n');
if (isCRLF) out = out.replace(/\n/g, '\r\n');
writeFileSync(FILE, out, 'utf8');

console.log(`✓ 修改 ${FILE}（删除 3 行 analyze 残留 mock）`);
console.log('=== 完成 ===');
console.log('后续：');
console.log('1) 重新生成 Tauri 绑定（codegen 会刷新 src/bindings/tauri.ts 与 tauri.contracts.ts，那 7 处生成产物残留随之消失）');
console.log('2) cd src-tauri && cargo build && cargo test');
console.log('3) 前端 vue-tsc + vitest（重点跑 useShellWorkbenchView.spec.ts / AiAssistantPanel.spec.ts / useAiAssistant.spec.ts）');