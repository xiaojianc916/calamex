#!/usr/bin/env node
// 消除 list_git_stashes 的死计算：删除前端从不消费的 stash 逐文件 diff 明细。
// 跨 3 文件原子修改（任一锚点失配 → 零写入退出）。
// 用法（仓库根目录）：node fix-stash-list-drop-dead-diff.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const errors = [];
const files = new Map();

function load(rel) {
  const abs = resolve(process.cwd(), rel);
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    errors.push(`无法读取 ${rel}：${e.message}`);
    return null;
  }
  const usesCRLF = raw.includes("\r\n");
  const f = { rel, abs, usesCRLF, text: usesCRLF ? raw.replace(/\r\n/g, "\n") : raw };
  files.set(rel, f);
  return f;
}

function edit(f, { oldStr, newStr, label, applied }) {
  if (!f) return;
  const n = f.text.split(oldStr).length - 1;
  if (n === 1) {
    f.text = f.text.replace(oldStr, () => newStr);
    return;
  }
  if (n === 0) {
    if (applied && applied(f.text)) return; // 幂等：已应用
    errors.push(`[${f.rel}] 锚点未找到：${label}`);
    return;
  }
  errors.push(`[${f.rel}] 锚点不唯一（${n} 次）：${label}`);
}

// 删除 [startMarker, endMarker) 之间内容（保留 endMarker）。
function removeBetween(f, startMarker, endMarker, label, applied) {
  if (!f) return;
  if (applied && applied(f.text)) return;
  const sc = f.text.split(startMarker).length - 1;
  const ec = f.text.split(endMarker).length - 1;
  if (sc === 0 || ec === 0) {
    errors.push(`[${f.rel}] removeBetween 锚点缺失：${label}`);
    return;
  }
  if (sc > 1 || ec > 1) {
    errors.push(`[${f.rel}] removeBetween 锚点不唯一：${label}`);
    return;
  }
  const s = f.text.indexOf(startMarker);
  const e = f.text.indexOf(endMarker);
  if (e <= s) {
    errors.push(`[${f.rel}] removeBetween 顺序异常：${label}`);
    return;
  }
  f.text = f.text.slice(0, s) + f.text.slice(e);
}

const STASH = "src-tauri/src/commands/git/stash.rs";
const GITRS = "src-tauri/src/commands/git.rs";
const TAURI = "src/bindings/tauri.ts";
const fStash = load(STASH);
const fGit = load(GITRS);
const fTauri = load(TAURI);

// ── stash.rs ────────────────────────────────────────────────────────────
// (a) build_git_stash_entry_payload：去掉 build_git_stash_details 调用，改为内联廉价 created_at。
edit(fStash, {
  label: "stash.rs: entry payload 内联 created_at",
  applied: (t) => !t.includes("let details = build_git_stash_details(repository, oid)?;"),
  oldStr:
    "    let details = build_git_stash_details(repository, oid)?;\n" +
    "    let (branch_name, commit_short_id) = parse_git_stash_name(summary);",
  newStr:
    "    let (branch_name, commit_short_id) = parse_git_stash_name(summary);\n" +
    "    // 列表项只取廉价的提交时间。原先对每条 stash 都跑 rev_parse 三棵树 + 逐文件行级 diff\n" +
    "    // 统计增删/文件列表，但前端 stash 面板从不消费这些字段，纯属死计算（stash 多/改动大时\n" +
    "    // 拖慢面板首屏首次渲染），故移除；created_at 仅读提交时间，不含任何 diff。\n" +
    "    let created_at = repository\n" +
    "        .find_commit(oid)\n" +
    "        .ok()\n" +
    "        .and_then(|commit| commit.time().ok())\n" +
    "        .and_then(|time| jiff::Timestamp::from_second(time.seconds).ok())\n" +
    "        .unwrap_or_else(jiff::Timestamp::now)\n" +
    "        .to_string();",
});

