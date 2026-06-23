use super::*;

pub(super) struct AiProviderConnectionCandidate {
    pub(super) provider_id: String,
    pub(super) provider_type: String,
    pub(super) selected_model: Option<String>,
    pub(super) base_url: Option<String>,
    pub(super) api_key_for_test: String,
    pub(super) api_key_from_saved: bool,
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

/// 持久化「全量可原生切换模型清单」（前端下发的 seeded_models）。
///
/// 该清单是「Kimi 启动时要写入 config.toml 的候选模型全集」的单一事实源：前端把项目内置的
/// 可扩展模型目录（MASTRA_PROVIDER_PRESET.models）整体下发并落盘 ai.json，后端 provisioner 在
/// 拉起 kimi acp 前据此逐条 seed（仅 seed 用户有 Key 的厂商，见 seeded_sidecar_model_configs）。
/// 入参先归一化（trim / 去空 / 保序去重）。与各模型「角色 / 凭证」无关，故不走 save_config 的
/// 按角色写入，而是独立写 seeded_models 字段。
pub fn set_seeded_models(models: Vec<String>) -> Result<AiConfigPayload, String> {
    let normalized = normalize_seeded_models(models);

    let mut guard = config_state()
        .lock()
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))?;
    guard.seeded_models = normalized;

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
                .unwrap_or("API Key")
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
    allow_saved_fallback: bool,
) -> Result<AiProviderConnectionCandidate, String> {
    validate_provider(provider_type)?;

    let normalized_base_url = normalize_base_url(provider_type, base_url)?;
    let model = selected_model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_model(provider_type));
    let resolved_provider_id = validate_model_provider(model.as_deref(), provider_id)?;

    let typed_api_key = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let api_key_from_saved = typed_api_key.is_none() && allow_saved_fallback;
    let api_key_for_test = match typed_api_key {
        Some(value) => value,
        None => {
            if allow_saved_fallback {
                get_saved_api_key_for_candidate(model.as_deref())?
            } else {
                return Err(errors::error(
                    "AI_PROVIDER_AUTH_FAILED",
                    "请先填写要测试的 API Key 后再测试连接。",
                ));
            }
        }
    };

    if api_key_for_test.trim().is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    Ok(AiProviderConnectionCandidate {
        provider_id: resolved_provider_id,
        provider_type: provider_type.to_string(),
        selected_model: model,
        base_url: normalized_base_url,
        api_key_for_test,
        api_key_from_saved,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
    })
}

/// 持久化「已确认的」模型端点与凭证。
///
/// 入参借用 `candidate`（而非取得所有权），以便上层 `connect_provider` 能够
/// 先保存、再用同一 `candidate` 做非致命连通性验证——把「能否保存」与「在线是否连通」
/// 彻底解耦。
pub(super) fn save_connected_model(
    role: AiResolvedModelRole,
    candidate: &AiProviderConnectionCandidate,
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
            guard.provider_type = candidate.provider_type.clone();
            guard.selected_model = candidate.selected_model.clone();
            guard.base_url = candidate.base_url.clone();
            guard.inline_completion_enabled = candidate.inline_completion_enabled;
            guard.chat_enabled = candidate.chat_enabled;
            guard.agent_enabled = candidate.agent_enabled;
        }
        AiResolvedModelRole::Narrator => {
            guard.narrator.provider_type = candidate.provider_type.clone();
            guard.narrator.selected_model = candidate.selected_model.clone();
            guard.narrator.base_url = candidate.base_url.clone();
        }
    }

    let payload = to_payload(guard.clone());
    persist_config(&guard)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::super::normalize_seeded_models;

    #[test]
    fn normalize_seeded_models_trims_drops_empty_and_dedupes_in_order() {
        let input = vec![
            "  deepseek/deepseek-v4-pro  ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "zhipuai/glm-4.7-flash".to_string(),
            "deepseek/deepseek-v4-pro".to_string(),
        ];
        let normalized = normalize_seeded_models(input);
        assert_eq!(
            normalized,
            vec![
                "deepseek/deepseek-v4-pro".to_string(),
                "zhipuai/glm-4.7-flash".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_seeded_models_handles_empty_input() {
        assert!(normalize_seeded_models(Vec::new()).is_empty());
        assert!(normalize_seeded_models(vec!["  ".to_string(), "".to_string()]).is_empty());
    }
}
