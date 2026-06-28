// fix-all.mjs —— calamex 代码审查修复合集
// 幂等 / 锚点校验 / 不匹配即跳过（绝不破坏文件）。用法：node fix-all.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
let hardFail = false;
const log = (s) => console.log(s);
const abs = (rel) => path.join(ROOT, rel);
async function readMaybe(rel) {
  try { return await readFile(abs(rel), "utf8"); } catch { return null; }
}

// 1) shell_integration.rs：filter() 无 ESC 快路径（通常已在，仅校验；缺失才补）
async function fixShellIntegration() {
  const rel = "src-tauri/src/terminal/shell_integration.rs";
  const src = await readMaybe(rel);
  if (src == null) { log(`• 跳过(读不到)：${rel}`); return; }
  const hasFast =
    src.includes("!input.contains(ESC)") &&
    /out\.push_str\(input\);\s*\n\s*return \(out, marks\);/.test(src);
  if (hasFast) { log("• 已是最新：filter() 无 ESC 快路径已存在"); return; }
  const anchor = "\n        for c in input.chars() {";
  if (!src.includes(anchor)) { log("✗ 锚点未匹配，跳过：shell_integration 快路径"); hardFail = true; return; }
  const block =
    "\n        // 快路径：Normal 态且无半截缓存时，本段不含 ESC 即无任何 OSC/转义序列，\n" +
    "        // 整段拷贝，避免纯文本输出逐字符 push（O(n) push 降为一次 memcpy）。\n" +
    "        if self.state == FilterState::Normal && self.pending.is_empty() && !input.contains(ESC) {\n" +
    "            out.push_str(input);\n" +
    "            return (out, marks);\n" +
    "        }\n";
  await writeFile(abs(rel), src.replace(anchor, block + anchor));
  log("✓ 已应用：filter() 无 ESC 快路径");
}

// 2) workspace_fs.rs：is_workspace_directory_entry 仅对 symlink 额外 stat（通常已在）
async function fixWorkspaceFs() {
  const rel = "src-tauri/src/commands/workspace_fs.rs";
  const src = await readMaybe(rel);
  if (src == null) { log(`• 跳过(读不到)：${rel}`); return; }
  if (src.includes("if file_type.is_symlink() {") &&
      src.includes("if file_type.is_dir() {\n        return true;")) {
    log("• 已是最新：workspace_fs 仅 symlink 额外 stat"); return;
  }
  const oldExpr = "file_type.is_dir() || fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())";
  if (!src.includes(oldExpr)) { log("✗ 锚点未匹配，跳过：workspace_fs"); hardFail = true; return; }
  const replacement =
    "if file_type.is_dir() {\n        return true;\n    }\n" +
    "    if file_type.is_symlink() {\n" +
    "        return fs::metadata(path).is_ok_and(|metadata| metadata.is_dir());\n    }\n    false";
  await writeFile(abs(rel), src.replace(oldExpr, replacement));
  log("✓ 已应用：workspace_fs 仅 symlink 额外 stat");
}

// 3) fuzzy-score.ts：DP 外预计算（仅校验，不改动）
async function verifyFuzzyScore() {
  const rel = "src/utils/core/fuzzy-score.ts";
  const src = await readMaybe(rel);
  if (src == null) { log(`• 跳过(读不到)：${rel}`); return; }
  log(src.includes("CHAR_CLASS_LUT")
    ? "• 已是最新：fuzzy-score DP 外预计算已存在"
    : `• 未检出预计算标记，跳过（不改动 ${rel}）`);
}

// 4) branches.rs：删除与 worktree_io 逐字相同的 5 个私有副本，调用点改为复用
async function fixBranchesDedup() {
  const rel = "src-tauri/src/commands/git/branches.rs";
  const src = await readMaybe(rel);
  if (src == null) { log(`✗ 读不到：${rel}`); hardFail = true; return; }
  if (src.includes("super::worktree_io::restore_worktree_from_index_blob(")) {
    log("• 已是最新：branches.rs 已复用 worktree_io"); return;
  }
  const dupStart = "/// 从工作区删除某路径（忽略不存在的情况）。\nfn checkout_remove_worktree_path(";
  const idx = src.indexOf(dupStart);
  if (idx === -1) { log("✗ 锚点未匹配，跳过：branches.rs 副本起点"); hardFail = true; return; }
  const tail = src.slice(idx);
  const required = [
    "fn checkout_remove_worktree_path(", "fn checkout_restore_worktree_blob(",
    "fn checkout_upsert_index_entry(", "fn checkout_remove_index_path(",
    "fn checkout_recreate_symlink(",
  ];
  if (!required.every((s) => tail.includes(s))) { log("✗ 尾段结构不符预期，跳过：branches.rs"); hardFail = true; return; }

  // (a) 删除文件末尾这 5 个连续副本
  let out = src.slice(0, idx).replace(/\s+$/, "") + "\n";
  // (b) 8 处调用改为复用 worktree_io 的同名 pub(super) 函数
  const callMap = [
    ["checkout_restore_worktree_blob(", "super::worktree_io::restore_worktree_from_index_blob("],
    ["checkout_upsert_index_entry(", "super::worktree_io::upsert_index_entry("],
    ["checkout_remove_worktree_path(", "super::worktree_io::remove_worktree_path("],
    ["checkout_remove_index_path(", "super::worktree_io::remove_index_path("],
  ];
  for (const [from, to] of callMap) out = out.split(from).join(to);
  // (c) 终检：旧 token 必须全部消失
  const leftover = required.map((s) => s.replace("fn ", "") )
    .filter((t) => out.includes(t));
  if (leftover.length) { log(`✗ 仍残留旧引用，放弃写入：${leftover.join(", ")}`); hardFail = true; return; }

  await writeFile(abs(rel), out);
  log("✓ 已应用：branches.rs 去重（删 5 个副本 + 8 处调用改为复用 worktree_io）");
}

log("== calamex 修复合集 ==");
await fixShellIntegration();
await fixWorkspaceFs();
await verifyFuzzyScore();
await fixBranchesDedup();
log(hardFail
  ? "\n⚠ 有步骤因锚点不匹配被跳过（文件未被破坏），请核对后重跑。"
  : "\n全部完成。");
process.exit(hardFail ? 1 : 0);