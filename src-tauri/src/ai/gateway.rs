use super::audit::{self, AiAuditEventKind};
use super::credential::CredentialStore;
use super::errors;
use super::openai_compatible;
use super::provider::{AiProviderChatRequest, AiProviderMessage, AiProviderResponse};
use super::redaction::redact_text;
use super::stream_manager;
use crate::ai_agent::planner::AgentPlanner;
use crate::commands::contracts::{
    AiAgentApprovePlanPayload, AiAgentApprovePlanRequest, AiAgentClassifyTaskPayload,
    AiAgentClassifyTaskRequest, AiAgentPlanPayload, AiAgentPlanRequest, AiChatRequest,
    AiCodeActionPayload, AiCodeActionRequest, AiConfigPayload, AiContextReferencePayload,
    AiConversationTitlePayload, AiConversationTitleRequest, AiInlineCompletionRangePayload,
    AiInlineCompletionRequest, AiInlineCompletionResult, AiProviderProfileDetailPayload,
    AiProviderProfilePayload, AiProviderProfileSwitchRequest,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_AI_MESSAGES: usize = 32;
const MAX_MESSAGE_CHARS: usize = 16_000;
const MAX_CONTEXT_REFERENCES: usize = 8;
const MAX_CONTEXT_BLOCK_CHARS: usize = 12_000;
const MAX_REFERENCE_PREVIEW_CHARS: usize = 4_000;
const MAX_TITLE_SOURCE_CHARS: usize = 1_200;
const MIN_GENERATED_TITLE_CHARS: usize = 5;
const MAX_GENERATED_TITLE_CHARS: usize = 10;

const DEFAULT_LITELLM_BASE_URL: &str = "http://127.0.0.1:4000/v1";
const DEFAULT_LITELLM_MODEL: &str = "openai/gpt-5.5";

static CONFIG: OnceLock<Mutex<AiRuntimeConfig>> = OnceLock::new();
static STREAM_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
struct AiUpstreamEndpoint {
    provider_name: &'static str,
    base_url: &'static str,
    model: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AiRuntimeConfig {
    provider_type: String,
    selected_model: Option<String>,
    base_url: Option<String>,
    #[serde(default)]
    active_profile_id: Option<String>,
    #[serde(default)]
    profiles: Vec<AiProviderProfile>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProviderProfile {
    id: String,
    name: String,
    provider_type: String,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    last_used_at: Option<String>,
}

impl Default for AiRuntimeConfig {
    fn default() -> Self {
        Self {
            provider_type: "litellm".to_string(),
            selected_model: Some(DEFAULT_LITELLM_MODEL.to_string()),
            base_url: Some(DEFAULT_LITELLM_BASE_URL.to_string()),
            active_profile_id: None,
            profiles: Vec::new(),
            inline_completion_enabled: false,
            chat_enabled: true,
            agent_enabled: false,
        }
    }
}

struct AiProviderConnectionCandidate {
    provider_type: String,
    selected_model: Option<String>,
    base_url: Option<String>,
    api_key_for_test: Option<String>,
    api_key_for_save: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
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

pub fn get_config() -> AiConfigPayload {
    let config = config_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();

    to_payload(config)
}

pub fn save_config(
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
) -> Result<AiConfigPayload, String> {
    validate_provider(provider_type)?;

    let normalized_base_url = normalize_base_url(provider_type, base_url)?;
    let model = selected_model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_model(provider_type));

    let mut guard = config_state()
        .lock()
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))?;

    guard.provider_type = provider_type.to_string();
    guard.selected_model = model;
    guard.base_url = normalized_base_url;
    guard.active_profile_id = None;
    guard.inline_completion_enabled = inline_completion_enabled;
    guard.chat_enabled = chat_enabled;
    guard.agent_enabled = agent_enabled;

    let payload = to_payload(guard.clone());

    persist_config(&guard)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);

    Ok(payload)
}

pub fn save_credentials(provider_type: &str, api_key: &str) -> Result<AiConfigPayload, String> {
    validate_provider(provider_type)?;

    let trimmed = api_key.trim();

    if trimmed.is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    let active_profile_id = current_config()
        .map(|config| {
            (config.provider_type == provider_type)
                .then_some(config.active_profile_id)
                .flatten()
        })?;

    CredentialStore::save(provider_type, trimmed)?;

    if let Some(profile_id) = active_profile_id {
        CredentialStore::save_profile_secret(&profile_id, trimmed)?;
    }

    audit::emit(AiAuditEventKind::ConfigUpdated);

    Ok(get_config())
}

