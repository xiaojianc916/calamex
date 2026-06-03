use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::edit::apply::auto_apply::{self, AiAutoApplyOperationPlan};
use crate::ai::edit::apply::diff_render;
use crate::ai::edit::security::path_security;
use crate::ai::edit::AiEditState;
use crate::ai::errors;
use crate::commands::contracts::{
    AiApplyPatchFilePayload, AiApplyPatchPayload, AiApplyPatchRequest, AiPatchFilePayload,
    AiPatchSetPayload, AiProposePatchPayload, AiProposePatchRequest,
};
use diffy_imara::Patch;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const BASELINE_READ_RETRY_COUNT: usize = 3;

#[derive(Debug, Clone)]
pub struct FileContentBaseline {
    pub content: String,
    pub content_hash: String,
    pub modified_at: SystemTime,
}

pub fn propose_patch(payload: AiProposePatchRequest) -> Result<AiProposePatchPayload, String> {
    if payload.path.trim().is_empty() {
        return Err(errors::error(
            "AI_PATCH_INVALID",
            "Patch 文件路径不能为空。",
        ));
    }
    if payload.original_content == payload.updated_content {
        return Err(errors::error("AI_PATCH_INVALID", "Patch 内容没有变化。"));
    }

    let rendered =
        diff_render::render_patch_hunks(&payload.original_content, &payload.updated_content);
    let patch = AiPatchSetPayload {
        summary: payload.summary.trim().to_string(),
        files: vec![AiPatchFilePayload {
            original_modified_at_ms: read_matching_modified_at_ms(
                &payload.path,
                &payload.original_content,
            ),
            path: payload.path,
            original_hash: hash_text(&payload.original_content),
            hunks: rendered.hunks,
        }],
    };
    audit::emit(AiAuditEventKind::PatchProposed);
    Ok(AiProposePatchPayload { patch })
}

struct PendingPatchFile {
    payload_path: String,
    original_hash: String,
    original_modified_at: SystemTime,
    original: String,
    updated: String,
}

pub fn apply_patch(
    payload: AiApplyPatchRequest,
    state: &AiEditState,
    snapshot_root: &Path,
) -> Result<AiApplyPatchPayload, String> {
    validate_patch(&payload.patch)?;
    let metadata = payload.metadata;
    let workspace_root = metadata
        .as_ref()
        .and_then(|value| value.workspace_root_path.as_deref());
    let patch = payload.patch;
    let mut pending_files = Vec::with_capacity(patch.files.len());

    for file in &patch.files {
        let path = path_security::validate_ai_writable_path_with_root(&file.path, workspace_root)?
            .into_path_buf();
        validate_writable_path(&path, workspace_root)?;
        let baseline = read_text_file_baseline(&path)
            .map_err(|error| errors::error("AI_PATCH_CONFLICT", error))?;
        if baseline.content_hash != file.original_hash
            || file.original_modified_at_ms.is_some_and(|expected| {
                system_time_to_millis(baseline.modified_at) != Some(expected)
            })
        {
            audit::emit(AiAuditEventKind::PatchFailed);
            return Err(errors::error(
                "AI_PATCH_CONFLICT",
                format!("文件已变化，拒绝应用 Patch：{}", file.path),
            ));
        }
        let updated = apply_file_patch(&baseline.content, file)?;
        pending_files.push(PendingPatchFile {
            payload_path: file.path.clone(),
            original_hash: file.original_hash.clone(),
            original_modified_at: baseline.modified_at,
            original: baseline.content,
            updated,
        });
    }

    let operation_plans = pending_files
        .iter()
        .map(|file| AiAutoApplyOperationPlan {
            path: file.payload_path.clone(),
            original_hash: Some(file.original_hash.clone()),
            original_modified_at: Some(file.original_modified_at),
            original_content: Some(file.original.clone()),
            updated_content: Some(file.updated.clone()),
        })
        .collect::<Vec<_>>();

    let applied_files = match auto_apply::apply_operation_plans(
        &operation_plans,
        metadata.as_ref(),
        &patch.summary,
        state,
        snapshot_root,
    ) {
        Ok(result) => result,
        Err(error) => {
            audit::emit(AiAuditEventKind::PatchFailed);
            return Err(error);
        }
    };

    let applied_files = applied_files
        .into_iter()
        .map(|file| AiApplyPatchFilePayload {
            path: file.path,
            byte_size: file.byte_size,
        })
        .collect::<Vec<_>>();

    if applied_files.is_empty() {
        audit::emit(AiAuditEventKind::PatchFailed);
        return Err(errors::error(
            "AI_PATCH_APPLY_FAILED",
            "Patch 未产生任何写入结果。",
        ));
    }

    tracing::info!(
        target: "ai.audit",
        event = "ai.edit.applied",
        task_id = metadata
            .as_ref()
            .and_then(|value| value.task_id.as_deref())
            .unwrap_or(""),
        turn_id = metadata
            .as_ref()
            .and_then(|value| value.turn_id.as_deref())
            .unwrap_or(""),
        file_count = applied_files.len(),
        byte_size_total = applied_files.iter().map(|file| file.byte_size).sum::<u64>(),
        "AI edit applied"
    );
    audit::emit(AiAuditEventKind::AiEditApplied);
    audit::emit(AiAuditEventKind::PatchApplied);
    Ok(AiApplyPatchPayload { applied_files })
}

