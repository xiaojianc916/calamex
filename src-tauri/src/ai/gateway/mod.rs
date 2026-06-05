use super::audit::{self, AiAuditEventKind};
use super::credential::CredentialStore;
use super::errors;
use super::provider::{AiProviderChatRequest, AiProviderMessage, AiProviderUsage};
use super::security::redaction::redact_text;
use super::stream as stream_manager;
use crate::ai::agent::planner::AgentPlanner;
use crate::commands::contracts::{
    AiAgentClassifyTaskPayload, AiAgentClassifyTaskRequest, AiChatRequest, AiConfigPayload,
    AiContextReferencePayload, AiConversationTitlePayload, AiConversationTitleRequest,
    AiCredentialStatusPayload, AiInlineCompletionRangePayload, AiInlineCompletionRequest,
    AiInlineCompletionResult, AiModelEndpointConfigPayload, AiSuggestionPoolPayload,
    AiSuggestionPoolRequest,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Emitter, Manager};

mod config;
mod connection;
mod conversation;
mod prompt;
mod suggestions;

#[cfg(test)]
mod tests;

pub use config::{clear_credentials, get_config, save_config, save_credentials};
pub use connection::{connect_provider, test_provider, test_provider_config};
pub use conversation::{chat_stream, classify_task, generate_conversation_title, inline_complete};
pub use suggestions::{generate_suggestion_pool, get_suggestion_pool_cache};

const MAX_AI_MESSAGES: usize = 32;
const MAX_MESSAGE_CHARS: usize = 16_000;
const MAX_CONTEXT_REFERENCES: usize = 8;
const MAX_CONTEXT_BLOCK_CHARS: usize = 12_000;
const MAX_REFERENCE_PREVIEW_CHARS: usize = 4_000;
const MAX_TITLE_SOURCE_CHARS: usize = 1_200;
const MIN_GENERATED_TITLE_CHARS: usize = 5;
const MAX_GENERATED_TITLE_CHARS: usize = 10;

// 默认主模型：与 sidecar 的 models/config.ts `DEFAULT_MODEL_ID` 保持单一来源对齐
// （DeepSeek 是本项目默认网关）。二者必须同步修改，否则"Rust 默认"与"sidecar 默认"
// 会漂移成两个不同模型。
const DEFAULT_MASTRA_MODEL: &str = "deepseek/deepseek-v4-flash";
const DEFAULT_NARRATOR_MODEL: &str = "zhipuai/glm-4.7-flash";