// (b) struct 字面量尾部：去掉 4 个明细字段。
edit(fStash, {
  label: "stash.rs: entry payload 字面量去明细字段",
  applied: (t) => !t.includes("created_at: details.created_at,"),
  oldStr:
    "        created_at: details.created_at,\n" +
    "        file_count: details.file_count,\n" +
    "        additions: details.additions,\n" +
    "        deletions: details.deletions,\n" +
    "        files: details.files,\n" +
    "    })",
  newStr: "        created_at,\n    })",
});

// (c) 删除 build_git_stash_details + collect_stash_tree_changes + struct GitStashDetails。
removeBetween(
  fStash,
  "/// 通过 gix 解析贮藏提交的差异，构建明细（增删行数 + 文件列表），避免依赖系统安装的 git。\n",
  "fn parse_git_stash_name(",
  "stash.rs: 删除死的 stash 明细函数与结构体",
  (t) => !t.includes("fn build_git_stash_details"),
);

// ── git.rs ──────────────────────────────────────────────────────────────
// (1) GitStashEntryPayload 去掉 4 个明细字段。
edit(fGit, {
  label: "git.rs: GitStashEntryPayload 去明细字段",
  applied: (t) => !t.includes("    files: Vec<GitStashFilePayload>,"),
  oldStr:
    "    created_at: String,\n" +
    "    #[specta(type = u32)]\n" +
    "    file_count: usize,\n" +
    "    additions: u32,\n" +
    "    deletions: u32,\n" +
    "    files: Vec<GitStashFilePayload>,\n" +
    "}",
  newStr: "    created_at: String,\n}",
});

// (2) 删除 GitStashFilePayload 结构体（现已无引用）。
edit(fGit, {
  label: "git.rs: 删除 GitStashFilePayload",
  applied: (t) => !t.includes("pub struct GitStashFilePayload"),
  oldStr:
    "#[derive(Debug, Serialize, Clone, specta::Type)]\n" +
    '#[serde(rename_all = "camelCase")]\n' +
    "pub struct GitStashFilePayload {\n" +
    "    relative_path: String,\n" +
    "    file_name: String,\n" +
    "    previous_relative_path: Option<String>,\n" +
    "    status: String,\n" +
    "    additions: u32,\n" +
    "    deletions: u32,\n" +
    "}\n\n",
  newStr: "",
});

// ── bindings/tauri.ts（specta 生成）────────────────────────────────────────
// (1) GitStashEntryPayload 去掉 4 个明细字段（制表符缩进）。
edit(fTauri, {
  label: "tauri.ts: GitStashEntryPayload 去明细字段",
  applied: (t) => !t.includes("\tfiles: GitStashFilePayload[],"),
  oldStr:
    "\tcreatedAt: string,\n" +
    "\tfileCount: number,\n" +
    "\tadditions: number,\n" +
    "\tdeletions: number,\n" +
    "\tfiles: GitStashFilePayload[],\n" +
    "};",
  newStr: "\tcreatedAt: string,\n};",
});

// (2) 删除 GitStashFilePayload 类型。
edit(fTauri, {
  label: "tauri.ts: 删除 GitStashFilePayload 类型",
  applied: (t) => !t.includes("export type GitStashFilePayload"),
  oldStr:
    "export type GitStashFilePayload = {\n" +
    "\trelativePath: string,\n" +
    "\tfileName: string,\n" +
    "\tpreviousRelativePath: string | null,\n" +
    "\tstatus: string,\n" +
    "\tadditions: number,\n" +
    "\tdeletions: number,\n" +
    "};\n\n",
  newStr: "",
});

// ── 提交：任一错误则零写入 ──────────────────────────────────────────────────
if (errors.length > 0) {
  console.error("✗ 中止，未写入任何文件：");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
for (const f of files.values()) {
  const out = f.usesCRLF ? f.text.replace(/\n/g, "\r\n") : f.text;
  writeFileSync(f.abs, out, "utf8");
  console.log(`✓ 已更新 ${f.rel}`);
}
console.log("✓ stash 死计算已移除（列表零 diff）。");