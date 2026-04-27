use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderChatRequest {
    pub messages: Vec<AiProviderMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderResponse {
    pub content: String,
    pub model: String,
}

pub struct MockProvider;

impl MockProvider {
    pub fn chat(request: AiProviderChatRequest) -> AiProviderResponse {
        let last_user = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(|message| message.content.as_str())
            .unwrap_or("未提供问题");
        let preview: String = last_user.chars().take(180).collect();

        AiProviderResponse {
            content: format!(
                "MockProvider 已收到请求。\n\n当前仅启用通用 IDE AI 架构基线，不会调用真实模型。\n\n问题预览：{}",
                preview
            ),
            model: "mock-ide-assistant".to_string(),
        }
    }
}
