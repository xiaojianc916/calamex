//! AI 网关侧的 sidecar 模型配置构造。
//!
//! `current_sidecar_model_config` / `narrator_sidecar_model_config` 历史上住在已下线的
//! `crate::agent_sidecar`（旧 HTTP sidecar 模块）里，但它们与 HTTP 传输无关：只是把
//! 当前已保存的 AI 配置（主模型 / Narrator）组装成 `AgentSidecarModelConfigPayload`，
//! 供 ACP 透传（model/chat）在 payload 未携带 model_config 时补齐。
//!
//! 随旧 HTTP 模块删除迁来 `ai::gateway`——既贴近其数据来源 `get_config()`，
//! 也让 `conversation` / `suggestions` 两个消费者就近引用。

use crate::ai::credential::CredentialStore;
use crate::commands::contracts::AgentSidecarModelConfigPayload;

/// 从模型 ID 中解析厂商前缀（“厂商/模型” 形式）。
fn model_provider_id(model_id: &str) -> Result<&str, String> {
    model_id
        .split_once('/')
        .map(|(provider_id, _)| provider_id.trim())
        .filter(|provider_id| !provider_id.is_empty())
        .ok_or_else(|| "AI 模型 ID 缺少厂商前缀，请使用“厂商/模型”格式。".to_string())
}

/// 把已配置的 selected_model / base_url 组装成 sidecar 模型配置。
/// current / narrator 两条链路只是数据来源与报错文案不同，这里抽出公共逻辑去重。
fn sidecar_model_config_from(
    selected_model: Option<&str>,
    base_url: Option<&str>,
    missing_model_error: &str,
) -> Result<AgentSidecarModelConfigPayload, String> {
    let model_id = selected_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| missing_model_error.to_string())?;
    let provider_id = model_provider_id(model_id)?;
    let resolved = CredentialStore::resolve(provider_id, base_url)?;

    Ok(AgentSidecarModelConfigPayload {
        model_id: model_id.to_string(),
        api_key: resolved.api_key.into(),
        base_url: resolved.base_url,
    })
}

/// 主模型（顶层 selected_model / base_url）的 sidecar 模型配置。
pub(crate) fn current_sidecar_model_config() -> Result<AgentSidecarModelConfigPayload, String> {
    let config = crate::ai::gateway::get_config();
    sidecar_model_config_from(
        config.selected_model.as_deref(),
        config.base_url.as_deref(),
        "AI 模型未配置：请先在 AI 设置中选择模型并保存。",
    )
}

/// Narrator 模型（config.narrator.selected_model / base_url）的 sidecar 模型配置。
pub(crate) fn narrator_sidecar_model_config() -> Result<AgentSidecarModelConfigPayload, String> {
    let config = crate::ai::gateway::get_config();
    sidecar_model_config_from(
        config.narrator.selected_model.as_deref(),
        config.narrator.base_url.as_deref(),
        "Narrator 模型未配置：请先在 AI 设置中选择 Narrator 模型并保存。",
    )
}

#[cfg(test)]
mod tests {
    use super::model_provider_id;

    #[test]
    fn model_provider_id_extracts_prefix_and_rejects_missing() {
        assert_eq!(
            model_provider_id("zhipuai/glm-4.7-flash").unwrap(),
            "zhipuai"
        );
        assert_eq!(
            model_provider_id("deepseek/deepseek-v4-pro").unwrap(),
            "deepseek"
        );
        assert!(model_provider_id("no-prefix").is_err());
    }
}
