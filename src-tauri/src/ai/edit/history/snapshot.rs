use crate::ai::edit::errors;
use crate::ai::edit::history::blob_store;
use crate::ai::edit::history::pins::PinIndex;
use crate::ai::edit::io::storage_lock;
use crate::commands::contracts::{AiApplyPatchMetadataRequest, AiSnapshotPayload};
use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};
use jiff::{SignedDuration, Timestamp};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const AED_DB_DIR: &str = "fjall";
const SNAPSHOTS_KEYSPACE: &str = "snapshots";
const SNAPSHOT_SCOPE_PRE_TOOL: &str = "pre-tool";
const SNAPSHOT_SCOPE_TASK_START: &str = "task-start";
const SNAPSHOT_SCOPE_TURN_START: &str = "turn-start";
const SNAPSHOT_SCOPE_MANUAL: &str = "manual";
const SNAPSHOT_SCOPE_PRE_REVERT: &str = "pre-revert";
const SNAPSHOT_SCOPE_REVERT: &str = "revert";
/// v2 -> v3：快照文件内容的物理存储从 fjall keyspace + 手写 CAS 目录切换到
/// gix 对象库（见 `history::blob_store`），blob_key 前缀从 `fjall:`/`cas:`
/// 变为唯一的 `git:`。不做双读兼容：v3 之前写入的快照清单里的 blob_key 在新
/// 代码下一律读取失败（清单本身仍可正常列出，`content_available` 会如实
/// 报告为 false，见 `has_live_blob`）。
const SNAPSHOT_MANIFEST_VERSION: u32 = 3;
pub const FULL_BLOB_TTL_DAYS: i64 = 14;
pub const PINNED_FULL_BLOB_TTL_DAYS: i64 = 30;
pub const DEFAULT_TOTAL_BLOB_QUOTA_BYTES: u64 = 1024 * 1024 * 1024;

