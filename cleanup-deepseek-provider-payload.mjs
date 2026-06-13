#!/usr/bin/env node
// cleanup-deepseek-provider-payload.mjs  (v2: CRLF/缩进容忍版)
//
// 清理迁移到官方 @ai-sdk/deepseek 后遗留的死代码：
//   1) engines/types.ts         —— 删除孤立的 TAcontextProviderPayloadEventDraft 别名
//   2) streaming/stream-types.ts —— 删除 acontext.provider_payload.checked 事件变体
//      （数组字面量 + IAgentAcontextProviderPayloadEvent 接口 + TAgentRuntimeEvent 联合成员）
//
// 特性：幂等、正则锚点（对 CRLF/LF 与缩进都容忍）、找不到即中止不写、跑完扫描残留引用。
//
// 用法（仓库根目录或 agent-sidecar/ 下）：
//   node cleanup-deepseek-provider-payload.mjs --dry-run   # 预览
//   node cleanup-deepseek-provider-payload.mjs             # 应用
// 跑完：pnpm -C agent-sidecar typecheck && pnpm -C agent-sidecar test

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');

function findSrcRoot() {
  const candidates = [
    resolve(process.cwd(), 'agent-sidecar/src'),
    resolve(process.cwd(), 'src'),
    resolve(process.cwd(), '../agent-sidecar/src'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'engines/types.ts'))) return c;
  throw new Error('找不到 agent-sidecar/src，请在仓库根目录或 agent-sidecar/ 下运行。');
}
const SRC = findSrcRoot();

function mustReplace(content, re, replace, what) {
  if (!re.test(content)) {
    throw new Error(`未匹配到："${what}"。文件已偏离预期，已中止且未写入。`);
  }
  return content.replace(re, replace);
}

let changed = 0;
function edit(relPath, label, mutate, presenceMarker) {
  const file = join(SRC, relPath);
  const before = readFileSync(file, 'utf8');
  if (presenceMarker && !before.includes(presenceMarker)) {
    console.log(`• [skip] ${relPath}: "${label}" 已应用，跳过`);
    return;
  }
  const after = mutate(before); // 任一步抛错 => 此文件不写入
  if (after === before) {
    console.log(`• [skip] ${relPath}: "${label}" 无变化`);
    return;
  }
  if (DRY_RUN) console.log(`• [dry-run] ${relPath}: 将应用 "${label}"`);
  else { writeFileSync(file, after, 'utf8'); console.log(`✔ [done] ${relPath}: ${label}`); }
  changed++;
}

// 1) engines/types.ts —— 删除孤立的 producer-draft 别名（含其行尾）
edit(
  'engines/types.ts',
  'remove TAcontextProviderPayloadEventDraft alias',
  (c) =>
    mustReplace(
      c,
      /export type TAcontextProviderPayloadEventDraft\s*=\s*Extract<\s*TAgentRuntimeEventDraft\s*,\s*\{\s*type:\s*'acontext\.provider_payload\.checked'\s*;?\s*\}>\s*;[ \t]*\r?\n/,
      '',
      'TAcontextProviderPayloadEventDraft 别名',
    ),
  'TAcontextProviderPayloadEventDraft',
);

// 2) streaming/stream-types.ts —— 事件变体三处耦合点
edit(
  'streaming/stream-types.ts',
  'remove acontext.provider_payload.checked event variant',
  (c) => {
    let out = c;
    // 2a) AGENT_RUNTIME_EVENT_TYPES 数组字面量行
    out = mustReplace(out, /^[ \t]*'acontext\.provider_payload\.checked',[ \t]*\r?\n/m, '', '事件类型数组字面量');
    // 2b) IAgentAcontextProviderPayloadEvent 接口（连同其后一空行，保留接口前的空行）
    out = mustReplace(
      out,
      /export interface IAgentAcontextProviderPayloadEvent extends IAgentRuntimeEventBase \{[\s\S]*?\r?\n\}\r?\n\r?\n/,
      '',
      'IAgentAcontextProviderPayloadEvent 接口',
    );
    // 2c) TAgentRuntimeEvent 联合成员行
    out = mustReplace(out, /^[ \t]*\|[ \t]*IAgentAcontextProviderPayloadEvent[ \t]*\r?\n/m, '', '联合成员');
    return out;
  },
  'acontext.provider_payload.checked',
);

// --- 安全网：扫描全 src 报告残留引用（只读） --------------------------------
const NEEDLES = ['acontext.provider_payload.checked', 'IAgentAcontextProviderPayloadEvent', 'TAcontextProviderPayloadEventDraft'];
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(name)) continue;
      walk(p, acc);
    } else if (/\.(ts|tsx|mts|cts)$/.test(name)) acc.push(p);
  }
  return acc;
}
const remaining = [];
for (const f of walk(SRC)) {
  const txt = readFileSync(f, 'utf8');
  for (const n of NEEDLES) if (txt.includes(n)) remaining.push({ file: f.replace(SRC, 'src'), needle: n });
}

console.log('\n────────────────────────────────────────');
console.log(DRY_RUN ? 'DRY RUN 完成（未写入任何文件）。' : `已应用 ${changed} 组修改。`);
if (remaining.length) {
  console.log('\n⚠ 仍有残留引用需手动清理（很可能是 ACP 出口映射的 case 分支）：');
  for (const r of remaining) console.log(`   - ${r.file}  →  ${r.needle}`);
  console.log('\n   删掉对应的 case/处理分支后重新 typecheck。');
} else {
  console.log('\n✓ 未发现残留引用。');
}
console.log('\n下一步：pnpm -C agent-sidecar typecheck && pnpm -C agent-sidecar test');