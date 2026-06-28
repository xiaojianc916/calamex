#!/usr/bin/env node
// fix-aed-retention-single-handle.mjs  (Stage 3a / 统一共享句柄)
// 目标：单次 AED retention 由 4 次「开库+抢锁」（list_ops/list_pins/prune/snapshot_gc）→ 1 把写锁 + 1 个 Database。
// 独立于 Stage 2（不碰 auto_apply / capture）。频率优化（4 遍→1 遍）属 Stage 3b，需 Stage 2 先落地。
//
// 用法：node fix-aed-retention-single-handle.mjs
// 验证：cargo build -p calamex --features desktop --quiet
//      cargo test -p calamex ai::edit::history --quiet
//      cargo test -p calamex ai::edit::mod --quiet   （或 cargo test -p calamex ai::edit:: --quiet）
//
// 安全：仅精确锚点替换；任一锚点缺失/不唯一 → 整体放弃（exit 1），不写任何文件。
//      读入归一化 LF 做匹配，写回还原各文件原本 EOL（CRLF 保持 CRLF）。

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
// 1) io/mod.rs —— 统一开库入口
// ============================================================================
const ioMod = loadState("src-tauri/src/ai/edit/io/mod.rs");

edit(
  ioMod,
  `pub mod atomic_write;
pub mod file_transaction;
pub mod storage_lock;`,
  `pub mod atomic_write;
pub mod file_transaction;
pub mod storage_lock;

use crate::ai::edit::errors;
use fjall::Database;
use std::path::Path;

const AED_DB_DIR: &str = "fjall";

/// 打开（或恢复）项目级 AED fjall 存储库的单一句柄。
///
/// 各历史子模块（operations / snapshots / pins / file_transactions）原本各自
/// \`Database::builder(...).open()\`，一次 retention 最多开 4 次库。这里提供统一入口，
/// 让调用方在单一写锁内只打开一次 \`Database\`、按需 \`db.keyspace(...)\` 复用同一句柄。
///
/// 不变量：调用方需自行持有 \`journal.lock\`（见 \`storage_lock\`）。
pub fn open_aed_database(storage_root: &Path) -> Result<Database, String> {
    Database::builder(storage_root.join(AED_DB_DIR))
        .open()
        .map_err(|error| errors::journal_failed(format!("打开 fjall AED 存储失败：{error}")))
}`,
  "io/mod.rs 新增 open_aed_database",
  "pub fn open_aed_database(",
);

// ============================================================================
// 2) edit_journal.rs —— list/prune 的 lock-free with_db
// ============================================================================
const journal = loadState("src-tauri/src/ai/edit/history/edit_journal.rs");

edit(
  journal,
  `fn list_operations_locked(storage_root: &Path) -> Result<Vec<AiEditOperationPayload>, String> {
    let store = open_store(storage_root)?;
    let mut operations = Vec::new();

    for item in store.operations.iter() {
        let (_key, value) = item
            .into_inner()
            .map_err(|error| errors::journal_failed(format!("读取 fjall 操作日志失败：{error}")))?;

        match serde_json::from_slice::<AiEditOperationPayload>(&value) {
            Ok(operation) => operations.push(operation),
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid fjall operation journal item"
                );
            }
        }
    }

    Ok(operations)
}`,
  `fn list_operations_locked(storage_root: &Path) -> Result<Vec<AiEditOperationPayload>, String> {
    let store = open_store(storage_root)?;
    list_operations_with_db(&store.db)
}

/// 复用调用方已打开的 fjall 句柄读取操作日志（lock-free 变体）。
///
/// 不变量：调用方须已持有 \`journal.lock\`（读或写锁），且 \`db\` 为同一存储目录上
/// 唯一存活句柄；供 retention 在单锁单句柄内复用。
pub fn list_operations_with_db(db: &Database) -> Result<Vec<AiEditOperationPayload>, String> {
    let operations = db
        .keyspace(OPERATIONS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::journal_failed(format!("打开 operations keyspace 失败：{error}"))
        })?;
    let mut result = Vec::new();

    for item in operations.iter() {
        let (_key, value) = item
            .into_inner()
            .map_err(|error| errors::journal_failed(format!("读取 fjall 操作日志失败：{error}")))?;

        match serde_json::from_slice::<AiEditOperationPayload>(&value) {
            Ok(operation) => result.push(operation),
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid fjall operation journal item"
                );
            }
        }
    }

    Ok(result)
}`,
  "edit_journal list_operations_with_db",
  "pub fn list_operations_with_db(",
);

