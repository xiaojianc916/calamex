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
    pub(crate) session_id: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiCancelRequest {
    #[expect(dead_code, reason = "stream_id remains part of the public cancel request payload")]
    pub(crate) stream_id: String,
    pub(crate) thread_id: Option<String>,
}

/// ACP 反向 `session/request_permission` 的审批投递请求（契约层）。
///
/// 对齐 `acp::AcpRuntime::resolve_approval(session_id, tool_call_id, decision)`：
///   * `session_id` / `tool_call_id` —— 定位挂起审批所属的会话与工具调用（ACP 原值，逐字透传）；
///   * `decision` —— 选中项 `optionId`（ACP `RequestPermissionRequest.options[].optionId` 原值，
///     逐字回填，绝不本地映射，对齐 `approval.rs` 的逐字匹配）。
///
/// 三者均必填且非空（前端总能从已渲染的审批气泡取得），空白校验由接线层负责。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiResolveApprovalRequest {
    pub(crate) session_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) decision: String,
}

/// ACP 标准 session/set_mode 的模式切换请求（契约层）。
///
/// 对齐 acp::AcpRuntime::set_session_mode(thread_id, mode_id)：
///   * thread_id —— 定位目标会话（宿主持有 thread_id ↔ SessionId 映射，跨回合复用）；
///   * mode_id —— 目标模式的 ACP SessionMode.id 原值，逐字透传，绝不本地映射。
///
/// 两者均必填且非空（前端总能从已渲染的模式选择器取得），空白校验由接线层负责。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSetSessionModeRequest {
    pub(crate) thread_id: String,
    pub(crate) mode_id: String,
}

/// ACP 会话可用模式清单的查询请求（契约层）。
///
/// 对齐 acp::AcpRuntime::session_modes(thread_id)：thread_id 定位目标会话（宿主持有
/// thread_id ↔ SessionId 映射，并在会话建立时登记 agent 公示的可用模式）。必填且非空（前端
/// 总能从当前线程取得），空白校验由接线层负责。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiGetSessionModesRequest {
    pub(crate) thread_id: String,
}

/// ACP 会话可用模式清单的响应载荷（契约层）。
///
/// modes 为 agent 在 NewSessionResponse 公示的可用模式清单原样 JSON（SessionModeState：
/// currentModeId + availableModes[]）。最小透传，宿主侧不重建 SDK 类型，交前端 ACL 解释（对齐
/// tool_call 的 acpUpdate 整体透传）。用 specta_typescript::Unknown 将导出 TS 映射为 unknown，
/// 避开 serde_json::Number 的 i64/u64 触发 specta BigInt-forbidden（对齐
/// AgentSidecarResponsePayload.events）；serde 运行时仍为 serde_json::Value，行为不变。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionModesPayload {
    #[specta(type = specta_typescript::Unknown)]
    pub(crate) modes: serde_json::Value,
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
