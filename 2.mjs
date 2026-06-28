// fix-aed-unify-handle-api.mjs
// 彻底统一 AED fjall 句柄访问、删光「locked 版 + _with_db 版」双轨。
// EOL 自适应；任一锚点失败则零写入并退出 1；已应用的编辑自动跳过(幂等)。
import { readFile, writeFile } from "node:fs/promises";

const ROOT = "src-tauri/src/ai/edit";

const FILES = [
  // ───────────────────────────── io/mod.rs ─────────────────────────────
  {
    path: `${ROOT}/io/mod.rs`,
    edits: [
      {
        label: "io: 新增 with_aed_database_write/read 唯一句柄入口",
        old: `pub fn open_aed_database(storage_root: &Path) -> Result<Database, String> {
    Database::builder(storage_root.join(AED_DB_DIR))
        .open()
        .map_err(|error| errors::journal_failed(format!("打开 fjall AED 存储失败：{error}")))
}`,
        new: `pub fn open_aed_database(storage_root: &Path) -> Result<Database, String> {
    Database::builder(storage_root.join(AED_DB_DIR))
        .open()
        .map_err(|error| errors::journal_failed(format!("打开 fjall AED 存储失败：{error}")))
}

/// 在 journal.lock 写锁临界区内打开唯一 AED Database 句柄并执行写闭包。
///
/// 这是 AED 历史存储唯一的可变访问入口：先获取项目级写锁，再打开同一存储目录上
/// 唯一的 Database，最后把句柄借给闭包。edit_journal / pins / snapshot 的历史函数
/// 全部退化为「只接受 &Database 的 keyspace 级操作」，不再各自加锁 / 开库，从根上
/// 消除「locked 版 + _with_db 版」双轨。闭包内可顺序复用同一句柄完成多步读改写
/// （如 retention：list -> prune -> GC），全程零额外开库。
pub fn with_aed_database_write<T>(
    storage_root: &Path,
    action: &str,
    run: impl FnOnce(&Database) -> Result<T, String>,
) -> Result<T, String> {
    storage_lock::with_storage_write_lock(storage_root, action, || {
        let db = open_aed_database(storage_root)?;
        run(&db)
    })
}

/// 在 journal.lock 读锁临界区内打开唯一 AED Database 句柄并执行只读闭包。
///
/// 语义同 with_aed_database_write，但使用共享读锁，供 list_timeline 等只读路径在
/// 单锁单句柄内合并多次读取（如 pins + operations）。
pub fn with_aed_database_read<T>(
    storage_root: &Path,
    action: &str,
    run: impl FnOnce(&Database) -> Result<T, String>,
) -> Result<T, String> {
    storage_lock::with_storage_read_lock(storage_root, action, || {
        let db = open_aed_database(storage_root)?;
        run(&db)
    })
}`,
      },
    ],
  },

  // ─────────────────────── history/edit_journal.rs ───────────────────────
  {
    path: `${ROOT}/history/edit_journal.rs`,
    edits: [
      {
        label: "edit_journal: 精简 import（去 storage_lock/Keyspace/Path）",
        old: `use crate::ai::edit::errors;
use crate::ai::edit::history::pins::PinIndex;
use crate::ai::edit::io::storage_lock;
use crate::commands::contracts::AiEditOperationPayload;
use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};
use std::collections::HashSet;
use std::path::Path;`,
        new: `use crate::ai::edit::errors;
use crate::ai::edit::history::pins::PinIndex;
use crate::commands::contracts::AiEditOperationPayload;
use fjall::{Database, KeyspaceCreateOptions, PersistMode};
use std::collections::HashSet;`,
      },
      {
        label: "edit_journal: 删除无用 AED_DB_DIR 常量",
        old: `const AED_DB_DIR: &str = "fjall";
const OPERATIONS_KEYSPACE: &str = "operations";`,
        new: `const OPERATIONS_KEYSPACE: &str = "operations";`,
      },
      {
        label: "edit_journal: 删 append_operations 加锁版并重命名 _with_db",
        old: `pub fn append_operations(
    storage_root: &Path,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "追加 AED 操作日志", || {
        append_operations_locked(storage_root, operations)
    })
}

/// 复用调用方已打开的 fjall 句柄写入操作日志（lock-free 变体）。
///
/// 不变量：调用方必须已持有 \`journal.lock\` 写锁，且 \`db\` 是同一存储目录上
/// 唯一存活的句柄；本函数不再获取锁或重新打开 \`Database\`，以便与
/// \`file_transaction::commit\` 共享单一句柄、消除一次提交内的重复开库。
pub fn append_operations_with_db(
    db: &Database,`,
        new: `/// 写入操作日志（唯一句柄 API）。
///
/// 调用方须先通过 io::with_aed_database_write 持有 journal.lock 写锁并打开同一存储
/// 目录上唯一的 Database；本函数只做 keyspace 级写入，不再自获取锁或重新开库。
pub fn append_operations(
    db: &Database,`,
      },
      {
        label: "edit_journal: 删 append_locked/list 加锁版，list_operations_with_pins 收 &Database",
        old: `fn append_operations_locked(
    storage_root: &Path,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    let store = open_store(storage_root)?;
    append_operations_with_db(&store.db, operations)
}

pub fn list_operations(storage_root: &Path) -> Result<Vec<AiEditOperationPayload>, String> {
    storage_lock::with_storage_read_lock(storage_root, "读取 AED 操作日志", || {
        list_operations_locked(storage_root)
    })
}

pub fn list_operations_with_pins(
    storage_root: &Path,
    pin_index: &PinIndex,
) -> Result<Vec<AiEditOperationPayload>, String> {
    let mut operations = list_operations(storage_root)?;
    merge_operation_pins(&mut operations, pin_index);
    Ok(operations)
}`,
        new: `pub fn list_operations_with_pins(
    db: &Database,
    pin_index: &PinIndex,
) -> Result<Vec<AiEditOperationPayload>, String> {
    let mut operations = list_operations(db)?;
    merge_operation_pins(&mut operations, pin_index);
    Ok(operations)
}`,
      },
      {
        label: "edit_journal: 删 list_operations_locked 并重命名 list_operations_with_db",
        old: `fn list_operations_locked(storage_root: &Path) -> Result<Vec<AiEditOperationPayload>, String> {
    let store = open_store(storage_root)?;
    list_operations_with_db(&store.db)
}

/// 复用调用方已打开的 fjall 句柄读取操作日志（lock-free 变体）。
///
/// 不变量：调用方须已持有 \`journal.lock\`（读或写锁），且 \`db\` 为同一存储目录上
/// 唯一存活句柄；供 retention 在单锁单句柄内复用。
pub fn list_operations_with_db(db: &Database) -> Result<Vec<AiEditOperationPayload>, String> {`,
        new: `/// 读取操作日志（唯一句柄 API，约束同 append_operations，只读）。
pub fn list_operations(db: &Database) -> Result<Vec<AiEditOperationPayload>, String> {`,
      },
      {
        label: "edit_journal: 删 prune 加锁版 + _locked，重命名 prune_operations_with_db",
        old: `pub fn prune_operations(
    storage_root: &Path,
    retained_operation_ids: &HashSet<String>,
) -> Result<JournalPruneOutcome, String> {
    storage_lock::with_storage_write_lock(storage_root, "裁剪 AED 操作日志", || {
        prune_operations_locked(storage_root, retained_operation_ids)
    })
}

fn prune_operations_locked(
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
) -> Result<JournalPruneOutcome, String> {`,
        new: `/// 裁剪操作日志（唯一句柄 API，约束同 append_operations，写）。
pub fn prune_operations(
    db: &Database,
    retained_operation_ids: &HashSet<String>,
) -> Result<JournalPruneOutcome, String> {`,
      },
      {
        label: "edit_journal: 删除 JournalStore / open_store",
        old: `struct JournalStore {
    db: Database,
    operations: Keyspace,
}

fn open_store(storage_root: &Path) -> Result<JournalStore, String> {
    let db = Database::builder(storage_root.join(AED_DB_DIR))
        .open()
        .map_err(|error| errors::journal_failed(format!("打开 fjall AED 存储失败：{error}")))?;
    let operations = db
        .keyspace(OPERATIONS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::journal_failed(format!("打开 operations keyspace 失败：{error}"))
        })?;
    Ok(JournalStore { db, operations })
}

fn persist(db: &Database) -> Result<(), String> {`,
        new: `fn persist(db: &Database) -> Result<(), String> {`,
      },
      {
        label: "edit_journal(test): 引入 io",
        old: `    use super::{append_operations, list_operations, prune_operations};
    use crate::commands::contracts::AiEditOperationPayload;
    use std::collections::HashSet;
    use std::fs;`,
        new: `    use super::{append_operations, list_operations, prune_operations};
    use crate::ai::edit::io;
    use crate::commands::contracts::AiEditOperationPayload;
    use std::collections::HashSet;
    use std::fs;`,
      },
      {
        label: "edit_journal(test): roundtrip 走句柄入口",
        old: `        append_operations(&temp_dir, &[operation("operation-1", "task-1", "turn-1")])
            .expect("operations should be appended");

        let operations = list_operations(&temp_dir).expect("operations should be listed");`,
        new: `        io::with_aed_database_write(&temp_dir, "测试写入操作日志", |db| {
            append_operations(db, &[operation("operation-1", "task-1", "turn-1")])
        })
        .expect("operations should be appended");

        let operations = io::with_aed_database_read(&temp_dir, "测试读取操作日志", list_operations)
            .expect("operations should be listed");`,
      },
      {
        label: "edit_journal(test): prune 走句柄入口",
        old: `        append_operations(
            &temp_dir,
            &[
                operation("operation-1", "task-1", "turn-1"),
                operation("operation-2", "task-1", "turn-2"),
                operation("operation-3", "task-2", "turn-3"),
            ],
        )
        .expect("operations should be appended");

        let retained_operation_ids =
            HashSet::from(["operation-2".to_string(), "operation-3".to_string()]);
        let outcome =
            prune_operations(&temp_dir, &retained_operation_ids).expect("journal should be pruned");

        let operations = list_operations(&temp_dir).expect("operations should be listed");`,
        new: `        io::with_aed_database_write(&temp_dir, "测试写入操作日志", |db| {
            append_operations(
                db,
                &[
                    operation("operation-1", "task-1", "turn-1"),
                    operation("operation-2", "task-1", "turn-2"),
                    operation("operation-3", "task-2", "turn-3"),
                ],
            )
        })
        .expect("operations should be appended");

        let retained_operation_ids =
            HashSet::from(["operation-2".to_string(), "operation-3".to_string()]);
        let outcome = io::with_aed_database_write(&temp_dir, "测试裁剪操作日志", |db| {
            prune_operations(db, &retained_operation_ids)
        })
        .expect("journal should be pruned");

        let operations = io::with_aed_database_read(&temp_dir, "测试读取操作日志", list_operations)
            .expect("operations should be listed");`,
      },
    ],
  },

  // ───────────────────────────── history/pins.rs ─────────────────────────
  {
    path: `${ROOT}/history/pins.rs`,
    edits: [
      {
        label: "pins: 删除 list_pin_records 加锁版",
        old: `pub fn list_pin_records(storage_root: &Path) -> Result<Vec<PinRecord>, String> {
    storage_lock::with_storage_read_lock(storage_root, "读取 AED Pin 状态", || {
        list_pin_records_locked(storage_root)
    })
}

pub fn build_pin_index(records: &[PinRecord]) -> PinIndex {`,
        new: `pub fn build_pin_index(records: &[PinRecord]) -> PinIndex {`,
      },
      {
        label: "pins: 删 list_pin_records_locked 并重命名 _with_db",
        old: `fn list_pin_records_locked(storage_root: &Path) -> Result<Vec<PinRecord>, String> {
    let store = open_store(storage_root)?;
    list_pin_records_with_db(&store.db)
}

/// 复用调用方已打开的 fjall 句柄读取 Pin 记录（lock-free 变体）。
///
/// 不变量：调用方须已持有 \`journal.lock\`，且 \`db\` 为同一存储目录上唯一存活句柄。
pub fn list_pin_records_with_db(db: &Database) -> Result<Vec<PinRecord>, String> {`,
        new: `/// 读取 Pin 记录（唯一句柄 API）。
///
/// 调用方须先通过 io::with_aed_database_read（或 write）持有 journal.lock 并打开同一
/// 存储目录上唯一的 Database；本函数只做 keyspace 级读取。
pub fn list_pin_records(db: &Database) -> Result<Vec<PinRecord>, String> {`,
      },
      {
        label: "pins(test): list_pin_records 走句柄入口",
        old: `mod tests {
    use super::{build_pin_index, list_pin_records, set_pin};
    use std::fs;

    #[test]
    fn set_pin_roundtrips_task_pin() {
        let temp_dir = temp_dir("aed-pins");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        set_pin(&temp_dir, "task", "task-1", true).expect("pin should be written");
        let records = list_pin_records(&temp_dir).expect("pins should be listed");`,
        new: `mod tests {
    use super::{build_pin_index, list_pin_records, set_pin};
    use crate::ai::edit::io;
    use std::fs;

    #[test]
    fn set_pin_roundtrips_task_pin() {
        let temp_dir = temp_dir("aed-pins");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        set_pin(&temp_dir, "task", "task-1", true).expect("pin should be written");
        let records = io::with_aed_database_read(&temp_dir, "测试读取 Pin", list_pin_records)
            .expect("pins should be listed");`,
      },
    ],
  },

  // ─────────────────────────── history/snapshot.rs ───────────────────────
  {
    path: `${ROOT}/history/snapshot.rs`,
    edits: [
      {
        label: "snapshot: 删 apply_snapshot_retention 加锁版 + _locked，重命名 _with_db",
        old: `pub fn apply_snapshot_retention(
    storage_root: &Path,
    pin_index: &PinIndex,
    policy: SnapshotRetentionPolicy,
) -> Result<SnapshotPruneOutcome, String> {
    storage_lock::with_storage_write_lock(storage_root, "执行 AED 快照 GC", || {
        apply_snapshot_retention_locked(storage_root, pin_index, policy)
    })
}

fn apply_snapshot_retention_locked(
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
) -> Result<SnapshotPruneOutcome, String> {`,
        new: `/// 执行快照 GC（唯一句柄 API）。
///
/// 调用方须先通过 io::with_aed_database_write 持有 journal.lock 写锁并打开同一存储
/// 目录上唯一的 Database；本函数只做 keyspace / CAS 级裁剪，不再自获取锁或重新开库。
pub fn apply_snapshot_retention(
    db: &Database,
    storage_root: &Path,
    pin_index: &PinIndex,
    policy: SnapshotRetentionPolicy,
) -> Result<SnapshotPruneOutcome, String> {`,
      },
      {
        label: "snapshot(test): 引入 io",
        old: `    use crate::ai::edit::history::pins::PinIndex;
    use crate::commands::contracts::AiApplyPatchMetadataRequest;
    use std::fs;`,
        new: `    use crate::ai::edit::history::pins::PinIndex;
    use crate::ai::edit::io;
    use crate::commands::contracts::AiApplyPatchMetadataRequest;
    use std::fs;`,
      },
      {
        label: "snapshot(test): apply_snapshot_retention 走句柄入口",
        old: `        let outcome = apply_snapshot_retention(
            &temp_dir,
            &PinIndex::default(),
            SnapshotRetentionPolicy {
                now: jiff::Timestamp::now()
                    + jiff::SignedDuration::from_secs((super::FULL_BLOB_TTL_DAYS + 1) * 86400),
                total_blob_quota_bytes: 0,
                ..SnapshotRetentionPolicy::default()
            },
        )
        .expect("snapshots should be downgraded");`,
        new: `        let outcome = io::with_aed_database_write(&temp_dir, "测试快照 GC", |db| {
            apply_snapshot_retention(
                db,
                &temp_dir,
                &PinIndex::default(),
                SnapshotRetentionPolicy {
                    now: jiff::Timestamp::now()
                        + jiff::SignedDuration::from_secs((super::FULL_BLOB_TTL_DAYS + 1) * 86400),
                    total_blob_quota_bytes: 0,
                    ..SnapshotRetentionPolicy::default()
                },
            )
        })
        .expect("snapshots should be downgraded");`,
      },
    ],
  },

  // ───────────────────────────────── mod.rs ──────────────────────────────
  {
    path: `${ROOT}/mod.rs`,
    edits: [
      {
        label: "mod: import 去掉 storage_lock",
        old: `use self::io::{self, file_transaction, storage_lock};`,
        new: `use self::io::{self, file_transaction};`,
      },
      {
        label: "mod: list_timeline 合并 pins+operations 到单锁单句柄",
        old: `    let pin_records = pins::list_pin_records(storage_root)?;
    let pin_index = pins::build_pin_index(&pin_records);
    let mut stored_snapshots = snapshot::list_stored_snapshots(storage_root)?;
    merge_snapshot_pins(&mut stored_snapshots, &pin_index);
    let stored_operations = edit_journal::list_operations_with_pins(storage_root, &pin_index)?;
    list_timeline_with_state(payload, state, stored_snapshots, stored_operations)`,
        new: `    let mut stored_snapshots = snapshot::list_stored_snapshots(storage_root)?;
    // 单锁单句柄：Pin 记录与操作日志共享一把 journal.lock 读锁与一个 Database，
    // 避免本函数内重复开库；快照清单走自身只读路径，置于本临界区之外，保持顺序加锁。
    let (pin_index, stored_operations) =
        io::with_aed_database_read(storage_root, "读取 AED 时间线", |db| {
            let pin_records = pins::list_pin_records(db)?;
            let pin_index = pins::build_pin_index(&pin_records);
            let stored_operations = edit_journal::list_operations_with_pins(db, &pin_index)?;
            Ok((pin_index, stored_operations))
        })?;
    merge_snapshot_pins(&mut stored_snapshots, &pin_index);
    list_timeline_with_state(payload, state, stored_snapshots, stored_operations)`,
      },
      {
        label: "mod: retention 改用 with_aed_database_write 并去 _with_db（读取段）",
        old: `        storage_lock::with_storage_write_lock(storage_root, "执行 AED 保留策略", || {
            let db = io::open_aed_database(storage_root)?;

            let stored_operations = edit_journal::list_operations_with_db(&db)?;
            let pin_records = pins::list_pin_records_with_db(&db)?;
            let pin_index = pins::build_pin_index(&pin_records);`,
        new: `        io::with_aed_database_write(storage_root, "执行 AED 保留策略", |db| {
            let stored_operations = edit_journal::list_operations(db)?;
            let pin_records = pins::list_pin_records(db)?;
            let pin_index = pins::build_pin_index(&pin_records);`,
      },
      {
        label: "mod: retention 去 _with_db（裁剪/GC 段）",
        old: `            let journal_outcome =
                edit_journal::prune_operations_with_db(&db, &retained_operation_ids)?;
            let snapshot_outcome = snapshot::apply_snapshot_retention_with_db(
                &db,
                storage_root,
                &pin_index,
                snapshot_policy,
            )?;`,
        new: `            let journal_outcome =
                edit_journal::prune_operations(db, &retained_operation_ids)?;
            let snapshot_outcome = snapshot::apply_snapshot_retention(
                db,
                storage_root,
                &pin_index,
                snapshot_policy,
            )?;`,
      },
      {
        label: "mod: refresh_timeline_pin_state 走句柄入口",
        old: `fn refresh_timeline_pin_state(state: &AiEditState, storage_root: &Path) -> Result<(), String> {
    let pin_records = pins::list_pin_records(storage_root)?;
    let pin_index = pins::build_pin_index(&pin_records);`,
        new: `fn refresh_timeline_pin_state(state: &AiEditState, storage_root: &Path) -> Result<(), String> {
    let pin_records =
        io::with_aed_database_read(storage_root, "读取 AED Pin 状态", pins::list_pin_records)?;
    let pin_index = pins::build_pin_index(&pin_records);`,
      },
    ],
  },

  // ──────────────────────────── history/revert.rs ────────────────────────
  {
    path: `${ROOT}/history/revert.rs`,
    edits: [
      {
        label: "revert: resolve_operation 走句柄入口",
        old: `    edit_journal::list_operations(storage_root)?
        .into_iter()
        .find(|operation| operation.id == operation_id)
        .ok_or_else(|| errors::operation_not_found(operation_id))`,
        new: `    crate::ai::edit::io::with_aed_database_read(
        storage_root,
        "读取 AED 操作日志",
        edit_journal::list_operations,
    )?
    .into_iter()
    .find(|operation| operation.id == operation_id)
    .ok_or_else(|| errors::operation_not_found(operation_id))`,
      },
      {
        label: "revert: list_task_operations 走句柄入口",
        old: `        state,
        Vec::new(),
        edit_journal::list_operations(storage_root)?,
    )?;
    let operations = timeline`,
        new: `        state,
        Vec::new(),
        crate::ai::edit::io::with_aed_database_read(
            storage_root,
            "读取 AED 操作日志",
            edit_journal::list_operations,
        )?,
    )?;
    let operations = timeline`,
      },
      {
        label: "revert(test): restore_snapshot 列举走句柄入口",
        old: `            snapshot::list_stored_snapshots(&snapshot_root).expect("snapshots should be listed"),
            edit_journal::list_operations(&snapshot_root).expect("operations should be listed"),
        )
        .expect("timeline should be listed");`,
        new: `            snapshot::list_stored_snapshots(&snapshot_root).expect("snapshots should be listed"),
            crate::ai::edit::io::with_aed_database_read(
                &snapshot_root,
                "测试读取操作日志",
                edit_journal::list_operations,
            )
            .expect("operations should be listed"),
        )
        .expect("timeline should be listed");`,
      },
      {
        label: "revert(test): undo_operation 列举走句柄入口",
        old: `            Vec::new(),
            edit_journal::list_operations(&snapshot_root).expect("operations should be listed"),
        )
        .expect("timeline should be listed")
        .entries`,
        new: `            Vec::new(),
            crate::ai::edit::io::with_aed_database_read(
                &snapshot_root,
                "测试读取操作日志",
                edit_journal::list_operations,
            )
            .expect("operations should be listed"),
        )
        .expect("timeline should be listed")
        .entries`,
      },
      {
        label: "revert(test): undo_rejects_manual 列举走句柄入口",
        old: `        let operation_id = edit_journal::list_operations(&snapshot_root)
            .expect("operations should be listed")
            .into_iter()`,
        new: `        let operation_id = crate::ai::edit::io::with_aed_database_read(
            &snapshot_root,
            "测试读取操作日志",
            edit_journal::list_operations,
        )
        .expect("operations should be listed")
        .into_iter()`,
      },
    ],
  },

  // ───────────────────────── io/file_transaction.rs ──────────────────────
  {
    path: `${ROOT}/io/file_transaction.rs`,
    edits: [
      {
        label: "file_transaction: commit 去 _with_db 后缀",
        old: `        edit_journal::append_operations_with_db(&store.db, &transaction.manifest.operations)?;`,
        new: `        edit_journal::append_operations(&store.db, &transaction.manifest.operations)?;`,
      },
      {
        label: "file_transaction: recover 去 _with_db 后缀",
        old: `                edit_journal::append_operations_with_db(&store.db, &manifest.operations)?;`,
        new: `                edit_journal::append_operations(&store.db, &manifest.operations)?;`,
      },
      {
        label: "file_transaction(test): commit 列举走句柄入口",
        old: `        let operations = edit_journal::list_operations(&temp_dir).expect("operations should list");
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].id, "operation-1");`,
        new: `        let operations =
            crate::ai::edit::io::with_aed_database_read(&temp_dir, "测试读取操作日志", edit_journal::list_operations)
                .expect("operations should list");
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].id, "operation-1");`,
      },
      {
        label: "file_transaction(test): recover 列举走句柄入口",
        old: `        let operations = edit_journal::list_operations(&temp_dir).expect("operations should list");
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].id, "operation-2");`,
        new: `        let operations =
            crate::ai::edit::io::with_aed_database_read(&temp_dir, "测试读取操作日志", edit_journal::list_operations)
                .expect("operations should list");
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].id, "operation-2");`,
      },
    ],
  },
];