static CONFIG: OnceLock<Mutex<AiRuntimeConfig>> = OnceLock::new();
static STREAM_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AiRuntimeConfig {
    provider_type: String,
    selected_model: Option<String>,
    base_url: Option<String>,
    #[serde(default)]
    narrator: AiModelEndpointRuntimeConfig,
    #[serde(default)]
    credentials: HashMap<String, AiCredentialRuntimeMetadata>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct AiCredentialRuntimeMetadata {
    #[serde(default)]
    alias: String,
    #[serde(default)]
    key_preview: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AiModelEndpointRuntimeConfig {
    provider_type: String,
    selected_model: Option<String>,
    base_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiResolvedModelRole {
    Main,
    Narrator,
}

impl Default for AiRuntimeConfig {
    fn default() -> Self {
        Self {
            provider_type: "mastra".to_string(),
            selected_model: Some(DEFAULT_MASTRA_MODEL.to_string()),
            base_url: None,
            narrator: AiModelEndpointRuntimeConfig::default(),
            credentials: HashMap::new(),
            inline_completion_enabled: true,
            chat_enabled: true,
            agent_enabled: false,
        }
    }
}

impl Default for AiModelEndpointRuntimeConfig {
    fn default() -> Self {
        Self {
            provider_type: "mastra".to_string(),
            selected_model: Some(DEFAULT_NARRATOR_MODEL.to_string()),
            base_url: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStreamEventPayload {
    pub stream_id: String,
    pub assistant_message_id: String,
    pub kind: String,
    pub delta: Option<String>,
    pub message: Option<String>,
    pub model: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub usage: Option<AiProviderUsage>,
}

pub struct AiChatStreamStart {
    pub stream_id: String,
    pub assistant_message_id: String,
    pub provider_type: String,
    pub model: String,
}

fn config_state() -> &'static Mutex<AiRuntimeConfig> {
    CONFIG.get_or_init(|| Mutex::new(load_config_from_disk().unwrap_or_default()))
}

fn current_config() -> Result<AiRuntimeConfig, String> {
    config_state()
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))
}

fn ensure_chat_enabled(config: &AiRuntimeConfig) -> Result<(), String> {
    if config.chat_enabled {
        return Ok(());
    }

    Err(errors::error(
        "AI_CHAT_DISABLED",
        "AI Chat 当前未启用，请先在设置中启用。",
    ))
}

fn to_payload(config: AiRuntimeConfig) -> AiConfigPayload {
    let has_credentials = has_credentials_for_model(config.selected_model.as_deref());
    let has_selected_model = has_model_selection(config.selected_model.as_deref());
    let narrator = model_endpoint_to_payload(&config.narrator, AiResolvedModelRole::Narrator);

    let is_base_url_configured = config
        .base_url
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    AiConfigPayload {
        provider_type: config.provider_type.clone(),
        selected_model: config.selected_model,
        base_url: config.base_url,
        is_base_url_configured,
        has_credentials,
        is_configured: is_endpoint_ready(has_credentials, has_selected_model),
        inline_completion_enabled: config.inline_completion_enabled,
        chat_enabled: config.chat_enabled,
        agent_enabled: config.agent_enabled,
        narrator,
        credentials: credential_status_payloads(&config.credentials),
    }
}

fn model_endpoint_to_payload(
    config: &AiModelEndpointRuntimeConfig,
    _role: AiResolvedModelRole,
) -> AiModelEndpointConfigPayload {
    let has_selected_model = has_model_selection(config.selected_model.as_deref());
    let is_base_url_configured = config
        .base_url
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let has_credentials = has_credentials_for_model(config.selected_model.as_deref());

    AiModelEndpointConfigPayload {
        provider_type: config.provider_type.clone(),
        selected_model: config.selected_model.clone(),
        base_url: config.base_url.clone(),
        is_base_url_configured,
        has_credentials,
        is_configured: is_endpoint_ready(has_credentials, has_selected_model),
    }
}

fn has_model_selection(selected_model: Option<&str>) -> bool {
    selected_model
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn is_endpoint_ready(has_credentials: bool, has_selected_model: bool) -> bool {
    has_credentials && has_selected_model
}

fn has_credentials_for_model(selected_model: Option<&str>) -> bool {
    model_service_platform(selected_model)
        .map(CredentialStore::has)
        .unwrap_or(false)
}

fn get_api_key_for_config(config: &AiRuntimeConfig) -> Result<String, String> {
    let provider_id = model_service_platform(config.selected_model.as_deref())
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "请先选择模型。"))?;

    CredentialStore::get(provider_id)
}

fn get_saved_api_key_for_candidate(selected_model: Option<&str>) -> Result<String, String> {
    let provider_id = model_service_platform(selected_model)
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "请先选择模型。"))?;

    CredentialStore::get(provider_id)
}

fn credential_status_payloads(
    metadata: &HashMap<String, AiCredentialRuntimeMetadata>,
) -> Vec<AiCredentialStatusPayload> {
    crate::ai::credential::supported_provider_ids()
        .iter()
        .map(|provider_id| {
            let has_credentials = CredentialStore::has(provider_id);
            let stored = metadata.get(*provider_id);
            AiCredentialStatusPayload {
                provider_id: (*provider_id).to_string(),
                has_credentials,
                alias: stored
                    .map(|entry| entry.alias.trim())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("厂商 API Key")
                    .to_string(),
                key_preview: stored
                    .map(|entry| entry.key_preview.trim())
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| credential_key_preview(provider_id, has_credentials)),
            }
        })
        .collect()
}

fn credential_key_preview(provider_id: &str, has_credentials: bool) -> String {
    if !has_credentials {
        return "未保存 Key".to_string();
    }

    CredentialStore::get(provider_id)
        .map(|api_key| mask_api_key(&api_key))
        .unwrap_or_else(|_| "已加密保存".to_string())
}

fn mask_api_key(api_key: &str) -> String {
    let trimmed = api_key.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.is_empty() {
        return "已加密保存".to_string();
    }
    if chars.len() <= 8 {
        let tail: String = chars
            .iter()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return format!("…{tail}");
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{head}…{tail}")
}

fn model_service_platform(model: Option<&str>) -> Option<&str> {
    let model = model?.trim();
    if model.is_empty() {
        return None;
    }

    model
        .split_once('/')
        .map(|(platform, _)| platform.trim())
        .filter(|platform| !platform.is_empty())
}

fn validate_model_provider(
    selected_model: Option<&str>,
    provider_id: Option<&str>,
) -> Result<String, String> {
    let model_provider_id = model_service_platform(selected_model)
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "请先选择模型。"))?;
    let normalized_provider_id = provider_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(model_provider_id);

    if normalized_provider_id != model_provider_id {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "模型必须挂在对应厂商下，不能跨厂商使用 API Key。",
        ));
    }

    if !crate::ai::credential::supported_provider_ids().contains(&normalized_provider_id) {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "当前模型厂商不支持保存凭证。",
        ));
    }

    Ok(normalized_provider_id.to_string())
}