edit(
  journal,
  `fn prune_operations_locked(
    storage_root: &Path,
    retained_operation_ids: &HashSet<String>,
) -> Result<JournalPruneOutcome, String> {
    let store = open_store(storage_root)?;
    let mut outcome = JournalPruneOutcome::default();
    let mut keys_to_remove = Vec::new();

    for item in store.operations.iter() {
        let (key, value) = item
            .into_inner()
            .map_err(|error| errors::journal_failed(format!("读取 fjall 操作日志失败：{error}")))?;

        let operation = match serde_json::from_slice::<AiEditOperationPayload>(&value) {
            Ok(operation) => operation,
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid fjall operation journal item during prune"
                );
                continue;
            }
        };

        if retained_operation_ids.contains(&operation.id) {
            continue;
        }

        outcome.reclaimed_bytes += value.len() as u64;
        outcome.removed_operation_ids.insert(operation.id);
        keys_to_remove.push(key.to_vec());
    }

    if outcome.removed_operation_ids.is_empty() {
        return Ok(outcome);
    }

    let mut batch = store.db.batch();
    for key in keys_to_remove {
        batch.remove(&store.operations, key);
    }
    batch
        .commit()
        .map_err(|error| errors::journal_failed(format!("裁剪 fjall 操作日志失败：{error}")))?;
    persist(&store.db)?;

    Ok(outcome)
}`,
  `fn prune_operations_locked(
    storage_root: &Path,
    retained_operation_ids: &HashSet<String>,
) -> Result<JournalPruneOutcome, String> {
    let store = open_store(storage_root)?;
    prune_operations_with_db(&store.db, retained_operation_ids)
}

/// 复用调用方已打开的 fjall 句柄裁剪操作日志（lock-free 变体）。
///
/// 不变量：调用方须已持有 \`journal.lock\` 写锁，且 \`db\` 为同一存储目录上唯一存活句柄。
pub fn prune_operations_with_db(
    db: &Database,
    retained_operation_ids: &HashSet<String>,
) -> Result<JournalPruneOutcome, String> {
    let operations = db
        .keyspace(OPERATIONS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::journal_failed(format!("打开 operations keyspace 失败：{error}"))
        })?;
    let mut outcome = JournalPruneOutcome::default();
    let mut keys_to_remove = Vec::new();

    for item in operations.iter() {
        let (key, value) = item
            .into_inner()
            .map_err(|error| errors::journal_failed(format!("读取 fjall 操作日志失败：{error}")))?;

        let operation = match serde_json::from_slice::<AiEditOperationPayload>(&value) {
            Ok(operation) => operation,
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid fjall operation journal item during prune"
                );
                continue;
            }
        };

        if retained_operation_ids.contains(&operation.id) {
            continue;
        }

        outcome.reclaimed_bytes += value.len() as u64;
        outcome.removed_operation_ids.insert(operation.id);
        keys_to_remove.push(key.to_vec());
    }

    if outcome.removed_operation_ids.is_empty() {
        return Ok(outcome);
    }

    let mut batch = db.batch();
    for key in keys_to_remove {
        batch.remove(&operations, key);
    }
    batch
        .commit()
        .map_err(|error| errors::journal_failed(format!("裁剪 fjall 操作日志失败：{error}")))?;
    persist(db)?;

    Ok(outcome)
}`,
  "edit_journal prune_operations_with_db",
  "pub fn prune_operations_with_db(",
);

