//! AED 撤销/回滚命令实现。
//!
//! # 职责边界
//! - `restore_snapshot`：基于已存快照整体恢复目标文件集合。
//! - `undo_operation` / `revert_file`：按 modify operation 粒度撤销，依赖 source
//!   snapshot 与当前文件内容 hash 校验对齐。
//! - `revert_hunk`：基于 `diff_render` 渲染的 hunk 序列做单 hunk 反向。
//! - `revert_task`：在同一 task 内逐条撤销 operation。
//!
//! # 关键不变量（如未来违反需同步修改本文件）
//! 1. **operation 顺序**：`list_task_operations` 返回的列表必须按时间倒序
//!    （最新的 operation 在前）。`revert_file` 使用 `find()` 取首个匹配，
//!    `revert_task` 顺序撤销，二者均依赖此约定。一旦改成正序，会因
//!    `ensure_operation_matches_expected_state` 中的 `after_hash` 校验全部失败。
//! 2. **`revert_hunk` 的副作用**：
//!    - 直接写盘但 **不会更新 operation.after_hash**，因此「先逐 hunk 回滚再
//!      整文件回滚」会被 `ensure_operation_matches_expected_state` 拒绝。
//!      逃生路径是用 `restore_snapshot` 回到 hunk 回滚前快照。
//!    - 当前 **不在 `edit_journal` 落账**，仅写两个快照 + 一条 tracing 事件。
//! 3. **diff_render 接入**：`revert_hunk` 调用 `apply_reverse_hunk` 单 hunk 版；
//!    本文件不依赖 `apply_reverse_hunks` 多 hunk 顺序保护。

use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::edit as ai_edit;
use crate::ai::edit::AiEditState;
use crate::ai::edit::apply::diff_render;
use crate::ai::edit::errors;
use crate::ai::edit::history::{edit_journal, snapshot};
use crate::ai::edit::io::atomic_write;
use crate::ai::edit::patch;
use crate::ai::edit::security::path_security;
use crate::commands::contracts::{
    AiEditDiffHunkPayload, AiEditGetDiffPayload, AiEditGetDiffRequest, AiEditListTimelineRequest,
    AiEditOperationPayload, AiEditRestoreSnapshotPayload, AiEditRestoreSnapshotRequest,
    AiEditRevertFilePayload, AiEditRevertFileRequest, AiEditRevertHunkPayload,
    AiEditRevertHunkRequest, AiEditRevertTaskPayload, AiEditRevertTaskRequest,
    AiEditTimelineEntryPayload, AiEditUndoOperationPayload, AiEditUndoOperationRequest,
    AiSnapshotPayload,
};
use fs_err as fs;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 单条 undo 路径的内部产物。
///
/// `restored_files` 中可能包含多个路径（如 rename 同时返回原路径与目标路径）。
struct UndoExecutionResult {
    restored_files: Vec<String>,
    pre_revert_snapshot: AiSnapshotPayload,
    restored_snapshot: AiSnapshotPayload,
    source_snapshot_id: Option<String>,
}

/// 单条 operation 的 diff 渲染上下文。
struct OperationDiffContext {
    operation: AiEditOperationPayload,
    path: String,
    kind: String,
    before_content: String,
    after_content: String,
}

