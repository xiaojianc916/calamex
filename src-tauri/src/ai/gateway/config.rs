use super::*;

pub(super) struct AiProviderConnectionCandidate {
    pub(super) provider_id: String,
    pub(super) provider_type: String,
    pub(super) selected_model: Option<String>,
    pub(super) base_url: Option<String>,
    pub(super) api_key_for_test: String,
    pub(super) inline_completion_enabled: bool,
    pub(super) chat_enabled: bool,
    pub(super) agent_enabled: bool,
}

pub fn get_config() -> AiConfigPayload {
    let config = config_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();

    to_payload(config)
}

pub fn save_config(
    role: Option<&str>,
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
) -> Result<AiConfigPayload, String> {
    let role = normalize_model_role(role)?;
    validate_provider(provider_type)?;

    let normalized_base_url = normalize_base_url(provider_type, base_url)?;
    let model = selected_model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_model(provider_type));

    if model.as_deref().is_some() {
        validate_model_provider(model.as_deref(), None)?;
    }

    let mut guard = config_state()
        .lock()
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))?;

    match role {
        AiResolvedModelRole::Main => {
            guard.provider_type = provider_type.to_string();
            guard.selected_model = model;
            guard.base_url = normalized_base_url;
            guard.inline_completion_enabled = inline_completion_enabled;
            guard.chat_enabled = chat_enabled;
            guard.agent_enabled = agent_enabled;
        }
        AiResolvedModelRole::Narrator => {
            guard.narrator.provider_type = provider_type.to_string();
            guard.narrator.selected_model = model;
            guard.narrator.base_url = normalized_base_url;
        }
    }

    let payload = to_payload(guard.clone());

    persist_config(&guard)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);

    Ok(payload)
}

pub fn save_credentials(
    provider_id: &str,
    alias: Option<&str>,
    api_key: &str,
) -> Result<AiConfigPayload, String> {
    let normalized_provider_id = provider_id.trim();

    if normalized_provider_id.is_empty() {
        return Err(errors::error("AI_PROVIDER_NOT_CONFIGURED", "请选择厂商。"));
    }

    CredentialStore::save(normalized_provider_id, api_key)?;

    let mut guard = config_state()
        .lock()
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))?;
    guard.credentials.insert(
        normalized_provider_id.to_string(),
        AiCredentialRuntimeMetadata {
            alias: alias
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("厂商 API Key")
                .to_string(),
            key_preview: mask_api_key(api_key),
        },
    );
    persist_config(&guard)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);

    Ok(to_payload(guard.clone()))
}

pub fn clear_credentials() -> Result<(), String> {
    CredentialStore::clear()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_provider_connection_candidate(
    provider_id: Option<&str>,
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
    let resolved_provider_id = validate_model_provider(model.as_deref(), provider_id)?;

    let api_key_for_test = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .map(Ok)
        .unwrap_or_else(|| get_saved_api_key_for_candidate(model.as_deref()))?;

    if api_key_for_test.trim().is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    Ok(AiProviderConnectionCandidate {
        provider_id: resolved_provider_id,
        provider_type: provider_type.to_string(),
        selected_model: model,
        base_url: normalized_base_url,
        api_key_for_test,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
    })
}

pub(super) fn save_connected_model(
    role: AiResolvedModelRole,
    candidate: AiProviderConnectionCandidate,
) -> Result<AiConfigPayload, String> {
    validate_provider(&candidate.provider_type)?;

    if !candidate.api_key_for_test.trim().is_empty() {
        CredentialStore::save(&candidate.provider_id, &candidate.api_key_for_test)?;
    }

    let mut guard = config_state()
        .lock()
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))?;

    match role {
        AiResolvedModelRole::Main => {
            guard.provider_type = candidate.provider_type;
            guard.selected_model = candidate.selected_model;
            guard.base_url = candidate.base_url;
            guard.inline_completion_enabled = candidate.inline_completion_enabled;
            guard.chat_enabled = candidate.chat_enabled;
            guard.agent_enabled = candidate.agent_enabled;
        }
        AiResolvedModelRole::Narrator => {
            guard.narrator.provider_type = candidate.provider_type;
            guard.narrator.selected_model = candidate.selected_model;
            guard.narrator.base_url = candidate.base_url;
        }
    }

    let payload = to_payload(guard.clone());
    persist_config(&guard)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);

    Ok(payload)
}