// ============================================================================
// 3) pins.rs —— list_pin_records 的 lock-free with_db
// ============================================================================
const pins = loadState("src-tauri/src/ai/edit/history/pins.rs");

edit(
  pins,
  `fn list_pin_records_locked(storage_root: &Path) -> Result<Vec<PinRecord>, String> {
    let store = open_store(storage_root)?;
    let mut records = Vec::new();

    for item in store.pins.iter() {
        let (_key, value) = item
            .into_inner()
            .map_err(|error| errors::journal_failed(format!("读取 AED Pin 状态失败：{error}")))?;
        match serde_json::from_slice::<PinRecord>(&value) {
            Ok(record) => records.push(record),
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid AED pin record"
                );
            }
        }
    }

    Ok(records)
}`,
  `fn list_pin_records_locked(storage_root: &Path) -> Result<Vec<PinRecord>, String> {
    let store = open_store(storage_root)?;
    list_pin_records_with_db(&store.db)
}

/// 复用调用方已打开的 fjall 句柄读取 Pin 记录（lock-free 变体）。
///
/// 不变量：调用方须已持有 \`journal.lock\`，且 \`db\` 为同一存储目录上唯一存活句柄。
pub fn list_pin_records_with_db(db: &Database) -> Result<Vec<PinRecord>, String> {
    let pins = db
        .keyspace(PINS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| errors::journal_failed(format!("打开 pins keyspace 失败：{error}")))?;
    let mut records = Vec::new();

    for item in pins.iter() {
        let (_key, value) = item
            .into_inner()
            .map_err(|error| errors::journal_failed(format!("读取 AED Pin 状态失败：{error}")))?;
        match serde_json::from_slice::<PinRecord>(&value) {
            Ok(record) => records.push(record),
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid AED pin record"
                );
            }
        }
    }

    Ok(records)
}`,
  "pins list_pin_records_with_db",
  "pub fn list_pin_records_with_db(",
);

// ============================================================================
// 4) snapshot.rs —— apply_snapshot_retention 的 with_db + strip/remove 改收 &Keyspace
// ============================================================================
const snap = loadState("src-tauri/src/ai/edit/history/snapshot.rs");

