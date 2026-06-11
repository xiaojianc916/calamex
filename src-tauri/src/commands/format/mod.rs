//! 通用多语言格式化（External 命令 formatter，子进程 stdin/stdout）。
//!
//! 设计对齐 ADR-0008：执行层按 `languageId` 解析「专用 External formatter」，
//! 经子进程 stdin 进 / stdout 出；未命中可用 formatter 时返回 `formatter_id: None`，
//! 由前端退回 whitespace 归一。优先级 Auto = 专用 External 优先（更可控、可固定
//! 版本、可离线），LSP `textDocument/formatting` 兜底属 P2 范围，本模块仅实现
//! External 路径。
//!
//! 复用 `shell_tools` 的子进程执行范式：tokio `Command` + `kill_on_drop` + 超时 +
//! `configure_tokio_command_for_background`（Windows 不弹窗）；二进制发现统一
//! 「随包优先 → PATH」（`bundled_resource_roots` / `find_command_path`）。

mod registry;
mod runner;

use super::{FormatDocumentPayload, FormatDocumentRequest};
use registry::resolve_external_formatter;
use runner::run_external_formatter;

#[tauri::command]
#[specta::specta]
pub async fn format_document(
    payload: FormatDocumentRequest,
) -> Result<FormatDocumentPayload, String> {
    // 空白或纯空白内容：无需调用任何 formatter，原样回传。
    if payload.content.trim().is_empty() {
        return finalize_payload(payload.content, None);
    }

    let Some(spec) = resolve_external_formatter(&payload.language_id) else {
        // 该语言无专用 External formatter：交给前端做 whitespace 归一。
        return finalize_payload(payload.content, None);
    };

    let Some(resolved) = spec.discover(payload.path.as_deref()) else {
        // 有默认 formatter 但未发现可用二进制：同样退回前端 whitespace。
        return finalize_payload(payload.content, None);
    };

    let formatted = run_external_formatter(&resolved, &payload.content).await?;

    finalize_payload(formatted, Some(spec.id.to_string()))
}

fn finalize_payload(
    content: String,
    formatter_id: Option<String>,
) -> Result<FormatDocumentPayload, String> {
    Ok(FormatDocumentPayload {
        line_count: count_to_u32(super::line_count(&content), "文档行数")?,
        char_count: count_to_u32(content.chars().count(), "文档字符数")?,
        content,
        formatter_id,
    })
}

fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}
