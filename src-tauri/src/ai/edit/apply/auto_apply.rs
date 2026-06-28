use crate::ai::edit as ai_edit;
use crate::ai::edit::AiEditState;
use crate::ai::edit::apply::diff_render;
use crate::ai::edit::history::snapshot::{self, SnapshotSourceFile};
use crate::ai::edit::io::file_transaction::{self, FileTransactionAction, FileTransactionPlan};
use crate::ai::edit::patch::{hash_text, read_text_file_baseline};
use crate::ai::edit::security::path_security;
use crate::ai::errors;
use crate::commands::contracts::{
    AiApplyPatchMetadataRequest, AiEditOperationPayload, AiEditTimelineEntryPayload,
};
use jiff::Timestamp;

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 集中维护错误码字面量，避免散落的字符串拼写漂移。
mod error_codes {
    pub const WRITE_INVALID: &str = "AI_EDIT_WRITE_INVALID";
    pub const WRITE_CONFLICT: &str = "AI_EDIT_WRITE_CONFLICT";
    pub const WRITE_FAILED: &str = "AI_EDIT_WRITE_FAILED";
}

/// 单条 Patch 修改写盘计划。
#[derive(Debug, Clone)]
pub struct AiAutoApplyOperationPlan {
    pub path: String,
    pub original_hash: Option<String>,
    pub original_modified_at: Option<SystemTime>,
    pub original_content: Option<String>,
    pub updated_content: Option<String>,
}

/// 单条操作执行成功后的反馈。
#[derive(Debug, Clone)]
pub struct AiAutoApplyFileResult {
    pub path: String,
    pub byte_size: u64,
}

pub fn apply_operation_plans(
    plans: &[AiAutoApplyOperationPlan],
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
    state: &AiEditState,
    storage_root: &Path,
) -> Result<Vec<AiAutoApplyFileResult>, String> {
    if plans.is_empty() {
        return Err(errors::error(
            error_codes::WRITE_INVALID,
            "AI 写计划不能为空。",
        ));
    }

    ai_edit::ensure_auto_apply_authorized(state, metadata, "AI 自动写盘")?;
    ai_edit::recover_pending_file_transactions(storage_root)?;
    let workspace_root = metadata.and_then(|value| value.workspace_root_path.as_deref());
    validate_operation_plans(plans, workspace_root)?;
    validate_operation_conflicts(plans, workspace_root)?;

    let source_snapshot_id =
        capture_checkpoint_snapshots(plans, metadata, summary, state, storage_root)?;

    let operation_payloads = plans
        .iter()
        .enumerate()
        .map(|(index, plan)| {
            build_operation_payload(
                index,
                plan,
                source_snapshot_id.as_deref(),
                metadata,
                summary,
            )
        })
        .collect::<Vec<_>>();
    let results = plans
        .iter()
        .map(build_file_result)
        .collect::<Result<Vec<_>, String>>()?;
    let transaction_plan =
        build_file_transaction_plan(plans, operation_payloads.clone(), workspace_root)?;
    validate_operation_conflicts(plans, workspace_root)?;
    file_transaction::commit(storage_root, transaction_plan)?;
    record_committed_operations(state, operation_payloads)?;
    ai_edit::run_retention_policy_best_effort(state, storage_root);

    Ok(results)
}

fn validate_operation_plans(
    plans: &[AiAutoApplyOperationPlan],
    workspace_root: Option<&str>,
) -> Result<(), String> {
    for plan in plans {
        if plan.path.trim().is_empty() {
            return Err(errors::error(
                error_codes::WRITE_INVALID,
                "AI 写入路径不能为空。",
            ));
        }

        validate_non_protected_path(&plan.path, workspace_root)?;

        if plan.original_hash.is_none() || plan.original_content.is_none() {
            return Err(errors::error(
                error_codes::WRITE_INVALID,
                "modify 操作缺少前后内容。",
            ));
        }

        if plan.updated_content.is_none() {
            return Err(errors::error(
                error_codes::WRITE_INVALID,
                "modify 操作缺少目标内容。",
            ));
        }

        validate_declared_original_hash(plan)?;
    }

    Ok(())
}

