use crate::ai::edit::errors;
use crate::ai::edit::history::pins::PinIndex;
use crate::ai::edit::io::storage_lock;
use crate::commands::contracts::AiEditOperationPayload;
use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};
use std::collections::HashSet;
use std::path::Path;

const AED_DB_DIR: &str = "fjall";
const OPERATIONS_KEYSPACE: &str = "operations";

#[derive(Debug, Default)]
pub struct JournalPruneOutcome {
    pub removed_operation_ids: HashSet<String>,
    pub reclaimed_bytes: u64,
}

pub fn append_operations(
    storage_root: &Path,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "追加 AED 操作日志", || {
        append_operations_locked(storage_root, operations)
    })
}

/// 复用调用方已打开的 fjall 句柄写入操作日志（lock-free 变体）。
///
/// 不变量：调用方必须已持有 `journal.lock` 写锁，且 `db` 是同一存储目录上
/// 唯一存活的句柄；本函数不再获取锁或重新打开 `Database`，以便与
/// `file_transaction::commit` 共享单一句柄、消除一次提交内的重复开库。
pub fn append_operations_with_db(
    db: &Database,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    if operations.is_empty() {
        return Ok(());
    }

    let operations_keyspace = db
        .keyspace(OPERATIONS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::journal_failed(format!("打开 operations keyspace 失败：{error}"))
        })?;
    let mut batch = db.batch();

    for operation in operations {
        let key = operation_key(operation);
        let value = serde_json::to_vec(operation)
            .map_err(|error| errors::journal_failed(format!("序列化操作日志失败：{error}")))?;
        batch.insert(&operations_keyspace, key, value);
    }

    batch
        .commit()
        .map_err(|error| errors::journal_failed(format!("写入 fjall 操作日志失败：{error}")))?;
    persist(db)
}

fn append_operations_locked(
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
}

pub fn merge_operation_pins(operations: &mut [AiEditOperationPayload], pin_index: &PinIndex) {
    for operation in operations {
        operation.pinned = pin_index.pinned_operations.contains(&operation.id)
            || pin_index.pinned_tasks.contains(&operation.task_id);
    }
}

fn list_operations_locked(storage_root: &Path) -> Result<Vec<AiEditOperationPayload>, String> {
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
}

pub fn prune_operations(
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
}

struct JournalStore {
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

fn persist(db: &Database) -> Result<(), String> {
    db.persist(PersistMode::SyncAll)
        .map_err(|error| errors::journal_failed(format!("持久化 fjall 操作日志失败：{error}")))
}

fn operation_key(operation: &AiEditOperationPayload) -> String {
    format!("{}|{}", operation.applied_at, operation.id)
}

#[cfg(test)]
mod tests {
    use super::{append_operations, list_operations, prune_operations};
    use crate::commands::contracts::AiEditOperationPayload;
    use std::collections::HashSet;
    use std::fs;

    #[test]
    fn append_and_list_operations_roundtrip() {
        let temp_dir = temp_dir("aed-edit-journal");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        append_operations(&temp_dir, &[operation("operation-1", "task-1", "turn-1")])
            .expect("operations should be appended");

        let operations = list_operations(&temp_dir).expect("operations should be listed");

        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].id, "operation-1");
        assert_eq!(
            operations[0].source_snapshot_id.as_deref(),
            Some("snapshot-1")
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn prune_operations_removes_unretained_entries_only() {
        let temp_dir = temp_dir("aed-edit-journal-prune");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        append_operations(
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

        let operations = list_operations(&temp_dir).expect("operations should be listed");
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[0].id, "operation-2");
        assert_eq!(operations[1].id, "operation-3");
        assert!(outcome.removed_operation_ids.contains("operation-1"));
        assert!(!outcome.removed_operation_ids.contains("operation-2"));
        assert!(outcome.reclaimed_bytes > 0);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    fn operation(id: &str, task_id: &str, turn_id: &str) -> AiEditOperationPayload {
        AiEditOperationPayload {
            id: id.to_string(),
            task_id: task_id.to_string(),
            turn_id: turn_id.to_string(),
            kind: "modify".to_string(),
            path: "src/main.ts".to_string(),
            new_path: None,
            source_snapshot_id: Some("snapshot-1".to_string()),
            before_hash: Some("blake3:before".to_string()),
            after_hash: Some("blake3:after".to_string()),
            bytes_before: Some(32),
            bytes_after: Some(48),
            applied_at: format!("2026-04-28T10:00:0{}.000Z", &id[id.len() - 1..]),
            reason: "测试日志".to_string(),
            tool_call_id: None,
            diff_text: None,
            pinned: false,
        }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ))
    }
}