pub fn clear_credentials() -> Result<(), String> {
    let profile_ids = current_config()
        .map(|config| {
            config
                .profiles
                .into_iter()
                .map(|profile| profile.id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    CredentialStore::clear()?;

    for profile_id in profile_ids {
        CredentialStore::delete_profile_secret(&profile_id)?;
    }

    Ok(())
}

pub fn list_provider_profiles() -> Result<Vec<AiProviderProfilePayload>, String> {
    let config = current_config()?;

    Ok(config
        .profiles
        .into_iter()
        .map(profile_to_payload)
        .collect())
}

pub fn get_provider_profile_detail(
    payload: AiProviderProfileSwitchRequest,
) -> Result<AiProviderProfileDetailPayload, String> {
    let config = current_config()?;
    let profile = config
        .profiles
        .into_iter()
        .find(|item| item.id == payload.profile_id)
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "未找到该 AI 配置记录。"))?;
    let api_key = CredentialStore::get_profile_secret(&profile.id).ok();

    Ok(AiProviderProfileDetailPayload {
        profile: profile_to_payload(profile),
        api_key,
    })
}

pub fn switch_provider_profile(
    payload: AiProviderProfileSwitchRequest,
) -> Result<AiConfigPayload, String> {
    let mut guard = config_state()
        .lock()
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))?;
    let now = chrono::Utc::now().to_rfc3339();
    let profile_index = guard
        .profiles
        .iter()
        .position(|profile| profile.id == payload.profile_id)
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "未找到该 AI 配置记录。"))?;
    let profile = guard.profiles[profile_index].clone();

    if !CredentialStore::has_profile_secret(&profile.id) {
        return Err(errors::error(
            "AI_PROVIDER_AUTH_FAILED",
            "该配置记录缺少 API Key，请重新连接后保存。",
        ));
    }

    guard.provider_type = profile.provider_type.clone();
    guard.selected_model = profile.selected_model.clone();
    guard.base_url = profile.base_url.clone();
    guard.inline_completion_enabled = profile.inline_completion_enabled;
    guard.chat_enabled = profile.chat_enabled;
    guard.agent_enabled = profile.agent_enabled;
    guard.active_profile_id = Some(profile.id.clone());
    guard.profiles[profile_index].last_used_at = Some(now.clone());
    guard.profiles[profile_index].updated_at = now;

    let payload = to_payload(guard.clone());
    persist_config(&guard)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);

    Ok(payload)
}

