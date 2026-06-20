#!/usr/bin/env node
// 8.2d · 退役孤儿协议 VM 适配器 from-runtime-tool-call / from-wire-tool-call
//
// 已由本地 grep 确证(search_code 不可用 → 用户本地 grep 兜底):
//   · fromRuntimeToolCall —— 仅出现于 from-runtime-tool-call.ts(定义) + from-runtime-tool-call.spec.ts
//   · fromWireToolCall    —— 仅出现于 from-wire-tool-call.ts(定义) + from-wire-tool-call.spec.ts
//   全仓无其他消费者;其唯一历史消费者 build-thread-entries.ts 已于 8.2b 退役 → 现为死代码。
//
// 依赖保留(删除后不产生破坏性 orphan):
//   · tool-kind.ts(RUNTIME_KIND_TO_TOOL_KIND / classifyRuntimeToolKind)仍被 from-sidecar-events 消费
//   · tool-view.ts / plan-runtime-timeline / constants/ai/runtime-tools 均另有消费者
//
// 用法:
//   node 1.mjs --check     # 干跑
//   node 1.mjs             # 落盘
//   REPO_ROOT=/path node 1.mjs

import { readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : process.cwd();
const CHECK = process.argv.includes('--check');

const rel = (p) => join(REPO_ROOT, p);
const read = (p) => readFileSync(rel(p), 'utf8');
const toLf = (s) => s.replace(/\r\n/g, '\n');

function write(p, next) {
  if (CHECK) {
    console.log(`  [dry] write ${p} (${next.length} bytes)`);
    return;
  }
  writeFileSync(rel(p), next);
  console.log(`  ✓ write ${p}`);
}

function remove(p) {
  const abs = rel(p);
  if (!existsSync(abs)) {
    throw new Error(`remove 目标不存在：${p}`);
  }
  if (!statSync(abs).isFile()) {
    throw new Error(`remove 目标不是文件：${p}`);
  }
  if (CHECK) {
    console.log(`  [dry] remove ${p}`);
    return;
  }
  rmSync(abs);
  console.log(`  ✓ remove ${p}`);
}

/** 断言恰好命中 numOccurrences 次后替换;用于外科式编辑。 */
function replaceOnce(src, oldStr, newStr, numOccurrences = 1) {
  const parts = src.split(oldStr);
  const hits = parts.length - 1;
  if (hits !== numOccurrences) {
    throw new Error(
      `replaceOnce 命中次数不符:期望 ${numOccurrences},实际 ${hits}\n--- 片段 ---\n${oldStr}`,
    );
  }
  return parts.join(newStr);
}

console.log(`8.2d 退役孤儿适配器 @ ${REPO_ROOT}${CHECK ? '  (--check 干跑)' : ''}`);

// ---- 1) 删除孤儿文件(定义 + spec)--------------------------------------------
console.log('\n[1/2] 删除文件');
const DELETIONS = [
  'src/components/business/ai/thread/projection/from-runtime-tool-call.ts',
  'src/components/business/ai/thread/projection/from-runtime-tool-call.spec.ts',
  'src/components/business/ai/thread/projection/from-wire-tool-call.ts',
  'src/components/business/ai/thread/projection/from-wire-tool-call.spec.ts',
];
for (const p of DELETIONS) {
  remove(p);
}

// ---- 2) 摘除 projection 桶的两条 re-export ------------------------------------
console.log('\n[2/2] 编辑 projection/index.ts');
{
  const p = 'src/components/business/ai/thread/projection/index.ts';
  let src = toLf(read(p)); // LF
  src = replaceOnce(src, "export * from './from-runtime-tool-call';\n", '');
  src = replaceOnce(src, "export * from './from-wire-tool-call';\n", '');
  write(p, src);
}

console.log(`\n完成${CHECK ? '(干跑,未落盘)' : ''}。`);