/// 整体恢复至指定快照。
///
/// 流程：
/// 1. 加载目标快照 + 当前文件状态。
/// 2. 写入「恢复前快照」（`pre-revert`）记录回滚前的现场。
/// 3. 把目标快照中的每个文件写回磁盘。
/// 4. 写入「恢复后快照」（`revert`）作为新的基线。
///
/// 失败语义：任一步骤失败即返回 Err；已经写入的 pre-revert 快照保留，便于审计。
pub fn restore_snapshot(
    payload: AiEditRestoreSnapshotRequest,
    storage_root: &Path,
    state: &AiEditState,
) -> Result<AiEditRestoreSnapshotPayload, String> {
    let snapshot_id =
        require_non_empty_param(&payload.snapshot_id, || errors::snapshot_not_found(""))?;

    let target_snapshot = snapshot::load_stored_snapshot(storage_root, snapshot_id)?;
    ai_edit::ensure_write_authorized(
        state,
        "AED 快照恢复",
        Some(target_snapshot.snapshot.task_id.as_str()),
    )?;

    let current_files = target_snapshot
        .files
        .iter()
        .map(|file| {
            let path = validate_revert_path(&file.path)?;
            let current_content = fs::read_to_string(&path).map_err(|error| {
                errors::restore_conflict(format!("读取当前文件失败({}):{error}", file.path))
            })?;
            Ok(snapshot::StoredSnapshotFile {
                path: file.path.clone(),
                content_hash: patch::hash_text(&current_content),
                content: current_content,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let current_sources = as_snapshot_sources(&current_files);
    let pre_revert_snapshot = snapshot::store_pre_revert_snapshot(
        storage_root,
        &target_snapshot.snapshot.task_id,
        &format!("恢复前快照:{}", target_snapshot.snapshot.label),
        &current_sources,
    )?;
    ai_edit::append_snapshot(state, storage_root, pre_revert_snapshot.clone())?;

    for file in &target_snapshot.files {
        let path = validate_revert_path(&file.path)?;
        ensure_parent_dir(&path, "恢复目录")?;
        atomic_write::write_text(&path, &file.content).map_err(|error| {
            errors::restore_failed(format!("写回恢复文件失败({}):{error}", file.path))
        })?;
    }

    let restored_sources = as_snapshot_sources(&target_snapshot.files);
    let restored_snapshot = snapshot::store_revert_snapshot(
        storage_root,
        &target_snapshot.snapshot.task_id,
        &format!("恢复到快照:{}", target_snapshot.snapshot.label),
        &restored_sources,
    )?;
    ai_edit::append_snapshot(state, storage_root, restored_snapshot.clone())?;

    tracing::info!(
        target: "ai.audit",
        event = "ai.edit.snapshot_restored",
        snapshot_id = snapshot_id,
        pre_revert_snapshot_id = pre_revert_snapshot.id.as_str(),
        restored_snapshot_id = restored_snapshot.id.as_str(),
        task_id = target_snapshot.snapshot.task_id.as_str(),
        restored_file_count = target_snapshot.files.len(),
        "AI edit snapshot restored"
    );
    audit::emit(AiAuditEventKind::AiEditSnapshotRestored);

    Ok(AiEditRestoreSnapshotPayload {
        snapshot_id: snapshot_id.to_string(),
        restored_files: target_snapshot
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect(),
        pre_revert_snapshot,
        restored_snapshot,
    })
}

/// 撤销指定 operation。
///
/// 严格校验：要求当前文件状态匹配 modify operation.after_hash。
/// 任何漂移都会立刻报错而不是写坏。
pub fn undo_operation(
    payload: AiEditUndoOperationRequest,
    storage_root: &Path,
    state: &AiEditState,
) -> Result<AiEditUndoOperationPayload, String> {
    let operation_id =
        require_non_empty_param(&payload.operation_id, || errors::operation_not_found(""))?;

    let operation = resolve_operation(storage_root, state, operation_id)?;
    ai_edit::ensure_write_authorized(state, "AED 单条编辑撤销", Some(operation.task_id.as_str()))?;

    let result = execute_undo_operation(storage_root, state, &operation)?;
    emit_operation_reverted(&operation, &result);

    Ok(AiEditUndoOperationPayload {
        operation_id: operation.id,
        restored_files: result.restored_files,
        pre_revert_snapshot: result.pre_revert_snapshot,
        restored_snapshot: result.restored_snapshot,
    })
}

/// 渲染指定 task + 文件路径下、当前最新有效 operation 的 diff。
///
/// 优先返回有 hunk 的 preview；若所有匹配 operation 都已 hunk 为空（已撤销/无变化），
/// 退回最后一次匹配的 preview，便于前端展示「无差异」。
pub fn get_diff(
    payload: AiEditGetDiffRequest,
    storage_root: &Path,
    state: &AiEditState,
) -> Result<AiEditGetDiffPayload, String> {
    let task_id = require_non_empty_param(&payload.task_id, || errors::task_not_found(""))?;
    let target_path = require_non_empty_path(&payload.path, "缺少待预览 diff 的文件路径。")?;

    let preview = resolve_diff_preview(storage_root, state, task_id, target_path)?;

    Ok(AiEditGetDiffPayload {
        task_id: task_id.to_string(),
        path: preview.path,
        operation_id: preview.operation.id,
        kind: preview.kind,
        additions: preview.additions,
        deletions: preview.deletions,
        hunks: preview.hunks,
    })
}

/// 整文件回滚至 operation 的 source snapshot 状态。
///
/// 选取 `list_task_operations` 中**首条**匹配路径的 operation —— 由于列表按
/// 时间倒序，等价于「最近一次涉及该文件的 operation」。
pub fn revert_file(
    payload: AiEditRevertFileRequest,
    storage_root: &Path,
    state: &AiEditState,
) -> Result<AiEditRevertFilePayload, String> {
    let task_id = require_non_empty_param(&payload.task_id, || errors::task_not_found(""))?;
    let target_path = require_non_empty_path(&payload.path, "缺少待回滚的文件路径。")?;

    ai_edit::ensure_write_authorized(state, "AED 文件回滚", Some(task_id))?;

    let operations = list_task_operations(storage_root, state, task_id)?;
    let operation = operations
        .into_iter()
        .find(|operation| operation.path == target_path)
        .ok_or_else(|| {
            errors::restore_conflict(format!(
                "任务 {task_id} 中未找到文件 {target_path} 的 AED 编辑记录。"
            ))
        })?;

    if is_operation_already_reverted(storage_root, &operation)? {
        return Err(errors::restore_conflict(format!(
            "文件 {target_path} 当前没有可回滚的 AED 编辑。"
        )));
    }

    let result = execute_undo_operation(storage_root, state, &operation)?;
    emit_operation_reverted(&operation, &result);

    tracing::info!(
        target: "ai.audit",
        event = "ai.edit.file_reverted",
        operation_id = operation.id.as_str(),
        task_id = operation.task_id.as_str(),
        path = target_path,
        pre_revert_snapshot_id = result.pre_revert_snapshot.id.as_str(),
        restored_snapshot_id = result.restored_snapshot.id.as_str(),
        restored_file_count = result.restored_files.len(),
        granularity = "file",
        "AI edit file reverted"
    );
    audit::emit(AiAuditEventKind::AiEditFileReverted);

    Ok(AiEditRevertFilePayload {
        task_id: operation.task_id.clone(),
        path: target_path.to_string(),
        operation_id: operation.id,
        restored_files: result.restored_files,
        pre_revert_snapshot: result.pre_revert_snapshot,
        restored_snapshot: result.restored_snapshot,
    })
}

/// 撤销指定 task + 文件下的某一个 hunk。
///
/// # 已知限制（在重构前不要改）
/// - 仅支持 `kind == "modify"` 的 operation。rename/create/delete 即使 diff 不为空，
///   也会被拒绝；前端应据此隐藏按钮。
/// - **不更新** operation 的 `after_hash`，所以「先 revert_hunk 再 revert_file
///   /undo_operation」会因 hash 校验失败被拒。这是设计权衡：保留 operation 原状以
///   便审计，逃生路径是 `restore_snapshot` 回滚到 hunk 回滚前快照。
/// - **不在 `edit_journal` 落账**，仅写两个快照 + 一条 `ai.edit.hunk_reverted`
///   tracing 事件。后续如要支持「撤销 hunk 撤销」，需要先扩展 journal。
pub fn revert_hunk(
    payload: AiEditRevertHunkRequest,
    storage_root: &Path,
    state: &AiEditState,
) -> Result<AiEditRevertHunkPayload, String> {
    let task_id = require_non_empty_param(&payload.task_id, || errors::task_not_found(""))?;
    let target_path = require_non_empty_path(&payload.path, "缺少待回滚 hunk 的文件路径。")?;

    ai_edit::ensure_write_authorized(state, "AED hunk 回滚", Some(task_id))?;

    let preview = resolve_diff_preview(storage_root, state, task_id, target_path)?;

    if preview.kind != "modify" {
        return Err(errors::restore_conflict(format!(
            "当前仅支持对 modify 类型执行 hunk 回滚:{target_path}"
        )));
    }

    let selected_hunk = preview
        .hunks
        .iter()
        .find(|hunk| hunk.hunk_index == payload.hunk_index)
        .ok_or_else(|| {
            errors::restore_conflict(format!("未找到 hunk #{}:{target_path}", payload.hunk_index))
        })?;

    let current_file = read_snapshot_file(target_path)?;
    let pre_revert_snapshot = append_pre_revert_snapshot(
        storage_root,
        state,
        task_id,
        &format!("按 hunk 回滚前快照:{target_path}"),
        std::slice::from_ref(&current_file),
    )?;

    // diff_render 内部对 current_segment 与 hunk +行做严格相等校验，
    // 任何漂移都会以 restore_conflict 形式返回。
    let restored_content =
        diff_render::apply_reverse_hunk(&current_file.content, &to_patch_hunk(selected_hunk))
            .map_err(errors::restore_conflict)?;

    let safe_target_path = validate_revert_path(target_path)?;
    atomic_write::write_text(&safe_target_path, &restored_content).map_err(|error| {
        errors::restore_failed(format!("写回 hunk 回滚文件失败({target_path}):{error}"))
    })?;

    let restored_file = read_snapshot_file(target_path)?;
    let restored_snapshot = append_revert_snapshot(
        storage_root,
        state,
        task_id,
        &format!("按 hunk 回滚:{target_path}#{}", payload.hunk_index),
        std::slice::from_ref(&restored_file),
    )?;

    tracing::info!(
        target: "ai.audit",
        event = "ai.edit.hunk_reverted",
        operation_id = preview.operation.id.as_str(),
        task_id = task_id,
        path = target_path,
        hunk_index = payload.hunk_index,
        pre_revert_snapshot_id = pre_revert_snapshot.id.as_str(),
        restored_snapshot_id = restored_snapshot.id.as_str(),
        granularity = "hunk",
        "AI edit hunk reverted"
    );
    audit::emit(AiAuditEventKind::AiEditHunkReverted);

    Ok(AiEditRevertHunkPayload {
        task_id: task_id.to_string(),
        path: target_path.to_string(),
        operation_id: preview.operation.id,
        hunk_index: payload.hunk_index,
        restored_files: vec![target_path.to_string()],
        pre_revert_snapshot,
        restored_snapshot,
    })
}

/// 整 task 回滚：按 `list_task_operations` 顺序（newest-first）依次撤销每个 operation。
///
/// # 顺序约束
/// 列表必须 newest-first；正序会因 `after_hash` 校验失败。同一文件多次编辑时，
/// 撤销序列：op_n → op_{n-1} → ... → op_1。
///
/// # 失败语义
/// 任一 operation 撤销失败立即抛错，已撤销的部分保留（每条都生成了
/// pre/post 快照，可手动通过 `restore_snapshot` 回到任意中间状态）。
pub fn revert_task(
    payload: AiEditRevertTaskRequest,
    storage_root: &Path,
    state: &AiEditState,
) -> Result<AiEditRevertTaskPayload, String> {
    let task_id = require_non_empty_param(&payload.task_id, || errors::task_not_found(""))?;

    ai_edit::ensure_write_authorized(state, "AED 任务回滚", Some(task_id))?;

    let operations = list_task_operations(storage_root, state, task_id)?;

    let mut reverted_operation_ids = Vec::new();
    let mut restored_files = Vec::new();
    let mut restored_file_set = HashSet::new();
    let mut pre_revert_snapshots = Vec::new();
    let mut restored_snapshots = Vec::new();

    for operation in operations {
        if is_operation_already_reverted(storage_root, &operation)? {
            continue;
        }

        let result = execute_undo_operation(storage_root, state, &operation)?;
        emit_operation_reverted(&operation, &result);

        for path in &result.restored_files {
            if restored_file_set.insert(path.clone()) {
                restored_files.push(path.clone());
            }
        }

        reverted_operation_ids.push(operation.id.clone());
        pre_revert_snapshots.push(result.pre_revert_snapshot);
        restored_snapshots.push(result.restored_snapshot);
    }

    if reverted_operation_ids.is_empty() {
        return Err(errors::restore_conflict(format!(
            "任务 {task_id} 当前没有可撤销的 AED 编辑。"
        )));
    }

    tracing::info!(
        target: "ai.audit",
        event = "ai.edit.task_reverted",
        task_id = task_id,
        reverted_operation_count = reverted_operation_ids.len(),
        restored_file_count = restored_files.len(),
        "AI edit task reverted"
    );
    audit::emit(AiAuditEventKind::AiEditTaskReverted);

    Ok(AiEditRevertTaskPayload {
        task_id: task_id.to_string(),
        reverted_operation_ids,
        restored_files,
        pre_revert_snapshots,
        restored_snapshots,
    })
}

// =============================================================================
// 内部辅助
// =============================================================================

/// 通用空字符串参数校验：trim 后空 → 调用方提供的错误构造器。
///
/// 所有公开命令都先过这一道。错误类别保持与原始实现一致，调用方决定使用
/// `task_not_found` / `operation_not_found` / `snapshot_not_found` 中的哪一种。
fn require_non_empty_param<F>(value: &str, on_empty: F) -> Result<&str, String>
where
    F: FnOnce() -> String,
{
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(on_empty());
    }
    Ok(trimmed)
}

/// 路径参数校验：与 `require_non_empty_param` 类似，但错误统一走 `restore_conflict`。
fn require_non_empty_path<'a>(value: &'a str, message: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(errors::restore_conflict(message));
    }
    Ok(trimmed)
}

/// 解析 operation：优先在内存时间线里找，找不到再去 journal。
fn resolve_operation(
    storage_root: &Path,
    state: &AiEditState,
    operation_id: &str,
) -> Result<AiEditOperationPayload, String> {
    {
        let guard = state.timeline.lock();
        if let Some(operation) = guard.iter().find_map(|entry| match entry {
            AiEditTimelineEntryPayload::Operation(operation) if operation.id == operation_id => {
                Some(operation.clone())
            }
            _ => None,
        }) {
            return Ok(operation);
        }
    }
    edit_journal::list_operations(storage_root)?
        .into_iter()
        .find(|operation| operation.id == operation_id)
        .ok_or_else(|| errors::operation_not_found(operation_id))
}

/// 列出指定 task 的全部 operation（**newest-first**，详见模块顶部不变量）。
fn list_task_operations(
    storage_root: &Path,
    state: &AiEditState,
    task_id: &str,
) -> Result<Vec<AiEditOperationPayload>, String> {
    let timeline = ai_edit::list_timeline_with_state(
        AiEditListTimelineRequest {
            task_id: Some(task_id.to_string()),
            limit: None,
        },
        state,
        Vec::new(),
        edit_journal::list_operations(storage_root)?,
    )?;
    let operations = timeline
        .entries
        .into_iter()
        .filter_map(|entry| match entry {
            AiEditTimelineEntryPayload::Operation(operation) => Some(operation),
            AiEditTimelineEntryPayload::Snapshot(_) => None,
        })
        .collect::<Vec<_>>();

    if operations.is_empty() {
        return Err(errors::task_not_found(task_id));
    }

    Ok(operations)
}

fn execute_undo_operation(
    storage_root: &Path,
    state: &AiEditState,
    operation: &AiEditOperationPayload,
) -> Result<UndoExecutionResult, String> {
    ensure_operation_matches_expected_state(operation)?;

    let source_snapshot = operation
        .source_snapshot_id
        .as_deref()
        .map(|snapshot_id| snapshot::load_stored_snapshot(storage_root, snapshot_id))
        .transpose()?;

    match operation.kind.as_str() {
        "modify" => undo_modify_operation(storage_root, state, operation, source_snapshot.as_ref()),
        other => Err(errors::restore_conflict(format!(
            "当前不支持撤销该操作类型:{other}"
        ))),
    }
}

/// 入口校验：撤销前确保磁盘上的状态与 operation 记录的「编辑后」状态一致。
///
/// - `modify`：当前文件 hash == operation.after_hash
fn ensure_operation_matches_expected_state(
    operation: &AiEditOperationPayload,
) -> Result<(), String> {
    match operation.kind.as_str() {
        "modify" => {
            let current_file = read_snapshot_file(&operation.path)?;
            if let Some(expected_hash) = operation.after_hash.as_deref()
                && current_file.content_hash != expected_hash
            {
                return Err(errors::restore_conflict(format!(
                    "文件当前内容与 AED 记录不一致,拒绝回滚:{}",
                    operation.path
                )));
            }
            Ok(())
        }
        other => Err(errors::restore_conflict(format!(
            "当前不支持校验该操作类型的状态:{other}"
        ))),
    }
}

struct ResolvedDiffPreview {
    operation: AiEditOperationPayload,
    path: String,
    kind: String,
    additions: u32,
    deletions: u32,
    hunks: Vec<AiEditDiffHunkPayload>,
}

fn resolve_diff_preview(
    storage_root: &Path,
    state: &AiEditState,
    task_id: &str,
    target_path: &str,
) -> Result<ResolvedDiffPreview, String> {
    let operations = list_task_operations(storage_root, state, task_id)?;

    let mut matched_operation = false;
    let mut last_preview = None;

    for operation in operations {
        if operation.path != target_path {
            continue;
        }
        matched_operation = true;

        let context = match build_operation_diff_context(storage_root, &operation) {
            Ok(context) => context,
            Err(error) => {
                if let Some(preview) = build_preview_from_stored_diff(&operation)? {
                    if !preview.hunks.is_empty() {
                        return Ok(preview);
                    }
                    last_preview = Some(preview);
                    continue;
                } else {
                    return Err(error);
                }
            }
        };
        let rendered =
            diff_render::render_patch_hunks(&context.before_content, &context.after_content);

        let preview = ResolvedDiffPreview {
            operation: context.operation,
            path: context.path,
            kind: context.kind,
            additions: rendered.additions,
            deletions: rendered.deletions,
            hunks: rendered
                .hunks
                .into_iter()
                .enumerate()
                .map(|(index, hunk)| AiEditDiffHunkPayload {
                    hunk_index: index as u32,
                    old_start: hunk.old_start,
                    old_lines: hunk.old_lines,
                    new_start: hunk.new_start,
                    new_lines: hunk.new_lines,
                    lines: hunk.lines,
                })
                .collect(),
        };

        if !preview.hunks.is_empty() {
            return Ok(preview);
        }
        last_preview = Some(preview);
    }

    if let Some(preview) = last_preview {
        return Ok(preview);
    }

    if matched_operation {
        return Err(errors::restore_conflict(format!(
            "文件 {target_path} 当前没有可预览的 AED diff。"
        )));
    }

    Err(errors::restore_conflict(format!(
        "任务 {task_id} 中未找到文件 {target_path} 的 AED 编辑记录。"
    )))
}

fn build_preview_from_stored_diff(
    operation: &AiEditOperationPayload,
) -> Result<Option<ResolvedDiffPreview>, String> {
    let Some(diff_text) = operation.diff_text.as_deref() else {
        return Ok(None);
    };
    let (additions, deletions, hunks) = parse_stored_unified_diff_hunks(diff_text)?;
    Ok(Some(ResolvedDiffPreview {
        operation: operation.clone(),
        path: operation.path.clone(),
        kind: operation.kind.clone(),
        additions,
        deletions,
        hunks,
    }))
}

fn parse_stored_unified_diff_hunks(
    diff_text: &str,
) -> Result<(u32, u32, Vec<AiEditDiffHunkPayload>), String> {
    let mut additions = 0;
    let mut deletions = 0;
    let mut hunks = Vec::new();
    let mut current: Option<AiEditDiffHunkPayload> = None;

    for line in diff_text.lines() {
        if let Some(header) = line.strip_prefix("@@ ") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            let (old_start, old_lines, new_start, new_lines) = parse_unified_hunk_header(header)?;
            current = Some(AiEditDiffHunkPayload {
                hunk_index: hunks.len() as u32,
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines: Vec::new(),
            });
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            continue;
        };
        if line == "\\ No newline at end of file" {
            hunk.lines.push(line.to_string());
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
            hunk.lines.push(line.to_string());
            continue;
        }
        if line.starts_with('-') {
            deletions += 1;
            hunk.lines.push(line.to_string());
            continue;
        }
        if line.starts_with(' ') {
            hunk.lines.push(line.to_string());
        }
    }

    if let Some(hunk) = current {
        hunks.push(hunk);
    }

    Ok((additions, deletions, hunks))
}