/// 进程内单调递增序列：与纳秒时间戳组合，确保同一把写锁内连续创建的多个快照
/// （task-start / turn-start / manual|pre-tool）即使纳秒时间戳相同也不会发生
/// snapshot_id 冲突、互相覆盖。
static SNAPSHOT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Default)]
pub struct SnapshotPruneOutcome {
    pub removed_snapshot_ids: HashSet<String>,
    pub removed_blob_count: usize,
    pub reclaimed_bytes: u64,
    pub downgraded_snapshot_count: usize,
    pub downgraded_snapshot_ids: HashSet<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct SnapshotRetentionPolicy {
    pub now: Timestamp,
    pub full_blob_ttl: SignedDuration,
    pub pinned_full_blob_ttl: SignedDuration,
    pub total_blob_quota_bytes: u64,
}

impl Default for SnapshotRetentionPolicy {
    fn default() -> Self {
        Self {
            now: Timestamp::now(),
            full_blob_ttl: SignedDuration::from_secs(FULL_BLOB_TTL_DAYS * 86400),
            pinned_full_blob_ttl: SignedDuration::from_secs(PINNED_FULL_BLOB_TTL_DAYS * 86400),
            total_blob_quota_bytes: DEFAULT_TOTAL_BLOB_QUOTA_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SnapshotSourceFile<'a> {
    pub path: &'a str,
    pub content_hash: &'a str,
    pub content: &'a str,
}

#[derive(Debug, Clone)]
pub struct StoredSnapshotFile {
    pub path: String,
    pub content_hash: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct StoredSnapshot {
    pub snapshot: AiSnapshotPayload,
    pub files: Vec<StoredSnapshotFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    version: u32,
    id: String,
    scope: String,
    task_id: String,
    created_at: String,
    label: String,
    size_bytes: u64,
    files: Vec<SnapshotManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifestFile {
    path: String,
    content_hash: String,
    blob_key: Option<String>,
    byte_size: u64,
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
}

pub fn store_manual_snapshot(
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
/// 原实现为每个快照各自获取一次写锁并重新打开 `Database`，一次应用最多 3 次
/// 「开库 + 加锁」。这里收敛为 1 次，句柄生命周期严格 ⊆ 写锁临界区。
///
/// 返回 `(task_start, turn_start, source)`，其中 `source` 为 manual 或 pre-tool
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
}

pub fn store_pre_revert_snapshot(
    storage_root: &Path,
    task_id: &str,
    label: &str,
    files: &[SnapshotSourceFile<'_>],
) -> Result<AiSnapshotPayload, String> {
    store_snapshot(
        storage_root,
        SNAPSHOT_SCOPE_PRE_REVERT,
        task_id,
        label,
        files,
    )
}

pub fn store_revert_snapshot(
    storage_root: &Path,
    task_id: &str,
    label: &str,
    files: &[SnapshotSourceFile<'_>],
) -> Result<AiSnapshotPayload, String> {
    store_snapshot(storage_root, SNAPSHOT_SCOPE_REVERT, task_id, label, files)
}

pub fn load_stored_snapshot(
    storage_root: &Path,
    snapshot_id: &str,
) -> Result<StoredSnapshot, String> {
    storage_lock::with_storage_read_lock(storage_root, "读取 AED 快照", || {
        load_stored_snapshot_locked(storage_root, snapshot_id)
    })
}

fn load_stored_snapshot_locked(
    storage_root: &Path,
    snapshot_id: &str,
) -> Result<StoredSnapshot, String> {
    let store = open_store(storage_root)?;
    let manifest = load_manifest(&store.snapshots, snapshot_id)?
        .ok_or_else(|| errors::snapshot_not_found(snapshot_id))?;
    manifest.into_stored_snapshot(&store)
}

pub fn list_stored_snapshots(storage_root: &Path) -> Result<Vec<AiSnapshotPayload>, String> {
    storage_lock::with_storage_read_lock(storage_root, "读取 AED 快照列表", || {
        list_stored_snapshots_locked(storage_root)
    })
}

fn list_stored_snapshots_locked(storage_root: &Path) -> Result<Vec<AiSnapshotPayload>, String> {
    let store = open_store(storage_root)?;
    let mut snapshots = Vec::new();

    for item in store.snapshots.iter() {
        let (_key, value) = item.into_inner().map_err(|error| {
            errors::snapshot_store_failed(format!("读取 fjall 快照清单失败：{error}"))
        })?;

        match serde_json::from_slice::<SnapshotManifest>(&value) {
            Ok(manifest) => snapshots.push(manifest.into_payload()),
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid fjall snapshot manifest"
                );
            }
        }
    }

    Ok(snapshots)
}

/// 执行快照 GC（唯一句柄 API）。
///
/// 调用方须先通过 io::with_aed_database_write 持有 journal.lock 写锁并打开同一存储
/// 目录上唯一的 Database；本函数只做 fjall 快照清单更新与 gix blob 对象库裁剪，
/// 不再自获取锁或重新开库。
pub fn apply_snapshot_retention(
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
}

fn store_snapshot(
    storage_root: &Path,
    scope: &str,
    task_id: &str,
    label: &str,
    files: &[SnapshotSourceFile<'_>],
) -> Result<AiSnapshotPayload, String> {
    storage_lock::with_storage_write_lock(storage_root, "写入 AED 快照", || {
        store_snapshot_locked(storage_root, scope, task_id, label, files)
    })
}

fn store_snapshot_locked(
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
    );

    let mut manifest_files = Vec::with_capacity(files.len());
    let mut file_refs = Vec::with_capacity(files.len());
    let mut size_bytes = 0_u64;
    let mut batch = store.db.batch();

    for file in files {
        let blob_key = blob_store::store_blob(&store.blob_repo, file.content.as_bytes())?;
        let byte_size = file.content.len() as u64;
        size_bytes += byte_size;
        file_refs.push(file.path.to_string());
        manifest_files.push(SnapshotManifestFile {
            path: file.path.to_string(),
            content_hash: file.content_hash.to_string(),
            blob_key: Some(blob_key),
            byte_size,
        });
    }

    let manifest = SnapshotManifest {
        version: SNAPSHOT_MANIFEST_VERSION,
        id: snapshot_id.clone(),
        scope: scope.to_string(),
        task_id: task_id.to_string(),
        created_at: timestamp.to_string(),
        label: label.to_string(),
        size_bytes,
        files: manifest_files,
    };
    let manifest_json = serde_json::to_vec(&manifest)
        .map_err(|error| errors::snapshot_store_failed(format!("序列化快照清单失败：{error}")))?;
    batch.insert(
        &store.snapshots,
        snapshot_id.as_bytes().to_vec(),
        manifest_json,
    );
    batch
        .commit()
        .map_err(|error| errors::snapshot_store_failed(format!("写入 fjall 快照失败：{error}")))?;
    persist(&store.db)?;

    Ok(AiSnapshotPayload {
        id: snapshot_id,
        scope: scope.to_string(),
        task_id: task_id.to_string(),
        created_at: timestamp.to_string(),
        label: label.to_string(),
        file_refs,
        storage_key: manifest.storage_key(),
        size_bytes,
        content_available: true,
        pinned: false,
    })
}

fn resolve_task_id(metadata: Option<&AiApplyPatchMetadataRequest>) -> String {
    metadata
        .and_then(|value| value.task_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("manual-preview")
        .to_string()
}

fn resolve_label(
    metadata: Option<&AiApplyPatchMetadataRequest>,
    fallback: &str,
    empty_label: &str,
) -> String {
    let label = metadata
        .and_then(|value| value.reason.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .trim()
        .to_string();
    if label.is_empty() {
        empty_label.to_string()
    } else {
        label
    }
}

struct SnapshotStore {
    db: Database,
    snapshots: Keyspace,
    blob_repo: gix::Repository,
}

fn open_store(storage_root: &Path) -> Result<SnapshotStore, String> {
    let db = Database::builder(storage_root.join(AED_DB_DIR))
        .open()
        .map_err(|error| {
            errors::snapshot_store_failed(format!("打开 fjall AED 存储失败：{error}"))
        })?;
    let snapshots = db
        .keyspace(SNAPSHOTS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::snapshot_store_failed(format!("打开 snapshots keyspace 失败：{error}"))
        })?;
    let blob_repo = blob_store::open_blob_repo(storage_root)?;
    Ok(SnapshotStore {
        db,
        snapshots,
        blob_repo,
    })
}

fn persist(db: &Database) -> Result<(), String> {
    db.persist(PersistMode::SyncAll)
        .map_err(|error| errors::snapshot_store_failed(format!("持久化 fjall 快照失败：{error}")))
}

fn load_manifest(
    snapshots: &Keyspace,
    snapshot_id: &str,
) -> Result<Option<SnapshotManifest>, String> {
    let Some(value) = snapshots.get(snapshot_id).map_err(|error| {
        errors::snapshot_store_failed(format!("读取 fjall 快照清单失败：{error}"))
    })?
    else {
        return Ok(None);
    };

    serde_json::from_slice::<SnapshotManifest>(&value)
        .map(Some)
        .map_err(|error| errors::snapshot_store_failed(format!("解析 fjall 快照清单失败：{error}")))
}

fn list_manifests(snapshots: &Keyspace) -> Result<Vec<SnapshotManifest>, String> {
    let mut manifests = Vec::new();
    for item in snapshots.iter() {
        let (_key, value) = item.into_inner().map_err(|error| {
            errors::snapshot_store_failed(format!("读取 fjall 快照清单失败：{error}"))
        })?;
        match serde_json::from_slice::<SnapshotManifest>(&value) {
            Ok(manifest) => manifests.push(manifest),
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid fjall snapshot manifest during prune"
                );
            }
        }
    }
    Ok(manifests)
}

fn build_blob_ref_counts(manifests: &[SnapshotManifest]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for manifest in manifests {
        for blob_key in manifest
            .files
            .iter()
            .filter_map(|file| file.blob_key.as_ref())
        {
            *counts.entry(blob_key.clone()).or_insert(0) += 1;
        }
    }
    counts
}

fn build_active_blob_bytes(manifests: &[SnapshotManifest]) -> HashMap<String, u64> {
    let mut bytes_by_key = HashMap::new();
    for manifest in manifests {
        for file in &manifest.files {
            if let Some(blob_key) = file.blob_key.as_ref() {
                bytes_by_key
                    .entry(blob_key.clone())
                    .or_insert(file.byte_size);
            }
        }
    }
    bytes_by_key
}

fn should_strip_full_blobs(
    manifest: &SnapshotManifest,
    pin_index: &PinIndex,
    policy: SnapshotRetentionPolicy,
) -> bool {
    let Some(age) = snapshot_age(manifest, policy.now) else {
        return false;
    };
    if is_snapshot_pinned(manifest, pin_index) {
        age > policy.pinned_full_blob_ttl
    } else {
        age > policy.full_blob_ttl
    }
}

fn is_full_blob_pin_protected(
    manifest: &SnapshotManifest,
    pin_index: &PinIndex,
    policy: SnapshotRetentionPolicy,
) -> bool {
    if !is_snapshot_pinned(manifest, pin_index) {
        return false;
    }
    snapshot_age(manifest, policy.now)
        .map(|age| age <= policy.pinned_full_blob_ttl)
        .unwrap_or(true)
}

fn is_snapshot_pinned(manifest: &SnapshotManifest, pin_index: &PinIndex) -> bool {
    pin_index.pinned_snapshots.contains(&manifest.id)
        || pin_index.pinned_tasks.contains(&manifest.task_id)
}

fn snapshot_age(manifest: &SnapshotManifest, now: Timestamp) -> Option<SignedDuration> {
    parse_rfc3339_utc(&manifest.created_at).map(|created_at| now.duration_since(created_at))
}

fn parse_rfc3339_utc(value: &str) -> Option<Timestamp> {
    value.parse::<Timestamp>().ok()
}

fn strip_manifest_blobs(
    storage_root: &Path,
    manifest: &mut SnapshotManifest,
    blob_ref_counts: &mut HashMap<String, usize>,
    active_blob_bytes: &mut HashMap<String, u64>,
    outcome: &mut SnapshotPruneOutcome,
) -> Result<(), String> {
    let mut changed = false;
    let mut candidate_blob_keys = Vec::new();

    for file in &mut manifest.files {
        let Some(blob_key) = file.blob_key.take() else {
            continue;
        };
        changed = true;
        candidate_blob_keys.push(blob_key);
    }

    if !changed {
        return Ok(());
    }

    for blob_key in candidate_blob_keys {
        let Some(count) = blob_ref_counts.get_mut(&blob_key) else {
            continue;
        };
        *count = count.saturating_sub(1);
        if *count > 0 {
            continue;
        }

        blob_ref_counts.remove(&blob_key);
        active_blob_bytes.remove(&blob_key);
        let removed_bytes = blob_store::remove_blob(storage_root, &blob_key)?;
        if removed_bytes > 0 {
            outcome.removed_blob_count += 1;
            outcome.reclaimed_bytes += removed_bytes;
        }
    }

    outcome.downgraded_snapshot_count += 1;
    outcome.downgraded_snapshot_ids.insert(manifest.id.clone());
    Ok(())
}

impl SnapshotManifest {
    fn storage_key(&self) -> String {
        format!("fjall://snapshots/{}", self.id)
    }

    fn into_payload(self) -> AiSnapshotPayload {
        let storage_key = self.storage_key();
        let content_available = self.has_live_blob();
        AiSnapshotPayload {
            id: self.id,
            scope: self.scope,
            task_id: self.task_id,
            created_at: self.created_at,
            label: self.label,
            file_refs: self.files.into_iter().map(|file| file.path).collect(),
            storage_key,
            size_bytes: self.size_bytes,
            content_available,
            pinned: false,
        }
    }

    fn into_stored_snapshot(self, store: &SnapshotStore) -> Result<StoredSnapshot, String> {
        let mut files = Vec::with_capacity(self.files.len());
        for file in &self.files {
            let Some(blob_key) = file.blob_key.as_deref() else {
                return Err(errors::snapshot_store_failed(format!(
                    "快照 {} 的全文内容已按保留策略清理，无法一键恢复。",
                    self.id
                )));
            };
            let content = read_blob(&store.blob_repo, blob_key)?;
            files.push(StoredSnapshotFile {
                path: file.path.clone(),
                content_hash: file.content_hash.clone(),
                content,
            });
        }

        Ok(StoredSnapshot {
            snapshot: self.into_payload(),
            files,
        })
    }

    /// 是否存在“新格式且理论上可读”的 blob 引用。区分：
    /// - 保留策略主动清理（`blob_key` 被设为 `None`）
    /// - 迁移前遗留的旧格式 key（`blob_key` 是 `Some`，但不是 `git:` 前缀）
    /// 两者对最终用户而言都等价于“内容已不可恢复”，`content_available` 必须
    /// 对两者都如实报告为 `false`，而不是只看 `blob_key` 是否存在。
    fn has_live_blob(&self) -> bool {
        self.files.iter().all(|file| {
            file.blob_key
                .as_deref()
                .is_some_and(blob_store::is_valid_blob_key)
        })
    }
}

fn read_blob(blob_repo: &gix::Repository, blob_key: &str) -> Result<String, String> {
    let bytes = blob_store::read_blob(blob_repo, blob_key)?;
    String::from_utf8(bytes)
        .map_err(|error| errors::snapshot_store_failed(format!("快照 blob 不是 UTF-8：{error}")))
}

#[cfg(test)]
mod tests {
    use super::{
        SnapshotRetentionPolicy, SnapshotSourceFile, apply_snapshot_retention,
        list_stored_snapshots, load_stored_snapshot, store_checkpoint_snapshots,
        store_manual_snapshot,
    };
    use crate::ai::edit::history::pins::PinIndex;
    use crate::ai::edit::io;
    use crate::commands::contracts::AiApplyPatchMetadataRequest;
    use std::fs;

    #[test]
    fn store_checkpoint_pre_tool_snapshot_writes_manifest_and_dedupes_identical_content() {
        let temp_dir = temp_dir("aed-snapshot");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        let (task_start, turn_start, snapshot) = store_checkpoint_snapshots(
            &temp_dir,
            &[
                SnapshotSourceFile {
                    path: "src/a.sh",
                    content_hash: "blake3:shared",
                    content: "echo shared",
                },
                SnapshotSourceFile {
                    path: "src/b.sh",
                    content_hash: "blake3:shared",
                    content: "echo shared",
                },
            ],
            Some(&AiApplyPatchMetadataRequest {
                task_id: Some("task-1".to_string()),
                turn_id: None,
                reason: Some("预快照".to_string()),
                tool_call_id: None,
                confirmed_by_user: None,
                agent_run_id: None,
                agent_step_id: None,
                workspace_root_path: None,
            }),
            "应用 AI Patch",
            false,
            false,
            false,
        )
        .expect("snapshot should be written");

        assert!(task_start.is_none());
        assert!(turn_start.is_none());

        let restored = list_stored_snapshots(&temp_dir).expect("snapshots should be listed");
        let stored = load_stored_snapshot(&temp_dir, &snapshot.id).expect("snapshot should load");

        assert_eq!(snapshot.scope, "pre-tool");
        assert_eq!(snapshot.task_id, "task-1");
        assert_eq!(snapshot.file_refs.len(), 2);
        assert!(snapshot.storage_key.starts_with("fjall://snapshots/"));
        assert_eq!(restored.len(), 1);
        assert_eq!(stored.files.len(), 2);
        assert_eq!(stored.files[0].content, "echo shared");
        assert!(!temp_dir.join("snapshots").exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn store_manual_snapshot_uses_manual_scope() {
        let temp_dir = temp_dir("aed-manual-snapshot");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        let snapshot = store_manual_snapshot(
            &temp_dir,
            &[SnapshotSourceFile {
                path: "src/main.ts",
                content_hash: "blake3:manual",
                content: "console.log('manual');",
            }],
            Some(&AiApplyPatchMetadataRequest {
                task_id: Some("task-manual".to_string()),
                turn_id: None,
                reason: Some("Pin checkpoint".to_string()),
                tool_call_id: None,
                confirmed_by_user: Some(true),
                agent_run_id: None,
                agent_step_id: None,
                workspace_root_path: None,
            }),
            "Pin checkpoint",
        )
        .expect("manual snapshot should be written");

        let restored = list_stored_snapshots(&temp_dir).expect("snapshots should be listed");

        assert_eq!(snapshot.scope, "manual");
        assert_eq!(snapshot.task_id, "task-manual");
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].scope, "manual");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn large_snapshot_blob_round_trips_via_git_object_store() {
        let temp_dir = temp_dir("aed-large-snapshot");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        // 旧实现按 SMALL_BLOB_MAX_BYTES 阈值在此切到 CAS 目录；gix 对象库不区分
        // 大小，这里只需验证「足够大」的内容依然完整往返。
        let large_content = "x".repeat(512 * 1024);

        let snapshot = store_manual_snapshot(
            &temp_dir,
            &[SnapshotSourceFile {
                path: "src/large.sh",
                content_hash: "blake3:largeblob",
                content: &large_content,
            }],
            None,
            "large",
        )
        .expect("large snapshot should be written");

        let stored = load_stored_snapshot(&temp_dir, &snapshot.id).expect("snapshot should load");
        assert_eq!(stored.files[0].content, large_content);
        assert!(temp_dir.join("blobstore.git").is_dir());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn apply_snapshot_retention_downgrades_unpinned_full_blobs() {
        let temp_dir = temp_dir("aed-snapshot-retention");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        let first = store_manual_snapshot(
            &temp_dir,
            &[SnapshotSourceFile {
                path: "src/one.sh",
                content_hash: "blake3:shared",
                content: "echo shared",
            }],
            None,
            "first",
        )
        .expect("first snapshot should be written");
        std::thread::sleep(std::time::Duration::from_millis(1));

        let second = store_manual_snapshot(
            &temp_dir,
            &[SnapshotSourceFile {
                path: "src/two.sh",
                content_hash: "blake3:unique",
                content: "echo unique",
            }],
            None,
            "second",
        )
        .expect("second snapshot should be written");

        let outcome = io::with_aed_database_write(&temp_dir, "测试快照 GC", |db| {
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
        .expect("snapshots should be downgraded");

        let snapshots = list_stored_snapshots(&temp_dir).expect("snapshots should be listed");

        assert_eq!(snapshots.len(), 2);
        assert!(snapshots.iter().any(|snapshot| snapshot.id == first.id));
        assert!(snapshots.iter().any(|snapshot| snapshot.id == second.id));
        assert!(snapshots.iter().all(|snapshot| !snapshot.content_available));
        assert!(outcome.removed_snapshot_ids.is_empty());
        assert_eq!(outcome.downgraded_snapshot_count, 2);
        assert_eq!(outcome.removed_blob_count, 2);
        assert!(outcome.reclaimed_bytes > 0);

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