fn build_provider_connection_candidate(
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<AiProviderConnectionCandidate, String> {
    validate_provider(provider_type)?;

    let normalized_base_url = normalize_base_url(provider_type, base_url)?;
    let model = selected_model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_model(provider_type));

    let provided_api_key = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let api_key_for_test = match provided_api_key.clone() {
        Some(value) => value,
        None => get_saved_api_key_for_candidate(
            provider_type,
            model.as_deref(),
            normalized_base_url.as_deref(),
        )?,
    };

    if api_key_for_test.trim().is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    Ok(AiProviderConnectionCandidate {
        provider_type: provider_type.to_string(),
        selected_model: model,
        base_url: normalized_base_url,
        api_key_for_test: Some(api_key_for_test),
        api_key_for_save: provided_api_key,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_conversation_title_prompt, build_identity_system_prompt, default_base_url,
        default_model, normalize_conversation_title, resolve_direct_upstream_endpoint,
        should_try_direct_upstream_fallback, validate_provider, with_identity_system_message,
        DEFAULT_LITELLM_BASE_URL, MAX_GENERATED_TITLE_CHARS,
    };
    use crate::ai::provider::AiProviderMessage;

    #[test]
    fn litellm_provider_uses_local_proxy_defaults() {
        assert!(validate_provider("litellm").is_ok());
        assert_eq!(default_model("litellm").as_deref(), Some("openai/gpt-5.5"));
        assert_eq!(
            default_base_url("litellm").as_deref(),
            Some("http://127.0.0.1:4000/v1")
        );
        assert!(validate_provider("openai").is_err());
    }

    #[test]
    fn deepseek_model_routes_to_direct_upstream_when_default_litellm_is_unavailable() {
        let endpoint =
            resolve_direct_upstream_endpoint(DEFAULT_LITELLM_BASE_URL, "deepseek/deepseek-v4-pro")
                .expect("deepseek route should resolve");

        assert_eq!(endpoint.provider_name, "DeepSeek");
        assert_eq!(endpoint.base_url, "https://api.deepseek.com");
        assert_eq!(endpoint.model, "deepseek-v4-pro");
    }

    #[test]
    fn direct_upstream_fallback_only_handles_default_proxy_transport_errors() {
        assert!(should_try_direct_upstream_fallback(
            DEFAULT_LITELLM_BASE_URL,
            "deepseek/deepseek-v4-pro",
            "error sending request for url (http://127.0.0.1:4000/v1/chat/completions)",
        ));
        assert!(!should_try_direct_upstream_fallback(
            "https://api.deepseek.com",
            "deepseek/deepseek-v4-pro",
            "error sending request for url (https://api.deepseek.com/chat/completions)",
        ));
        assert!(!should_try_direct_upstream_fallback(
            DEFAULT_LITELLM_BASE_URL,
            "anthropic/claude-sonnet-4-6",
            "error sending request for url (http://127.0.0.1:4000/v1/chat/completions)",
        ));
    }

    #[test]
    fn deepseek_identity_prompt_is_model_aware_and_concise() {
        let prompt = build_identity_system_prompt("deepseek/deepseek-v4-pro");

        assert!(prompt.contains("DeepSeek"));
        assert!(prompt.contains("当前模型：deepseek/deepseek-v4-pro"));
        assert!(prompt.contains("不冒充其他模型或厂商"));
        assert!(prompt.contains("deepseek/deepseek-v4-pro"));
        assert!(!prompt.contains("不要自称"));
    }

    #[test]
    fn anthropic_identity_prompt_keeps_claude_as_current_model() {
        let prompt = build_identity_system_prompt("anthropic/claude-sonnet-4-6");

        assert!(prompt.contains("Anthropic"));
        assert!(prompt.contains("当前模型：anthropic/claude-sonnet-4-6"));
        assert!(!prompt.contains("当前模型不是"));
    }

    #[test]
    fn identity_message_is_prepended_before_user_messages() {
        let messages = with_identity_system_message(
            vec![AiProviderMessage::user("你是谁")],
            "deepseek/deepseek-v4-pro",
        );

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert!(messages[0].content.contains("身份："));
        assert_eq!(messages[1].role, "user");
    }

    #[test]
    fn conversation_title_prompt_uses_only_first_round() {
        let prompt = build_conversation_title_prompt("第一轮用户问题", "第一轮 AI 回答");

        assert!(prompt.contains("第一轮用户问题"));
        assert!(prompt.contains("第一轮 AI 回答"));
        assert!(prompt.contains("只依据下面第一轮问答"));
        assert!(!prompt.contains("第二轮"));
    }

    #[test]
    fn conversation_title_normalization_limits_length_and_removes_wrappers() {
        let title = normalize_conversation_title("标题：《修复弹窗滚动与标题生成》");

        assert!(title.chars().count() <= MAX_GENERATED_TITLE_CHARS);
        assert_eq!(title, "修复弹窗滚动与标题生");
    }
}

async fn test_with_litellm_fallback(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<(), String> {
    match openai_compatible::test(base_url, api_key, model).await {
        Ok(()) => Ok(()),
        Err(primary_error)
            if should_try_direct_upstream_fallback(base_url, model, &primary_error) =>
        {
            let Some(endpoint) = resolve_direct_upstream_endpoint(base_url, model) else {
                return Err(primary_error);
            };

            openai_compatible::test(endpoint.base_url, api_key, &endpoint.model)
                .await
                .map_err(|fallback_error| {
                    direct_upstream_fallback_error(&primary_error, &endpoint, &fallback_error)
                })
        }
        Err(error) => Err(error),
    }
}

async fn chat_with_litellm_fallback(
    base_url: &str,
    api_key: &str,
    model: &str,
    request: AiProviderChatRequest,
) -> Result<AiProviderResponse, String> {
    match openai_compatible::chat(base_url, api_key, model, request.clone()).await {
        Ok(response) => Ok(response),
        Err(primary_error)
            if should_try_direct_upstream_fallback(base_url, model, &primary_error) =>
        {
            let Some(endpoint) = resolve_direct_upstream_endpoint(base_url, model) else {
                return Err(primary_error);
            };

            let mut response =
                openai_compatible::chat(endpoint.base_url, api_key, &endpoint.model, request)
                    .await
                    .map_err(|fallback_error| {
                        direct_upstream_fallback_error(&primary_error, &endpoint, &fallback_error)
                    })?;
            response.model = model.to_string();

            Ok(response)
        }
        Err(error) => Err(error),
    }
}

async fn chat_stream_with_litellm_fallback<F, C>(
    base_url: &str,
    api_key: &str,
    model: &str,
    request: AiProviderChatRequest,
    mut on_delta: F,
    is_cancelled: C,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
    C: Fn() -> bool,
{
    match openai_compatible::chat_stream(
        base_url,
        api_key,
        model,
        request.clone(),
        |delta| on_delta(delta),
        || is_cancelled(),
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(primary_error)
            if should_try_direct_upstream_fallback(base_url, model, &primary_error) =>
        {
            let Some(endpoint) = resolve_direct_upstream_endpoint(base_url, model) else {
                return Err(primary_error);
            };

            openai_compatible::chat_stream(
                endpoint.base_url,
                api_key,
                &endpoint.model,
                request,
                |delta| on_delta(delta),
                || is_cancelled(),
            )
            .await
            .map_err(|fallback_error| {
                direct_upstream_fallback_error(&primary_error, &endpoint, &fallback_error)
            })
        }
        Err(error) => Err(error),
    }
}

fn should_try_direct_upstream_fallback(base_url: &str, model: &str, error: &str) -> bool {
    is_default_litellm_proxy_url(base_url)
        && resolve_direct_upstream_endpoint(base_url, model).is_some()
        && is_transport_connect_error(error)
}

fn is_transport_connect_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();

    normalized.contains("error sending request")
        || normalized.contains("connection refused")
        || normalized.contains("tcp connect error")
        || normalized.contains("operation timed out")
        || normalized.contains("deadline has elapsed")
}

fn resolve_direct_upstream_endpoint(base_url: &str, model: &str) -> Option<AiUpstreamEndpoint> {
    if !is_default_litellm_proxy_url(base_url) {
        return None;
    }

    let (provider, upstream_model) = model.trim().split_once('/')?;
    let upstream_model = upstream_model.trim();
    if upstream_model.is_empty() {
        return None;
    }

    let (provider_name, base_url) = match provider.trim() {
        "openai" => ("OpenAI", "https://api.openai.com/v1"),
        "deepseek" => ("DeepSeek", "https://api.deepseek.com"),
        "moonshot" => ("Moonshot Kimi", "https://api.moonshot.cn/v1"),
        "dashscope" => (
            "阿里云百炼",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        ),
        "gemini" => (
            "Google Gemini",
            "https://generativelanguage.googleapis.com/v1beta/openai",
        ),
        "ollama" => ("Ollama", "http://127.0.0.1:11434/v1"),
        _ => return None,
    };

    Some(AiUpstreamEndpoint {
        provider_name,
        base_url,
        model: upstream_model.to_string(),
    })
}

fn is_default_litellm_proxy_url(base_url: &str) -> bool {
    let normalized = base_url.trim().trim_end_matches('/');

    matches!(
        normalized,
        DEFAULT_LITELLM_BASE_URL | "http://localhost:4000/v1" | "http://[::1]:4000/v1"
    )
}

fn direct_upstream_fallback_error(
    primary_error: &str,
    endpoint: &AiUpstreamEndpoint,
    fallback_error: &str,
) -> String {
    errors::error(
        "AI_PROVIDER_UNAVAILABLE",
        format!(
            "本地 LiteLLM Proxy 不可用，已自动尝试直连 {}，但直连也失败。LiteLLM 错误：{}；直连错误：{}",
            endpoint.provider_name, primary_error, fallback_error
        ),
    )
}

async fn test_provider_connection_candidate(
    candidate: &AiProviderConnectionCandidate,
) -> Result<(), String> {
    let base_url = candidate.base_url.as_deref().ok_or_else(|| {
        errors::error("AI_PROVIDER_NOT_CONFIGURED", "请先配置 Provider API 地址。")
    })?;

    let api_key = candidate
        .api_key_for_test
        .as_deref()
        .ok_or_else(|| errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"))?;

    let model = candidate
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_LITELLM_MODEL);

    test_with_litellm_fallback(base_url, api_key, model).await
}

pub async fn test_provider() -> Result<(), String> {
    let config = current_config()?;

    let base_url = resolve_base_url(&config)?;
    let api_key = get_api_key_for_config(&config)?;
    let model = config
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_LITELLM_MODEL);

    test_with_litellm_fallback(base_url, &api_key, model).await
}

pub async fn test_provider_config(
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<(), String> {
    let candidate = build_provider_connection_candidate(
        provider_type,
        selected_model,
        base_url,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
        api_key,
    )?;

    test_provider_connection_candidate(&candidate).await
}

pub async fn connect_provider(
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<AiConfigPayload, String> {
    let candidate = build_provider_connection_candidate(
        provider_type,
        selected_model,
        base_url,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
        api_key,
    )?;

    test_provider_connection_candidate(&candidate).await?;

    if let Some(api_key_to_save) = candidate.api_key_for_save.as_deref() {
        CredentialStore::save(&candidate.provider_type, api_key_to_save)?;
    }

    save_connected_profile(
        candidate.provider_type,
        candidate.selected_model,
        candidate.base_url,
        candidate.inline_completion_enabled,
        candidate.chat_enabled,
        candidate.agent_enabled,
        candidate.api_key_for_test.as_deref(),
    )
}

fn save_connected_profile(
    provider_type: String,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<AiConfigPayload, String> {
    validate_provider(&provider_type)?;

    let mut guard = config_state()
        .lock()
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))?;
    let now = chrono::Utc::now().to_rfc3339();
    let profile_index = find_matching_profile_index(
        &guard.profiles,
        &provider_type,
        selected_model.as_deref(),
        base_url.as_deref(),
    );
    let profile_id = profile_index
        .and_then(|index| guard.profiles.get(index).map(|profile| profile.id.clone()))
        .unwrap_or_else(generate_profile_id);
    let profile_name = build_profile_name(selected_model.as_deref(), base_url.as_deref());

    if let Some(api_key_to_save) = api_key {
        CredentialStore::save_profile_secret(&profile_id, api_key_to_save)?;
    }

    match profile_index {
        Some(index) => {
            let profile = &mut guard.profiles[index];
            profile.name = profile_name;
            profile.provider_type = provider_type.clone();
            profile.selected_model = selected_model.clone();
            profile.base_url = base_url.clone();
            profile.inline_completion_enabled = inline_completion_enabled;
            profile.chat_enabled = chat_enabled;
            profile.agent_enabled = agent_enabled;
            profile.updated_at = now.clone();
            profile.last_used_at = Some(now.clone());
        }
        None => guard.profiles.push(AiProviderProfile {
            id: profile_id.clone(),
            name: profile_name,
            provider_type: provider_type.clone(),
            selected_model: selected_model.clone(),
            base_url: base_url.clone(),
            inline_completion_enabled,
            chat_enabled,
            agent_enabled,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_used_at: Some(now.clone()),
        }),
    }

    guard.provider_type = provider_type;
    guard.selected_model = selected_model;
    guard.base_url = base_url;
    guard.inline_completion_enabled = inline_completion_enabled;
    guard.chat_enabled = chat_enabled;
    guard.agent_enabled = agent_enabled;
    guard.active_profile_id = Some(profile_id);

    let payload = to_payload(guard.clone());
    persist_config(&guard)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);

    Ok(payload)
}

pub async fn chat(payload: AiChatRequest) -> Result<AiProviderResponse, String> {
    audit::emit(AiAuditEventKind::ChatStarted);

    let result = async {
        let config = current_config()?;

        ensure_chat_enabled(&config)?;

        let model = config
            .selected_model
            .as_deref()
            .unwrap_or(DEFAULT_LITELLM_MODEL);
        let _thread_id = payload.thread_id.as_deref();
        let messages = with_identity_system_message(
            collect_messages(payload.messages, payload.references)?,
            model,
        );
        let request = AiProviderChatRequest::new(messages);

        let base_url = resolve_base_url(&config)?;
        let api_key = get_api_key_for_config(&config)?;

        chat_with_litellm_fallback(base_url, &api_key, model, request).await
    }
    .await;

    match result {
        Ok(response) => {
            audit::emit(AiAuditEventKind::ChatCompleted);
            Ok(response)
        }
        Err(error) => {
            audit::emit(AiAuditEventKind::ChatFailed);
            Err(error)
        }
    }
}

pub async fn generate_conversation_title(
    payload: AiConversationTitleRequest,
) -> Result<AiConversationTitlePayload, String> {
    let config = current_config()?;
    ensure_chat_enabled(&config)?;

    let user_message = clip_title_source(&payload.user_message);
    let assistant_message = clip_title_source(&payload.assistant_message);

    if user_message.trim().is_empty() || assistant_message.trim().is_empty() {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "第一轮问答内容为空，无法生成会话标题。",
        ));
    }

    let model = config
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_LITELLM_MODEL);
    let request = AiProviderChatRequest::new(vec![
        AiProviderMessage::system(
            "你是会话标题生成器。只输出 5 到 10 个中文字符的标题，不要解释。",
        ),
        AiProviderMessage::user(build_conversation_title_prompt(
            &user_message,
            &assistant_message,
        )),
    ]);
    let base_url = resolve_base_url(&config)?;
    let api_key = get_api_key_for_config(&config)?;
    let response = chat_with_litellm_fallback(base_url, &api_key, model, request).await?;
    let title = normalize_conversation_title(&response.content);

    if title.chars().count() < MIN_GENERATED_TITLE_CHARS {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "AI 生成的会话标题不符合 5 到 10 个字要求。",
        ));
    }

    Ok(AiConversationTitlePayload {
        title,
        model: response.model,
    })
}

