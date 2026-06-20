#!/usr/bin/env node
// 8.2b · 退役 AiThreadTimeline 死组件 + 随之死掉的 buildThreadEntries 投影链
//        —— render 双轨正式塌缩为 entries 单一真相源(ADR-0014)。
//
// 已由本地双份 grep 确证(search_code 不可用 → 用户本地 grep 兜底):
//   · AiThreadTimeline 全仓无运行时 import(仅自身 spec / thread 桶导出 / 注释 / 文档 / 历史脚本)
//   · buildThreadEntries 唯一运行时消费者即 AiThreadTimeline.vue;删后仅余 spec 与定义自身
//   · AiChatThread(8.1b 起 entries-only)与 reduce 实时路径均不依赖 buildThreadEntries
//     → 删除不影响 plan-control / 实时渲染
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

console.log(`8.2b 退役 AiThreadTimeline 链 @ ${REPO_ROOT}${CHECK ? '  (--check 干跑)' : ''}`);

// ---- 1) 删除死组件与投影链(及其 spec)-----------------------------------------
console.log('\n[1/3] 删除文件');
const DELETIONS = [
  'src/components/business/ai/thread/AiThreadTimeline.vue',
  'src/components/business/ai/thread/AiThreadTimeline.spec.ts',
  'src/components/business/ai/thread/projection/build-thread-entries.ts',
  'src/components/business/ai/thread/projection/build-thread-entries.spec.ts',
  'src/components/business/ai/thread/projection/build-thread-entries.acp.spec.ts',
  'src/components/business/ai/thread/projection/render-parity.golden.spec.ts',
];
for (const p of DELETIONS) {
  remove(p);
}

// ---- 2) 摘除桶导出 ------------------------------------------------------------
console.log('\n[2/3] 编辑桶导出');
{
  // thread 桶:移除 AiThreadTimeline 具名默认导出
  const p = 'src/components/business/ai/thread/index.ts';
  let src = toLf(read(p)); // LF
  src = replaceOnce(
    src,
    "export { default as AiThreadTimeline } from './AiThreadTimeline.vue';\n",
    '',
  );
  write(p, src);
}
{
  // projection 桶:移除 build-thread-entries re-export(8.2a 已先行摘除 single-message / reconcile)
  const p = 'src/components/business/ai/thread/projection/index.ts';
  let src = toLf(read(p)); // LF
  src = replaceOnce(src, "export * from './build-thread-entries';\n", '');
  write(p, src);
}

// ---- 3) 注释保真:AiThreadEntryView 调用方已收敛为单一 entries 路径 -------------
console.log('\n[3/3] 注释保真');
{
  const p = 'src/components/business/ai/thread/AiThreadEntryView.vue';
  let src = toLf(read(p)); // LF
  src = replaceOnce(
    src,
    '// 单条平铺时间线条目的渲染分派。三处调用方(AiThreadTimeline / AiThreadSingleMessageTimeline /\n' +
      '// AiChatThread 的逐 entry 虚拟化路径)共用本组件;按 kind 差异化的 patches / workspace 透传\n' +
      '// 经独立 props 承载,以保持各调用方既有行为不变。\n',
    '// 单条平铺时间线条目的渲染分派。当前唯一调用方为 AiChatThread 的逐 entry 虚拟化路径;\n' +
      '// 按 kind 差异化的 patches / workspace 透传经独立 props 承载,以保持调用方行为不变。\n',
  );
  write(p, src);
}

console.log(`\n完成${CHECK ? '(干跑,未落盘)' : ''}。`);