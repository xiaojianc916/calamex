use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFilePayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) content: String,
    pub(crate) encoding: String,
    pub(crate) line_count: usize,
    pub(crate) char_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetPayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) mime_type: String,
    pub(crate) data_url: String,
    pub(crate) byte_size: usize,
}

#[derive(Debug, Deserialize)]
pub struct SaveScriptRequest {
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) encoding: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatScriptRequest {
    pub(crate) path: Option<String>,
    pub(crate) content: String,
    pub(crate) encoding: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatScriptPayload {
    pub(crate) content: String,
    pub(crate) encoding: String,
    pub(crate) line_count: usize,
    pub(crate) char_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeScriptRequest {
    pub(crate) path: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDiagnosticPayload {
    pub(crate) line: usize,
    pub(crate) end_line: usize,
    pub(crate) column: usize,
    pub(crate) end_column: usize,
    pub(crate) level: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeScriptPayload {
    pub(crate) available: bool,
    pub(crate) message: Option<String>,
    pub(crate) dialect: String,
    pub(crate) diagnostics: Vec<ScriptDiagnosticPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOption {
    pub(crate) r#type: String,
    pub(crate) label: String,
    pub(crate) available: bool,
    pub(crate) description: String,
    pub(crate) command_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironment {
    pub(crate) recommended: String,
    pub(crate) has_any: bool,
    pub(crate) executors: Vec<ExecutionOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) has_children: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryPayload {
    pub(crate) root_path: String,
    pub(crate) root_name: String,
    pub(crate) entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathCreateRequest {
    pub(crate) parent_path: String,
    pub(crate) root_path: String,
    pub(crate) name: String,
    pub(crate) kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathCreatePayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathRenameRequest {
    pub(crate) path: String,
    pub(crate) root_path: String,
    pub(crate) new_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathRenamePayload {
    pub(crate) old_path: String,
    pub(crate) new_path: String,
    pub(crate) name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathDeleteRequest {
    pub(crate) path: String,
    pub(crate) root_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathDeletePayload {
    pub(crate) path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionTestRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionTestPayload {
    pub(crate) ok: bool,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryListRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryEntryPayload {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) kind: String,
    pub(crate) size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryListPayload {
    pub(crate) path: String,
    pub(crate) entries: Vec<SshDirectoryEntryPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileDownloadRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) remote_path: String,
    pub(crate) local_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileDownloadPayload {
    pub(crate) remote_path: String,
    pub(crate) local_path: String,
    pub(crate) byte_size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileUploadRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) local_path: String,
    pub(crate) remote_directory: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileUploadPayload {
    pub(crate) local_path: String,
    pub(crate) remote_path: String,
    pub(crate) byte_size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathDeleteRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) remote_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathDeletePayload {
    pub(crate) remote_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathRenameRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) remote_path: String,
    pub(crate) new_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathRenamePayload {
    pub(crate) old_path: String,
    pub(crate) new_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryCreateRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) remote_directory: String,
    pub(crate) name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryCreatePayload {
    pub(crate) remote_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHostPayload {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) username: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) identity_path: Option<String>,
    pub(crate) last_used_label: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessagePayload {
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) id: String,
    pub(crate) created_at: String,
    pub(crate) references: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContextRangePayload {
    pub(crate) start_line: u32,
    pub(crate) end_line: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContextReferencePayload {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) path: Option<String>,
    pub(crate) range: Option<AiContextRangePayload>,
    pub(crate) content_preview: String,
    pub(crate) redacted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub(crate) thread_id: Option<String>,
    pub(crate) messages: Vec<AiChatMessagePayload>,
    pub(crate) references: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatPayload {
    pub(crate) message: AiChatMessagePayload,
    pub(crate) provider_type: String,
    pub(crate) model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStreamPayload {
    pub(crate) stream_id: String,
    pub(crate) assistant_message_id: String,
    pub(crate) provider_type: String,
    pub(crate) model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCancelRequest {
    pub(crate) stream_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSaveConfigRequest {
    pub(crate) provider_type: String,
    pub(crate) selected_model: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) inline_completion_enabled: bool,
    pub(crate) chat_enabled: bool,
    pub(crate) agent_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSaveCredentialsRequest {
    pub(crate) provider_type: String,
    pub(crate) api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigPayload {
    pub(crate) provider_type: String,
    pub(crate) selected_model: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) is_base_url_configured: bool,
    pub(crate) has_credentials: bool,
    pub(crate) is_configured: bool,
    pub(crate) inline_completion_enabled: bool,
    pub(crate) chat_enabled: bool,
    pub(crate) agent_enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderTestPayload {
    pub(crate) ok: bool,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionRequest {
    pub(crate) file_path: String,
    pub(crate) language: String,
    pub(crate) cursor_offset: u32,
    pub(crate) prefix: String,
    pub(crate) suffix: String,
    pub(crate) recent_edits: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionRangePayload {
    pub(crate) start_offset: u32,
    pub(crate) end_offset: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionResult {
    pub(crate) insert_text: String,
    pub(crate) range: AiInlineCompletionRangePayload,
    pub(crate) confidence: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCodeActionRequest {
    pub(crate) kind: String,
    pub(crate) file_path: Option<String>,
    pub(crate) language: String,
    pub(crate) selection: String,
    pub(crate) diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPatchHunkPayload {
    pub(crate) old_start: u32,
    pub(crate) old_lines: u32,
    pub(crate) new_start: u32,
    pub(crate) new_lines: u32,
    pub(crate) lines: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPatchFilePayload {
    pub(crate) path: String,
    pub(crate) original_hash: String,
    pub(crate) hunks: Vec<AiPatchHunkPayload>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPatchSetPayload {
    pub(crate) summary: String,
    pub(crate) files: Vec<AiPatchFilePayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCodeActionPayload {
    pub(crate) explanation: String,
    pub(crate) suggested_patch: Option<AiPatchSetPayload>,
    pub(crate) test_suggestion: Option<String>,
    pub(crate) follow_up_questions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProposePatchRequest {
    pub(crate) path: String,
    pub(crate) original_content: String,
    pub(crate) updated_content: String,
    pub(crate) summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProposePatchPayload {
    pub(crate) patch: AiPatchSetPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyPatchRequest {
    pub(crate) patch: AiPatchSetPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyPatchFilePayload {
    pub(crate) path: String,
    pub(crate) byte_size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyPatchPayload {
    pub(crate) applied_files: Vec<AiApplyPatchFilePayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolDefinitionPayload {
    pub(crate) name: String,
    pub(crate) read_only: bool,
    pub(crate) destructive: bool,
    pub(crate) requires_confirmation: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentPlanRequest {
    pub(crate) goal: String,
    pub(crate) context: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskPlanStepPayload {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentPlanPayload {
    pub(crate) steps: Vec<AiTaskPlanStepPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBuildIndexRequest {
    pub(crate) workspace_root_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBuildIndexPayload {
    pub(crate) root_path: String,
    pub(crate) indexed_file_count: usize,
    pub(crate) skipped_file_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQueryIndexRequest {
    pub(crate) workspace_root_path: String,
    pub(crate) query: String,
    pub(crate) limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiIndexResultPayload {
    pub(crate) path: String,
    pub(crate) line_number: Option<usize>,
    pub(crate) preview: String,
    pub(crate) score: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQueryIndexPayload {
    pub(crate) root_path: String,
    pub(crate) results: Vec<AiIndexResultPayload>,
}
