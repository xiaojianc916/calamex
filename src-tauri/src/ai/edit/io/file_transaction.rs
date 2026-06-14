use crate::ai::edit::errors;
use crate::ai::edit::history::edit_journal;
use crate::ai::edit::io::{atomic_write, storage_lock};
use crate::ai::edit::security::path_security;
use crate::commands::contracts::AiEditOperationPayload;
use jiff::Timestamp;

use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};
use serde::{Deserialize, Serialize};
use fs_err as fs;
use std::path::{Path, PathBuf};

const AED_DB_DIR: &str = "fjall";
const FILE_TRANSACTIONS_KEYSPACE: &str = "file_transactions";
const TRANSACTIONS_DIR: &str = "transactions";
const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub enum FileTransactionAction {
    Modify { path: PathBuf, content: String },
}

#[derive(Debug, Clone)]
pub struct FileTransactionPlan {
    pub actions: Vec<FileTransactionAction>,
    pub operations: Vec<AiEditOperationPayload>,
}

pub fn commit(storage_root: &Path, plan: FileTransactionPlan) -> Result<(), String> {
    if plan.actions.is_empty() {
        return Ok(());
    }

    recover_pending(storage_root)?;

    let transaction = PreparedFileTransaction::new(storage_root, plan)?;
    transaction.write_staging_files()?;
    update_status(
        storage_root,
        &transaction.manifest.id,
        TransactionStatus::Committed,
    )?;
    apply_manifest(storage_root, &transaction.manifest)?;
    edit_journal::append_operations(storage_root, &transaction.manifest.operations)?;
    update_status(
        storage_root,
        &transaction.manifest.id,
        TransactionStatus::Done,
    )?;
    remove_staging_dir(storage_root, &transaction.manifest.id)?;

    Ok(())
}

pub fn recover_pending(storage_root: &Path) -> Result<(), String> {
    let manifests = list_manifests(storage_root)?;

    for manifest in manifests {
        match manifest.status {
            TransactionStatus::Prepared => {
                remove_staging_dir(storage_root, &manifest.id)?;
                update_status(storage_root, &manifest.id, TransactionStatus::Done)?;
            }
            TransactionStatus::Committed => {
                apply_manifest(storage_root, &manifest)?;
                edit_journal::append_operations(storage_root, &manifest.operations)?;
                update_status(storage_root, &manifest.id, TransactionStatus::Done)?;
                remove_staging_dir(storage_root, &manifest.id)?;
            }
            TransactionStatus::Done => {}
        }
    }

    Ok(())
}

struct PreparedFileTransaction {
    storage_root: PathBuf,
    manifest: FileTransactionManifest,
}

impl PreparedFileTransaction {
    fn new(storage_root: &Path, plan: FileTransactionPlan) -> Result<Self, String> {
        let now = Timestamp::now();
        let id = format!("ai-edit-tx-{}", now.as_nanosecond());
        let entries = plan
            .actions
            .into_iter()
            .enumerate()
            .map(|(index, action)| FileTransactionEntry::from_action(&id, index, action))
            .collect::<Result<Vec<_>, String>>()?;
        let manifest = FileTransactionManifest {
            version: MANIFEST_VERSION,
            id,
            status: TransactionStatus::Prepared,
            created_at: now.to_string(),
            entries,
            operations: plan.operations,
        };

        upsert_manifest(storage_root, &manifest)?;
        Ok(Self {
            storage_root: storage_root.to_path_buf(),
            manifest,
        })
    }

