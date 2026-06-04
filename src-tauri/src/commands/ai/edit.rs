use super::storage::{recover_ai_edit_storage, resolve_ai_edit_storage_root};
use crate::ai::edit as ai_edit;
use crate::ai::edit::AiEditState;
use crate::ai::edit::patch;
use crate::commands::contracts::{
    AiApplyPatchPayload, AiApplyPatchRequest, AiEditAuthStatePayload, AiEditCreateSnapshotPayload,
    AiEditCreateSnapshotRequest, AiEditGetDiffPayload, AiEditGetDiffRequest,
    AiEditListTimelinePayload, AiEditListTimelineRequest, AiEditRestoreSnapshotPayload,
    AiEditRestoreSnapshotRequest, AiEditRevertFilePayload, AiEditRevertFileRequest,
    AiEditRevertHunkPayload, AiEditRevertHunkRequest, AiEditRevertTaskPayload,
    AiEditRevertTaskRequest, AiEditSetAuthLevelRequest, AiEditSetPinPayload, AiEditSetPinRequest,
    AiEditUndoOperationPayload, AiEditUndoOperationRequest, AiProposePatchPayload,
    AiProposePatchRequest,
};
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub fn ai_propose_patch(payload: AiProposePatchRequest) -> Result<AiProposePatchPayload, String> {
    patch::propose_patch(payload)
}

#[tauri::command]
#[specta::specta]
pub fn ai_apply_patch(
    app: AppHandle,
    payload: AiApplyPatchRequest,
    state: State<AiEditState>,
) -> Result<AiApplyPatchPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    patch::apply_patch(payload, state.inner(), &snapshot_root)
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_get_auth_level(state: State<AiEditState>) -> Result<AiEditAuthStatePayload, String> {
    ai_edit::get_auth_level(state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_set_auth_level(
    payload: AiEditSetAuthLevelRequest,
    state: State<AiEditState>,
) -> Result<AiEditAuthStatePayload, String> {
    ai_edit::set_auth_level(payload, state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_list_timeline(
    app: AppHandle,
    payload: AiEditListTimelineRequest,
    state: State<AiEditState>,
) -> Result<AiEditListTimelinePayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::list_timeline(payload, state.inner(), &snapshot_root)
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_set_pin(
    app: AppHandle,
    payload: AiEditSetPinRequest,
    state: State<AiEditState>,
) -> Result<AiEditSetPinPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::set_pin(payload, &snapshot_root, state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_get_diff(
    app: AppHandle,
    payload: AiEditGetDiffRequest,
    state: State<AiEditState>,
) -> Result<AiEditGetDiffPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::get_diff(payload, &snapshot_root, state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_create_snapshot(
    app: AppHandle,
    payload: AiEditCreateSnapshotRequest,
    state: State<AiEditState>,
) -> Result<AiEditCreateSnapshotPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::create_snapshot(payload, &snapshot_root, state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_restore_snapshot(
    app: AppHandle,
    payload: AiEditRestoreSnapshotRequest,
    state: State<AiEditState>,
) -> Result<AiEditRestoreSnapshotPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::restore_snapshot(payload, &snapshot_root, state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_undo_operation(
    app: AppHandle,
    payload: AiEditUndoOperationRequest,
    state: State<AiEditState>,
) -> Result<AiEditUndoOperationPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::undo_operation(payload, &snapshot_root, state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_revert_file(
    app: AppHandle,
    payload: AiEditRevertFileRequest,
    state: State<AiEditState>,
) -> Result<AiEditRevertFilePayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::revert_file(payload, &snapshot_root, state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_revert_hunk(
    app: AppHandle,
    payload: AiEditRevertHunkRequest,
    state: State<AiEditState>,
) -> Result<AiEditRevertHunkPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::revert_hunk(payload, &snapshot_root, state.inner())
}

#[tauri::command]
#[specta::specta]
pub fn ai_edit_revert_task(
    app: AppHandle,
    payload: AiEditRevertTaskRequest,
    state: State<AiEditState>,
) -> Result<AiEditRevertTaskPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    recover_ai_edit_storage(&snapshot_root)?;
    ai_edit::revert_task(payload, &snapshot_root, state.inner())
}
