#!/usr/bin/env node
// cleanup-deepseek-provider-payload.mjs
//
// 清理迁移到官方 @ai-sdk/deepseek 后遗留的死代码：
//   1) engines/types.ts        —— 删除孤立的 TAcontextProviderPayloadEventDraft 别名
//   2) streaming/stream-types.ts —— 删除 acontext.provider_payload.checked 事件变体
//      （数组字面量 + IAgentAcontextProviderPayloadEvent 接口 + TAgentRuntimeEvent 联合成员）
//
// 特性：幂等、带锚点断言（找不到即中止不写）、跑完扫描全 src 报告残留引用。
//
// 用法（从仓库根目录或 agent-sidecar/ 下执行）：
//   node cleanup-deepseek-provider-payload.mjs            # 应用
//   node cleanup-deepseek-provider-payload.mjs --dry-run  # 仅预览
//
// 跑完务必：pnpm -C agent-sidecar typecheck && pnpm -C agent-sidecar test

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');

// --- 定位 agent-sidecar/src ---------------------------------------------------
function findSrcRoot() {
  const candidates = [
    resolve(process.cwd(), 'agent-sidecar/src'),
    resolve(process.cwd(), 'src'),
    resolve(process.cwd(), '../agent-sidecar/src'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'engines/types.ts'))) return c;
  }
  throw new Error('找不到 agent-sidecar/src，请在仓库根目录或 agent-sidecar/ 下运行。');
}
const SRC = findSrcRoot();

// --- 断言式替换：锚点缺失就抛错（绝不盲写） ----------------------------------
function mustReplace(content, find, replace, what) {
  if (typeof find === 'string') {
    if (!content.includes(find)) {
      throw new Error(`未找到锚点："${what}"。文件与预期版本不符，已中止且未写入。`);
    }
    return content.split(find).join(replace); // 恰好一处
  }
  if (!find.test(content)) {
    throw new Error(`未匹配到模式："${what}"。文件已偏离预期，已中止。`);
  }
  return content.replace(find, replace);
}

let changed = 0;
function edit(relPath, label, mutate, presenceMarker) {
  const file = join(SRC, relPath);
  const before = readFileSync(file, 'utf8');
  if (presenceMarker && !before.includes(presenceMarker)) {
    console.log(`• [skip] ${relPath}: "${label}" 已应用，跳过`);
    return;
  }
  const after = mutate(before); // 任一步骤抛错 => 此文件不写入
  if (after === before) {
    console.log(`• [skip] ${relPath}: "${label}" 无变化`);
    return;
  }
  if (DRY_RUN) {
    console.log(`• [dry-run] ${relPath}: 将应用 "${label}"`);
  } else {
    writeFileSync(file, after, 'utf8');
    console.log(`✔ [done] ${relPath}: ${label}`);
  }
  changed++;
}

// 1) engines/types.ts —— 删除孤立的 producer-draft 别名
edit(
  'engines/types.ts',
  'remove TAcontextProviderPayloadEventDraft alias',
  (c) =>
    mustReplace(
      c,
      "export type TAcontextProviderPayloadEventDraft = Extract<TAgentRuntimeEventDraft, {\n    type: 'acontext.provider_payload.checked';\n}>;\n",
      '',
      'TAcontextProviderPayloadEventDraft 别名',
    ),
  'TAcontextProviderPayloadEventDraft',
);

// 2) streaming/stream-types.ts —— 删除事件变体的三处耦合点
edit(
  'streaming/stream-types.ts',
  'remove acontext.provider_payload.checked event variant',
  (c) => {
    let out = c;
    // 2a) AGENT_RUNTIME_EVENT_TYPES 数组字面量
    out = mustReplace(out, "  'acontext.provider_payload.checked',\n", '', '事件类型数组字面量');
    // 2b) IAgentAcontextProviderPayloadEvent 接口（保留前后各一空行）
    out = mustReplace(
      out,
      /\n\nexport interface IAgentAcontextProviderPayloadEvent extends IAgentRuntimeEventBase \{[\s\S]*?\n\}/,
      '',
      'IAgentAcontextProviderPayloadEvent 接口',
    );
    // 2c) TAgentRuntimeEvent 联合成员
    out = mustReplace(out, '  | IAgentAcontextProviderPayloadEvent\n', '', '联合成员');
    return out;
  },
  'acontext.provider_payload.checked',
);

// --- 安全网：扫描全 src 报告残留引用（只读） --------------------------------
const NEEDLES = [
  'acontext.provider_payload.checked',
  'IAgentAcontextProviderPayloadEvent',
  'TAcontextProviderPayloadEventDraft',
];
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(name)) continue;
      walk(p, acc);
    } else if (/\.(ts|tsx|mts|cts)$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}
const remaining = [];
for (const f of walk(SRC)) {
  const txt = readFileSync(f, 'utf8');
  for (const n of NEEDLES) {
    if (txt.includes(n)) remaining.push({ file: f.replace(SRC, 'src'), needle: n });
  }
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