pub async fn chat_stream(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamStart, String> {
    audit::emit(AiAuditEventKind::ChatStarted);

    let config = current_config()?;
    ensure_chat_enabled(&config)?;

    let stream_id = next_runtime_id("ai-stream");
    let assistant_message_id = next_runtime_id("assistant");
    let response_provider_type = config.provider_type.clone();
    let task_config = config.clone();

    let model = config
        .selected_model
        .clone()
        .or_else(|| default_model(&config.provider_type))
        .unwrap_or_else(|| DEFAULT_LITELLM_MODEL.to_string());
    let messages = with_identity_system_message(
        collect_messages(payload.messages, payload.references)?,
        &model,
    );
    let request = AiProviderChatRequest::new(messages);

    stream_manager::register(&stream_id);

    let task_stream_id = stream_id.clone();
    let task_assistant_message_id = assistant_message_id.clone();
    let task_model = model.clone();

    tokio::spawn(async move {
        emit_stream_event(
            &app,
            AiChatStreamEventPayload {
                stream_id: task_stream_id.clone(),
                assistant_message_id: task_assistant_message_id.clone(),
                kind: "start".to_string(),
                delta: None,
                message: None,
                model: Some(task_model.clone()),
            },
        );

        let result = async {
            let base_url = resolve_base_url(&task_config)?.to_string();
            let api_key = get_api_key_for_config(&task_config)?;

            chat_stream_with_litellm_fallback(
                &base_url,
                &api_key,
                &task_model,
                request,
                |delta| {
                    emit_stream_event(
                        &app,
                        AiChatStreamEventPayload {
                            stream_id: task_stream_id.clone(),
                            assistant_message_id: task_assistant_message_id.clone(),
                            kind: "delta".to_string(),
                            delta: Some(delta),
                            message: None,
                            model: Some(task_model.clone()),
                        },
                    );

                    Ok(())
                },
                || stream_manager::is_cancelled(&task_stream_id),
            )
            .await
        }
        .await;

        match result {
            Ok(()) => {
                if stream_manager::is_cancelled(&task_stream_id) {
                    emit_stream_event(
                        &app,
                        AiChatStreamEventPayload {
                            stream_id: task_stream_id.clone(),
                            assistant_message_id: task_assistant_message_id.clone(),
                            kind: "cancelled".to_string(),
                            delta: None,
                            message: Some("AI 请求已取消。".to_string()),
                            model: Some(task_model.clone()),
                        },
                    );
                } else {
                    audit::emit(AiAuditEventKind::ChatCompleted);

                    emit_stream_event(
                        &app,
                        AiChatStreamEventPayload {
                            stream_id: task_stream_id.clone(),
                            assistant_message_id: task_assistant_message_id.clone(),
                            kind: "done".to_string(),
                            delta: None,
                            message: None,
                            model: Some(task_model.clone()),
                        },
                    );
                }
            }
            Err(error) => {
                audit::emit(AiAuditEventKind::ChatFailed);

                let kind = if error.contains("AI_REQUEST_CANCELLED") {
                    "cancelled"
                } else {
                    "error"
                };

                emit_stream_event(
                    &app,
                    AiChatStreamEventPayload {
                        stream_id: task_stream_id.clone(),
                        assistant_message_id: task_assistant_message_id.clone(),
                        kind: kind.to_string(),
                        delta: None,
                        message: Some(error),
                        model: Some(task_model.clone()),
                    },
                );
            }
        }

        stream_manager::finish(&task_stream_id);
    });

    Ok(AiChatStreamStart {
        stream_id,
        assistant_message_id,
        provider_type: response_provider_type,
        model,
    })
}

fn emit_stream_event(app: &AppHandle, payload: AiChatStreamEventPayload) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("ai:chat-stream", payload);
    }
}

