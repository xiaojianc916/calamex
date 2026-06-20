use super::errors;

const SERVICE_NAME: &str = "calamex.ai";

const SUPPORTED_PROVIDER_IDS: &[&str] = &[
    "openai",
    "anthropic",
    "deepseek",
    "google",
    "moonshotai",
    "alibaba",
    "zhipuai",
    "ollama",
];

pub struct CredentialStore;

impl CredentialStore {
    pub fn save(provider_id: &str, api_key: &str) -> Result<(), String> {
        let account = provider_account(provider_id)?;
        let trimmed_api_key = api_key.trim();

        if trimmed_api_key.is_empty() {
            return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
        }

        keyring::Entry::new(SERVICE_NAME, &account)
            .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?
            .set_password(trimmed_api_key)
            .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))
    }

    pub fn get(provider_id: &str) -> Result<String, String> {
        let account = provider_account(provider_id)?;
        let password = keyring::Entry::new(SERVICE_NAME, &account)
            .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?
            .get_password()
            .map_err(|_| {
                errors::error(
                    "AI_PROVIDER_AUTH_FAILED",
                    "未找到当前厂商的 API Key，请在 AI 设置里填写并保存。",
                )
            })?;

        let trimmed = password.trim();
        if trimmed.is_empty() {
            return Err(errors::error(
                "AI_PROVIDER_AUTH_FAILED",
                "当前厂商的 API Key 为空，请在 AI 设置里重新填写并保存。",
            ));
        }

        Ok(trimmed.to_string())
    }

    pub fn has(provider_id: &str) -> bool {
        Self::get(provider_id).is_ok()
    }

    pub fn clear() -> Result<(), String> {
        for provider_id in SUPPORTED_PROVIDER_IDS {
            let account = provider_account(provider_id)?;
            let entry = keyring::Entry::new(SERVICE_NAME, &account)
                .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;

            let _ = entry.delete_credential();
        }

        Ok(())
    }
}

pub fn supported_provider_ids() -> &'static [&'static str] {
    SUPPORTED_PROVIDER_IDS
}

/// 各受支持厂商的官方 OpenAI 兼容端点——「厂商 → 默认 base_url」的**唯一权威表**。
///
/// 此前端点在多处「双写」：sidecar 主链路依赖 Mastra 内置 provider 注册表解析端点、
/// `acp::launch` 为 Kimi 预置凭证时又自带一份默认端点表。两者一旦漂移就会出现
/// 「某厂商有 Key 却无端点」的盲区——例如 zhipuai/GLM 在主链路缺 base_url 时 Mastra
/// 注册表并不收录，导致请求无端点、上游 401，最终在宿主侧显示
/// 「acp protocol error: Authentication required」。
///
/// 现统一收敛到这里：
///   * 主链路 sidecar 模型配置（`ai::gateway::model_config`）在用户未显式填写
///     「Provider 地址」时按此补齐；
///   * Kimi 外部后端凭证预置（`acp::launch`）同样据此回退。
///
/// 键集合与 [`supported_provider_ids`] 对齐（见下方单测覆盖）；deepseek 与 sidecar
/// `agent-sidecar/src/models/providers/deepseek-mastra-gateway.ts` 的 DEFAULT_DEEPSEEK_BASE_URL
/// 保持同值，moonshotai 与 `acp::launch` 的 KIMI_DEFAULT_BASE_URL 保持同值。
pub fn default_provider_base_url(provider_id: &str) -> Option<&'static str> {
    match provider_id.trim() {
        "openai" => Some("https://api.openai.com/v1"),
        "anthropic" => Some("https://api.anthropic.com/v1"),
        "deepseek" => Some("https://api.deepseek.com/v1"),
        "google" => Some("https://generativelanguage.googleapis.com/v1beta/openai"),
        "moonshotai" => Some("https://api.moonshot.ai/v1"),
        "alibaba" => Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        "zhipuai" => Some("https://open.bigmodel.cn/api/paas/v4"),
        "ollama" => Some("http://localhost:11434/v1"),
        _ => None,
    }
}