    fn write_staging_files(&self) -> Result<(), String> {
        for entry in &self.manifest.entries {
            let Some(content) = entry.content.as_deref() else {
                continue;
            };
            let staging_path = resolve_staging_path(&self.storage_root, &self.manifest.id, entry)?;
            if let Some(parent) = staging_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    errors::transaction_failed(format!("创建事务 staging 目录失败：{error}"))
                })?;
            }
            atomic_write::write_text(&staging_path, content).map_err(|error| {
                errors::transaction_failed(format!(
                    "写入事务 staging 文件失败（{}）：{error}",
                    staging_path.display()
                ))
            })?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTransactionManifest {
    version: u32,
    id: String,
    status: TransactionStatus,
    created_at: String,
    entries: Vec<FileTransactionEntry>,
    operations: Vec<AiEditOperationPayload>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TransactionStatus {
    Prepared,
    Committed,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTransactionEntry {
    kind: FileTransactionEntryKind,
    path: String,
    new_path: Option<String>,
    staging_key: Option<String>,
    #[serde(skip)]
    content: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum FileTransactionEntryKind {
    Modify,
}

impl FileTransactionEntry {
    fn from_action(
        _transaction_id: &str,
        index: usize,
        action: FileTransactionAction,
    ) -> Result<Self, String> {
        let entry = match action {
            FileTransactionAction::Modify { path, content } => {
                let path = path_to_string(&path)?;
                Self {
                    kind: FileTransactionEntryKind::Modify,
                    path,
                    new_path: None,
                    staging_key: Some(format!("{index}.txt")),
                    content: Some(content),
                }
            }
        };
        Ok(entry)
    }
}

fn apply_manifest(storage_root: &Path, manifest: &FileTransactionManifest) -> Result<(), String> {
    for entry in &manifest.entries {
        match entry.kind {
            FileTransactionEntryKind::Modify => {
                let target_path = path_security::validate_ai_writable_path(&entry.path)?;
                path_security::reject_existing_symlink(&target_path)?;
                ensure_parent_dir(&target_path)?;
                let staging_path = resolve_staging_path(storage_root, &manifest.id, entry)?;
                let content = fs::read_to_string(&staging_path).map_err(|error| {
                    errors::transaction_failed(format!(
                        "读取事务 staging 文件失败（{}）：{error}",
                        staging_path.display()
                    ))
                })?;
                atomic_write::write_text(&target_path, &content).map_err(|error| {
                    errors::transaction_failed(format!(
                        "提交事务写入失败（{}）：{error}",
                        target_path.display()
                    ))
                })?;
            }
        }
    }
    Ok(())
}

fn upsert_manifest(storage_root: &Path, manifest: &FileTransactionManifest) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "写入 AED 文件事务", || {
        let store = open_store(storage_root)?;
        let value = serde_json::to_vec(manifest)
            .map_err(|error| errors::transaction_failed(format!("序列化文件事务失败：{error}")))?;
        store
            .transactions
            .insert(manifest.id.as_bytes(), value)
            .map_err(|error| errors::transaction_failed(format!("写入文件事务失败：{error}")))?;
        persist(&store.db)
    })
}

fn update_status(
    storage_root: &Path,
    transaction_id: &str,
    status: TransactionStatus,
) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "更新 AED 文件事务状态", || {
        let store = open_store(storage_root)?;
        let mut manifest = load_manifest(&store.transactions, transaction_id)?
            .ok_or_else(|| errors::transaction_failed("文件事务不存在。"))?;
        manifest.status = status;
        let value = serde_json::to_vec(&manifest)
            .map_err(|error| errors::transaction_failed(format!("序列化文件事务失败：{error}")))?;
        store
            .transactions
            .insert(transaction_id.as_bytes(), value)
            .map_err(|error| errors::transaction_failed(format!("写入文件事务失败：{error}")))?;
        persist(&store.db)
    })
}

fn list_manifests(storage_root: &Path) -> Result<Vec<FileTransactionManifest>, String> {
    storage_lock::with_storage_read_lock(storage_root, "读取 AED 文件事务", || {
        let store = open_store(storage_root)?;
        let mut manifests = Vec::new();

        for item in store.transactions.iter() {
            let (_key, value) = item.into_inner().map_err(|error| {
                errors::transaction_failed(format!("读取文件事务失败：{error}"))
            })?;
            match serde_json::from_slice::<FileTransactionManifest>(&value) {
                Ok(manifest) => manifests.push(manifest),
                Err(error) => {
                    tracing::warn!(
                        target: "ai.edit",
                        error = %error,
                        "skip invalid AED file transaction manifest"
                    );
                }
            }
        }

        Ok(manifests)
    })
}

fn load_manifest(
    transactions: &Keyspace,
    transaction_id: &str,
) -> Result<Option<FileTransactionManifest>, String> {
    let Some(value) = transactions
        .get(transaction_id)
        .map_err(|error| errors::transaction_failed(format!("读取文件事务失败：{error}")))?
    else {
        return Ok(None);
    };

    serde_json::from_slice::<FileTransactionManifest>(&value)
        .map(Some)
        .map_err(|error| errors::transaction_failed(format!("解析文件事务失败：{error}")))
}

struct TransactionStore {
    db: Database,
    transactions: Keyspace,
}