pub async fn inline_complete(
    payload: AiInlineCompletionRequest,
) -> Result<AiInlineCompletionResult, String> {
    let config = current_config()?;

    if !config.inline_completion_enabled {
        return Ok(disabled_inline_complete(payload));
    }

    let prompt = build_inline_prompt(&payload);
    let request = AiProviderChatRequest::new(vec![AiProviderMessage {
        role: "user".to_string(),
        content: prompt,
    }]);

    let base_url = resolve_base_url(&config)?;
    let api_key = get_api_key_for_config(&config)?;
    let model = config
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_LITELLM_MODEL);

    let response = chat_with_litellm_fallback(base_url, &api_key, model, request).await?;

    Ok(AiInlineCompletionResult {
        insert_text: response.content,
        range: AiInlineCompletionRangePayload {
            start_offset: payload.cursor_offset,
            end_offset: payload.cursor_offset,
        },
        confidence: "medium".to_string(),
    })
}

pub async fn code_action(payload: AiCodeActionRequest) -> Result<AiCodeActionPayload, String> {
    let config = current_config()?;
    let trimmed_selection = payload.selection.trim();

    if trimmed_selection.is_empty() {
        return Ok(AiCodeActionPayload {
            explanation: "当前没有选区，请先选择需要处理的代码。".to_string(),
            suggested_patch: None,
            test_suggestion: None,
            follow_up_questions: vec!["请选择代码后重新执行 AI Action。".to_string()],
        });
    }

    let prompt = build_code_action_prompt(&payload);
    let redacted_prompt = redact_text(&prompt);

    if redacted_prompt.blocked {
        audit::emit(AiAuditEventKind::SecretDetected);
    }

    let request = AiProviderChatRequest::new(vec![AiProviderMessage {
        role: "user".to_string(),
        content: redacted_prompt.text,
    }]);

    let base_url = resolve_base_url(&config)?;
    let api_key = get_api_key_for_config(&config)?;
    let model = config
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_LITELLM_MODEL);

    let response = chat_with_litellm_fallback(base_url, &api_key, model, request).await?;

    Ok(AiCodeActionPayload {
        explanation: response.content,
        suggested_patch: None,
        test_suggestion: if payload.kind == "generate_tests" {
            Some("建议基于返回内容在测试目录新增用例；应用前请先走 patch 预览。".to_string())
        } else {
            None
        },
        follow_up_questions: Vec::new(),
    })
}

