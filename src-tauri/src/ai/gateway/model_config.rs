//! AI 网关侧的 sidecar 模型配置构造。
//!
//! `current_sidecar_model_config` / `narrator_sidecar_model_config` 历史上住在已下线的
//! `crate::agent_sidecar`（旧 HTTP sidecar 模块）里，但它们与 HTTP 传输无关：只是把
//! 当前已保存的 AI 配置（主模型 / Narrator）组装成 `AgentSidecarModelConfigPayload`，
//! 供 ACP 透传（model/chat）在 payload 未携带 model_config 时补齐。
//!
//! 随旧 HTTP 模块删除迁来 `ai::gateway`——既贴近其数据来源 `get_config()`，
//! 也让 `conversation` / `suggestions` 两个消费者就近引用。

use crate::ai::credential::{default_provider_base_url, CredentialStore};
use crate::commands::contracts::AgentSidecarModelConfigPayload;

/// 从模型 ID 中解析厂商前缀（“厂商/模型” 形式）。
fn model_provider_id(model_id: &str) -> Result<&str, String> {
    model_id
        .split_once('/')
        .map(|(provider_id, _)| provider_id.trim())
        .filter(|provider_id| !provider_id.is_empty())
        .ok_or_else(|| "AI 模型 ID 缺少厂商前缀，请使用“厂商/模型”格式。".to_string())
}

/// 解析下发给 sidecar 的 base_url：优先用户在 AI 设置里显式保存的网关地址，缺失（None /
/// 空白）时按厂商回退官方 OpenAI 兼容端点（单一事实源见
/// [`crate::ai::credential::default_provider_base_url`]）。
///
/// 此前主链路缺 base_url 时直接下发 None，依赖 sidecar 内 Mastra 的 provider 注册表解析
/// 端点——但注册表并不收录全部受支持厂商（如 zhipuai/GLM），导致请求无端点、上游 401
/// → sidecar 归类 `AI_PROVIDER_AUTH_FAILED` → `runtime.chat` 报错 → agent/chat 抛错 →
/// 宿主显示「acp protocol error: Authentication required」。DeepSeek 因有手写网关恒有默认
/// 端点，故此前唯独 DeepSeek 可用、其余厂商踩坑。该回退与 Kimi 凭证预置
/// （`acp::launch::collect_kimi_model_entry`）同源同策。
fn resolve_sidecar_base_url(provider_id: &str, base_url: Option<&str>) -> Option<String> {
    base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string())
        .or_else(|| default_provider_base_url(provider_id).map(ToOwned::to_owned))
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
    let api_key = CredentialStore::get(provider_id)?;
    let base_url = resolve_sidecar_base_url(provider_id, base_url);

    Ok(AgentSidecarModelConfigPayload {
        model_id: model_id.to_string(),
        api_key: api_key.into(),
        base_url,
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
    use super::{model_provider_id, resolve_sidecar_base_url};

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

    #[test]
    fn resolve_base_url_prefers_explicit_override_and_trims_trailing_slash() {
        assert_eq!(
            resolve_sidecar_base_url("zhipuai", Some("https://gw.example/v1/")).as_deref(),
            Some("https://gw.example/v1")
        );
    }

    #[test]
    fn resolve_base_url_falls_back_to_provider_default_when_empty() {
        // 修复关键路径：用户未手填 Provider 地址（None / 空白）时按厂商回退默认端点，
        // 而非下发 None 让 sidecar 失去端点 → 401 → Authentication required。
        assert_eq!(
            resolve_sidecar_base_url("zhipuai", None).as_deref(),
            Some("https://open.bigmodel.cn/api/paas/v4")
        );
        assert_eq!(
            resolve_sidecar_base_url("zhipuai", Some("   ")).as_deref(),
            Some("https://open.bigmodel.cn/api/paas/v4")
        );
        assert_eq!(
            resolve_sidecar_base_url("deepseek", None).as_deref(),
            Some("https://api.deepseek.com/v1")
        );
    }

    #[test]
    fn resolve_base_url_none_for_unknown_provider_without_override() {
        assert_eq!(resolve_sidecar_base_url("mystery", None), None);
    }
}