fn open_store(storage_root: &Path) -> Result<TransactionStore, String> {
    let db = Database::builder(storage_root.join(AED_DB_DIR))
        .open()
        .map_err(|error| errors::transaction_failed(format!("打开 fjall AED 存储失败：{error}")))?;
    let transactions = db
        .keyspace(FILE_TRANSACTIONS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::transaction_failed(format!("打开 file_transactions keyspace 失败：{error}"))
        })?;
    Ok(TransactionStore { db, transactions })
}

fn persist(db: &Database) -> Result<(), String> {
    db.persist(PersistMode::SyncAll)
        .map_err(|error| errors::transaction_failed(format!("持久化文件事务失败：{error}")))
}

fn resolve_staging_path(
    storage_root: &Path,
    transaction_id: &str,
    entry: &FileTransactionEntry,
) -> Result<PathBuf, String> {
    let staging_key = entry
        .staging_key
        .as_deref()
        .ok_or_else(|| errors::transaction_failed("事务条目缺少 staging key。"))?;
    Ok(storage_root
        .join(TRANSACTIONS_DIR)
        .join(transaction_id)
        .join(staging_key))
}

fn remove_staging_dir(storage_root: &Path, transaction_id: &str) -> Result<(), String> {
    let path = storage_root.join(TRANSACTIONS_DIR).join(transaction_id);
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(errors::transaction_failed(format!(
            "清理事务 staging 目录失败（{}）：{error}",
            path.display()
        ))),
    }
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| {
            errors::transaction_failed(format!(
                "创建事务目标目录失败（{}）：{error}",
                parent.display()
            ))
        })?;
    }
    Ok(())
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "路径不是有效 UTF-8。".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        FileTransactionAction, FileTransactionPlan, TransactionStatus, commit, recover_pending,
        update_status,
    };
    use crate::ai::edit::history::edit_journal;
    use crate::commands::contracts::AiEditOperationPayload;
    use std::fs;

    #[test]
    fn commit_applies_modify_actions_and_appends_operations() {
        let temp_dir = temp_dir("aed-file-transaction");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        let modify_path = temp_dir.join("modify.txt");
        fs::write(&modify_path, "old").expect("modify target should be written");

        commit(
            &temp_dir,
            FileTransactionPlan {
                actions: vec![FileTransactionAction::Modify {
                    path: modify_path.clone(),
                    content: "new".to_string(),
                }],
                operations: vec![operation("operation-1")],
            },
        )
        .expect("transaction should commit");

        assert_eq!(
            fs::read_to_string(&modify_path).expect("modify target should exist"),
            "new"
        );
        let operations = edit_journal::list_operations(&temp_dir).expect("operations should list");
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].id, "operation-1");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn recover_committed_transaction_replays_files_and_operations() {
        let temp_dir = temp_dir("aed-file-transaction-recover");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        let target_path = temp_dir.join("target.txt");
        fs::write(&target_path, "before").expect("target should be written");

        let plan = FileTransactionPlan {
            actions: vec![FileTransactionAction::Modify {
                path: target_path.clone(),
                content: "recovered".to_string(),
            }],
            operations: vec![operation("operation-2")],
        };

        let transaction = super::PreparedFileTransaction::new(&temp_dir, plan)
            .expect("transaction should prepare");
        transaction
            .write_staging_files()
            .expect("staging should be written");
        update_status(
            &temp_dir,
            &transaction.manifest.id,
            TransactionStatus::Committed,
        )
        .expect("transaction should be marked committed");

        recover_pending(&temp_dir).expect("transaction should recover");

        assert_eq!(
            fs::read_to_string(&target_path).expect("target should exist"),
            "recovered"
        );
        let operations = edit_journal::list_operations(&temp_dir).expect("operations should list");
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].id, "operation-2");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    fn operation(id: &str) -> AiEditOperationPayload {
        AiEditOperationPayload {
            id: id.to_string(),
            task_id: "task-1".to_string(),
            turn_id: "turn-1".to_string(),
            kind: "modify".to_string(),
            path: "src/main.ts".to_string(),
            new_path: None,
            source_snapshot_id: Some("snapshot-1".to_string()),
            before_hash: Some("blake3:before".to_string()),
            after_hash: Some("blake3:after".to_string()),
            bytes_before: Some(3),
            bytes_after: Some(9),
            applied_at: format!("2026-04-28T10:00:0{}.000Z", &id[id.len() - 1..]),
            reason: "事务测试".to_string(),
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