/// 「解析一次、人人复用」的统一凭证视图。
/// builtin sidecar 与各外部 agent 的 provisioner 均以此为唯一入口，
/// 杜绝多处各自从 keyring / 端点表取值导致的漂移。
pub struct ResolvedCredential {
    pub provider_id: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

/// 端点解析纯函数：调用方显式传入优先（trim 后非空），否则回退到唯一权威表
/// default_provider_base_url。抽成纯函数以便脱离 keyring 做单元测试。
pub fn resolve_provider_base_url(
    provider_id: &str,
    explicit_base_url: Option<&str>,
) -> Option<String> {
    explicit_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| default_provider_base_url(provider_id.trim()).map(ToOwned::to_owned))
}

impl CredentialStore {
    /// 解析某厂商的完整凭证视图：keyring 取 key（缺失/空 → Err，沿用 CredentialStore::get
    /// 的结构化错误码）+ 端点按 resolve_provider_base_url 回退。
    /// 下一步 provisioner 接线后即被消费，届时移除 allow(dead_code)。
    #[allow(dead_code)]
    pub fn resolve(
        provider_id: &str,
        explicit_base_url: Option<&str>,
    ) -> Result<ResolvedCredential, String> {
        let normalized_provider_id = provider_id.trim();
        let api_key = Self::get(normalized_provider_id)?;
        let base_url = resolve_provider_base_url(normalized_provider_id, explicit_base_url);

        Ok(ResolvedCredential {
            provider_id: normalized_provider_id.to_string(),
            api_key,
            base_url,
        })
    }
}

fn provider_account(provider_id: &str) -> Result<String, String> {
    let normalized_provider_id = provider_id.trim();

    if !SUPPORTED_PROVIDER_IDS.contains(&normalized_provider_id) {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "当前厂商不支持保存凭证。",
        ));
    }

    Ok(format!("provider:{normalized_provider_id}"))
}

#[cfg(test)]
mod tests {
    use super::{
        ResolvedCredential, default_provider_base_url, provider_account,
        resolve_provider_base_url, supported_provider_ids,
    };

    #[test]
    fn resolve_provider_base_url_prefers_explicit_then_falls_back() {
        assert_eq!(
            resolve_provider_base_url("deepseek", Some("  https://proxy.example/v1  ")),
            Some("https://proxy.example/v1".to_string())
        );
        assert_eq!(
            resolve_provider_base_url("deepseek", Some("   ")),
            Some("https://api.deepseek.com/v1".to_string())
        );
        assert_eq!(
            resolve_provider_base_url("  zhipuai  ", None),
            Some("https://open.bigmodel.cn/api/paas/v4".to_string())
        );
        assert_eq!(resolve_provider_base_url("unknown-vendor", None), None);
    }

    #[test]
    fn resolved_credential_exposes_provider_and_base_url() {
        let resolved = ResolvedCredential {
            provider_id: "deepseek".to_string(),
            api_key: "sk-test".to_string(),
            base_url: resolve_provider_base_url("deepseek", None),
        };
        assert_eq!(resolved.provider_id, "deepseek");
        assert_eq!(
            resolved.base_url.as_deref(),
            Some("https://api.deepseek.com/v1")
        );
        assert!(!resolved.api_key.is_empty());
    }

    #[test]
    fn provider_account_resolves_supported_vendor() {
        assert_eq!(provider_account("deepseek").unwrap(), "provider:deepseek");
        assert_eq!(provider_account(" openai ").unwrap(), "provider:openai");
    }

    #[test]
    fn provider_account_rejects_runtime_provider_and_unknown_vendor() {
        assert!(provider_account("mastra").is_err());
        assert!(provider_account("unknown-provider").is_err());
    }

    #[test]
    fn default_provider_base_url_covers_every_supported_id() {
        // 单一事实源约束：每个受支持厂商都必须有默认端点，杜绝「有 Key 却无端点」的盲区。
        for provider_id in supported_provider_ids() {
            assert!(
                default_provider_base_url(provider_id).is_some(),
                "缺少厂商默认端点：{provider_id}"
            );
        }
    }

    #[test]
    fn default_provider_base_url_resolves_known_and_trims_whitespace() {
        assert_eq!(
            default_provider_base_url("zhipuai"),
            Some("https://open.bigmodel.cn/api/paas/v4")
        );
        assert_eq!(
            default_provider_base_url("  deepseek  "),
            Some("https://api.deepseek.com/v1")
        );
        assert_eq!(default_provider_base_url("unknown-vendor"), None);
    }
}