pub fn hash_text(value: &str) -> String {
    format!("blake3:{}", blake3::hash(value.as_bytes()).to_hex())
}

pub fn read_text_file_baseline(path: &Path) -> Result<FileContentBaseline, String> {
    let mut last_error = None;
    for _ in 0..BASELINE_READ_RETRY_COUNT {
        let before = file_modified_at(path)?;
        let content = fs::read_to_string(path).map_err(|error| format!("读取文件失败：{error}"))?;
        let after = file_modified_at(path)?;

        if before == after {
            let content_hash = hash_text(&content);
            return Ok(FileContentBaseline {
                content,
                content_hash,
                modified_at: after,
            });
        }

        last_error = Some("读取文件期间检测到文件变化。".to_string());
    }

    Err(last_error.unwrap_or_else(|| "读取文件 baseline 失败。".to_string()))
}

pub fn system_time_to_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn file_modified_at(path: &Path) -> Result<SystemTime, String> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| format!("读取文件修改时间失败：{error}"))
}

fn read_matching_modified_at_ms(path: &str, expected_content: &str) -> Option<u64> {
    let baseline = read_text_file_baseline(Path::new(path)).ok()?;
    if baseline.content_hash == hash_text(expected_content) {
        return system_time_to_millis(baseline.modified_at);
    }
    None
}

fn validate_patch(patch: &AiPatchSetPayload) -> Result<(), String> {
    if patch.files.is_empty() {
        return Err(errors::error(
            "AI_PATCH_INVALID",
            "Patch 至少需要包含一个文件。",
        ));
    }
    if patch.files.len() > 20 {
        return Err(errors::error(
            "AI_PATCH_INVALID",
            "单次 Patch 文件数量过多。",
        ));
    }
    for file in &patch.files {
        if file.path.trim().is_empty()
            || file.original_hash.trim().is_empty()
            || file.hunks.is_empty()
        {
            return Err(errors::error("AI_PATCH_INVALID", "Patch 文件信息不完整。"));
        }
    }
    Ok(())
}

fn validate_writable_path(path: &Path, workspace_root: Option<&str>) -> Result<(), String> {
    let raw_path = path
        .to_str()
        .ok_or_else(|| errors::error("AI_PATCH_INVALID", "Patch 路径不是有效 UTF-8。"))?;
    let path = path_security::validate_ai_writable_path_with_root(raw_path, workspace_root)?
        .into_path_buf();
    path_security::reject_existing_symlink(&path)?;
    if !path.is_file() {
        return Err(errors::error("AI_PATCH_CONFLICT", "Patch 目标文件不存在。"));
    }
    Ok(())
}

