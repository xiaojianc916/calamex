use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// Secret newtype
// ----------------------------------------------------------------------------
// 用于在结构体中包裹敏感字符串（如 API Key），保证：
// - 在 JSON 上仍序列化/反序列化为普通字符串（serde transparent）；
// - {:?} / Debug 输出永远是 "***"，不会随 tracing/println 泄漏；
// - 通过 Deref<Target = str> 与 AsRef<str>，调用方对原 `String` 字段的绝大多数
//   只读用法（如 `&req.api_key` 当作 `&str`、`req.api_key.is_empty()`、
//   `req.api_key.len()`、`req.api_key.to_string()`）保持源码级兼容。
// ============================================================================
#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    /// 显式取出明文，命名上提醒调用点这是一次"暴露密钥"的动作，便于审计。
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// 消费 `SecretString` 取回内部 `String`。
    pub fn into_inner(self) -> String {
        self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(***)")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl Deref for SecretString {
    type Target = str;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<str> for SecretString {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<SecretString> for String {
    fn from(value: SecretString) -> Self {
        value.0
    }
}

// ============================================================================
// Script payloads
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum DocumentEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    #[serde(rename = "gbk")]
    Gbk,
    #[serde(rename = "gb18030")]
    Gb18030,
    #[serde(rename = "utf-16le")]
    Utf16le,
    #[serde(rename = "utf-16be")]
    Utf16be,
}

impl DocumentEncoding {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf8Bom => "utf-8-bom",
            Self::Gbk => "gbk",
            Self::Gb18030 => "gb18030",
            Self::Utf16le => "utf-16le",
            Self::Utf16be => "utf-16be",
        }
    }
}

impl fmt::Display for DocumentEncoding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePathKind {
    Directory,
    File,
}

impl WorkspacePathKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File => "file",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ScriptDiagnosticSeverity {
    Error,
    Warning,
    Info,
    Style,
}

