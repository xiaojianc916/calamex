#!/usr/bin/env node
// fix-aed-snapshots-single-handle.mjs  (Stage 2 / 统一共享句柄)
// 目标：auto_apply::capture_checkpoint_snapshots 一次应用最多 3 次「开库+抢锁」→ 1 把写锁 + 1 个 Database 句柄。
//      snapshot.rs 暴露 lock-free 的 *_with_store 变体 + store_checkpoint_snapshots（单锁内顺序写）。
//      并为 snapshot_id 增加进程内原子单调序号，杜绝同锁内纳秒戳相同导致的 ID 覆盖。
// 不变量：句柄生命周期严格 ⊆ 写锁临界区；scope 去重判定、快照顺序、source_snapshot_id 回填均不变。
//
// 用法：node fix-aed-snapshots-single-handle.mjs
// 验证：cargo build -p calamex --features desktop --quiet
//      cargo test -p calamex ai::edit::history::snapshot --quiet
//      cargo test -p calamex ai::edit::apply::auto_apply --quiet
//
// 安全：仅精确锚点替换；任一锚点缺失/不唯一 → 整体放弃（exit 1），不写任何文件。
//      读入归一化为 LF 做匹配，写回还原文件原本 EOL（CRLF 文件保持 CRLF）。

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
// 1) snapshot.rs
// ============================================================================
const snap = loadState("src-tauri/src/ai/edit/history/snapshot.rs");

// 1a. 进程内原子单调序号（防同锁内纳秒戳相同 → snapshot_id 冲突覆盖）
edit(
  snap,
  `pub const DEFAULT_TOTAL_BLOB_QUOTA_BYTES: u64 = 1024 * 1024 * 1024;`,
  `pub const DEFAULT_TOTAL_BLOB_QUOTA_BYTES: u64 = 1024 * 1024 * 1024;

/// 进程内单调递增序列：与纳秒时间戳组合，确保同一把写锁内连续创建的多个快照
/// （task-start / turn-start / manual|pre-tool）即使纳秒时间戳相同也不会发生
/// snapshot_id 冲突、互相覆盖。
static SNAPSHOT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);`,
  "新增 SNAPSHOT_SEQ 原子序号",
  "static SNAPSHOT_SEQ",
);

// 1b. store_pre_tool_snapshot → 带锁壳 + lock-free with_store
edit(
  snap,
  `pub fn store_pre_tool_snapshot(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    let task_id = resolve_task_id(metadata);
    let label = resolve_label(metadata, summary, "Patch 前快照");

    store_snapshot(
        storage_root,
        SNAPSHOT_SCOPE_PRE_TOOL,
        &task_id,
        &label,
        files,
    )
}`,
  `pub fn store_pre_tool_snapshot(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    storage_lock::with_storage_write_lock(storage_root, "写入 AED 快照", || {
        let store = open_store(storage_root)?;
        store_pre_tool_snapshot_with_store(storage_root, &store, files, metadata, summary)
    })
}

fn store_pre_tool_snapshot_with_store(
    storage_root: &Path,
    store: &SnapshotStore,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    let task_id = resolve_task_id(metadata);
    let label = resolve_label(metadata, summary, "Patch 前快照");

    store_snapshot_with_store(
        storage_root,
        store,
        SNAPSHOT_SCOPE_PRE_TOOL,
        &task_id,
        &label,
        files,
    )
}`,
  "store_pre_tool_snapshot 拆 with_store",
  "fn store_pre_tool_snapshot_with_store(",
);

// 1c. store_task_start_snapshot → 带锁壳 + with_store
edit(
  snap,
  `pub fn store_task_start_snapshot(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    let task_id = resolve_task_id(metadata);
    let fallback_label = format!("任务起点：{}", summary.trim());
    let label = resolve_label(metadata, &fallback_label, "任务起点快照");

    store_snapshot(
        storage_root,
        SNAPSHOT_SCOPE_TASK_START,
        &task_id,
        &label,
        files,
    )
}`,
  `pub fn store_task_start_snapshot(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    storage_lock::with_storage_write_lock(storage_root, "写入 AED 快照", || {
        let store = open_store(storage_root)?;
        store_task_start_snapshot_with_store(storage_root, &store, files, metadata, summary)
    })
}

fn store_task_start_snapshot_with_store(
    storage_root: &Path,
    store: &SnapshotStore,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    let task_id = resolve_task_id(metadata);
    let fallback_label = format!("任务起点：{}", summary.trim());
    let label = resolve_label(metadata, &fallback_label, "任务起点快照");

    store_snapshot_with_store(
        storage_root,
        store,
        SNAPSHOT_SCOPE_TASK_START,
        &task_id,
        &label,
        files,
    )
}`,
  "store_task_start_snapshot 拆 with_store",
  "fn store_task_start_snapshot_with_store(",
);