// 4a. apply_snapshot_retention_locked → 委托 + 新增 apply_snapshot_retention_with_db
edit(
  snap,
  `fn apply_snapshot_retention_locked(
    storage_root: &Path,
    pin_index: &PinIndex,
    policy: SnapshotRetentionPolicy,
) -> Result<SnapshotPruneOutcome, String> {
    let store = open_store(storage_root)?;
    let mut manifests = list_manifests(&store.snapshots)?;
    let mut outcome = SnapshotPruneOutcome::default();
    let mut batch = store.db.batch();
    let mut blob_ref_counts = build_blob_ref_counts(&manifests);
    let mut active_blob_bytes = build_active_blob_bytes(&manifests);

    manifests.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    for manifest in &mut manifests {
        let should_strip = should_strip_full_blobs(manifest, pin_index, policy);
        if !should_strip || !manifest.has_live_blob() {
            continue;
        }

        strip_manifest_blobs(
            storage_root,
            &store,
            &mut batch,
            manifest,
            &mut blob_ref_counts,
            &mut active_blob_bytes,
            &mut outcome,
        )?;
    }

    if policy.total_blob_quota_bytes > 0 {
        let mut current_total = active_blob_bytes.values().copied().sum::<u64>();
        for manifest in &mut manifests {
            if current_total <= policy.total_blob_quota_bytes {
                break;
            }
            if !manifest.has_live_blob() || is_full_blob_pin_protected(manifest, pin_index, policy)
            {
                continue;
            }

            let before_total = current_total;
            strip_manifest_blobs(
                storage_root,
                &store,
                &mut batch,
                manifest,
                &mut blob_ref_counts,
                &mut active_blob_bytes,
                &mut outcome,
            )?;
            current_total = active_blob_bytes.values().copied().sum::<u64>();
            if current_total == before_total {
                break;
            }
        }
    }

    if outcome.downgraded_snapshot_count == 0 && outcome.removed_blob_count == 0 {
        return Ok(outcome);
    }

    for manifest in manifests {
        let manifest_json = serde_json::to_vec(&manifest).map_err(|error| {
            errors::snapshot_store_failed(format!("序列化快照清单失败：{error}"))
        })?;
        batch.insert(
            &store.snapshots,
            manifest.id.as_bytes().to_vec(),
            manifest_json,
        );
    }

    batch.commit().map_err(|error| {
        errors::snapshot_store_failed(format!("执行 AED 快照 GC 失败：{error}"))
    })?;
    persist(&store.db)?;

    Ok(outcome)
}`,
  `fn apply_snapshot_retention_locked(
    storage_root: &Path,
    pin_index: &PinIndex,
    policy: SnapshotRetentionPolicy,
) -> Result<SnapshotPruneOutcome, String> {
    let store = open_store(storage_root)?;
    apply_snapshot_retention_with_db(&store.db, storage_root, pin_index, policy)
}

/// 复用调用方已打开的 fjall 句柄执行快照 GC（lock-free 变体）。
///
/// 不变量：调用方须已持有 \`journal.lock\` 写锁，且 \`db\` 为同一存储目录上唯一存活句柄；
/// 供 retention 在单锁单句柄内复用，避免单次 GC 重复开库。
pub fn apply_snapshot_retention_with_db(
    db: &Database,
    storage_root: &Path,
    pin_index: &PinIndex,
    policy: SnapshotRetentionPolicy,
) -> Result<SnapshotPruneOutcome, String> {
    let snapshots = db
        .keyspace(SNAPSHOTS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::snapshot_store_failed(format!("打开 snapshots keyspace 失败：{error}"))
        })?;
    let snapshot_blobs = db
        .keyspace(SNAPSHOT_BLOBS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::snapshot_store_failed(format!("打开 snapshot_blobs keyspace 失败：{error}"))
        })?;

    let mut manifests = list_manifests(&snapshots)?;
    let mut outcome = SnapshotPruneOutcome::default();
    let mut batch = db.batch();
    let mut blob_ref_counts = build_blob_ref_counts(&manifests);
    let mut active_blob_bytes = build_active_blob_bytes(&manifests);

    manifests.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    for manifest in &mut manifests {
        let should_strip = should_strip_full_blobs(manifest, pin_index, policy);
        if !should_strip || !manifest.has_live_blob() {
            continue;
        }

        strip_manifest_blobs(
            storage_root,
            &snapshot_blobs,
            &mut batch,
            manifest,
            &mut blob_ref_counts,
            &mut active_blob_bytes,
            &mut outcome,
        )?;
    }

    if policy.total_blob_quota_bytes > 0 {
        let mut current_total = active_blob_bytes.values().copied().sum::<u64>();
        for manifest in &mut manifests {
            if current_total <= policy.total_blob_quota_bytes {
                break;
            }
            if !manifest.has_live_blob() || is_full_blob_pin_protected(manifest, pin_index, policy)
            {
                continue;
            }

            let before_total = current_total;
            strip_manifest_blobs(
                storage_root,
                &snapshot_blobs,
                &mut batch,
                manifest,
                &mut blob_ref_counts,
                &mut active_blob_bytes,
                &mut outcome,
            )?;
            current_total = active_blob_bytes.values().copied().sum::<u64>();
            if current_total == before_total {
                break;
            }
        }
    }

    if outcome.downgraded_snapshot_count == 0 && outcome.removed_blob_count == 0 {
        return Ok(outcome);
    }

    for manifest in manifests {
        let manifest_json = serde_json::to_vec(&manifest).map_err(|error| {
            errors::snapshot_store_failed(format!("序列化快照清单失败：{error}"))
        })?;
        batch.insert(
            &snapshots,
            manifest.id.as_bytes().to_vec(),
            manifest_json,
        );
    }

    batch.commit().map_err(|error| {
        errors::snapshot_store_failed(format!("执行 AED 快照 GC 失败：{error}"))
    })?;
    persist(db)?;

    Ok(outcome)
}`,
  "snapshot apply_snapshot_retention_with_db",
  "pub fn apply_snapshot_retention_with_db(",
);