fn validate_declared_original_hash(plan: &AiAutoApplyOperationPlan) -> Result<(), String> {
    let Some(original_content) = plan.original_content.as_deref() else {
        return Ok(());
    };

    let Some(original_hash) = plan.original_hash.as_deref() else {
        return Ok(());
    };

    let actual_hash = hash_text(original_content);

    if actual_hash != original_hash {
        return Err(errors::error(
            error_codes::WRITE_INVALID,
            "AI 写计划中的 original_hash 与 original_content 不匹配。",
        ));
    }

    Ok(())
}

/// 写前统一做磁盘冲突检测。
///
/// 这一步非常关键：
/// - modify 必须确认磁盘当前内容仍等于计划生成时的 original_hash。
fn validate_operation_conflicts(
    plans: &[AiAutoApplyOperationPlan],
    workspace_root: Option<&str>,
) -> Result<(), String> {
    for plan in plans {
        let path = validate_existing_file_for_original_hash(
            plan,
            workspace_root,
            "modify 目标文件不存在。",
        )?;

        if !path.is_file() {
            return Err(errors::error(
                error_codes::WRITE_CONFLICT,
                "modify 目标不是普通文件。",
            ));
        }
    }

    Ok(())
}

fn validate_existing_file_for_original_hash(
    plan: &AiAutoApplyOperationPlan,
    workspace_root: Option<&str>,
    missing_message: &str,
) -> Result<PathBuf, String> {
    let path = validate_non_protected_path(&plan.path, workspace_root)?;

    if !path.exists() {
        return Err(errors::error(error_codes::WRITE_CONFLICT, missing_message));
    }

    let baseline = read_text_file_baseline(&path).map_err(|error| {
        errors::error(
            error_codes::WRITE_FAILED,
            format!("读取当前文件失败：{error}"),
        )
    })?;

    let expected_hash = plan
        .original_hash
        .as_deref()
        .expect("validated operation should have original hash");

    if baseline.content_hash != expected_hash
        || plan
            .original_modified_at
            .is_some_and(|expected| baseline.modified_at != expected)
    {
        return Err(errors::error(
            error_codes::WRITE_CONFLICT,
            "目标文件已发生变化，为避免覆盖用户修改，AI 写入已取消。",
        ));
    }

    Ok(path)
}

fn capture_checkpoint_snapshots(
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

    // 登记到内存时间线但不在此触发 retention：本次 apply 末尾的
    // run_retention_policy_best_effort 会统一收口，避免一次应用跑 4 遍 retention。
    if let Some(snapshot) = task_start_snapshot {
        ai_edit::append_snapshot_without_retention(state, snapshot);
    }
    if let Some(snapshot) = turn_start_snapshot {
        ai_edit::append_snapshot_without_retention(state, snapshot);
    }

    let source_snapshot_id = source_snapshot.id.clone();
    ai_edit::append_snapshot_without_retention(state, source_snapshot);

    Ok(Some(source_snapshot_id))
}

fn build_snapshot_sources(plans: &[AiAutoApplyOperationPlan]) -> Vec<SnapshotSourceFile<'_>> {
    plans
        .iter()
        .map(|plan| SnapshotSourceFile {
            path: plan.path.as_str(),
            content_hash: plan
                .original_hash
                .as_deref()
                .expect("validated operation should have original hash"),
            content: plan
                .original_content
                .as_deref()
                .expect("validated operation should have original content"),
        })
        .collect()
}

fn build_file_transaction_plan(
    plans: &[AiAutoApplyOperationPlan],
    operations: Vec<AiEditOperationPayload>,
    workspace_root: Option<&str>,
) -> Result<FileTransactionPlan, String> {
    let actions = plans
        .iter()
        .map(|plan| build_file_transaction_action(plan, workspace_root))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(FileTransactionPlan {
        actions,
        operations,
    })
}

fn build_file_transaction_action(
    plan: &AiAutoApplyOperationPlan,
    workspace_root: Option<&str>,
) -> Result<FileTransactionAction, String> {
    Ok(FileTransactionAction::Modify {
        path: validate_non_protected_path(&plan.path, workspace_root)?,
        content: plan
            .updated_content
            .clone()
            .expect("validated modify operation should have updated content"),
    })
}