// ───────────────────────────── harness ─────────────────────────────
const errors = [];
const pending = [];

for (const file of FILES) {
  let raw;
  try {
    raw = await readFile(file.path, "utf8");
  } catch (e) {
    errors.push(`读取失败 ${file.path}: ${e.message}`);
    continue;
  }
  const crlf = raw.includes("\r\n");
  let content = crlf ? raw.split("\r\n").join("\n") : raw;

  for (const ed of file.edits) {
    const first = content.indexOf(ed.old);
    if (first !== -1) {
      if (content.lastIndexOf(ed.old) !== first) {
        errors.push(`锚点不唯一 [${file.path}] ${ed.label}`);
        continue;
      }
      content = content.slice(0, first) + ed.new + content.slice(first + ed.old.length);
    } else if (content.includes(ed.new)) {
      console.log(`跳过(已应用) [${file.path}] ${ed.label}`);
    } else {
      errors.push(`锚点未匹配 [${file.path}] ${ed.label}`);
    }
  }
  pending.push({ path: file.path, content, crlf });
}

if (errors.length > 0) {
  console.error("❌ 存在错误，未写入任何文件：");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

for (const p of pending) {
  const out = p.crlf ? p.content.split("\n").join("\r\n") : p.content;
  await writeFile(p.path, out, "utf8");
  console.log("✅ 写入 " + p.path);
}
console.log("✓ AED 句柄 API 已统一，双轨已删光。");