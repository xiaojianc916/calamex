use serde::{Deserialize, Serialize};

use super::secret::SecretString;

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
