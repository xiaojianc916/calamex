#!/usr/bin/env node
// fix-aed-retention-frequency.mjs  (Stage 3b)
// 目标：一次 apply 的 retention 从 4 遍降到 1 遍。
// 解耦「登记快照到时间线」与「触发 retention 裁剪」：capture 阶段 3 次 append 不再各自裁剪，
// 由 apply_operation_plans 末尾那次 run_retention_policy_best_effort 统一收口。
// 依赖：Stage 2（capture_checkpoint_snapshots 已重写）已在 main —— 已确认。
// 与 Stage 3a 正交，可独立应用。
//
// 用法：node fix-aed-retention-frequency.mjs
// 验证：cargo build -p calamex --features desktop --quiet
//      cargo test -p calamex ai::edit::apply::auto_apply --quiet
//      cargo test -p calamex ai::edit:: --quiet
//
// 安全：仅精确锚点替换；锚点缺失/不唯一 → 整体放弃(exit 1)，不写任何文件。
//      读入归一化 LF 匹配，写回还原各文件原本 EOL。

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function loadState(rel) {
  const path = resolve(ROOT, rel);
  const raw = readFileSync(path, "utf8");
  const usesCRLF = raw.includes("\r\n");
  return { rel, path, usesCRLF, text: raw.replace(/\r\n/g, "\n"), applied: [], skipped: [], errors: [] };
}

function edit(state, oldStr, newStr, label, marker) {
  if (marker && state.text.includes(marker)) {
    state.skipped.push(label);
    return;
  }
  const first = state.text.indexOf(oldStr);
  if (first === -1) {
    state.errors.push(`${label}：锚点未匹配`);
    return;
  }
  if (state.text.indexOf(oldStr, first + oldStr.length) !== -1) {
    state.errors.push(`${label}：锚点不唯一`);
    return;
  }
  state.text = state.text.slice(0, first) + newStr + state.text.slice(first + oldStr.length);
  state.applied.push(label);
}

// ============================================================================
// 1) mod.rs —— 新增 append_snapshot_without_retention，append_snapshot 委托之
// ============================================================================
const mod_ = loadState("src-tauri/src/ai/edit/mod.rs");

edit(
  mod_,
  `pub fn append_snapshot(
    state: &AiEditState,
    storage_root: &Path,
    snapshot: AiSnapshotPayload,
) -> Result<(), String> {
    {
        let mut guard = state.timeline.lock();
        guard.push(AiEditTimelineEntryPayload::Snapshot(snapshot));
    }
    run_retention_policy_best_effort(state, storage_root);
    Ok(())
}`,
  `pub fn append_snapshot(
    state: &AiEditState,
    storage_root: &Path,
    snapshot: AiSnapshotPayload,
) -> Result<(), String> {
    append_snapshot_without_retention(state, snapshot);
    run_retention_policy_best_effort(state, storage_root);
    Ok(())
}

/// 仅把快照登记进内存时间线，不触发本地历史保留（retention）裁剪。
///
/// 用于一次应用内连续登记多张检查点快照（task-start / turn-start / source）的场景：
/// 这些 append 紧挨着发生，期间逐个跑 retention 纯属重复——\`apply_operation_plans\`
/// 会在提交后统一调用一次 \`run_retention_policy_best_effort\` 收口。把「登记」与
/// 「裁剪」解耦后，一次 apply 的 retention 次数从最多 4 次降到 1 次。
pub(crate) fn append_snapshot_without_retention(
    state: &AiEditState,
    snapshot: AiSnapshotPayload,
) {
    let mut guard = state.timeline.lock();
    guard.push(AiEditTimelineEntryPayload::Snapshot(snapshot));
}`,
  "mod.rs append_snapshot_without_retention",
  "pub(crate) fn append_snapshot_without_retention(",
);

// ============================================================================
// 2) auto_apply.rs —— capture 的 3 次 append 改为不触发 retention
// ============================================================================
const auto = loadState("src-tauri/src/ai/edit/apply/auto_apply.rs");

edit(
  auto,
  `    if let Some(snapshot) = task_start_snapshot {
        ai_edit::append_snapshot(state, storage_root, snapshot)?;
    }
    if let Some(snapshot) = turn_start_snapshot {
        ai_edit::append_snapshot(state, storage_root, snapshot)?;
    }

    let source_snapshot_id = source_snapshot.id.clone();
    ai_edit::append_snapshot(state, storage_root, source_snapshot)?;`,
  `    // 登记到内存时间线但不在此触发 retention：本次 apply 末尾的
    // run_retention_policy_best_effort 会统一收口，避免一次应用跑 4 遍 retention。
    if let Some(snapshot) = task_start_snapshot {
        ai_edit::append_snapshot_without_retention(state, snapshot);
    }
    if let Some(snapshot) = turn_start_snapshot {
        ai_edit::append_snapshot_without_retention(state, snapshot);
    }

    let source_snapshot_id = source_snapshot.id.clone();
    ai_edit::append_snapshot_without_retention(state, source_snapshot);`,
  "auto_apply capture 改用 append_snapshot_without_retention",
  "append_snapshot_without_retention(state, source_snapshot);",
);

// ============================================================================
// 汇总
// ============================================================================
const states = [mod_, auto];
const totalErrors = states.flatMap((s) => s.errors.map((e) => `${s.rel} :: ${e}`));

if (totalErrors.length > 0) {
  console.error("✗ 锚点校验失败，未改动任何文件：");
  for (const e of totalErrors) console.error("   - " + e);
  process.exit(1);
}

let wrote = 0;
for (const s of states) {
  if (s.applied.length > 0) {
    const out = s.usesCRLF ? s.text.replace(/\n/g, "\r\n") : s.text;
    writeFileSync(s.path, out, "utf8");
    wrote++;
    console.log(`✓ ${s.rel}  (${s.usesCRLF ? "CRLF" : "LF"})`);
    for (const a of s.applied) console.log(`    应用: ${a}`);
    for (const sk of s.skipped) console.log(`    跳过(已存在): ${sk}`);
  } else {
    console.log(`= ${s.rel}（全部已应用，跳过）`);
  }
}
console.log(`\n完成：写入 ${wrote} 个文件。请运行 cargo build/test 验证。`);