pub async fn plan_task(payload: AiAgentPlanRequest) -> Result<AiAgentPlanPayload, String> {
    AgentPlanner::create_plan(payload)
}

pub async fn classify_task(
    payload: AiAgentClassifyTaskRequest,
) -> Result<AiAgentClassifyTaskPayload, String> {
    AgentPlanner::classify_task(payload)
}

pub async fn approve_plan(
    payload: AiAgentApprovePlanRequest,
) -> Result<AiAgentApprovePlanPayload, String> {
    AgentPlanner::approve_plan(payload)
}

pub(crate) fn collect_messages(
    messages: Vec<crate::commands::contracts::AiChatMessagePayload>,
    references: Vec<AiContextReferencePayload>,
) -> Result<Vec<AiProviderMessage>, String> {
    if messages.is_empty() {
        audit::emit(AiAuditEventKind::ChatFailed);

        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "请输入要发送给 AI 的内容。",
        ));
    }

    if messages.len() > MAX_AI_MESSAGES {
        audit::emit(AiAuditEventKind::ChatFailed);

        return Err(errors::error(
            "AI_CONTEXT_TOO_LARGE",
            "对话轮次过多，请清空部分历史后重试。",
        ));
    }

    let context_block = build_context_block(&references);
    let last_user_index = messages.iter().rposition(|message| message.role == "user");

    let mut result = Vec::new();

    for (index, message) in messages.into_iter().enumerate() {
        if message.role != "user" && message.role != "assistant" && message.role != "system" {
            continue;
        }

        let mut combined_content = message.content;

        if Some(index) == last_user_index && !context_block.trim().is_empty() {
            combined_content = format!(
                "{combined_content}\n\n---\n以下是 IDE 收集的结构化上下文。上下文仅用于回答当前问题，不代表用户要求你直接修改文件；如需修改必须输出建议或 patch 预览。\n{context_block}"
            );
        }

        let raw_content: String = combined_content.chars().take(MAX_MESSAGE_CHARS).collect();
        let redacted = redact_text(&raw_content);

        if redacted.blocked {
            audit::emit(AiAuditEventKind::SecretDetected);
        }

        if redacted.text.trim().is_empty() {
            continue;
        }

        result.push(AiProviderMessage {
            role: message.role,
            content: redacted.text,
        });
    }

    if result.is_empty() {
        audit::emit(AiAuditEventKind::ChatFailed);

        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "请输入要发送给 AI 的内容。",
        ));
    }

    Ok(result)
}

fn with_identity_system_message(
    mut messages: Vec<AiProviderMessage>,
    model: &str,
) -> Vec<AiProviderMessage> {
    let mut result = Vec::with_capacity(messages.len() + 1);
    result.push(build_identity_system_message(model));
    result.append(&mut messages);
    result
}

fn build_identity_system_message(model: &str) -> AiProviderMessage {
    AiProviderMessage::system(build_identity_system_prompt(model))
}

fn build_identity_system_prompt(model: &str) -> String {
    let trimmed_model = match model.trim() {
        "" => "未指定",
        value => value,
    };
    let provider_label = infer_model_provider_label(trimmed_model);

    format!(
        "身份：你是小建C桌面应用中的 AI 编程助手。当前模型：{trimmed_model}，平台：{provider_label}。用户询问身份时按当前真实模型回答，不冒充其他模型或厂商。"
    )
}

