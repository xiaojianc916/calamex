use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// AI – chat
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessagePayload {
    /// 已知值："user" | "assistant" | "system" | "tool"。
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) id: String,
    pub(crate) created_at: String,
    pub(crate) references: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiContextRangePayload {
    pub(crate) start_line: u32,
    pub(crate) end_line: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
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

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub(crate) thread_id: Option<String>,
    pub(crate) messages: Vec<AiChatMessagePayload>,
    pub(crate) references: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationTitleRequest {
    pub(crate) user_message: String,
    pub(crate) assistant_message: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationTitlePayload {
    pub(crate) title: String,
    pub(crate) model: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestionPoolRequest {
    #[specta(type = u32)]
    pub(crate) count: usize,
    pub(crate) locale: String,
    pub(crate) topics: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestionPoolPayload {
    pub(crate) suggestions: Vec<String>,
    pub(crate) model: String,
    pub(crate) generated_at: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStreamPayload {
    pub(crate) stream_id: String,
    pub(crate) assistant_message_id: String,
    pub(crate) provider_type: String,
    pub(crate) model: String,
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiCancelRequest {
    pub(crate) stream_id: String,
    pub(crate) thread_id: Option<String>,
}

// ============================================================================
// AI – inline completion
// ============================================================================

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionRequest {
    pub(crate) file_path: String,
    pub(crate) language: String,
    pub(crate) cursor_offset: u32,
    pub(crate) prefix: String,
    pub(crate) suffix: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionRangePayload {
    pub(crate) start_offset: u32,
    pub(crate) end_offset: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineCompletionResult {
    pub(crate) insert_text: String,
    pub(crate) range: AiInlineCompletionRangePayload,
    /// 置信度等级，已知值："low" | "medium" | "high"。
    pub(crate) confidence: String,
}
