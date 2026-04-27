use super::errors;
use super::provider::{AiProviderChatRequest, AiProviderMessage, AiProviderResponse};
use super::transport::sse::{parse_sse_line, SseParseOutcome};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

const PROVIDER_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatCompletionChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChoice {
    message: ChatCompletionMessage,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionMessage {
    content: String,
}

pub async fn chat(
    base_url: &str,
    api_key: &str,
    model: &str,
    request: AiProviderChatRequest,
) -> Result<AiProviderResponse, String> {
    let base_url = validate_base_url(base_url)?;
    let client = reqwest::Client::builder()
        .timeout(PROVIDER_TIMEOUT)
        .build()
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;
    let response = client
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "messages": request.messages.into_iter().map(|message| json!({
                "role": message.role,
                "content": message.content,
            })).collect::<Vec<_>>(),
            "temperature": 0.2,
        }))
        .send()
        .await
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;

    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(errors::error(
            "AI_PROVIDER_AUTH_FAILED",
            "AI Provider 鉴权失败。",
        ));
    }
    if status.as_u16() == 429 {
        return Err(errors::error(
            "AI_PROVIDER_RATE_LIMITED",
            "AI Provider 触发限流。",
        ));
    }
    if !status.is_success() {
        return Err(errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!("AI Provider 返回错误 {status}: {}", summarize_body(&body)),
        ));
    }

    let parsed = serde_json::from_str::<ChatCompletionResponse>(&body)
        .map_err(|error| errors::error("AI_RESPONSE_INVALID", error.to_string()))?;
    let content = parsed
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
        .unwrap_or_default()
        .trim()
        .to_string();

    if content.is_empty() {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "AI Provider 未返回有效内容。",
        ));
    }

    Ok(AiProviderResponse {
        content,
        model: model.to_string(),
    })
}


pub async fn chat_stream<F, C>(
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
    let base_url = validate_base_url(base_url)?;
    let client = reqwest::Client::builder()
        .timeout(PROVIDER_TIMEOUT)
        .build()
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;
    let mut response = client
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "messages": request.messages.into_iter().map(|message| json!({
                "role": message.role,
                "content": message.content,
            })).collect::<Vec<_>>(),
            "temperature": 0.2,
            "stream": true,
        }))
        .send()
        .await
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "AI Provider ?????"));
    }
    if status.as_u16() == 429 {
        return Err(errors::error("AI_PROVIDER_RATE_LIMITED", "AI Provider ?????"));
    }
    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;
        return Err(errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!("AI Provider ???? {status}: {}", summarize_body(&body)),
        ));
    }

    let mut buffer = String::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?
    {
        if is_cancelled() {
            return Err(errors::error("AI_REQUEST_CANCELLED", "AI ????????"));
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim_end_matches('\r').to_string();
            buffer = buffer[line_end + 1..].to_string();
            let (outcome, delta) = parse_sse_line(&line)
                .map_err(|error| errors::error("AI_RESPONSE_INVALID", error))?;
            if let Some(delta) = delta {
                on_delta(delta)?;
            }
            if matches!(outcome, SseParseOutcome::Done) {
                return Ok(());
            }
        }
    }

    if !buffer.trim().is_empty() {
        let (outcome, delta) = parse_sse_line(&buffer)
            .map_err(|error| errors::error("AI_RESPONSE_INVALID", error))?;
        if let Some(delta) = delta {
            on_delta(delta)?;
        }
        if matches!(outcome, SseParseOutcome::Done) {
            return Ok(());
        }
    }

    Ok(())
}


pub async fn test(base_url: &str, api_key: &str, model: &str) -> Result<(), String> {
    let request = AiProviderChatRequest {
        messages: vec![AiProviderMessage {
            role: "user".to_string(),
            content: "ping".to_string(),
        }],
    };
    chat(base_url, api_key, model, request).await.map(|_| ())
}

fn validate_base_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "请填写 Provider API 地址。",
        ));
    }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://localhost")) {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "AI Provider 地址必须使用 HTTPS；本地调试仅允许 http://localhost。",
        ));
    }
    Ok(trimmed.to_string())
}

fn summarize_body(value: &str) -> String {
    value.chars().take(600).collect()
}