fn apply_file_patch(original: &str, file: &AiPatchFilePayload) -> Result<String, String> {
    let patch_text = build_unified_patch(file)?;
    let patch = Patch::from_str(&patch_text)
        .map_err(|error| errors::error("AI_PATCH_INVALID", format!("解析 Patch 失败：{error}")))?;

    diffy_imara::apply(original, &patch)
        .map_err(|error| errors::error("AI_PATCH_CONFLICT", format!("应用 Patch 失败：{error}")))
}

fn build_unified_patch(file: &AiPatchFilePayload) -> Result<String, String> {
    let mut patch = String::from("--- original\n+++ modified\n");
    for hunk in &file.hunks {
        patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        ));
        for line in &hunk.lines {
            validate_patch_line(line)?;
            patch.push_str(line);
            patch.push('\n');
        }
    }

    Ok(patch)
}

fn validate_patch_line(line: &str) -> Result<(), String> {
    if line.contains('\n') {
        return Err(errors::error(
            "AI_PATCH_INVALID",
            "Patch 行不能包含换行符。",
        ));
    }
    if line == "\\ No newline at end of file" {
        return Ok(());
    }
    if matches!(line.as_bytes().first(), Some(b' ' | b'+' | b'-')) {
        return Ok(());
    }
    Err(errors::error(
        "AI_PATCH_INVALID",
        "Patch 行必须以空格、+ 或 - 开头。",
    ))
}

#[cfg(test)]
mod tests {
    use super::{apply_patch, hash_text, propose_patch, validate_writable_path};
    use crate::ai::edit as ai_edit;
    use crate::ai::edit::apply::diff_render;
    use crate::ai::edit::history::edit_journal;
    use crate::ai::edit::AiEditState;
    use crate::commands::contracts::{
        AiApplyPatchMetadataRequest, AiApplyPatchRequest, AiEditListTimelineRequest,
        AiEditSetAuthLevelRequest, AiEditTimelineEntryPayload, AiPatchFilePayload,
        AiPatchSetPayload, AiProposePatchRequest,
    };
    use std::fs;
use std::path::{Path, PathBuf};
    #[test]
    fn propose_patch_uses_original_hash() {
        let payload = propose_patch(AiProposePatchRequest {
            path: "a.sh".to_string(),
            original_content: "echo old".to_string(),
            updated_content: "echo new".to_string(),
            summary: "更新输出".to_string(),
        })
        .expect("patch should be generated");
        assert_eq!(payload.patch.files[0].original_hash, hash_text("echo old"));
        assert!(payload.patch.files[0].original_hash.starts_with("blake3:"));
    }

    #[test]
    fn propose_patch_records_original_mtime_when_disk_content_matches() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-ai-patch-baseline-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let payload = propose_patch(AiProposePatchRequest {
            path: file_path.to_string_lossy().to_string(),
            original_content: "echo old".to_string(),
            updated_content: "echo new".to_string(),
            summary: "更新输出".to_string(),
        })
        .expect("patch should be generated");

        assert!(payload.patch.files[0].original_modified_at_ms.is_some());

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn apply_patch_rejects_stale_original_mtime() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-ai-patch-stale-mtime-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let state = AiEditState::default();
        let snapshot_root = temp_dir.join("snapshot-store");
        let mut patch = patch_file(&file_path, "echo old", "echo new");
        patch.original_modified_at_ms = Some(0);

