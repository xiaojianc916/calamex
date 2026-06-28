// fix-branches.mjs —— branches.rs 去重（复用 worktree_io 的同名 pub(super) 函数）
// ASCII 锚点 + CRLF 容忍 + 幂等 + 不匹配即跳过（绝不破坏文件）。用法：node fix-branches.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rel = "src-tauri/src/commands/git/branches.rs";
const file = path.join(process.cwd(), rel);

let src;
try { src = await readFile(file, "utf8"); }
catch { console.log(`✗ 读不到：${rel}`); process.exit(1); }

if (src.includes("super::worktree_io::restore_worktree_from_index_blob(")) {
  console.log("• 已是最新：branches.rs 已复用 worktree_io");
  process.exit(0);
}

// 纯 ASCII 锚点：副本首个函数的签名（无换行，CRLF 安全）
const marker = "fn checkout_remove_worktree_path(";
const p = src.indexOf(marker);
if (p === -1) {
  console.log("✗ 锚点未匹配：未找到 fn checkout_remove_worktree_path(");
  console.log("  → 说明本地 branches.rs 与预期不同，请把该文件“末尾这几个 checkout_* 函数”贴给我。");
  process.exit(1);
}

// 结构校验：5 个副本（含 windows 版 recreate）都应在 marker 之后
const tail = src.slice(p);
const sigs = [
  "fn checkout_remove_worktree_path(",
  "fn checkout_restore_worktree_blob(",
  "fn checkout_upsert_index_entry(",
  "fn checkout_remove_index_path(",
  "fn checkout_recreate_symlink(",
];
const missing = sigs.filter((s) => !tail.includes(s));
if (missing.length) {
  console.log(`✗ 尾段结构不符预期，跳过：缺 ${missing.join(", ")}`);
  process.exit(1);
}

// 删除起点 = marker 所在行行首，并向上吞掉紧邻的 /// 文档注释与空行
let cut = src.lastIndexOf("\n", p) + 1;
while (cut > 0) {
  const prevEnd = cut - 1;                            // 上一行末尾的 '\n'
  const prevStart = src.lastIndexOf("\n", prevEnd - 1) + 1;
  const prevLine = src.slice(prevStart, prevEnd);     // 可能含尾随 '\r'
  const t = prevLine.trim();
  if (t === "" || t.startsWith("///")) cut = prevStart;
  else break;
}

// (a) 删除文件末尾这 5 个连续副本
let out = src.slice(0, cut).replace(/\s+$/, "") + "\n";

// (b) 8 处调用改为复用 worktree_io（token 级替换，缩进/CRLF 无关）
const callMap = [
  ["checkout_restore_worktree_blob(", "super::worktree_io::restore_worktree_from_index_blob("],
  ["checkout_upsert_index_entry(",    "super::worktree_io::upsert_index_entry("],
  ["checkout_remove_worktree_path(",  "super::worktree_io::remove_worktree_path("],
  ["checkout_remove_index_path(",     "super::worktree_io::remove_index_path("],
];
for (const [from, to] of callMap) out = out.split(from).join(to);

// (c) 终检：旧 checkout_* token 必须全部消失，否则放弃写入
const leftover = sigs.map((s) => s.slice(3)).filter((t) => out.includes(t));
if (leftover.length) {
  console.log(`✗ 仍残留旧引用，放弃写入：${leftover.join(", ")}`);
  process.exit(1);
}

await writeFile(file, out);
console.log("✓ 已应用：branches.rs 去重（删 5 个副本 + 8 处调用改为复用 worktree_io）");