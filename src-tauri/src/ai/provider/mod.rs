use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderMessage {
    pub role: String,
    pub content: String,
}

impl AiProviderMessage {
    pub fn new(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::new("user", content)
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self::new("system", content)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderChatRequest {
    pub messages: Vec<AiProviderMessage>,
    #[serde(default)]
    pub tools: Vec<AiProviderToolSpec>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub force_tool_choice_none: bool,
}

impl AiProviderChatRequest {
    pub fn new(messages: Vec<AiProviderMessage>) -> Self {
        Self {
            messages,
            tools: Vec::new(),
            force_tool_choice_none: false,
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInputTokenDetails {
    pub no_cache_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderOutputTokenDetails {
    pub text_tokens: u64,
    pub reasoning_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderUsage {
    pub input_tokens: u64,
    pub input_token_details: AiProviderInputTokenDetails,
    pub output_tokens: u64,
    pub output_token_details: AiProviderOutputTokenDetails,
    pub total_tokens: u64,
    pub cached_input_tokens: u64,
    pub reasoning_tokens: u64,
    pub raw: Value,
}