fn build_file_result(plan: &AiAutoApplyOperationPlan) -> Result<AiAutoApplyFileResult, String> {
    Ok(AiAutoApplyFileResult {
        path: plan.path.clone(),
        byte_size: plan
            .updated_content
            .as_deref()
            .expect("validated write operation should have updated content")
            .len() as u64,
    })
}

fn record_committed_operations(
    state: &AiEditState,
    operations: Vec<AiEditOperationPayload>,
) -> Result<(), String> {
    let mut guard = state.timeline.lock();
    guard.extend(
        operations
            .into_iter()
            .map(AiEditTimelineEntryPayload::Operation),
    );
    Ok(())
}

fn build_operation_payload(
    index: usize,
    plan: &AiAutoApplyOperationPlan,
    source_snapshot_id: Option<&str>,
    metadata: Option<&AiApplyPatchMetadataRequest>,
    summary: &str,
) -> AiEditOperationPayload {
    let timestamp = Timestamp::now();
    let task_id = resolve_task_id(metadata);
    let turn_id = resolve_turn_id(metadata).unwrap_or_else(|| task_id.clone());
    let reason = resolve_reason(metadata, summary);
    let updated_hash = plan.updated_content.as_deref().map(hash_text);

    let original_bytes = plan
        .original_content
        .as_deref()
        .map(|value| value.len() as u64);

    let updated_bytes = plan
        .updated_content
        .as_deref()
        .map(|value| value.len() as u64);

    let diff_text = build_operation_diff_text(plan);

    AiEditOperationPayload {
        id: format!("ai-edit-op-{}-{index}", timestamp.as_millisecond()),
        task_id,
        turn_id,
        kind: "modify".to_string(),
        path: plan.path.clone(),
        new_path: None,
        source_snapshot_id: source_snapshot_id.map(str::to_string),
        before_hash: plan.original_hash.clone(),
        after_hash: updated_hash,
        bytes_before: original_bytes,
        bytes_after: updated_bytes,
        applied_at: timestamp.to_string(),
        reason,
        tool_call_id: metadata.and_then(|value| value.tool_call_id.clone()),
        diff_text,
        pinned: false,
    }
}

fn build_operation_diff_text(plan: &AiAutoApplyOperationPlan) -> Option<String> {
    Some(diff_render::render_unified_diff_text(
        &plan.path,
        &plan.path,
        plan.original_content.as_deref()?,
        plan.updated_content.as_deref()?,
    ))
}

fn validate_non_protected_path(
    raw_path: &str,
    workspace_root: Option<&str>,
) -> Result<PathBuf, String> {
    let path = path_security::validate_ai_writable_path_with_root(raw_path, workspace_root)?
        .into_path_buf();
    path_security::reject_existing_symlink(&path)?;
    Ok(path)
}