fn infer_model_provider_label(model: &str) -> &'static str {
    let normalized = model.trim().to_ascii_lowercase();

    if normalized.starts_with("deepseek/") || normalized.contains("deepseek") {
        return "DeepSeek";
    }

    if is_anthropic_model(model) {
        return "Anthropic";
    }

    if normalized.starts_with("openai/") || normalized.starts_with("gpt-") {
        return "OpenAI";
    }

    if normalized.starts_with("google/") || normalized.contains("gemini") {
        return "Google";
    }

    if normalized.starts_with("qwen/") || normalized.contains("qwen") {
        return "通义千问";
    }

    "当前配置的 AI 服务平台"
}

fn is_anthropic_model(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();

    normalized.starts_with("anthropic/") || normalized.contains("claude")
}

fn build_context_block(references: &[AiContextReferencePayload]) -> String {
    if references.is_empty() {
        return String::new();
    }

    let mut block = String::new();

    for reference in references.iter().take(MAX_CONTEXT_REFERENCES) {
        let range = reference
            .range
            .as_ref()
            .map(|item| format!("{}-{}", item.start_line, item.end_line))
            .unwrap_or_else(|| "全文摘要".to_string());

        let path = reference.path.as_deref().unwrap_or("未保存");

        let preview: String = reference
            .content_preview
            .chars()
            .take(MAX_REFERENCE_PREVIEW_CHARS)
            .collect();

        let preview = sanitize_fenced_text(&preview);

        let redacted_label = if reference.redacted {
            "，已脱敏"
        } else {
            ""
        };

        block.push_str(&format!(
            "\n[{}] {} ({path}, {range}{redacted_label})\n```text\n{preview}\n```\n",
            reference.kind, reference.label
        ));

        if block.chars().count() >= MAX_CONTEXT_BLOCK_CHARS {
            let clipped: String = block.chars().take(MAX_CONTEXT_BLOCK_CHARS).collect();
            block = format!("{clipped}\n[上下文已按预算截断]\n");
            break;
        }
    }

    block
}

fn disabled_inline_complete(payload: AiInlineCompletionRequest) -> AiInlineCompletionResult {
    let _recent_edits_count = payload
        .recent_edits
        .as_ref()
        .map(Vec::len)
        .unwrap_or_default();

    AiInlineCompletionResult {
        insert_text: String::new(),
        range: AiInlineCompletionRangePayload {
            start_offset: payload.cursor_offset,
            end_offset: payload.cursor_offset,
        },
        confidence: "low".to_string(),
    }
}

fn build_inline_prompt(payload: &AiInlineCompletionRequest) -> String {
    format!(
        "只返回需要插入到光标处的代码，不要解释。\n语言：{}\n文件：{}\n前文：\n{}\n后文：\n{}",
        payload.language,
        payload.file_path,
        sanitize_fenced_text(&payload.prefix),
        sanitize_fenced_text(&payload.suffix)
    )
}

fn build_code_action_prompt(payload: &AiCodeActionRequest) -> String {
    let file_path = payload.file_path.as_deref().unwrap_or("未保存文件");

    let diagnostics = if payload.diagnostics.is_empty() {
        "无".to_string()
    } else {
        payload.diagnostics.join("\n")
    };

    format!(
        "你是 IDE AI。请执行代码动作：{}。\n规则：不要直接声称已修改文件；如需修改，只描述建议并等待 patch 预览确认。\n文件：{}\n语言：{}\n诊断：\n{}\n选区：\n```{}\n{}\n```",
        payload.kind,
        file_path,
        payload.language,
        sanitize_fenced_text(&diagnostics),
        payload.language,
        sanitize_fenced_text(&payload.selection)
    )
}

fn clip_title_source(value: &str) -> String {
    value.trim().chars().take(MAX_TITLE_SOURCE_CHARS).collect()
}

fn build_conversation_title_prompt(user_message: &str, assistant_message: &str) -> String {
    format!(
        "请只依据下面第一轮问答生成中文会话标题。\n规则：\n- 只输出标题本身，不要解释、引号或标点\n- 标题必须为 5 到 10 个中文字符\n- 不要使用后续对话，因为后续对话未提供\n\n用户第一句：\n```text\n{}\n```\n\nAI 第一句：\n```text\n{}\n```",
        sanitize_fenced_text(user_message),
        sanitize_fenced_text(assistant_message)
    )
}

fn normalize_conversation_title(value: &str) -> String {
    let first_line = value
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut title = first_line
        .trim_start_matches(|item: char| item == '-' || item == '*' || item == '#')
        .trim()
        .to_string();

    for prefix in [
        "会话标题：",
        "会话标题:",
        "正式标题：",
        "正式标题:",
        "标题：",
        "标题:",
    ] {
        if title.starts_with(prefix) {
            title = title[prefix.len()..].trim().to_string();
            break;
        }
    }

    let trimmed = title.trim_matches(|item: char| {
        item.is_whitespace()
            || matches!(
                item,
                '"' | '\''
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '《'
                    | '》'
                    | '【'
                    | '】'
                    | '「'
                    | '」'
                    | '『'
                    | '』'
                    | '。'
                    | '，'
                    | ','
                    | '.'
                    | ':'
                    | '：'
                    | '-'
                    | '—'
            )
    });

    trimmed.chars().take(MAX_GENERATED_TITLE_CHARS).collect()
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
    let has_credentials = has_credentials_for_config(&config);

    let is_base_url_configured = config
        .base_url
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    AiConfigPayload {
        provider_type: config.provider_type.clone(),
        selected_model: config.selected_model,
        base_url: config.base_url,
        active_profile_id: config.active_profile_id,
        is_base_url_configured,
        has_credentials,
        is_configured: has_credentials && is_base_url_configured,
        inline_completion_enabled: config.inline_completion_enabled,
        chat_enabled: config.chat_enabled,
        agent_enabled: config.agent_enabled,
    }
}

