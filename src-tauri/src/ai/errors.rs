use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiErrorPayload {
    pub code: String,
    pub message: String,
}

/// 构造结构化错误 JSON 字符串。
///
/// `code` 接受 `impl Into<String>`，既兼容 `&'static str` 字面量
/// （如 `errors::error("AI_PROVIDER_AUTH_FAILED", "...")`），也支持
/// 从 sidecar 响应中动态提取的错误码（如 `errors::error(code, msg)`
/// 其中 `code: &str` 来自 `AgentSidecarResponsePayload.error_code`）。
pub fn error(code: impl Into<String>, message: impl Into<String>) -> String {
    let payload = AiErrorPayload {
        code: code.into(),
        message: message.into(),
    };
    serde_json::to_string(&payload).unwrap_or(payload.message)
}