// 4b. strip_manifest_blobs 签名：&SnapshotStore → &Keyspace
edit(
  snap,
  `fn strip_manifest_blobs(
    storage_root: &Path,
    store: &SnapshotStore,
    batch: &mut fjall::OwnedWriteBatch,`,
  `fn strip_manifest_blobs(
    storage_root: &Path,
    snapshot_blobs: &Keyspace,
    batch: &mut fjall::OwnedWriteBatch,`,
  "strip_manifest_blobs 改收 &Keyspace",
  `fn strip_manifest_blobs(
    storage_root: &Path,
    snapshot_blobs: &Keyspace,`,
);

// 4c. strip_manifest_blobs 内对 remove_blob 的调用
edit(
  snap,
  `        let removed_bytes = remove_blob(storage_root, store, batch, &blob_key)?;`,
  `        let removed_bytes = remove_blob(storage_root, snapshot_blobs, batch, &blob_key)?;`,
  "strip 内 remove_blob 调用改参",
  "remove_blob(storage_root, snapshot_blobs, batch, &blob_key)",
);

// 4d. remove_blob 签名+体：&SnapshotStore → &Keyspace
edit(
  snap,
  `fn remove_blob(
    storage_root: &Path,
    store: &SnapshotStore,
    batch: &mut fjall::OwnedWriteBatch,
    blob_key: &str,
) -> Result<u64, String> {
    if let Some(fjall_key) = blob_key.strip_prefix("fjall:") {
        let removed_bytes = store
            .snapshot_blobs
            .size_of(fjall_key)
            .map_err(|error| {
                errors::snapshot_store_failed(format!("读取 fjall blob 大小失败：{error}"))
            })?
            .unwrap_or_default() as u64;
        batch.remove(&store.snapshot_blobs, fjall_key.as_bytes().to_vec());
        return Ok(removed_bytes);
    }`,
  `fn remove_blob(
    storage_root: &Path,
    snapshot_blobs: &Keyspace,
    batch: &mut fjall::OwnedWriteBatch,
    blob_key: &str,
) -> Result<u64, String> {
    if let Some(fjall_key) = blob_key.strip_prefix("fjall:") {
        let removed_bytes = snapshot_blobs
            .size_of(fjall_key)
            .map_err(|error| {
                errors::snapshot_store_failed(format!("读取 fjall blob 大小失败：{error}"))
            })?
            .unwrap_or_default() as u64;
        batch.remove(snapshot_blobs, fjall_key.as_bytes().to_vec());
        return Ok(removed_bytes);
    }`,
  "remove_blob 改收 &Keyspace",
  "    snapshot_blobs: &Keyspace,\n    batch: &mut fjall::OwnedWriteBatch,\n    blob_key: &str,",
);

// ============================================================================
// 5) mod.rs —— retention 编排：单写锁 + 单句柄
// ============================================================================
const mod_ = loadState("src-tauri/src/ai/edit/mod.rs");

// 5a. 引入 io 自身与 storage_lock
edit(
  mod_,
  `use self::io::file_transaction;`,
  `use self::io::{self, file_transaction, storage_lock};`,
  "mod.rs 引入 io::self + storage_lock",
  "use self::io::{self, file_transaction, storage_lock};",
);