fn has_credentials_for_config(config: &AiRuntimeConfig) -> bool {
    if let Some(profile_id) = config.active_profile_id.as_deref() {
        return CredentialStore::has_profile_secret(profile_id);
    }

    CredentialStore::has_provider_secret(&config.provider_type)
}

fn get_api_key_for_config(config: &AiRuntimeConfig) -> Result<String, String> {
    if let Some(profile_id) = config.active_profile_id.as_deref() {
        return CredentialStore::get_profile_secret(profile_id);
    }

    CredentialStore::get(&config.provider_type)
}

fn get_saved_api_key_for_candidate(
    provider_type: &str,
    selected_model: Option<&str>,
    base_url: Option<&str>,
) -> Result<String, String> {
    let config = current_config()?;

    if let Some(index) =
        find_matching_profile_index(&config.profiles, provider_type, selected_model, base_url)
    {
        return CredentialStore::get_profile_secret(&config.profiles[index].id);
    }

    CredentialStore::get(provider_type)
}

fn profile_to_payload(profile: AiProviderProfile) -> AiProviderProfilePayload {
    let has_profile_credentials = CredentialStore::has_profile_secret(&profile.id);

    AiProviderProfilePayload {
        id: profile.id,
        name: profile.name,
        provider_type: profile.provider_type,
        selected_model: profile.selected_model,
        base_url: profile.base_url,
        inline_completion_enabled: profile.inline_completion_enabled,
        chat_enabled: profile.chat_enabled,
        agent_enabled: profile.agent_enabled,
        has_credentials: has_profile_credentials,
        created_at: profile.created_at,
        updated_at: profile.updated_at,
        last_used_at: profile.last_used_at,
    }
}

fn find_matching_profile_index(
    profiles: &[AiProviderProfile],
    provider_type: &str,
    selected_model: Option<&str>,
    base_url: Option<&str>,
) -> Option<usize> {
    profiles.iter().position(|profile| {
        profile.provider_type == provider_type
            && profile.selected_model.as_deref() == selected_model
            && profile.base_url.as_deref() == base_url
    })
}

fn generate_profile_id() -> String {
    format!(
        "ai-profile-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        STREAM_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn build_profile_name(selected_model: Option<&str>, base_url: Option<&str>) -> String {
    let model = selected_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("未选择模型");
    let base_url = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_LITELLM_BASE_URL);

    if base_url == DEFAULT_LITELLM_BASE_URL {
        return model.to_string();
    }

    format!("{model} · {base_url}")
}

fn validate_provider(provider_type: &str) -> Result<(), String> {
    match provider_type {
        "litellm" => Ok(()),
        _ => Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "当前版本只支持 LiteLLM Proxy Provider。",
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
        .or_else(|| default_base_url(provider_type))
        .unwrap_or_else(|| DEFAULT_LITELLM_BASE_URL.to_string());

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
        "litellm" => Some(DEFAULT_LITELLM_MODEL.to_string()),
        _ => None,
    }
}

fn default_base_url(provider_type: &str) -> Option<String> {
    match provider_type {
        "litellm" => Some(DEFAULT_LITELLM_BASE_URL.to_string()),
        _ => None,
    }
}

fn resolve_base_url(config: &AiRuntimeConfig) -> Result<&str, String> {
    config
        .base_url
        .as_deref()
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "请先配置 Provider API 地址。"))
}

fn next_runtime_id(prefix: &str) -> String {
    let sequence = STREAM_SEQUENCE.fetch_add(1, Ordering::Relaxed);

    format!(
        "{}-{}-{}",
        prefix,
        chrono::Utc::now().timestamp_millis(),
        sequence
    )
}

fn sanitize_fenced_text(value: &str) -> String {
    value.replace("```", "`\u{200b}``")
}

fn config_file_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))?;

    Some(base.join("Calamex").join("ai-config.json"))
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
    config.profiles = config
        .profiles
        .into_iter()
        .filter_map(normalize_provider_profile)
        .collect();

    if config
        .active_profile_id
        .as_deref()
        .is_some_and(|profile_id| {
            !config
                .profiles
                .iter()
                .any(|profile| profile.id == profile_id)
        })
    {
        config.active_profile_id = None;
    }

    config
}

fn normalize_provider_profile(mut profile: AiProviderProfile) -> Option<AiProviderProfile> {
    if profile.id.trim().is_empty() || validate_provider(&profile.provider_type).is_err() {
        return None;
    }

    profile.id = profile.id.trim().to_string();
    profile.name = profile.name.trim().to_string();
    profile.selected_model = profile
        .selected_model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    profile.base_url = profile
        .base_url
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_base_url(&profile.provider_type));

    if profile.name.is_empty() {
        profile.name = build_profile_name(
            profile.selected_model.as_deref(),
            profile.base_url.as_deref(),
        );
    }

    Some(profile)
}

fn persist_config(config: &AiRuntimeConfig) -> Result<(), String> {
    let Some(path) = config_file_path() else {
        return Ok(());
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                &format!("AI 配置目录创建失败：{error}"),
            )
        })?;
    }

    let content = serde_json::to_string_pretty(config).map_err(|error| {
        errors::error(
            "AI_RESPONSE_INVALID",
            &format!("AI 配置序列化失败：{error}"),
        )
    })?;

    fs::write(path, content).map_err(|error| {
        errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            &format!("AI 配置保存失败：{error}"),
        )
    })
}