fn parse_unified_hunk_header(header: &str) -> Result<(u32, u32, u32, u32), String> {
    let range_part = header.split(" @@").next().unwrap_or(header).trim();
    let mut parts = range_part.split_whitespace();
    let old_range = parts
        .next()
        .ok_or_else(|| errors::restore_conflict("存档 diff hunk 缺少旧范围。"))?;
    let new_range = parts
        .next()
        .ok_or_else(|| errors::restore_conflict("存档 diff hunk 缺少新范围。"))?;
    let (old_start, old_lines) = parse_unified_range(old_range, '-')?;
    let (new_start, new_lines) = parse_unified_range(new_range, '+')?;
    Ok((old_start, old_lines, new_start, new_lines))
}

fn parse_unified_range(value: &str, prefix: char) -> Result<(u32, u32), String> {
    let raw = value
        .strip_prefix(prefix)
        .ok_or_else(|| errors::restore_conflict("存档 diff hunk 范围格式无效。"))?;
    let (start, lines) = raw.split_once(',').unwrap_or((raw, "1"));
    let start = start
        .parse::<u32>()
        .map_err(|error| errors::restore_conflict(format!("解析 hunk 起点失败：{error}")))?;
    let lines = lines
        .parse::<u32>()
        .map_err(|error| errors::restore_conflict(format!("解析 hunk 行数失败：{error}")))?;
    Ok((start, lines))
}