// 5b. apply_retention_policy_with_policy 收敛为单写锁单句柄
edit(
  mod_,
  `fn apply_retention_policy_with_policy(
    state: &AiEditState,
    storage_root: &Path,
    snapshot_policy: snapshot::SnapshotRetentionPolicy,
) -> Result<Option<AiEditRetentionOutcome>, String> {
    let stored_operations = edit_journal::list_operations(storage_root)?;
    let pin_records = pins::list_pin_records(storage_root)?;
    let pin_index = pins::build_pin_index(&pin_records);
    let metadata_cutoff =
        snapshot_policy.now - jiff::SignedDuration::from_secs(OPERATION_METADATA_TTL_DAYS * 86400);
    let retained_operations = stored_operations
        .iter()
        .filter(|operation| {
            operation_is_pinned(operation, &pin_index)
                || parse_rfc3339_utc(&operation.applied_at)
                    .map(|applied_at| applied_at >= metadata_cutoff)
                    .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    let retained_operation_ids = retained_operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect::<HashSet<_>>();
    let referenced_snapshot_ids = retained_operations
        .iter()
        .filter_map(|operation| operation.source_snapshot_id.clone())
        .collect::<HashSet<_>>();

    let journal_outcome = edit_journal::prune_operations(storage_root, &retained_operation_ids)?;
    let snapshot_outcome =
        snapshot::apply_snapshot_retention(storage_root, &pin_index, snapshot_policy)?;

    if journal_outcome.removed_operation_ids.is_empty()`,
  `fn apply_retention_policy_with_policy(
    state: &AiEditState,
    storage_root: &Path,
    snapshot_policy: snapshot::SnapshotRetentionPolicy,
) -> Result<Option<AiEditRetentionOutcome>, String> {
    // 单写锁 + 单句柄：list_operations / list_pin_records / prune_operations /
    // apply_snapshot_retention 共享一把 journal.lock 写锁与一个 Database，把单次
    // retention 的 4 次「开库 + 加锁」收敛为 1 次；同时消除 list 与 prune 之间的
    // TOCTOU 窗口（读-改-写在同一临界区内完成）。时间线裁剪改用内存锁、置于存储锁外。
    let (journal_outcome, snapshot_outcome, referenced_snapshot_ids) =
        storage_lock::with_storage_write_lock(storage_root, "执行 AED 保留策略", || {
            let db = io::open_aed_database(storage_root)?;

            let stored_operations = edit_journal::list_operations_with_db(&db)?;
            let pin_records = pins::list_pin_records_with_db(&db)?;
            let pin_index = pins::build_pin_index(&pin_records);
            let metadata_cutoff = snapshot_policy.now
                - jiff::SignedDuration::from_secs(OPERATION_METADATA_TTL_DAYS * 86400);
            let retained_operations = stored_operations
                .iter()
                .filter(|operation| {
                    operation_is_pinned(operation, &pin_index)
                        || parse_rfc3339_utc(&operation.applied_at)
                            .map(|applied_at| applied_at >= metadata_cutoff)
                            .unwrap_or(true)
                })
                .cloned()
                .collect::<Vec<_>>();
            let retained_operation_ids = retained_operations
                .iter()
                .map(|operation| operation.id.clone())
                .collect::<HashSet<_>>();
            let referenced_snapshot_ids = retained_operations
                .iter()
                .filter_map(|operation| operation.source_snapshot_id.clone())
                .collect::<HashSet<_>>();

            let journal_outcome =
                edit_journal::prune_operations_with_db(&db, &retained_operation_ids)?;
            let snapshot_outcome = snapshot::apply_snapshot_retention_with_db(
                &db,
                storage_root,
                &pin_index,
                snapshot_policy,
            )?;

            Ok((journal_outcome, snapshot_outcome, referenced_snapshot_ids))
        })?;

    if journal_outcome.removed_operation_ids.is_empty()`,
  "mod.rs retention 单锁单句柄",
  `with_storage_write_lock(storage_root, "执行 AED 保留策略"`,
);

// ============================================================================
// 汇总
// ============================================================================
const states = [ioMod, journal, pins, snap, mod_];
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