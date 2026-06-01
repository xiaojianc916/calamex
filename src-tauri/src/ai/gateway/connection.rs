use super::config::{
    build_provider_connection_candidate, save_connected_model, AiProviderConnectionCandidate,
};
use super::*;
use crate::agent_sidecar;
use crate::commands::contracts::{AgentSidecarChatRequest, AgentSidecarMessagePayload};

fn build_test_request(
    candidate: &AiProviderConnectionCandidate,
) -> Result<AgentSidecarChatRequest, String> {
    let model_id = candidate
        .selected_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "请先选择模型。"))?;
    let api_key = candidate.api_key_for_test.trim();
    if api_key.is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    Ok(AgentSidecarChatRequest {
        session_id: None,
        mode: Some("ask".to_string()),
        goal: Some("测试模型连接".to_string()),
        messages: vec![AgentSidecarMessagePayload {
            role: "user".to_string(),
            content: "请只回复：连接成功".to_string(),
        }],
        workspace_root_path: None,
        context: Vec::new(),
        model_config: Some(crate::commands::contracts::AgentSidecarModelConfigPayload {
            model_id: model_id.to_string(),
            api_key: api_key.to_string().into(),
            base_url: candidate
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string()),
        }),
        thread_id: None,
    })
}

async fn test_provider_connection_candidate(
    candidate: &AiProviderConnectionCandidate,
) -> Result<(), String> {
    let _ = agent_sidecar::model_chat_once(build_test_request(candidate)?).await?;
    Ok(())
}

pub async fn test_provider() -> Result<(), String> {
    let config = current_config()?;
    let selected_model = config
        .selected_model
        .clone()
        .or_else(|| default_model(&config.provider_type));
    let provider_id = validate_model_provider(selected_model.as_deref(), None)?;
    let candidate = AiProviderConnectionCandidate {
        provider_id,
        provider_type: config.provider_type.clone(),
        selected_model,
        base_url: config.base_url.clone(),
        api_key_for_test: get_api_key_for_config(&config)?,
        inline_completion_enabled: config.inline_completion_enabled,
        chat_enabled: config.chat_enabled,
        agent_enabled: config.agent_enabled,
    };

    test_provider_connection_candidate(&candidate).await
}

#[allow(clippy::too_many_arguments)]
pub async fn test_provider_config(
    _role: Option<&str>,
    provider_id: Option<&str>,
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<(), String> {
    let candidate = build_provider_connection_candidate(
        provider_id,
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

#[allow(clippy::too_many_arguments)]
pub async fn connect_provider(
    role: Option<&str>,
    provider_id: Option<&str>,
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<AiConfigPayload, String> {
    let role = normalize_model_role(role)?;
    let candidate = build_provider_connection_candidate(
        provider_id,
        provider_type,
        selected_model,
        base_url,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
        api_key,
    )?;

    test_provider_connection_candidate(&candidate).await?;

    save_connected_model(role, candidate)
}