fn build_operation_diff_context(
    storage_root: &Path,
    operation: &AiEditOperationPayload,
) -> Result<OperationDiffContext, String> {
    let source_snapshot = operation
        .source_snapshot_id
        .as_deref()
        .map(|snapshot_id| snapshot::load_stored_snapshot(storage_root, snapshot_id))
        .transpose()?;

    match operation.kind.as_str() {
        "modify" => {
            let source_snapshot = source_snapshot
                .ok_or_else(|| errors::restore_conflict("未找到 modify diff 所需的源快照。"))?;
            let source_file = require_source_file(&source_snapshot, &operation.path)?;
            let current_file = read_snapshot_file(&operation.path)?;
            Ok(OperationDiffContext {
                operation: operation.clone(),
                path: operation.path.clone(),
                kind: operation.kind.clone(),
                before_content: source_file.content,
                after_content: current_file.content,
            })
        }
        other => Err(errors::restore_conflict(format!(
            "当前不支持生成该操作类型的 AED diff:{other}"
        ))),
    }
}

/// 把 `AiEditDiffHunkPayload` 投影回 `AiPatchHunkPayload` 以喂给 `diff_render`。
fn to_patch_hunk(hunk: &AiEditDiffHunkPayload) -> crate::commands::contracts::AiPatchHunkPayload {
    crate::commands::contracts::AiPatchHunkPayload {
        old_start: hunk.old_start,
        old_lines: hunk.old_lines,
        new_start: hunk.new_start,
        new_lines: hunk.new_lines,
        lines: hunk.lines.clone(),
    }
}

