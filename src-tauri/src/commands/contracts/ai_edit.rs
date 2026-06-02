use serde::{Deserialize, Serialize};

// ============================================================================
// AI – patch
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPatchHunkPayload {
    pub(crate) old_start: u32,
    pub(crate) old_lines: u32,
    pub(crate) new_start: u32,
    pub(crate) new_lines: u32,
    /// 统一 diff hunk 的原始行序列。每行首字符约定为：
    /// - `' '`（空格）：上下文行
    /// - `'+'`：新增行
    /// - `'-'`：删除行
    /// - `"\\ No newline at end of file"`：标准 unified diff 无末尾换行标记
    /// 普通行内不含末尾换行符；应用端按 unified diff 语义补齐。
    pub(crate) lines: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPatchFilePayload {
    pub(crate) path: String,
    pub(crate) original_hash: String,
    /// 生成 patch 时源文件的 mtime（Unix epoch 毫秒）。
    /// 旧调用可为空；AED 写盘链路会在真正落盘前用运行时读取的 baseline 再做 OCC。
    #[serde(default)]
    pub(crate) original_modified_at_ms: Option<u64>,
    pub(crate) hunks: Vec<AiPatchHunkPayload>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPatchSetPayload {
    pub(crate) summary: String,
    pub(crate) files: Vec<AiPatchFilePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProposePatchRequest {
    pub(crate) path: String,
    pub(crate) original_content: String,
    pub(crate) updated_content: String,
    pub(crate) summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProposePatchPayload {
    pub(crate) patch: AiPatchSetPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyPatchMetadataRequest {
    pub(crate) task_id: Option<String>,
    pub(crate) turn_id: Option<String>,
    pub(crate) reason: Option<String>,
    pub(crate) tool_call_id: Option<String>,
    pub(crate) confirmed_by_user: Option<bool>,
    pub(crate) agent_run_id: Option<String>,
    pub(crate) agent_step_id: Option<String>,
    pub(crate) workspace_root_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyPatchRequest {
    pub(crate) patch: AiPatchSetPayload,
    pub(crate) metadata: Option<AiApplyPatchMetadataRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyPatchFilePayload {
    pub(crate) path: String,
    pub(crate) byte_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyPatchPayload {
    pub(crate) applied_files: Vec<AiApplyPatchFilePayload>,
}

// ============================================================================
// AI – edit / timeline / auth
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditSetAuthLevelRequest {
    /// 已知值："manual" | "per_task" | "session"。
    pub(crate) level: String,
    pub(crate) task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditAuthStatePayload {
    /// 已知值："manual" | "per_task" | "session"。
    pub(crate) level: String,
    pub(crate) task_id: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditOperationPayload {
    pub(crate) id: String,
    pub(crate) task_id: String,
    pub(crate) turn_id: String,
    /// 已知值："modify"。
    pub(crate) kind: String,
    pub(crate) path: String,
    pub(crate) new_path: Option<String>,
    pub(crate) source_snapshot_id: Option<String>,
    pub(crate) before_hash: Option<String>,
    pub(crate) after_hash: Option<String>,
    pub(crate) bytes_before: Option<u64>,
    pub(crate) bytes_after: Option<u64>,
    pub(crate) applied_at: String,
    pub(crate) reason: String,
    pub(crate) tool_call_id: Option<String>,
    pub(crate) diff_text: Option<String>,
    pub(crate) pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSnapshotPayload {
    pub(crate) id: String,
    /// 已知值："task-start" | "turn-start" | "pre-tool" | "manual"
    /// | "pre-revert" | "revert"。
    pub(crate) scope: String,
    pub(crate) task_id: String,
    pub(crate) created_at: String,
    pub(crate) label: String,
    pub(crate) file_refs: Vec<String>,
    pub(crate) storage_key: String,
    pub(crate) size_bytes: u64,
    pub(crate) content_available: bool,
    pub(crate) pinned: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditSetPinRequest {
    /// 已知值："operation" | "snapshot" | "task"。
    pub(crate) target_type: String,
    pub(crate) target_id: String,
    pub(crate) pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditSetPinPayload {
    pub(crate) target_type: String,
    pub(crate) target_id: String,
    pub(crate) pinned: bool,
    pub(crate) pinned_at: Option<String>,
}

/// 与前端 `aiEditTimelineEntrySchema` 一一对齐的判别联合，
/// 形如 `{ "type": "snapshot" | "operation", "data": { … } }`。
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum AiEditTimelineEntryPayload {
    Snapshot(AiSnapshotPayload),
    Operation(AiEditOperationPayload),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditListTimelineRequest {
    pub(crate) task_id: Option<String>,
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditListTimelinePayload {
    pub(crate) entries: Vec<AiEditTimelineEntryPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditCreateSnapshotRequest {
    pub(crate) file_refs: Vec<String>,
    pub(crate) label: Option<String>,
    pub(crate) task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditCreateSnapshotPayload {
    pub(crate) snapshot: AiSnapshotPayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRestoreSnapshotRequest {
    pub(crate) snapshot_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRestoreSnapshotPayload {
    pub(crate) snapshot_id: String,
    pub(crate) restored_files: Vec<String>,
    pub(crate) pre_revert_snapshot: AiSnapshotPayload,
    pub(crate) restored_snapshot: AiSnapshotPayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditUndoOperationRequest {
    pub(crate) operation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditUndoOperationPayload {
    pub(crate) operation_id: String,
    pub(crate) restored_files: Vec<String>,
    pub(crate) pre_revert_snapshot: AiSnapshotPayload,
    pub(crate) restored_snapshot: AiSnapshotPayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRevertFileRequest {
    pub(crate) task_id: String,
    pub(crate) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRevertFilePayload {
    pub(crate) task_id: String,
    pub(crate) path: String,
    pub(crate) operation_id: String,
    pub(crate) restored_files: Vec<String>,
    pub(crate) pre_revert_snapshot: AiSnapshotPayload,
    pub(crate) restored_snapshot: AiSnapshotPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditDiffHunkPayload {
    pub(crate) hunk_index: u32,
    pub(crate) old_start: u32,
    pub(crate) old_lines: u32,
    pub(crate) new_start: u32,
    pub(crate) new_lines: u32,
    pub(crate) lines: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditGetDiffRequest {
    pub(crate) task_id: String,
    pub(crate) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditGetDiffPayload {
    pub(crate) task_id: String,
    pub(crate) path: String,
    pub(crate) operation_id: String,
    pub(crate) kind: String,
    pub(crate) additions: u32,
    pub(crate) deletions: u32,
    pub(crate) hunks: Vec<AiEditDiffHunkPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRevertHunkRequest {
    pub(crate) task_id: String,
    pub(crate) path: String,
    pub(crate) hunk_index: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRevertHunkPayload {
    pub(crate) task_id: String,
    pub(crate) path: String,
    pub(crate) operation_id: String,
    pub(crate) hunk_index: u32,
    pub(crate) restored_files: Vec<String>,
    pub(crate) pre_revert_snapshot: AiSnapshotPayload,
    pub(crate) restored_snapshot: AiSnapshotPayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRevertTaskRequest {
    pub(crate) task_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRevertTaskPayload {
    pub(crate) task_id: String,
    pub(crate) reverted_operation_ids: Vec<String>,
    pub(crate) restored_files: Vec<String>,
    pub(crate) pre_revert_snapshots: Vec<AiSnapshotPayload>,
    pub(crate) restored_snapshots: Vec<AiSnapshotPayload>,
}