impl TryFrom<&str> for ScriptDiagnosticSeverity {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, String> {
        match value {
            "error" => Ok(Self::Error),
            "warning" => Ok(Self::Warning),
            "info" => Ok(Self::Info),
            "style" => Ok(Self::Style),
            other => Err(format!("ShellCheck 返回了未知诊断级别：{other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFilePayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) content: String,
    pub(crate) encoding: DocumentEncoding,
    pub(crate) line_count: u32,
    pub(crate) char_count: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetPayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) mime_type: String,
    pub(crate) data_url: String,
    pub(crate) byte_size: u32,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct SaveScriptRequest {
    pub(crate) path: String,
    pub(crate) content: String,
    /// 文本编码，已知值："utf-8" | "utf-8-bom" | "gbk" | …（保持字符串以便扩展）。
    pub(crate) encoding: DocumentEncoding,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatScriptRequest {
    pub(crate) path: Option<String>,
    pub(crate) content: String,
    /// 文本编码，已知值："utf-8" | "utf-8-bom" | "gbk" | …。
    pub(crate) encoding: DocumentEncoding,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatScriptPayload {
    pub(crate) content: String,
    pub(crate) encoding: DocumentEncoding,
    pub(crate) line_count: u32,
    pub(crate) char_count: u32,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeScriptRequest {
    pub(crate) path: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) content: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDiagnosticPayload {
    pub(crate) line: u32,
    pub(crate) end_line: u32,
    pub(crate) column: u32,
    pub(crate) end_column: u32,
    pub(crate) level: ScriptDiagnosticSeverity,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeScriptPayload {
    pub(crate) available: bool,
    pub(crate) message: Option<String>,
    pub(crate) dialect: String,
    pub(crate) diagnostics: Vec<ScriptDiagnosticPayload>,
}

// ============================================================================
// Execution environment
// ============================================================================

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ExecutorKind {
    Wsl,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOption {
    pub(crate) r#type: ExecutorKind,
    pub(crate) label: String,
    pub(crate) available: bool,
    pub(crate) description: String,
    pub(crate) command_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironment {
    pub(crate) recommended: ExecutorKind,
    pub(crate) has_any: bool,
    pub(crate) executors: Vec<ExecutionOption>,
}

// ============================================================================
// Workspace tree
// ============================================================================

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    /// 已知值："file" | "directory" | "symlink" | …。
    pub(crate) kind: WorkspacePathKind,
    pub(crate) has_children: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryPayload {
    pub(crate) root_path: String,
    pub(crate) root_name: String,
    pub(crate) entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathCreateRequest {
    pub(crate) parent_path: String,
    pub(crate) root_path: String,
    pub(crate) name: String,
    /// 已知值："file" | "directory"。
    pub(crate) kind: WorkspacePathKind,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathCreatePayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: WorkspacePathKind,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathRenameRequest {
    pub(crate) path: String,
    pub(crate) root_path: String,
    pub(crate) new_name: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathRenamePayload {
    pub(crate) old_path: String,
    pub(crate) new_path: String,
    pub(crate) name: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathDeleteRequest {
    pub(crate) path: String,
    pub(crate) root_path: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathDeletePayload {
    pub(crate) path: String,
}

// ============================================================================
// SSH
// ============================================================================
//
// 以下 *Request 共享一组连接字段（host/port/username/auth_mode/identity_path），
// 出于"零破坏性"约束本版未抽 SshCredentials + #[serde(flatten)]，未来若决定
// 重构，是 wire-compatible 的纯 Rust 内部改动。
//
// 注意：identity_path 在某些上下文下可能算敏感信息（包含本地用户名路径），
// 当前保留 Debug；若要进一步收紧可换成 `SecretString` 或自定义 Debug。

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionTestRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    /// 已知值："password" | "key" | "agent"。
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionTestPayload {
    pub(crate) ok: bool,
    /// 已知值："ok" | "auth-failed" | "host-unreachable" | "timeout" | …。
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPasswordSaveRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) password: SecretString,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPasswordGetRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPasswordStatusPayload {
    pub(crate) has_password: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPasswordPayload {
    pub(crate) password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryListRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryEntryPayload {
    pub(crate) name: String,
    pub(crate) path: String,
    /// 已知值："file" | "directory" | "symlink"。
    pub(crate) kind: String,
    pub(crate) size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryListPayload {
    pub(crate) path: String,
    pub(crate) entries: Vec<SshDirectoryEntryPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileDownloadRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) remote_path: String,
    pub(crate) local_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileDownloadPayload {
    pub(crate) remote_path: String,
    pub(crate) local_path: String,
    pub(crate) byte_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileUploadRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) local_path: String,
    pub(crate) remote_directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileUploadPayload {
    pub(crate) local_path: String,
    pub(crate) remote_path: String,
    pub(crate) byte_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathDeleteRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) remote_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathDeletePayload {
    pub(crate) remote_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathRenameRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) remote_path: String,
    pub(crate) new_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPathRenamePayload {
    pub(crate) old_path: String,
    pub(crate) new_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryCreateRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) remote_directory: String,
    pub(crate) name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryCreatePayload {
    pub(crate) remote_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileReadRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) remote_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileReadPayload {
    pub(crate) remote_path: String,
    pub(crate) content: String,
    pub(crate) byte_size: u64,
    pub(crate) encoding: String,
    pub(crate) line_count: u64,
    pub(crate) line_ending: String,
    pub(crate) permission: String,
    pub(crate) owner: String,
    pub(crate) modified_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileWriteRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) remote_path: String,
    pub(crate) content: String,
    pub(crate) encoding: String,
    pub(crate) line_ending: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileWritePayload {
    pub(crate) remote_path: String,
    pub(crate) byte_size: u64,
}

#[derive(Debug, Clone, Serialize)]
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

// ============================================================================
// AI – chat
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessagePayload {
    /// 已知值："user" | "assistant" | "system" | "tool"。
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) id: String,
    pub(crate) created_at: String,
    pub(crate) references: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContextRangePayload {
    pub(crate) start_line: u32,
    pub(crate) end_line: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContextReferencePayload {
    pub(crate) id: String,
    /// 引用种类，已知值："file" | "selection" | "symbol" | "diagnostic" | …。
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) path: Option<String>,
    pub(crate) range: Option<AiContextRangePayload>,
    pub(crate) content_preview: String,
    pub(crate) redacted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub(crate) thread_id: Option<String>,
    pub(crate) messages: Vec<AiChatMessagePayload>,
    pub(crate) references: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationTitleRequest {
    pub(crate) user_message: String,
    pub(crate) assistant_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationTitlePayload {
    pub(crate) title: String,
    pub(crate) model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestionPoolRequest {
    pub(crate) count: usize,
    pub(crate) locale: String,
    pub(crate) topics: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestionPoolPayload {
    pub(crate) suggestions: Vec<String>,
    pub(crate) model: String,
    pub(crate) generated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStreamPayload {
    pub(crate) stream_id: String,
    pub(crate) assistant_message_id: String,
    pub(crate) provider_type: String,
    pub(crate) model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCancelRequest {
    pub(crate) stream_id: String,
}

// ============================================================================
// AI – config / credentials
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSaveConfigRequest {
    #[serde(default)]
    pub(crate) role: Option<String>,
    pub(crate) provider_type: String,
    pub(crate) selected_model: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) inline_completion_enabled: bool,
    pub(crate) chat_enabled: bool,
    pub(crate) agent_enabled: bool,
}

/// ⚠️ `api_key` 已包装在 `SecretString` 中，Debug 输出会被遮蔽为 `***`。
/// 调用方读取明文请使用 `request.api_key.expose()` 显式取出。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSaveCredentialsRequest {
    pub(crate) provider_id: String,
    #[serde(default)]
    pub(crate) alias: Option<String>,
    pub(crate) api_key: SecretString,
}

/// 用于“测试连接 / 开始连接”的草稿配置。
///
/// `api_key` 允许为空：为空时后端只会尝试读取当前 Provider 已保存的凭证；
/// 若也不存在已保存凭证，连接测试必须失败，不能伪造成功。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConnectionRequest {
    #[serde(default)]
    pub(crate) role: Option<String>,
    #[serde(default)]
    pub(crate) provider_id: Option<String>,
    pub(crate) provider_type: String,
    pub(crate) selected_model: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) inline_completion_enabled: bool,
    pub(crate) chat_enabled: bool,
    pub(crate) agent_enabled: bool,
    pub(crate) api_key: Option<SecretString>,
}

#[derive(Debug, Clone, Serialize)]
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
    pub(crate) narrator: AiModelEndpointConfigPayload,
    pub(crate) credentials: Vec<AiCredentialStatusPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelEndpointConfigPayload {
    pub(crate) provider_type: String,
    pub(crate) selected_model: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) is_base_url_configured: bool,
    pub(crate) has_credentials: bool,
    pub(crate) is_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCredentialStatusPayload {
    pub(crate) provider_id: String,
    pub(crate) has_credentials: bool,
    pub(crate) alias: String,
    pub(crate) key_preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderTestPayload {
    pub(crate) ok: bool,
    /// 已知值："ok" | "unauthorized" | "rate-limited" | "network" | …。
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConnectionPayload {
    pub(crate) config: AiConfigPayload,
    pub(crate) test: AiProviderTestPayload,
}

// ============================================================================
// AI – inline completion
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionRequest {
    pub(crate) file_path: String,
    pub(crate) language: String,
    pub(crate) cursor_offset: u32,
    pub(crate) prefix: String,
    pub(crate) suffix: String,
    pub(crate) recent_edits: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionRangePayload {
    pub(crate) start_offset: u32,
    pub(crate) end_offset: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionResult {
    pub(crate) insert_text: String,
    pub(crate) range: AiInlineCompletionRangePayload,
    /// 置信度等级，已知值："low" | "medium" | "high"。
    pub(crate) confidence: String,
}

// ============================================================================
// AI – code action / patch
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCodeActionRequest {
    /// 已知值："explain" | "fix" | "refactor" | "test" | …。
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCodeActionPayload {
    pub(crate) explanation: String,
    pub(crate) suggested_patch: Option<AiPatchSetPayload>,
    pub(crate) test_suggestion: Option<String>,
    pub(crate) follow_up_questions: Vec<String>,
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

// ============================================================================
// AI – agent plan / index
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentClassifyTaskRequest {
    pub(crate) goal: String,
    pub(crate) context: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentClassifyTaskPayload {
    pub(crate) classification: String,
    pub(crate) should_enter_plan_mode: bool,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentSetNetworkPermissionRequest {
    pub(crate) permission: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentNetworkPermissionPayload {
    pub(crate) permission: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebSearchInput {
    pub(crate) query: String,
    pub(crate) intent: String,
    pub(crate) max_results: usize,
    pub(crate) recency: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebSearchResultPayload {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) snippet: String,
    pub(crate) source_type: String,
    pub(crate) fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebSearchPayload {
    pub(crate) results: Vec<AiWebSearchResultPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebFetchInput {
    pub(crate) url: String,
    pub(crate) reason: String,
    pub(crate) max_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebFetchResultPayload {
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) text_ref: String,
    pub(crate) excerpt: String,
    pub(crate) bytes: usize,
    pub(crate) fetched_at: String,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebFetchPayload {
    pub(crate) source: AiWebFetchResultPayload,
}

// ============================================================================
// Agent sidecar
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarMessagePayload {
    pub(crate) role: String,
    pub(crate) content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarModelConfigPayload {
    pub(crate) model_id: String,
    pub(crate) api_key: SecretString,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarWarmupRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
}

fn is_blank_optional_string(value: &Option<String>) -> bool {
    value
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarChatRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) mode: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) goal: Option<String>,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) goal: String,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) plan_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarExecuteRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) goal: String,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    pub(crate) plan_id: String,
    pub(crate) plan_version: u32,
    pub(crate) plan_step_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanValidateRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) goal: Option<String>,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    pub(crate) plan_id: String,
    pub(crate) plan_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanReplanRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) goal: String,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    pub(crate) plan_id: String,
    pub(crate) plan_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanApproveRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) plan_id: String,
    pub(crate) version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanQueryRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) plan_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanRejectRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) plan_id: String,
    pub(crate) version: u32,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanFinishRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) plan_id: String,
    pub(crate) version: u32,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarApprovalResolveRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) request_id: String,
    pub(crate) decision: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) goal: Option<String>,
    #[serde(default)]
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan_version: Option<u32>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) plan_step_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentSidecarRollbackStepPath {
    Single(String),
    Nested(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarCheckpointRestoreRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) run_id: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) step: Option<AgentSidecarRollbackStepPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarMcpHealthPayload {
    pub(crate) configured_servers: u32,
    pub(crate) server_names: Vec<String>,
    pub(crate) errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarHealthPayload {
    pub(crate) ok: bool,
    pub(crate) status: String,
    pub(crate) engine: String,
    pub(crate) version: Option<String>,
    pub(crate) protocol_version: Option<String>,
    pub(crate) implementation_version: Option<String>,
    pub(crate) mcp: AgentSidecarMcpHealthPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarWarmupPayload {
    pub(crate) ok: bool,
    pub(crate) provider_id: Option<String>,
    pub(crate) origin: Option<String>,
    pub(crate) status_code: Option<u16>,
    pub(crate) duration_ms: u64,
    pub(crate) skipped: bool,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarResponsePayload {
    pub(crate) session_id: String,
    pub(crate) events: Vec<serde_json::Value>,
    pub(crate) result: Option<String>,
}

#[cfg(test)]
mod agent_sidecar_contract_tests {
    use serde::Serialize;
    use serde_json::{Map, Value};

    use super::{
        AgentSidecarChatRequest, AgentSidecarCheckpointRestoreRequest, AgentSidecarExecuteRequest,
        AgentSidecarMessagePayload, AgentSidecarRollbackStepPath,
    };

    fn sidecar_message() -> AgentSidecarMessagePayload {
        AgentSidecarMessagePayload {
            role: "user".to_string(),
            content: "run".to_string(),
        }
    }

    fn serialize_object<T: Serialize>(value: &T) -> Map<String, Value> {
        let serialized = match serde_json::to_value(value) {
            Ok(serialized) => serialized,
            Err(error) => panic!("failed to serialize sidecar request: {error}"),
        };

        match serialized {
            Value::Object(object) => object,
            other => panic!("expected object, got {other:?}"),
        }
    }

    #[test]
    fn chat_request_omits_blank_optional_fields() {
        let request = AgentSidecarChatRequest {
            session_id: None,
            mode: Some(" ".to_string()),
            goal: Some("".to_string()),
            messages: vec![sidecar_message()],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: Some(" ".to_string()),
        };

        let object = serialize_object(&request);

        assert!(!object.contains_key("sessionId"));
        assert!(!object.contains_key("mode"));
        assert!(!object.contains_key("goal"));
        assert!(!object.contains_key("workspaceRootPath"));
        assert!(!object.contains_key("threadId"));
        assert!(object.contains_key("messages"));
        assert!(object.contains_key("context"));
    }

    #[test]
    fn chat_request_keeps_non_empty_thread_id() {
        let request = AgentSidecarChatRequest {
            session_id: Some("sidecar-chat-1".to_string()),
            mode: Some("ask".to_string()),
            goal: Some("继续".to_string()),
            messages: vec![sidecar_message()],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: Some("thread-chat-1".to_string()),
        };

        let object = serialize_object(&request);

        assert_eq!(
            object.get("threadId"),
            Some(&Value::String("thread-chat-1".to_string()))
        );
    }

    #[test]
    fn execute_request_omits_absent_optional_fields() {
        let request = AgentSidecarExecuteRequest {
            session_id: None,
            goal: "run".to_string(),
            messages: vec![sidecar_message()],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            plan_id: "plan-1".to_string(),
            plan_version: 1,
            plan_step_id: "step-1".to_string(),
        };

        let object = serialize_object(&request);

        assert!(!object.contains_key("sessionId"));
        assert!(!object.contains_key("workspaceRootPath"));
        assert_eq!(object.get("goal"), Some(&Value::String("run".to_string())));
    }

    #[test]
    fn execute_request_keeps_non_empty_optional_fields() {
        let request = AgentSidecarExecuteRequest {
            session_id: Some("agent-session-1".to_string()),
            goal: "run".to_string(),
            messages: vec![sidecar_message()],
            workspace_root_path: Some("D:/com.xiaojianc/my_desktop_app".to_string()),
            context: Vec::new(),
            model_config: None,
            plan_id: "plan-1".to_string(),
            plan_version: 1,
            plan_step_id: "step-1".to_string(),
        };

        let object = serialize_object(&request);

        assert_eq!(
            object.get("sessionId"),
            Some(&Value::String("agent-session-1".to_string()))
        );
        assert_eq!(
            object.get("workspaceRootPath"),
            Some(&Value::String(
                "D:/com.xiaojianc/my_desktop_app".to_string()
            ))
        );
    }

    #[test]
    fn restore_checkpoint_request_omits_absent_optional_fields() {
        let request = AgentSidecarCheckpointRestoreRequest {
            session_id: None,
            run_id: "run-1".to_string(),
            snapshot_id: None,
            step: None,
            model_config: None,
        };

        let object = serialize_object(&request);

        assert!(!object.contains_key("sessionId"));
        assert!(!object.contains_key("snapshotId"));
        assert!(!object.contains_key("step"));
        assert_eq!(
            object.get("runId"),
            Some(&Value::String("run-1".to_string()))
        );
    }

    #[test]
    fn restore_checkpoint_request_serializes_nested_step_path() {
        let request = AgentSidecarCheckpointRestoreRequest {
            session_id: Some("sidecar-rollback-1".to_string()),
            run_id: "run-1".to_string(),
            snapshot_id: Some("snapshot-1".to_string()),
            step: Some(AgentSidecarRollbackStepPath::Nested(vec![
                "durable-agentic-execution".to_string(),
                "durable-llm-execution".to_string(),
            ])),
            model_config: None,
        };

        let object = serialize_object(&request);

        assert_eq!(
            object.get("sessionId"),
            Some(&Value::String("sidecar-rollback-1".to_string()))
        );
        assert_eq!(
            object.get("snapshotId"),
            Some(&Value::String("snapshot-1".to_string()))
        );
        assert_eq!(
            object.get("step"),
            Some(&Value::Array(vec![
                Value::String("durable-agentic-execution".to_string()),
                Value::String("durable-llm-execution".to_string()),
            ]))
        );
    }
}