fn emit_operation_reverted(operation: &AiEditOperationPayload, result: &UndoExecutionResult) {
    tracing::info!(
        target: "ai.audit",
        event = "ai.edit.operation_reverted",
        operation_id = operation.id.as_str(),
        source_snapshot_id = result.source_snapshot_id.as_deref().unwrap_or(""),
        pre_revert_snapshot_id = result.pre_revert_snapshot.id.as_str(),
        restored_snapshot_id = result.restored_snapshot.id.as_str(),
        task_id = operation.task_id.as_str(),
        restored_file_count = result.restored_files.len(),
        "AI edit operation reverted"
    );
    audit::emit(AiAuditEventKind::AiEditOperationReverted);
}

/// 判断 operation 是否已经处于「已撤销」状态。
///
/// 语义：当前磁盘状态与 source snapshot 一致即视为已撤销。
/// 用途：`revert_file` / `revert_task` 在撤销前先做幂等性检查，避免重复写盘 + 幻觉
/// 报错。
fn is_operation_already_reverted(
    storage_root: &Path,
    operation: &AiEditOperationPayload,
) -> Result<bool, String> {
    match operation.kind.as_str() {
        "modify" => {
            if !validate_revert_path(&operation.path)?.exists() {
                return Ok(false);
            }
            let source_snapshot = load_required_source_snapshot(storage_root, operation, "modify")?;
            let source_file = require_source_file(&source_snapshot, &operation.path)?;
            let current_file = read_snapshot_file(&operation.path)?;
            Ok(current_file.content_hash == source_file.content_hash)
        }
        other => Err(errors::restore_conflict(format!(
            "当前不支持检查该操作类型的回滚状态:{other}"
        ))),
    }
}

/// 抽取「加载必需的 source snapshot」公共逻辑，统一错误信息格式。
fn load_required_source_snapshot(
    storage_root: &Path,
    operation: &AiEditOperationPayload,
    kind_label: &str,
) -> Result<snapshot::StoredSnapshot, String> {
    operation
        .source_snapshot_id
        .as_deref()
        .map(|snapshot_id| snapshot::load_stored_snapshot(storage_root, snapshot_id))
        .transpose()?
        .ok_or_else(|| errors::restore_conflict(format!("未找到 {kind_label} 撤销所需的源快照。")))
}

fn undo_modify_operation(
    storage_root: &Path,
    state: &AiEditState,
    operation: &AiEditOperationPayload,
    source_snapshot: Option<&snapshot::StoredSnapshot>,
) -> Result<UndoExecutionResult, String> {
    let source_snapshot_id = operation
        .source_snapshot_id
        .clone()
        .ok_or_else(|| errors::restore_conflict("该编辑没有可用的源快照引用。"))?;
    let source_snapshot = source_snapshot
        .ok_or_else(|| errors::restore_conflict("未找到 modify 撤销所需的源快照。"))?;
    let source_file = require_source_file(source_snapshot, &operation.path)?;

    let current_file = read_snapshot_file(&operation.path)?;
    let pre_revert_snapshot = append_pre_revert_snapshot(
        storage_root,
        state,
        &operation.task_id,
        &format!("撤销前快照:{}", operation.path),
        std::slice::from_ref(&current_file),
    )?;

    let target_path = validate_revert_path(&operation.path)?;
    ensure_parent_dir(&target_path, "撤销目录")?;
    atomic_write::write_text(&target_path, &source_file.content).map_err(|error| {
        errors::restore_failed(format!("写回撤销文件失败({}):{error}", operation.path))
    })?;

    let restored_snapshot = append_revert_snapshot(
        storage_root,
        state,
        &operation.task_id,
        &format!("撤销编辑:{}", operation.path),
        std::slice::from_ref(&source_file),
    )?;

    Ok(UndoExecutionResult {
        restored_files: vec![operation.path.clone()],
        pre_revert_snapshot,
        restored_snapshot,
        source_snapshot_id: Some(source_snapshot_id),
    })
}

