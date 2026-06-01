use crate::ai::edit as ai_edit;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(super) fn resolve_ai_edit_storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| ai_edit::errors::storage_path_unavailable(&error.to_string()))?
        .join(".notion-ide-ai")
        .join("edits"))
}

pub(super) fn recover_ai_edit_storage(storage_root: &Path) -> Result<(), String> {
    ai_edit::recover_pending_file_transactions(storage_root)
}
