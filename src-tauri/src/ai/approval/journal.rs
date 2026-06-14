use super::decision::ApprovalDecision;
use crate::ai::errors;
use fs_err as fs;
use fs_err::OpenOptions;
use std::io::Write;
use std::path::Path;

const JOURNAL_FILE_NAME: &str = "approval-decisions.jsonl";

pub fn append_decision(storage_root: &Path, decision: &ApprovalDecision) -> Result<(), String> {
    fs::create_dir_all(storage_root).map_err(|error| {
        errors::error(
            "AI_APPROVAL_JOURNAL_FAILED",
            format!("创建审批日志目录失败：{error}"),
        )
    })?;
    let path = storage_root.join(JOURNAL_FILE_NAME);
    let line = serde_json::to_string(decision).map_err(|error| {
        errors::error(
            "AI_APPROVAL_JOURNAL_FAILED",
            format!("序列化审批日志失败：{error}"),
        )
    })?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            errors::error(
                "AI_APPROVAL_JOURNAL_FAILED",
                format!("打开审批日志失败：{error}"),
            )
        })?;
    writeln!(file, "{line}").map_err(|error| {
        errors::error(
            "AI_APPROVAL_JOURNAL_FAILED",
            format!("写入审批日志失败：{error}"),
        )
    })
}