fn resolve_task_id(metadata: Option<&AiApplyPatchMetadataRequest>) -> String {
    metadata
        .and_then(|value| value.task_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("manual-preview")
        .to_string()
}

fn resolve_turn_id(metadata: Option<&AiApplyPatchMetadataRequest>) -> Option<String> {
    metadata
        .and_then(|value| value.turn_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn resolve_reason(metadata: Option<&AiApplyPatchMetadataRequest>, summary: &str) -> String {
    metadata
        .and_then(|value| value.reason.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(summary)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{AiAutoApplyOperationPlan, apply_operation_plans};
    use crate::ai::edit as ai_edit;
    use crate::ai::edit::AiEditState;
    use crate::commands::contracts::{
        AiApplyPatchMetadataRequest, AiEditListTimelineRequest, AiEditSetAuthLevelRequest,
        AiEditTimelineEntryPayload,
    };
    use std::fs;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ))
    }

    #[test]
    fn apply_operation_plans_capture_task_turn_and_manual_snapshots() {
        let temp_dir = temp_dir("aed-auto-apply-manual");
        let file_path = temp_dir.join("script.sh");
        let snapshot_root = temp_dir.join("snapshot-store");

        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let state = AiEditState::default();

        apply_operation_plans(
            &[AiAutoApplyOperationPlan {
                path: file_path.to_string_lossy().to_string(),
                original_hash: Some(crate::ai::edit::patch::hash_text("echo old")),
                original_modified_at: None,
                original_content: Some("echo old".to_string()),
                updated_content: Some("echo new".to_string()),
            }],
            Some(&AiApplyPatchMetadataRequest {
                task_id: Some("task-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                reason: Some("手动应用".to_string()),
                tool_call_id: None,
                confirmed_by_user: Some(true),
                agent_run_id: None,
                agent_step_id: None,
                workspace_root_path: None,
            }),
            "应用 AI 代码块",
            &state,
            &snapshot_root,
        )
        .expect("manual confirmed apply should succeed");

        let timeline = ai_edit::list_timeline_with_state(
            AiEditListTimelineRequest {
                task_id: None,
                limit: None,
            },
            &state,
            Vec::new(),
            Vec::new(),
        )
        .expect("timeline should be listed");

        let snapshot_scopes = timeline
            .entries
            .iter()
            .filter_map(|entry| match entry {
                AiEditTimelineEntryPayload::Snapshot(snapshot) => Some(snapshot.scope.as_str()),
                AiEditTimelineEntryPayload::Operation(_) => None,
            })
            .collect::<Vec<_>>();

        let operation = timeline
            .entries
            .iter()
            .find_map(|entry| match entry {
                AiEditTimelineEntryPayload::Operation(operation) => Some(operation),
                AiEditTimelineEntryPayload::Snapshot(_) => None,
            })
            .expect("operation should exist");

        assert!(snapshot_scopes.contains(&"task-start"));
        assert!(snapshot_scopes.contains(&"turn-start"));
        assert!(snapshot_scopes.contains(&"manual"));
        assert!(operation.source_snapshot_id.is_some());

        assert_eq!(
            fs::read_to_string(&file_path).expect("patched file should exist"),
            "echo new"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn modify_rejects_when_file_changed_after_plan_created() {
        let temp_dir = temp_dir("aed-auto-apply-conflict");
        let file_path = temp_dir.join("script.sh");
        let snapshot_root = temp_dir.join("snapshot-store");

        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo changed by user").expect("temp file should be written");

        let state = AiEditState::default();

        ai_edit::set_auth_level(
            AiEditSetAuthLevelRequest {
                level: "session".to_string(),
                task_id: None,
            },
            &state,
        )
        .expect("session auth should be set");

        let result = apply_operation_plans(
            &[AiAutoApplyOperationPlan {
                path: file_path.to_string_lossy().to_string(),
                original_hash: Some(crate::ai::edit::patch::hash_text("echo old")),
                original_modified_at: None,
                original_content: Some("echo old".to_string()),
                updated_content: Some("echo new".to_string()),
            }],
            None,
            "冲突测试",
            &state,
            &snapshot_root,
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should still exist"),
            "echo changed by user"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn modify_rejects_when_file_mtime_changed_after_baseline() {
        let temp_dir = temp_dir("aed-auto-apply-mtime-conflict");
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

        let result = apply_operation_plans(
            &[AiAutoApplyOperationPlan {
                path: file_path.to_string_lossy().to_string(),
                original_hash: Some(crate::ai::edit::patch::hash_text("echo old")),
                original_modified_at: Some(std::time::UNIX_EPOCH),
                original_content: Some("echo old".to_string()),
                updated_content: Some("echo new".to_string()),
            }],
            None,
            "mtime 冲突测试",
            &state,
            &snapshot_root,
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should still exist"),
            "echo old"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn rejects_original_hash_that_does_not_match_original_content() {
        let temp_dir = temp_dir("aed-auto-apply-invalid-hash");
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

        let result = apply_operation_plans(
            &[AiAutoApplyOperationPlan {
                path: file_path.to_string_lossy().to_string(),
                original_hash: Some("wrong-hash".to_string()),
                original_modified_at: None,
                original_content: Some("echo old".to_string()),
                updated_content: Some("echo new".to_string()),
            }],
            None,
            "非法 hash 测试",
            &state,
            &snapshot_root,
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should remain unchanged"),
            "echo old"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
