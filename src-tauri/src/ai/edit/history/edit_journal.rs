use crate::ai::edit::errors;
use crate::ai::edit::history::pins::PinIndex;
use crate::commands::contracts::AiEditOperationPayload;
use fjall::{Database, KeyspaceCreateOptions, PersistMode};
use std::collections::HashSet;

const OPERATIONS_KEYSPACE: &str = "operations";

#[derive(Debug, Default)]
pub struct JournalPruneOutcome {
    pub removed_operation_ids: HashSet<String>,
    pub reclaimed_bytes: u64,
}

/// 写入操作日志（唯一句柄 API）。
///
/// 调用方须先通过 io::with_aed_database_write 持有 journal.lock 写锁并打开同一存储
/// 目录上唯一的 Database；本函数只做 keyspace 级写入，不再自获取锁或重新开库。
pub fn append_operations(
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

pub fn list_operations_with_pins(
    db: &Database,
    pin_index: &PinIndex,
) -> Result<Vec<AiEditOperationPayload>, String> {
    let mut operations = list_operations(db)?;
    merge_operation_pins(&mut operations, pin_index);
    Ok(operations)
}

pub fn merge_operation_pins(operations: &mut [AiEditOperationPayload], pin_index: &PinIndex) {
    for operation in operations {
        operation.pinned = pin_index.pinned_operations.contains(&operation.id)
            || pin_index.pinned_tasks.contains(&operation.task_id);
    }
}

/// 读取操作日志（唯一句柄 API，约束同 append_operations，只读）。
pub fn list_operations(db: &Database) -> Result<Vec<AiEditOperationPayload>, String> {
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
}

/// 裁剪操作日志（唯一句柄 API，约束同 append_operations，写）。
pub fn prune_operations(
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
    use crate::ai::edit::io;
    use crate::commands::contracts::AiEditOperationPayload;
    use std::collections::HashSet;
    use std::fs;

    #[test]
    fn append_and_list_operations_roundtrip() {
        let temp_dir = temp_dir("aed-edit-journal");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        io::with_aed_database_write(&temp_dir, "测试写入操作日志", |db| {
            append_operations(db, &[operation("operation-1", "task-1", "turn-1")])
        })
        .expect("operations should be appended");

        let operations = io::with_aed_database_read(&temp_dir, "测试读取操作日志", list_operations)
            .expect("operations should be listed");

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

        io::with_aed_database_write(&temp_dir, "测试写入操作日志", |db| {
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
            .expect("operations should be listed");
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
