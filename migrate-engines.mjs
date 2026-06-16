#!/usr/bin/env node
// migrate-engines.mjs —— engines/ 按域重组 + 自动改写所有相对 import
// 用法：
//   node migrate-engines.mjs --dry-run   # 只打印将发生的改动，不写盘
//   node migrate-engines.mjs             # 执行 git mv + 重写 import（不自动 commit）
// 前置：在仓库根 (calamex) 运行；工作区干净；已切到 main 或新建分支。

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DRY = process.argv.includes("--dry-run");
const REPO = process.cwd();
const ENG = "agent-sidecar/src/engines";

// 重写 import 时要覆盖的扫描根（engines 外的文件也 import engines，必须一起改）
const SCAN_ROOTS = ["agent-sidecar/src", "src"];

// —— 文件级移动：旧相对路径 -> 新相对路径（相对仓库根，posix 斜杠）——
const fileMoves = {
  [`${ENG}/base.ts`]:                 `${ENG}/runtime/base.ts`,
  [`${ENG}/runtime.ts`]:              `${ENG}/runtime/runtime.ts`,
  [`${ENG}/rollback.ts`]:             `${ENG}/runtime/composition.ts`,   // 唯一重命名
  [`${ENG}/mastra-runtime.ts`]:       `${ENG}/runtime/mastra-runtime.ts`,

  [`${ENG}/chat/chat.ts`]:            `${ENG}/modes/chat.ts`,
  [`${ENG}/chat/chat.spec.ts`]:       `${ENG}/modes/chat.spec.ts`,
  [`${ENG}/plan/plan.ts`]:            `${ENG}/modes/plan.ts`,
  [`${ENG}/plan/plan.spec.ts`]:       `${ENG}/modes/plan.spec.ts`,
  [`${ENG}/validation.ts`]:           `${ENG}/modes/validation.ts`,
  [`${ENG}/validation.spec.ts`]:      `${ENG}/modes/validation.spec.ts`,
  [`${ENG}/execution.ts`]:            `${ENG}/modes/execution.ts`,
  [`${ENG}/execution.spec.ts`]:       `${ENG}/modes/execution.spec.ts`,

  [`${ENG}/workspace.ts`]:            `${ENG}/workspace/workspace.ts`,
  [`${ENG}/workspace.spec.ts`]:       `${ENG}/workspace/workspace.spec.ts`,
  [`${ENG}/search-index.ts`]:         `${ENG}/workspace/search-index.ts`,
  [`${ENG}/search-index.spec.ts`]:    `${ENG}/workspace/search-index.spec.ts`,
  [`${ENG}/bm25-tokenizer.ts`]:       `${ENG}/workspace/bm25-tokenizer.ts`,
  [`${ENG}/bm25-tokenizer.spec.ts`]:  `${ENG}/workspace/bm25-tokenizer.spec.ts`,

  [`${ENG}/responses.ts`]:            `${ENG}/responses/responses.ts`,
  [`${ENG}/responses.spec.ts`]:       `${ENG}/responses/responses.spec.ts`,

  [`${ENG}/types.ts`]:                `${ENG}/shared/types.ts`,
  [`${ENG}/utils.ts`]:                `${ENG}/shared/utils.ts`,
  [`${ENG}/errors.ts`]:               `${ENG}/shared/errors.ts`,
};

// —— 目录级前缀移动：approval-client/ -> approval/ ——
const dirMoves = [{ from: `${ENG}/approval-client/`, to: `${ENG}/approval/` }];

// ---------- 工具函数 ----------
const toPosix = (p) => p.split(path.sep).join("/");
const fromPosix = (p) => p.split("/").join(path.sep);
const exists = (rel) => fs.existsSync(path.join(REPO, fromPosix(rel)));

function walk(dir, acc) {
  const abs = path.join(REPO, fromPosix(dir));
  if (!fs.existsSync(abs)) return acc;
  for (const name of fs.readdirSync(abs)) {
    if (["node_modules", "target", ".git", "dist", "build"].includes(name)) continue;
    const rel = `${dir}/${name}`;
    const st = fs.statSync(path.join(REPO, fromPosix(rel)));
    if (st.isDirectory()) walk(rel, acc);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) acc.push(toPosix(rel));
  }
  return acc;
}

