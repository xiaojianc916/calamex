use super::errors;

const SERVICE_NAME: &str = "calamex.ai";
const OPENAI_COMPATIBLE_USER: &str = "openai-compatible";
const OPENAI_USER: &str = "openai";
const DEEPSEEK_USER: &str = "deepseek";
const MOONSHOT_USER: &str = "moonshot";
const DASHSCOPE_USER: &str = "dashscope";
const ZHIPU_USER: &str = "zhipu";
const SILICONFLOW_USER: &str = "siliconflow";

pub struct CredentialStore;

impl CredentialStore {
    pub fn save(provider_type: &str, api_key: &str) -> Result<(), String> {
        let account = provider_account(provider_type)?;
        keyring::Entry::new(SERVICE_NAME, account)
            .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?
            .set_password(api_key)
            .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))
    }

    pub fn get(provider_type: &str) -> Result<String, String> {
        let account = provider_account(provider_type)?;
        keyring::Entry::new(SERVICE_NAME, account)
            .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?
            .get_password()
            .map_err(|_| {
                errors::error(
                    "AI_PROVIDER_AUTH_FAILED",
                    "未找到当前 Provider 的 API Key，请在 AI 设置里填写并保存。",
                )
            })
    }

    pub fn clear() -> Result<(), String> {
        for account in [
            OPENAI_COMPATIBLE_USER,
            OPENAI_USER,
            DEEPSEEK_USER,
            MOONSHOT_USER,
            DASHSCOPE_USER,
            ZHIPU_USER,
            SILICONFLOW_USER,
        ] {
            let entry = keyring::Entry::new(SERVICE_NAME, account)
                .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;
            let _ = entry.delete_credential();
        }
        Ok(())
    }

    pub fn has_provider_secret(provider_type: &str) -> bool {
        Self::get(provider_type).is_ok()
    }
}

fn provider_account(provider_type: &str) -> Result<&'static str, String> {
    match provider_type {
        "openai" => Ok(OPENAI_USER),
        "deepseek" => Ok(DEEPSEEK_USER),
        "moonshot" => Ok(MOONSHOT_USER),
        "dashscope" => Ok(DASHSCOPE_USER),
        "zhipu" => Ok(ZHIPU_USER),
        "siliconflow" => Ok(SILICONFLOW_USER),
        "openai-compatible" => Ok(OPENAI_COMPATIBLE_USER),
        _ => Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "当前 Provider 不需要或不支持保存凭证。",
        )),
    }
}
