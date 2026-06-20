// 4.mjs — ④.3a 删除「被切换孤立」的 legacy 文件
// 目标：旧会话 store aiConversation(+3 specs) 与 entriesMirrorBridge(+spec)
// 前提：3.mjs(§C/§D/§E/§F)已落地 main@1674f5e2，这些文件已无任何 import 引用。
// 安全策略：全有或全无——
//   阶段1 校验每个目标“存在且 git-blob-sha 与评审版一致”；
//   阶段2 全部通过后才执行删除；任一不符立即抛错中止，且不删除任何文件。

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = dirname(fileURLToPath(import.meta.url));

/** 计算 git blob SHA-1（与 `git hash-object <file>` 完全一致）。 */
const gitBlobSha = (buf) =>
  createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// [相对路径, 评审时的 git blob sha @ main 1674f5e2]
const targets = [
  ['src/store/aiConversation.ts', 'b316e567b6592d5ae6449c2062fa090ddc2a5d2c'],
  ['src/store/aiConversation.store.spec.ts', '57344d7cbe41dffb43ebd9bb3a55d0ad27abaa75'],
  ['src/store/aiConversation.lazy.store.spec.ts', 'ae9fe7abd1a8ecc552822567fd10de205dabb9d0'],
  ['src/store/aiConversation.perf.store.spec.ts', '311fbc51d55db84a704db15b5ebe34a6511148a5'],
  ['src/store/aiThread/entriesMirrorBridge.ts', '78bcb4ccdaffce5047bece4c17985b6edc1d9c09'],
  ['src/store/aiThread/entriesMirrorBridge.spec.ts', '0c23a57d53116432097f19b929198257a98048ff'],
];

// ---- 阶段 1：校验（不做任何修改）----
const verified = [];
for (const [rel, expectedSha] of targets) {
  const abs = resolve(repoRoot, rel);
  if (!existsSync(abs)) {
    throw new Error(`[中止] 找不到目标文件：${rel}（未删除任何文件）`);
  }
  const actualSha = gitBlobSha(readFileSync(abs));
  if (actualSha !== expectedSha) {
    throw new Error(
      `[中止] 内容与评审版不一致：${rel}\n  期望 ${expectedSha}\n  实际 ${actualSha}\n` +
        `  （本地可能有改动；未删除任何文件，请确认后重试）`,
    );
  }
  verified.push({ rel, abs });
}

// ---- 阶段 2：执行删除（全部校验通过后）----
for (const { rel, abs } of verified) {
  rmSync(abs);
  console.log(`已删除 ${rel}`);
}

console.log(`\n④.3a 完成：删除 ${verified.length} 个 legacy 文件。`);