// 全量源文件集合（旧状态），用于模块解析
const allFiles = new Set();
for (const root of SCAN_ROOTS) walk(root, []).forEach((f) => allFiles.add(f));

// 展开目录级移动到 fileMoves
for (const { from, to } of dirMoves) {
  for (const f of [...allFiles]) {
    if (f.startsWith(from)) fileMoves[f] = to + f.slice(from.length);
  }
}

// 过滤掉磁盘上不存在的源（如某些 spec 本就不存在），避免 git mv 报错
const moves = Object.entries(fileMoves).filter(([oldRel]) => {
  const ok = allFiles.has(oldRel);
  if (!ok) console.warn(`· 跳过（源不存在）：${oldRel}`);
  return ok;
});
const moveMap = Object.fromEntries(moves);

// 把一条相对 import 解析成"旧的真实源文件相对路径"（解析不到返回 null = 外部/包）
function resolveLocal(importerOldRel, spec) {
  if (!spec.startsWith(".")) return null;
  const baseDir = path.posix.dirname(importerOldRel);
  const raw = path.posix.normalize(path.posix.join(baseDir, spec));
  const noJs = raw.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const cands = [
    raw, `${noJs}.ts`, `${noJs}.tsx`, `${noJs}.mts`, `${noJs}.cts`,
    `${raw}.ts`, `${raw}.tsx`, `${noJs}/index.ts`, `${noJs}/index.tsx`, `${raw}/index.ts`,
  ];
  for (const c of cands) if (allFiles.has(c)) return c;
  return null;
}

const IMPORT_RE = [
  /\bfrom\s*(['"])(\.[^'"]+)\1/g,                 // import/export ... from '...'
  /\bimport\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g,     // dynamic import('...')
  /\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g,    // require('...')
];

// 逐文件计算改写后的内容（key = 旧相对路径）
const rewritten = new Map();
let totalEdits = 0;
for (const oldRel of allFiles) {
  const newRel = moveMap[oldRel] || oldRel;
  const newDir = path.posix.dirname(newRel);
  let content = fs.readFileSync(path.join(REPO, fromPosix(oldRel)), "utf8");
  let edits = 0;

  for (const re of IMPORT_RE) {
    content = content.replace(re, (full, q, spec) => {
      const targetOld = resolveLocal(oldRel, spec);
      if (!targetOld) return full;                          // 外部依赖，不动
      const targetNew = moveMap[targetOld] || targetOld;
      if (oldRel === newRel && targetOld === targetNew) return full; // 两端都没动
      const targetNoExt = targetNew.replace(/\.(ts|tsx|mts|cts)$/, "");
      let rel = path.posix.relative(newDir, targetNoExt);
      if (!rel.startsWith(".")) rel = "./" + rel;
      const ext = /\.(js|jsx|mjs|cjs)$/.test(spec) ? ".js" : "";
      const newSpec = rel + ext;
      if (newSpec === spec) return full;
      edits++;
      return full.replace(spec, newSpec);
    });
  }
  if (edits > 0) { rewritten.set(oldRel, content); totalEdits += edits; }
}

// ---------- 输出 / 执行 ----------
console.log(`\n移动文件：${moves.length} 个；改写 import 的文件：${rewritten.size} 个；改写条数：${totalEdits}\n`);
if (DRY) {
  console.log("== git mv 计划 ==");
  for (const [o, n] of moves) console.log(`  ${o}  ->  ${n}`);
  console.log("\n== 受影响（import 被改写）的文件 ==");
  for (const f of rewritten.keys()) console.log(`  ${moveMap[f] || f}`);
  console.log("\n[dry-run] 未写盘。确认无误后去掉 --dry-run 重跑。");
  process.exit(0);
}

// 1) git mv（先建目标目录）
for (const [oldRel, newRel] of moves) {
  fs.mkdirSync(path.join(REPO, fromPosix(path.posix.dirname(newRel))), { recursive: true });
  execSync(`git mv "${oldRel}" "${newRel}"`, { cwd: REPO, stdio: "inherit" });
}
// 2) 写回改写后的内容（写到新路径）
for (const [oldRel, content] of rewritten) {
  fs.writeFileSync(path.join(REPO, fromPosix(moveMap[oldRel] || oldRel)), content, "utf8");
}
execSync(`git add -A`, { cwd: REPO, stdio: "inherit" });
console.log("\n完成。请先 `git status` / `git diff --staged` 审阅，再自行 commit。");