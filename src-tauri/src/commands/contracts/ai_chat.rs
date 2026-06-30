use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// AI – chat
// ============================================================================

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

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiCancelRequest {
    #[expect(
        dead_code,
        reason = "stream_id remains part of the public cancel request payload"
    )]
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

/// ACP 标准 session/set_config_option 的会话级配置项切换请求（契约层）。
///
/// 对齐 acp::AcpRuntime::set_session_config_option(thread_id, config_id, value_id)：
///   * thread_id —— 定位目标会话（宿主持有 thread_id ↔ SessionId 映射，跨回合复用）；
///   * config_id —— 目标配置项的 ACP SessionConfigOption.id 原值，逐字透传，绝不本地映射；
///   * value_id —— 选中值的 ACP SessionConfigValueId 原值，逐字透传，绝不本地映射。
///
/// 三者均必填且非空（前端总能从已渲染的配置项选择器取得），空白校验由接线层负责。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSetSessionConfigOptionRequest {
    pub(crate) thread_id: String,
    pub(crate) config_id: String,
    pub(crate) value_id: String,
}

/// ACP 会话握手请求（契约层，v3 · 唯一标准管线）。
///
/// 对齐 ai_ensure_acp_session：thread_id 定位/复用会话；backend 指定后端（builtin/kimi/codex）；
/// workspace_root_path 为新建会话的 cwd。握手建立/复用会话后，直接回传 agent 在 session/new 响应
/// 公示的可用配置项全集（AiSessionConfigOptionsPayload）——这是配置项初始发现的唯一来源；后续 agent
/// 主动发起的 config_option_update 经标准回合流式投影由前端增量并入。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiEnsureAcpSessionRequest {
    pub(crate) thread_id: String,
    pub(crate) backend: String,
    pub(crate) workspace_root_path: Option<String>,
}

/// ACP 会话可用配置项清单的响应载荷（契约层）。
///
/// config_options 为 agent 在 NewSessionResponse 公示的可用配置项清单原样 JSON
/// （Vec SessionConfigOption：id + name + description + category + kind 等）。最小透传，宿主侧
/// 不重建 SDK 类型，交前端 ACL 解释（最小透传整体 JSON）。用
/// specta_typescript::Unknown 将导出 TS 映射为 unknown，避开 serde_json::Number 触发 specta
/// BigInt-forbidden；serde 运行时仍为 serde_json::Value，行为不变。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionConfigOptionsPayload {
    #[specta(type = specta_typescript::Unknown)]
    pub(crate) config_options: serde_json::Value,
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
