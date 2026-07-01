#!/usr/bin/env node
// check-ai-defaults-sync.mjs  (建议放 scripts/ 并挂进 CI/pre-commit)
// 跨语言 AI 默认常量一致性守卫。任一侧漂移 -> 非零退出。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const die = (m) => { console.error('✗ ' + m); process.exit(1); };
const read = (p) => { const f = join(ROOT, p); if (!existsSync(f)) die(`未找到 ${p}`); return readFileSync(f, 'utf8'); };
const grab = (txt, re, label) => { const m = txt.match(re); if (!m) die(`${label}: 正则未命中,常量可能被重命名。`); return m[1]; };

const gw   = read('src-tauri/src/ai/gateway/mod.rs');
const cfg  = read('builtin-agent/src/models/config.ts');
const cred = read('src-tauri/src/ai/credential/mod.rs');
const dsgw = read('builtin-agent/src/models/providers/deepseek-mastra-gateway.ts');
const prov = read('src-tauri/src/acp/provisioner.rs');

const pairs = [
  { name: '默认主模型 (DEFAULT_MASTRA_MODEL ↔ DEFAULT_MODEL_ID)',
    a: grab(gw,  /const DEFAULT_MASTRA_MODEL:\s*&str\s*=\s*"([^"]+)"/, 'gateway/mod.rs'),
    b: grab(cfg, /export const DEFAULT_MODEL_ID\s*=\s*'([^']+)'/,      'config.ts') },
  { name: 'deepseek 默认端点',
    a: grab(cred, /"deepseek"\s*=>\s*Some\("([^"]+)"\)/,             'credential/mod.rs'),
    b: grab(dsgw, /const DEFAULT_DEEPSEEK_BASE_URL\s*=\s*'([^']+)'/, 'deepseek-mastra-gateway.ts') },
  { name: 'moonshotai/Kimi 默认端点',
    a: grab(cred, /"moonshotai"\s*=>\s*Some\("([^"]+)"\)/,               'credential/mod.rs'),
    b: grab(prov, /const KIMI_DEFAULT_BASE_URL:\s*&str\s*=\s*"([^"]+)"/, 'provisioner.rs') },
];

let bad = 0;
for (const p of pairs) {
  const ok = p.a === p.b;
  console.log(`${ok ? '✓' : '✗'} ${p.name}: Rust="${p.a}" · Node="${p.b}"`);
  if (!ok) bad++;
}
if (bad) die(`${bad} 组常量已漂移,请统一后再提交。`);
console.log('\n✓ 所有跨语言 AI 默认常量一致。');