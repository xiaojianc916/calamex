use crate::ai::edit as ai_edit;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// AI 编辑历史（快照 / 操作日志 / blobs）的存储根。
///
/// 统一到漫游根 `%APPDATA%\.calamex\ai-edits` 下（与 AI 配置、会话快照同根），
/// 取代旧的 `%APPDATA%\com.xiaojianc.Calamex\.notion-ide-ai\edits`。
/// `app` 句柄当前不再参与路径解析，保留入参以兼容既有命令签名。
pub(super) fn resolve_ai_edit_storage_root(_app: &AppHandle) -> Result<PathBuf, String> {
    crate::storage_paths::roaming_root()
        .map(|root| root.join("ai-edits"))
        .ok_or_else(|| {
            ai_edit::errors::storage_path_unavailable(
                "无法解析统一存储漫游根（APPDATA / HOME 均缺失）",
            )
        })
}

pub(super) fn recover_ai_edit_storage(storage_root: &Path) -> Result<(), String> {
    ai_edit::recover_pending_file_transactions(storage_root)
}
