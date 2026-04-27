pub mod apply;
pub mod parser;
pub mod preview;
pub mod rollback;
pub mod validator;

use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::errors;
use crate::commands::contracts::{
    AiApplyPatchFilePayload, AiApplyPatchPayload, AiApplyPatchRequest, AiPatchFilePayload,
    AiPatchHunkPayload, AiPatchSetPayload, AiProposePatchPayload, AiProposePatchRequest,
};
use std::fs;
use std::path::{Path, PathBuf};

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

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

    let old_lines = count_lines(&payload.original_content);
    let new_lines = count_lines(&payload.updated_content);
    let lines = build_full_replace_lines(&payload.original_content, &payload.updated_content);
    let patch = AiPatchSetPayload {
        summary: payload.summary.trim().to_string(),
        files: vec![AiPatchFilePayload {
            path: payload.path,
            original_hash: hash_text(&payload.original_content),
            hunks: vec![AiPatchHunkPayload {
                old_start: 1,
                old_lines,
                new_start: 1,
                new_lines,
                lines,
            }],
        }],
    };
    audit::emit(AiAuditEventKind::PatchProposed);
    Ok(AiProposePatchPayload { patch })
}

pub fn apply_patch(payload: AiApplyPatchRequest) -> Result<AiApplyPatchPayload, String> {
    validate_patch(&payload.patch)?;
    let mut backups: Vec<(PathBuf, String)> = Vec::new();
    let mut applied_files = Vec::new();

    for file in &payload.patch.files {
        let path = PathBuf::from(&file.path);
        validate_writable_path(&path)?;
        let original = fs::read_to_string(&path).map_err(|error| {
            errors::error("AI_PATCH_CONFLICT", format!("读取待应用文件失败：{error}"))
        })?;
        if hash_text(&original) != file.original_hash {
            rollback(&backups);
            audit::emit(AiAuditEventKind::PatchFailed);
            return Err(errors::error(
                "AI_PATCH_CONFLICT",
                format!("文件已变化，拒绝应用 Patch：{}", file.path),
            ));
        }
        let updated = apply_file_patch(file)?;
        backups.push((path.clone(), original));
        if let Err(error) = fs::write(&path, updated.as_bytes()) {
            rollback(&backups);
            audit::emit(AiAuditEventKind::PatchFailed);
            return Err(errors::error(
                "AI_PATCH_APPLY_FAILED",
                format!("写入 Patch 失败，已尝试回滚：{error}"),
            ));
        }
        applied_files.push(AiApplyPatchFilePayload {
            path: file.path.clone(),
            byte_size: updated.len() as u64,
        });
    }

    audit::emit(AiAuditEventKind::PatchApplied);
    Ok(AiApplyPatchPayload { applied_files })
}

pub fn hash_text(value: &str) -> String {
    let mut hash = FNV_OFFSET;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("fnv64:{hash:016x}")
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

fn validate_writable_path(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(errors::error("AI_PATCH_CONFLICT", "Patch 目标文件不存在。"));
    }
    let value = path.to_string_lossy().to_lowercase();
    if value.contains(".git") || value.contains("node_modules") || value.contains("target") {
        return Err(errors::error(
            "AI_PATCH_INVALID",
            "Patch 目标路径不允许写入。",
        ));
    }
    Ok(())
}

fn apply_file_patch(file: &AiPatchFilePayload) -> Result<String, String> {
    let mut output = Vec::new();
    for hunk in &file.hunks {
        for line in &hunk.lines {
            if let Some(rest) = line.strip_prefix('+') {
                output.push(rest.to_string());
            } else if let Some(rest) = line.strip_prefix(' ') {
                output.push(rest.to_string());
            } else if line.starts_with('-') {
                continue;
            } else {
                return Err(errors::error(
                    "AI_PATCH_INVALID",
                    "Patch 行必须以空格、+ 或 - 开头。",
                ));
            }
        }
    }
    Ok(output.join("\n"))
}

fn build_full_replace_lines(original: &str, updated: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for line in original.lines() {
        lines.push(format!("-{line}"));
    }
    for line in updated.lines() {
        lines.push(format!("+{line}"));
    }
    if updated.ends_with('\n') {
        lines.push("+".to_string());
    }
    lines
}

fn count_lines(value: &str) -> u32 {
    value.lines().count().max(1) as u32
}

fn rollback(backups: &[(PathBuf, String)]) {
    for (path, content) in backups.iter().rev() {
        let _ = fs::write(path, content);
    }
}

#[cfg(test)]
mod tests {
    use super::{hash_text, propose_patch};
    use crate::commands::contracts::AiProposePatchRequest;

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
    }
}