        let error = apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "应用 AI 代码块".to_string(),
                    files: vec![patch],
                },
                metadata: None,
            },
            &state,
            &snapshot_root,
        )
        .expect_err("stale mtime should reject patch apply");

        assert!(error.contains("AI_PATCH_CONFLICT"));
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should still exist"),
            "echo old"
        );

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn validate_writable_path_rejects_protected_targets() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-ai-patch-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let protected_dir = temp_dir.join("repo");
        let protected_path = protected_dir.join("Cargo.lock");

        fs::create_dir_all(&protected_dir).expect("temp directory should be created");
        fs::write(&protected_path, "lock").expect("temp file should be written");

        let error = validate_writable_path(&PathBuf::from(&protected_path), None)
            .expect_err("protected path should be rejected");
        assert!(error.contains("AI_EDIT_PATH_PROTECTED"));

        let _ = fs::remove_file(&protected_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn apply_patch_records_operation_into_ai_edit_timeline() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-ai-patch-record-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
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
        let snapshot_root = temp_dir.join("snapshot-store");
        let result = apply_patch(
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

        let timeline = ai_edit::list_timeline_with_state(
            AiEditListTimelineRequest {
                task_id: None,
                limit: None,
            },
            &state,
            Vec::new(),
            edit_journal::list_operations(&snapshot_root).expect("operations should be listed"),
        )
        .expect("timeline should be listed");

        assert_eq!(result.applied_files.len(), 1);
        assert_eq!(timeline.entries.len(), 3);
        assert!(matches!(
            timeline.entries[0],
            AiEditTimelineEntryPayload::Operation(_)
        ));
        assert!(matches!(
            timeline.entries[1],
            AiEditTimelineEntryPayload::Snapshot(_)
        ));
        assert!(matches!(
            timeline.entries[2],
            AiEditTimelineEntryPayload::Snapshot(_)
        ));
        if let AiEditTimelineEntryPayload::Operation(operation) = &timeline.entries[0] {
            assert!(operation.source_snapshot_id.is_some());
        }

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn apply_patch_rejects_manual_auth_mode() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-ai-patch-manual-auth-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let state = AiEditState::default();
        let snapshot_root = temp_dir.join("snapshot-store");
        let error = apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo old", "echo new")],
                },
                metadata: Some(AiApplyPatchMetadataRequest {
                    task_id: Some("task-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    reason: None,
                    tool_call_id: None,
                    confirmed_by_user: None,
                    agent_run_id: None,
                    agent_step_id: None,
                    workspace_root_path: None,
                }),
            },
            &state,
            &snapshot_root,
        )
        .expect_err("manual mode should block patch apply");

        assert!(error.contains("AI_EDIT_AUTH_BLOCKED"));
        assert_eq!(
            fs::read_to_string(&file_path).expect("file should still exist"),
            "echo old"
        );

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn apply_patch_allows_session_auth_mode() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-ai-patch-session-auth-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
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
        let snapshot_root = temp_dir.join("snapshot-store");

        let result = apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo old", "echo new")],
                },
                metadata: Some(AiApplyPatchMetadataRequest {
                    task_id: Some("task-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    reason: None,
                    tool_call_id: None,
                    confirmed_by_user: None,
                    agent_run_id: None,
                    agent_step_id: None,
                    workspace_root_path: None,
                }),
            },
            &state,
            &snapshot_root,
        )
        .expect("session mode should allow patch apply");

        assert_eq!(result.applied_files.len(), 1);
        assert_eq!(
            fs::read_to_string(&file_path).expect("patched file should exist"),
            "echo new"
        );

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn apply_patch_allows_user_confirmed_manual_mode() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aed-ai-patch-manual-confirm-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let file_path = temp_dir.join("script.sh");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        fs::write(&file_path, "echo old").expect("temp file should be written");

        let state = AiEditState::default();
        let snapshot_root = temp_dir.join("snapshot-store");

        let result = apply_patch(
            AiApplyPatchRequest {
                patch: AiPatchSetPayload {
                    summary: "应用 AI 代码块".to_string(),
                    files: vec![patch_file(&file_path, "echo old", "echo new")],
                },
                metadata: Some(AiApplyPatchMetadataRequest {
                    task_id: Some("task-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    reason: None,
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
        .expect("manual mode should allow user confirmed patch apply");

        assert_eq!(result.applied_files.len(), 1);
        assert_eq!(
            fs::read_to_string(&file_path).expect("patched file should exist"),
            "echo new"
        );

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    fn patch_file(path: &Path, original: &str, updated: &str) -> AiPatchFilePayload {
        AiPatchFilePayload {
            path: path.to_string_lossy().to_string(),
            original_hash: hash_text(original),
            original_modified_at_ms: None,
            hunks: diff_render::render_patch_hunks(original, updated).hunks,
        }
    }
}