fn append_pre_revert_snapshot(
    storage_root: &Path,
    state: &AiEditState,
    task_id: &str,
    label: &str,
    files: &[snapshot::StoredSnapshotFile],
) -> Result<AiSnapshotPayload, String> {
    let snapshot = snapshot::store_pre_revert_snapshot(
        storage_root,
        task_id,
        label,
        &as_snapshot_sources(files),
    )?;
    ai_edit::append_snapshot(state, storage_root, snapshot.clone())?;
    Ok(snapshot)
}

fn append_revert_snapshot(
    storage_root: &Path,
    state: &AiEditState,
    task_id: &str,
    label: &str,
    files: &[snapshot::StoredSnapshotFile],
) -> Result<AiSnapshotPayload, String> {
    let snapshot =
        snapshot::store_revert_snapshot(storage_root, task_id, label, &as_snapshot_sources(files))?;
    ai_edit::append_snapshot(state, storage_root, snapshot.clone())?;
    Ok(snapshot)
}

fn require_source_file(
    source_snapshot: &snapshot::StoredSnapshot,
    path: &str,
) -> Result<snapshot::StoredSnapshotFile, String> {
    source_snapshot
        .files
        .iter()
        .find(|file| file.path == path)
        .cloned()
        .ok_or_else(|| errors::restore_conflict(format!("源快照中未找到待撤销文件:{path}")))
}

fn read_snapshot_file(path: &str) -> Result<snapshot::StoredSnapshotFile, String> {
    let safe_path = validate_revert_path(path)?;
    let current_content = fs::read_to_string(&safe_path)
        .map_err(|error| errors::restore_conflict(format!("读取当前文件失败({path}):{error}")))?;
    Ok(snapshot::StoredSnapshotFile {
        path: path.to_string(),
        content_hash: patch::hash_text(&current_content),
        content: current_content,
    })
}

fn validate_revert_path(path: &str) -> Result<PathBuf, String> {
    let safe_path = path_security::validate_ai_writable_path(path)?;
    path_security::reject_existing_symlink(&safe_path)?;
    Ok(safe_path)
}

fn ensure_parent_dir(path: &Path, context: &str) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| {
            errors::restore_failed(format!("创建{context}失败({}):{error}", parent.display()))
        })?;
    }
    Ok(())
}