// 1d. store_turn_start_snapshot → 带锁壳 + with_store
edit(
  snap,
  `pub fn store_turn_start_snapshot(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    let task_id = resolve_task_id(metadata);
    let turn_id = metadata
        .and_then(|value| value.turn_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("manual-turn");
    let fallback_label = format!("回合起点：{turn_id} · {}", summary.trim());
    let label = resolve_label(metadata, &fallback_label, "回合起点快照");

    store_snapshot(
        storage_root,
        SNAPSHOT_SCOPE_TURN_START,
        &task_id,
        &label,
        files,
    )
}`,
  `pub fn store_turn_start_snapshot(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    storage_lock::with_storage_write_lock(storage_root, "写入 AED 快照", || {
        let store = open_store(storage_root)?;
        store_turn_start_snapshot_with_store(storage_root, &store, files, metadata, summary)
    })
}

fn store_turn_start_snapshot_with_store(
    storage_root: &Path,
    store: &SnapshotStore,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    let task_id = resolve_task_id(metadata);
    let turn_id = metadata
        .and_then(|value| value.turn_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("manual-turn");
    let fallback_label = format!("回合起点：{turn_id} · {}", summary.trim());
    let label = resolve_label(metadata, &fallback_label, "回合起点快照");

    store_snapshot_with_store(
        storage_root,
        store,
        SNAPSHOT_SCOPE_TURN_START,
        &task_id,
        &label,
        files,
    )
}`,
  "store_turn_start_snapshot 拆 with_store",
  "fn store_turn_start_snapshot_with_store(",
);

// 1e. store_manual_snapshot → 带锁壳 + with_store，并追加 store_checkpoint_snapshots
edit(
  snap,
  `pub fn store_manual_snapshot(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    let task_id = resolve_task_id(metadata);
    let fallback_label = format!("手动确认：{}", summary.trim());
    let label = resolve_label(metadata, &fallback_label, "手动确认前快照");
    let label = if label.is_empty() {
        "手动确认前快照".to_string()
    } else {
        label
    };

    store_snapshot(storage_root, SNAPSHOT_SCOPE_MANUAL, &task_id, &label, files)
}`,
  `pub fn store_manual_snapshot(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    storage_lock::with_storage_write_lock(storage_root, "写入 AED 快照", || {
        let store = open_store(storage_root)?;
        store_manual_snapshot_with_store(storage_root, &store, files, metadata, summary)
    })
}

fn store_manual_snapshot_with_store(
    storage_root: &Path,
    store: &SnapshotStore,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> Result<AiSnapshotPayload, String> {
    let task_id = resolve_task_id(metadata);
    let fallback_label = format!("手动确认：{}", summary.trim());
    let label = resolve_label(metadata, &fallback_label, "手动确认前快照");
    let label = if label.is_empty() {
        "手动确认前快照".to_string()
    } else {
        label
    };

    store_snapshot_with_store(storage_root, store, SNAPSHOT_SCOPE_MANUAL, &task_id, &label, files)
}

/// 在单一写锁 + 单一 fjall 句柄内创建本次应用所需的全部检查点快照
/// （task-start / turn-start / manual|pre-tool）。
///
/// 原实现为每个快照各自获取一次写锁并重新打开 \`Database\`，一次应用最多 3 次
/// 「开库 + 加锁」。这里收敛为 1 次，句柄生命周期严格 ⊆ 写锁临界区。
///
/// 返回 \`(task_start, turn_start, source)\`，其中 \`source\` 为 manual 或 pre-tool
/// 快照，调用方据此回填 operation.source_snapshot_id。
#[allow(clippy::type_complexity)]
pub fn store_checkpoint_snapshots(
    storage_root: &Path,
    files: &[SnapshotSourceFile<'_>],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
    capture_task_start: bool,
    capture_turn_start: bool,
    confirmed_by_user: bool,
) -> Result<
    (
        Option<AiSnapshotPayload>,
        Option<AiSnapshotPayload>,
        AiSnapshotPayload,
    ),
    String,
> {
    storage_lock::with_storage_write_lock(storage_root, "写入 AED 检查点快照", || {
        let store = open_store(storage_root)?;

        let task_start = if capture_task_start {
            Some(store_task_start_snapshot_with_store(
                storage_root,
                &store,
                files,
                metadata,
                summary,
            )?)
        } else {
            None
        };

        let turn_start = if capture_turn_start {
            Some(store_turn_start_snapshot_with_store(
                storage_root,
                &store,
                files,
                metadata,
                summary,
            )?)
        } else {
            None
        };

        let source = if confirmed_by_user {
            store_manual_snapshot_with_store(storage_root, &store, files, metadata, summary)?
        } else {
            store_pre_tool_snapshot_with_store(storage_root, &store, files, metadata, summary)?
        };

        Ok((task_start, turn_start, source))
    })
}`,
  "store_manual_snapshot 拆 with_store + 新增 store_checkpoint_snapshots",
  "fn store_manual_snapshot_with_store(",
);