fn normalize_model_role(role: Option<&str>) -> Result<AiResolvedModelRole, String> {
    match role.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("main") => Ok(AiResolvedModelRole::Main),
        Some("narrator") => Ok(AiResolvedModelRole::Narrator),
        Some(_) => Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "AI 模型用途无效。",
        )),
    }
}

fn validate_provider(provider_type: &str) -> Result<(), String> {
    match provider_type {
        "mastra" => Ok(()),
        _ => Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "当前版本只支持 Mastra Provider。",
        )),
    }
}

fn normalize_base_url(
    provider_type: &str,
    base_url: Option<String>,
) -> Result<Option<String>, String> {
    let value = base_url
        .map(|item| item.trim().trim_end_matches('/').to_string())
        .filter(|item| !item.is_empty())
        .or_else(|| default_base_url(provider_type));

    let Some(value) = value else {
        return Ok(None);
    };

    if !is_allowed_base_url(&value) {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "AI Provider 地址必须使用 HTTPS；本地调试仅允许 http://localhost、http://127.0.0.1 或 http://[::1]。",
        ));
    }

    Ok(Some(value))
}

fn is_allowed_base_url(value: &str) -> bool {
    value.starts_with("https://")
        || value.starts_with("http://localhost")
        || value.starts_with("http://127.0.0.1")
        || value.starts_with("http://[::1]")
}

fn default_model(provider_type: &str) -> Option<String> {
    match provider_type {
        "mastra" => Some(DEFAULT_MASTRA_MODEL.to_string()),
        _ => None,
    }
}

fn default_base_url(provider_type: &str) -> Option<String> {
    match provider_type {
        "mastra" => None,
        _ => None,
    }
}

fn next_runtime_id(prefix: &str) -> String {
    let sequence = STREAM_SEQUENCE.fetch_add(1, Ordering::Relaxed);

    format!(
        "{}-{}-{}",
        prefix,
        jiff::Timestamp::now().as_millisecond(),
        sequence
    )
}

fn sanitize_fenced_text(value: &str) -> String {
    value.replace("```", "`\u{200b}``")
}

fn config_file_path() -> Option<PathBuf> {
    Some(
        crate::storage_paths::roaming_root()?
            .join("config")
            .join("ai.json"),
    )
}

fn load_config_from_disk() -> Option<AiRuntimeConfig> {
    let path = config_file_path()?;
    let content = fs::read_to_string(path).ok()?;

    serde_json::from_str::<AiRuntimeConfig>(&content)
        .ok()
        .map(normalize_runtime_config)
}

fn normalize_runtime_config(mut config: AiRuntimeConfig) -> AiRuntimeConfig {
    if validate_provider(&config.provider_type).is_err() {
        return AiRuntimeConfig::default();
    }

    let selected_model = config
        .selected_model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_model(&config.provider_type));
    let base_url = config
        .base_url
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_base_url(&config.provider_type));

    config.selected_model = selected_model;
    config.base_url = base_url;
    config.narrator = normalize_model_endpoint_config(config.narrator).unwrap_or_default();

    config
}

fn normalize_model_endpoint_config(
    mut config: AiModelEndpointRuntimeConfig,
) -> Option<AiModelEndpointRuntimeConfig> {
    if validate_provider(&config.provider_type).is_err() {
        return None;
    }

    config.selected_model = config
        .selected_model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| Some(DEFAULT_NARRATOR_MODEL.to_string()));
    config.base_url = config
        .base_url
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_base_url(&config.provider_type));

    Some(config)
}

fn persist_config(config: &AiRuntimeConfig) -> Result<(), String> {
    let Some(path) = config_file_path() else {
        return Ok(());
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("AI 配置目录创建失败：{error}"),
            )
        })?;
    }

    let content = serde_json::to_string_pretty(config).map_err(|error| {
        errors::error("AI_RESPONSE_INVALID", format!("AI 配置序列化失败：{error}"))
    })?;

    fs::write(path, content).map_err(|error| {
        errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!("AI 配置保存失败：{error}"),
        )
    })
}