/// 将 `StoredSnapshotFile` 切片投影为 `SnapshotSourceFile` 切片用于持久化。
///
/// **生命周期**：返回值借用入参，调用方必须保证 `files` 在 `store_*_snapshot`
/// 全过程中存活。当前所有调用点要么是局部 `Vec`，要么 `slice::from_ref(&local)`，
/// 都满足。
fn as_snapshot_sources(
    files: &[snapshot::StoredSnapshotFile],
) -> Vec<snapshot::SnapshotSourceFile<'_>> {
    files
        .iter()
        .map(|file| snapshot::SnapshotSourceFile {
            path: file.path.as_str(),
            content_hash: file.content_hash.as_str(),
            content: file.content.as_str(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        get_diff, restore_snapshot, revert_file, revert_hunk, revert_task, undo_operation,
    };
    use crate::ai::edit as ai_edit;
    use crate::ai::edit::apply::{
        auto_apply::{AiAutoApplyOperationPlan, apply_operation_plans},
        diff_render,
    };
    use crate::ai::edit::history::{edit_journal, snapshot};
    use crate::ai::edit::{AiEditState, errors};
    use crate::commands::contracts::{
        AiApplyPatchMetadataRequest, AiApplyPatchRequest, AiEditGetDiffRequest,
        AiEditListTimelineRequest, AiEditRestoreSnapshotRequest, AiEditRevertFileRequest,
        AiEditRevertHunkRequest, AiEditRevertTaskRequest, AiEditSetAuthLevelRequest,
        AiEditTimelineEntryPayload, AiEditUndoOperationRequest, AiPatchFilePayload,
        AiPatchSetPayload,
    };
    use std::fs;
    use std::path::Path;

    #[test]
    fn restore_snapshot_restores_file_content_and_records_snapshots() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-restore-snapshot-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        let snapshot_root = temp_dir.join("snapshot-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &state,
        )
        .expect("session auth should be set");

        crate::ai::edit::patch::apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo old", "echo new")],
                },
                metadata: None,
            },
            &state,
            &snapshot_root,
        )
        .expect("patch should apply");

        let stored_snapshots =
            snapshot::list_stored_snapshots(&snapshot_root).expect("snapshots should be listed");
        assert_eq!(stored_snapshots.len(), 2);

        let target_snapshot = stored_snapshots
            .iter()
            .find(|snapshot| snapshot.scope == "pre-tool")
            .expect("pre-tool snapshot should exist");

        let restore_payload = restore_snapshot(
            AiEditRestoreSnapshotRequest {
                snapshot_id: target_snapshot.id.clone(),
            },
            &snapshot_root,
            &state,
        )
        .expect("snapshot should restore");

        let restored_content = fs::read_to_string(&file_path).expect("file should still exist");
        let timeline = ai_edit::list_timeline_with_state(
            AiEditListTimelineRequest {
                task_id: None,
                limit: None,
            },
            &state,
            snapshot::list_stored_snapshots(&snapshot_root).expect("snapshots should be listed"),
            edit_journal::list_operations(&snapshot_root).expect("operations should be listed"),
        )
        .expect("timeline should be listed");

        assert_eq!(restored_content, "echo old");
        assert_eq!(restore_payload.restored_files.len(), 1);
        assert_eq!(timeline.entries.len(), 5);

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn undo_operation_restores_file_content_from_source_snapshot() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-undo-operation-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        let snapshot_root = temp_dir.join("snapshot-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &state,
        )
        .expect("session auth should be set");

        crate::ai::edit::patch::apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo old", "echo new")],
                },
                metadata: None,
            },
            &state,
            &snapshot_root,
        )
        .expect("patch should apply");

        let operation_id = ai_edit::list_timeline_with_state(
            AiEditListTimelineRequest {
                task_id: None,
                limit: None,
            },
            &state,
            Vec::new(),
            edit_journal::list_operations(&snapshot_root).expect("operations should be listed"),
        )
        .expect("timeline should be listed")
        .entries
        .into_iter()
        .find_map(|entry| match entry {
            AiEditTimelineEntryPayload::Operation(operation) => Some(operation.id),
            AiEditTimelineEntryPayload::Snapshot(_) => None,
        })
        .expect("operation should exist");

        let revert_state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &revert_state,
        )
        .expect("session auth should be set after restart");

        let undo_payload = undo_operation(
            AiEditUndoOperationRequest { operation_id },
            &snapshot_root,
            &revert_state,
        )
        .expect("operation should be reverted");

        let restored_content = fs::read_to_string(&file_path).expect("file should still exist");
        assert_eq!(restored_content, "echo old");
        assert_eq!(
            undo_payload.restored_files,
            vec![file_path.to_string_lossy().to_string()]
        );

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn revert_file_restores_latest_effective_operation_for_target_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-revert-file-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        let snapshot_root = temp_dir.join("snapshot-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &state,
        )
        .expect("session auth should be set");

        crate::ai::edit::patch::apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "第一次应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo old", "echo mid")],
                },
                metadata: Some(AiApplyPatchMetadataRequest {
                    task_id: Some("task-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    reason: Some("第一次编辑".to_string()),
                    tool_call_id: None,
                    confirmed_by_user: Some(true),
                    agent_run_id: None,
                    agent_step_id: None,
                    workspace_root_path: None,
                }),
            },
            &state,
            &snapshot_root,
        )
        .expect("first patch should apply");

        crate::ai::edit::patch::apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "第二次应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo mid", "echo new")],
                },
                metadata: Some(AiApplyPatchMetadataRequest {
                    task_id: Some("task-1".to_string()),
                    turn_id: Some("turn-2".to_string()),
                    reason: Some("第二次编辑".to_string()),
                    tool_call_id: None,
                    confirmed_by_user: Some(true),
                    agent_run_id: None,
                    agent_step_id: None,
                    workspace_root_path: None,
                }),
            },
            &state,
            &snapshot_root,
        )
        .expect("second patch should apply");

        let revert_payload = revert_file(
            AiEditRevertFileRequest {
                task_id: "task-1".to_string(),
                path: file_path.to_string_lossy().to_string(),
            },
            &snapshot_root,
            &state,
        )
        .expect("file revert should succeed");

        let reverted_content = fs::read_to_string(&file_path).expect("file should still exist");

        assert_eq!(revert_payload.task_id, "task-1");
        assert_eq!(
            revert_payload.restored_files,
            vec![file_path.to_string_lossy().to_string()]
        );
        assert_eq!(reverted_content, "echo mid");

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn revert_hunk_restores_only_selected_segment() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-revert-hunk-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        let snapshot_root = temp_dir.join("snapshot-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "line-1\nline-2\nline-3\nline-4")
            .expect("temp file should be written");

        let state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &state,
        )
        .expect("session auth should be set");

        crate::ai::edit::patch::apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "包含两个 hunk 的 AI 编辑".to_string(),
                    files: vec![patch_file(
                        &file_path,
                        "line-1\nline-2\nline-3\nline-4",
                        "line-1\nline-2-updated\nline-3\nline-4-updated",
                    )],
                },
                metadata: Some(AiApplyPatchMetadataRequest {
                    task_id: Some("task-hunk".to_string()),
                    turn_id: Some("turn-hunk".to_string()),
                    reason: Some("测试 hunk 回滚".to_string()),
                    tool_call_id: None,
                    confirmed_by_user: Some(true),
                    agent_run_id: None,
                    agent_step_id: None,
                    workspace_root_path: None,
                }),
            },
            &state,
            &snapshot_root,
        )
        .expect("patch should apply");

        let preview = get_diff(
            AiEditGetDiffRequest {
                task_id: "task-hunk".to_string(),
                path: file_path.to_string_lossy().to_string(),
            },
            &snapshot_root,
            &state,
        )
        .expect("diff preview should succeed");

        assert_eq!(preview.hunks.len(), 2);
        assert_eq!(preview.additions, 2);
        assert_eq!(preview.deletions, 2);
        assert_eq!(preview.hunks[0].hunk_index, 0);

        let revert_payload = revert_hunk(
            AiEditRevertHunkRequest {
                task_id: "task-hunk".to_string(),
                path: file_path.to_string_lossy().to_string(),
                hunk_index: 0,
            },
            &snapshot_root,
            &state,
        )
        .expect("hunk revert should succeed");

        assert_eq!(revert_payload.hunk_index, 0);
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should still exist"),
            "line-1\nline-2\nline-3\nline-4-updated"
        );

        let refreshed_preview = get_diff(
            AiEditGetDiffRequest {
                task_id: "task-hunk".to_string(),
                path: file_path.to_string_lossy().to_string(),
            },
            &snapshot_root,
            &state,
        )
        .expect("refreshed diff preview should succeed");

        assert_eq!(refreshed_preview.hunks.len(), 1);
        assert_eq!(refreshed_preview.hunks[0].old_start, 4);

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn restore_snapshot_rejects_mismatched_per_task_auth_mode() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-restore-auth-blocked-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        let snapshot_root = temp_dir.join("snapshot-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let apply_state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &apply_state,
        )
        .expect("session auth should be set");

        crate::ai::edit::patch::apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo old", "echo new")],
                },
                metadata: Some(AiApplyPatchMetadataRequest {
                    task_id: Some("task-restore".to_string()),
                    turn_id: Some("turn-restore".to_string()),
                    reason: Some("恢复鉴权测试".to_string()),
                    tool_call_id: None,
                    confirmed_by_user: None,
                    agent_run_id: None,
                    agent_step_id: None,
                    workspace_root_path: None,
                }),
            },
            &apply_state,
            &snapshot_root,
        )
        .expect("patch should apply");

        let target_snapshot = snapshot::list_stored_snapshots(&snapshot_root)
            .expect("snapshots should be listed")
            .into_iter()
            .find(|item| item.scope == "pre-tool")
            .expect("pre-tool snapshot should exist");

        let revert_state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "per_task".to_string(),
                task_id: Some("task-other".to_string()),
            },
            &revert_state,
        )
        .expect("per-task auth should be set");

        let error = restore_snapshot(
            AiEditRestoreSnapshotRequest {
                snapshot_id: target_snapshot.id,
            },
            &snapshot_root,
            &revert_state,
        )
        .expect_err("mismatched per-task auth should block restore");

        assert!(error.contains(errors::AI_EDIT_AUTH_BLOCKED));
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should still exist"),
            "echo new"
        );

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn undo_operation_rejects_manual_auth_mode() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-undo-auth-blocked-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        let snapshot_root = temp_dir.join("snapshot-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let apply_state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &apply_state,
        )
        .expect("session auth should be set");

        crate::ai::edit::patch::apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo old", "echo new")],
                },
                metadata: Some(AiApplyPatchMetadataRequest {
                    task_id: Some("task-undo".to_string()),
                    turn_id: Some("turn-undo".to_string()),
                    reason: Some("撤销鉴权测试".to_string()),
                    tool_call_id: None,
                    confirmed_by_user: None,
                    agent_run_id: None,
                    agent_step_id: None,
                    workspace_root_path: None,
                }),
            },
            &apply_state,
            &snapshot_root,
        )
        .expect("patch should apply");

        let operation_id = edit_journal::list_operations(&snapshot_root)
            .expect("operations should be listed")
            .into_iter()
            .find(|operation| operation.kind == "modify")
            .expect("modify operation should exist")
            .id;

        let revert_state = AiEditState::default();

        let error = undo_operation(
            AiEditUndoOperationRequest { operation_id },
            &snapshot_root,
            &revert_state,
        )
        .expect_err("manual auth should block undo");

        assert!(error.contains(errors::AI_EDIT_AUTH_BLOCKED));
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should still exist"),
            "echo new"
        );

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn revert_task_reverts_all_effective_operations_after_restart() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-revert-task-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let first_path = temp_dir.join("first.sh");
        let second_path = temp_dir.join("second.sh");
        let snapshot_root = temp_dir.join("snapshot-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&first_path, "echo first-old").expect("first file should be written");
        fs::write(&second_path, "echo second-old").expect("second file should be written");

        let state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &state,
        )
        .expect("session auth should be set");

        apply_operation_plans(
            &[
                AiAutoApplyOperationPlan {
                    path: first_path.to_string_lossy().to_string(),
                    original_hash: Some(crate::ai::edit::patch::hash_text("echo first-old")),
                    original_modified_at: None,
                    original_content: Some("echo first-old".to_string()),
                    updated_content: Some("echo first-new".to_string()),
                },
                AiAutoApplyOperationPlan {
                    path: second_path.to_string_lossy().to_string(),
                    original_hash: Some(crate::ai::edit::patch::hash_text("echo second-old")),
                    original_modified_at: None,
                    original_content: Some("echo second-old".to_string()),
                    updated_content: Some("echo second-new".to_string()),
                },
            ],
            Some(&AiApplyPatchMetadataRequest {
                task_id: Some("task-revert-all".to_string()),
                turn_id: Some("turn-revert-all".to_string()),
                reason: Some("批量修改文件".to_string()),
                tool_call_id: None,
                confirmed_by_user: None,
                agent_run_id: None,
                agent_step_id: None,
                workspace_root_path: None,
            }),
            "批量修改文件",
            &state,
            &snapshot_root,
        )
        .expect("operations should apply");

        let revert_state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &revert_state,
        )
        .expect("session auth should be set after restart");

        let revert_payload = revert_task(
            AiEditRevertTaskRequest {
                task_id: "task-revert-all".to_string(),
            },
            &snapshot_root,
            &revert_state,
        )
        .expect("task should be reverted");

        assert_eq!(
            fs::read_to_string(&first_path).expect("first file should exist"),
            "echo first-old"
        );
        assert_eq!(
            fs::read_to_string(&second_path).expect("second file should exist"),
            "echo second-old"
        );
        assert_eq!(revert_payload.task_id, "task-revert-all");
        assert_eq!(revert_payload.reverted_operation_ids.len(), 2);
        assert_eq!(revert_payload.pre_revert_snapshots.len(), 2);
        assert_eq!(revert_payload.restored_snapshots.len(), 2);

        let _ = fs::remove_file(&first_path);
        let _ = fs::remove_file(&second_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn revert_task_rejects_manual_auth_mode() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-revert-task-auth-blocked-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("task.sh");
        let snapshot_root = temp_dir.join("snapshot-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let apply_state = AiEditState::default();
        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &apply_state,
        )
        .expect("session auth should be set");

        apply_operation_plans(
            &[AiAutoApplyOperationPlan {
                path: file_path.to_string_lossy().to_string(),
                original_hash: Some(crate::ai::edit::patch::hash_text("echo old")),
                original_modified_at: None,
                original_content: Some("echo old".to_string()),
                updated_content: Some("echo new".to_string()),
            }],
            Some(&AiApplyPatchMetadataRequest {
                task_id: Some("task-blocked".to_string()),
                turn_id: Some("turn-blocked".to_string()),
                reason: Some("任务回滚鉴权测试".to_string()),
                tool_call_id: None,
                confirmed_by_user: None,
                agent_run_id: None,
                agent_step_id: None,
                workspace_root_path: None,
            }),
            "任务回滚鉴权测试",
            &apply_state,
            &snapshot_root,
        )
        .expect("operation should apply");

        let revert_state = AiEditState::default();

        let error = revert_task(
            AiEditRevertTaskRequest {
                task_id: "task-blocked".to_string(),
            },
            &snapshot_root,
            &revert_state,
        )
        .expect_err("manual auth should block task revert");

        assert!(error.contains(errors::AI_EDIT_AUTH_BLOCKED));
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should still exist"),
            "echo new"
        );

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    fn patch_file(path: &Path, original: &str, updated: &str) -> AiPatchFilePayload {
        AiPatchFilePayload {
            path: path.to_string_lossy().to_string(),
            original_hash: crate::ai::edit::patch::hash_text(original),
            original_modified_at_ms: None,
            hunks: diff_render::render_patch_hunks(original, updated).hunks,
        }
    }
}
