use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiErrorPayload {
    pub code: &'static str,
    pub message: String,
}

pub fn error(code: &'static str, message: impl Into<String>) -> String {
    let payload = AiErrorPayload {
        code,
        message: message.into(),
    };
    serde_json::to_string(&payload).unwrap_or(payload.message)
}
