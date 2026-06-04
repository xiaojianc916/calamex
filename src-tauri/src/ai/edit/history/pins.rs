use crate::ai::edit::errors;
use crate::ai::edit::io::storage_lock;
use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

const AED_DB_DIR: &str = "fjall";
const PINS_KEYSPACE: &str = "pins";

pub const PIN_TARGET_OPERATION: &str = "operation";
pub const PIN_TARGET_SNAPSHOT: &str = "snapshot";
pub const PIN_TARGET_TASK: &str = "task";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRecord {
    pub target_type: String,
    pub target_id: String,
    pub pinned: bool,
    pub pinned_at: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct PinIndex {
    pub pinned_operations: HashSet<String>,
    pub pinned_snapshots: HashSet<String>,
    pub pinned_tasks: HashSet<String>,
}

pub fn set_pin(
    storage_root: &Path,
    target_type: &str,
    target_id: &str,
    pinned: bool,
) -> Result<PinRecord, String> {
    storage_lock::with_storage_write_lock(storage_root, "更新 AED Pin 状态", || {
        set_pin_locked(storage_root, target_type, target_id, pinned)
    })
}

pub fn list_pin_records(storage_root: &Path) -> Result<Vec<PinRecord>, String> {
    storage_lock::with_storage_read_lock(storage_root, "读取 AED Pin 状态", || {
        list_pin_records_locked(storage_root)
    })
}

pub fn build_pin_index(records: &[PinRecord]) -> PinIndex {
    let mut index = PinIndex::default();

    for record in records.iter().filter(|record| record.pinned) {
        match record.target_type.as_str() {
            PIN_TARGET_OPERATION => {
                index.pinned_operations.insert(record.target_id.clone());
            }
            PIN_TARGET_SNAPSHOT => {
                index.pinned_snapshots.insert(record.target_id.clone());
            }
            PIN_TARGET_TASK => {
                index.pinned_tasks.insert(record.target_id.clone());
            }
            _ => {}
        }
    }

    index
}

pub fn validate_target_type(value: &str) -> Result<&'static str, String> {
    match value.trim() {
        PIN_TARGET_OPERATION => Ok(PIN_TARGET_OPERATION),
        PIN_TARGET_SNAPSHOT => Ok(PIN_TARGET_SNAPSHOT),
        PIN_TARGET_TASK => Ok(PIN_TARGET_TASK),
        other => Err(errors::journal_failed(format!(
            "不支持的 AED Pin 目标类型：{other}"
        ))),
    }
}

fn set_pin_locked(
    storage_root: &Path,
    target_type: &str,
    target_id: &str,
    pinned: bool,
) -> Result<PinRecord, String> {
    let target_type = validate_target_type(target_type)?;
    let target_id = target_id.trim();
    if target_id.is_empty() {
        return Err(errors::journal_failed("AED Pin 目标 ID 不能为空。"));
    }

    let record = PinRecord {
        target_type: target_type.to_string(),
        target_id: target_id.to_string(),
        pinned,
        pinned_at: pinned.then(|| Timestamp::now().to_string()),
    };
    let store = open_store(storage_root)?;
    let value = serde_json::to_vec(&record)
        .map_err(|error| errors::journal_failed(format!("序列化 AED Pin 状态失败：{error}")))?;
    store
        .pins
        .insert(pin_key(target_type, target_id), value)
        .map_err(|error| errors::journal_failed(format!("写入 AED Pin 状态失败：{error}")))?;
    persist(&store.db)?;

    Ok(record)
}

fn list_pin_records_locked(storage_root: &Path) -> Result<Vec<PinRecord>, String> {
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
}

struct PinStore {
    db: Database,
    pins: Keyspace,
}

fn open_store(storage_root: &Path) -> Result<PinStore, String> {
    let db = Database::builder(storage_root.join(AED_DB_DIR))
        .open()
        .map_err(|error| errors::journal_failed(format!("打开 fjall AED 存储失败：{error}")))?;
    let pins = db
        .keyspace(PINS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| errors::journal_failed(format!("打开 pins keyspace 失败：{error}")))?;
    Ok(PinStore { db, pins })
}

fn persist(db: &Database) -> Result<(), String> {
    db.persist(PersistMode::SyncAll)
        .map_err(|error| errors::journal_failed(format!("持久化 AED Pin 状态失败：{error}")))
}

fn pin_key(target_type: &str, target_id: &str) -> String {
    format!("{target_type}:{target_id}")
}

#[cfg(test)]
mod tests {
    use super::{build_pin_index, list_pin_records, set_pin};
    use std::fs;

    #[test]
    fn set_pin_roundtrips_task_pin() {
        let temp_dir = temp_dir("aed-pins");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        set_pin(&temp_dir, "task", "task-1", true).expect("pin should be written");
        let records = list_pin_records(&temp_dir).expect("pins should be listed");
        let index = build_pin_index(&records);

        assert_eq!(records.len(), 1);
        assert!(index.pinned_tasks.contains("task-1"));

        let _ = fs::remove_dir_all(&temp_dir);
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