// 1f. store_snapshot_locked 拆出 lock-free store_snapshot_with_store（含原子序号 ID）
edit(
  snap,
  `fn store_snapshot_locked(
    storage_root: &Path,
    scope: &str,
    task_id: &str,
    label: &str,
    files: &[SnapshotSourceFile<'_>],
) -> Result<AiSnapshotPayload, String> {
    let store = open_store(storage_root)?;
    let timestamp = Timestamp::now();
    let snapshot_id = format!("ai-edit-snapshot-{}", timestamp.as_nanosecond());`,
  `fn store_snapshot_locked(
    storage_root: &Path,
    scope: &str,
    task_id: &str,
    label: &str,
    files: &[SnapshotSourceFile<'_>],
) -> Result<AiSnapshotPayload, String> {
    let store = open_store(storage_root)?;
    store_snapshot_with_store(storage_root, &store, scope, task_id, label, files)
}

fn store_snapshot_with_store(
    storage_root: &Path,
    store: &SnapshotStore,
    scope: &str,
    task_id: &str,
    label: &str,
    files: &[SnapshotSourceFile<'_>],
) -> Result<AiSnapshotPayload, String> {
    let timestamp = Timestamp::now();
    let snapshot_id = format!(
        "ai-edit-snapshot-{}-{}",
        timestamp.as_nanosecond(),
        SNAPSHOT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );`,
  "store_snapshot_locked 拆 with_store",
  "fn store_snapshot_with_store(",
);

// ============================================================================
// 2) auto_apply.rs
// ============================================================================
const apply = loadState("src-tauri/src/ai/edit/apply/auto_apply.rs");

edit(
  apply,
  `fn capture_checkpoint_snapshots(
    plans: &[AiAutoApplyOperationPlan],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
    state: &AiEditState,
    storage_root: &Path,
) -> Result<Option<String>, String> {
    let snapshot_sources = build_snapshot_sources(plans);
    let task_id = resolve_task_id(metadata);

    if ai_edit::mark_snapshot_scope(state, format!("task-start:{task_id}"))? {
        let snapshot = snapshot::store_task_start_snapshot(
            storage_root,
            &snapshot_sources,
            metadata,
            summary,
        )?;
        ai_edit::append_snapshot(state, storage_root, snapshot)?;
    }

    if let Some(turn_id) = resolve_turn_id(metadata)
        && ai_edit::mark_snapshot_scope(state, format!("turn-start:{turn_id}"))?
    {
        let snapshot = snapshot::store_turn_start_snapshot(
            storage_root,
            &snapshot_sources,
            metadata,
            summary,
        )?;
        ai_edit::append_snapshot(state, storage_root, snapshot)?;
    }

    let confirmed_by_user = metadata
        .and_then(|value| value.confirmed_by_user)
        .unwrap_or(false);

    let source_snapshot = if confirmed_by_user {
        snapshot::store_manual_snapshot(storage_root, &snapshot_sources, metadata, summary)?
    } else {
        snapshot::store_pre_tool_snapshot(storage_root, &snapshot_sources, metadata, summary)?
    };

    let source_snapshot_id = source_snapshot.id.clone();
    ai_edit::append_snapshot(state, storage_root, source_snapshot)?;

    Ok(Some(source_snapshot_id))
}`,
  `fn capture_checkpoint_snapshots(
    plans: &[AiAutoApplyOperationPlan],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
    state: &AiEditState,
    storage_root: &Path,
) -> Result<Option<String>, String> {
    let snapshot_sources = build_snapshot_sources(plans);
    let task_id = resolve_task_id(metadata);

    // 先做幂等去重判定（仅操作内存中的 scope 标记），再在「单锁单句柄」内一次性
    // 写入全部检查点快照，最后按原顺序把快照登记到内存时间线。
    // 把原先一次应用最多 3 次「开库 + 加锁」收敛为 1 次。
    let capture_task_start =
        ai_edit::mark_snapshot_scope(state, format!("task-start:{task_id}"))?;

    let capture_turn_start = match resolve_turn_id(metadata) {
        Some(turn_id) => ai_edit::mark_snapshot_scope(state, format!("turn-start:{turn_id}"))?,
        None => false,
    };

    let confirmed_by_user = metadata
        .and_then(|value| value.confirmed_by_user)
        .unwrap_or(false);

    let (task_start_snapshot, turn_start_snapshot, source_snapshot) =
        snapshot::store_checkpoint_snapshots(
            storage_root,
            &snapshot_sources,
            metadata,
            summary,
            capture_task_start,
            capture_turn_start,
            confirmed_by_user,
        )?;

    if let Some(snapshot) = task_start_snapshot {
        ai_edit::append_snapshot(state, storage_root, snapshot)?;
    }
    if let Some(snapshot) = turn_start_snapshot {
        ai_edit::append_snapshot(state, storage_root, snapshot)?;
    }

    let source_snapshot_id = source_snapshot.id.clone();
    ai_edit::append_snapshot(state, storage_root, source_snapshot)?;

    Ok(Some(source_snapshot_id))
}`,
  "capture_checkpoint_snapshots 收敛为单锁单句柄",
  `snapshot::store_checkpoint_snapshots(`,
);

// ============================================================================
// 汇总：任一文件有错误则整体放弃，不写盘；写回还原各文件原本 EOL
// ============================================================================
const states = [snap, apply];
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