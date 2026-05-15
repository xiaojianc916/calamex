use async_openai::config::OpenAIConfig;
use async_openai::error::OpenAIError;
use async_openai::traits::RequestOptionsBuilder;
use async_openai::types::chat::{
    ChatCompletionStreamOptions, ChatCompletionTool, ChatCompletionToolChoiceOption,
    ChatCompletionTools, FunctionObject, ToolChoiceOptions,
};
use async_openai::Client;
use super::errors;
use super::provider::{
    AiProviderChatRequest, AiProviderMessage, AiProviderResponse, AiProviderTokenEstimate,
    AiProviderToolCall, AiProviderToolSpec, AiProviderUsage,
};
use super::redaction::redact_text;
use super::token_budget;
use reqwest13::Client as Reqwest13Client;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;
use tokio_stream::StreamExt;

const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const PROVIDER_STREAM_TIMEOUT: Duration = Duration::from_secs(180);
const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROVIDER_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const PROVIDER_POOL_MAX_IDLE_PER_HOST: usize = 8;
const MAX_PROVIDER_ERROR_BODY_CHARS: usize = 600;

static PROVIDER_REQUEST_CLIENT: OnceLock<Result<Reqwest13Client, String>> = OnceLock::new();
static PROVIDER_STREAM_CLIENT: OnceLock<Result<Reqwest13Client, String>> = OnceLock::new();

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotChatCompletionResponse {
    #[serde(default)]
    choices: Vec<ByotChatChoice>,
    #[serde(default)]
    usage: Option<Value>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotChatChoice {
    message: ByotChatMessage,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotChatMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ByotToolCall>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotToolCall {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    function: Option<ByotToolFunction>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotToolFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotChatCompletionStreamResponse {
    #[serde(default)]
    choices: Vec<ByotStreamChoice>,
    #[serde(default)]
    usage: Option<Value>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotStreamChoice {
    #[serde(default)]
    delta: ByotStreamDelta,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct ByotStreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ByotStreamToolCall>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotStreamToolCall {
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<ByotPartialToolFunction>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ByotPartialToolFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Default)]
struct StreamResponseAccumulator {
    content: String,
    tool_calls: BTreeMap<usize, PartialStreamToolCall>,
    usage: Option<AiProviderUsage>,
}

#[derive(Debug, Default)]
struct PartialStreamToolCall {
    id: Option<String>,
    name: String,
    arguments: String,
}

type ProviderClient = Client<OpenAIConfig>;

#[derive(Debug, Clone)]
struct ParsedStreamChunk {
    raw_usage: Option<Value>,
    chunk: ByotChatCompletionStreamResponse,
}

#[derive(Debug, Clone)]
pub enum AiProviderStreamEvent {
    Delta {
        delta: String,
        completion_tokens_estimate: Option<u64>,
    },
    Usage {
        usage: AiProviderUsage,
    },
}

pub async fn chat(
    base_url: &str,
    api_key: &str,
    model: &str,
    request: AiProviderChatRequest,
) -> Result<AiProviderResponse, String> {
    let base_url = validate_base_url(base_url)?;
    let api_key = validate_api_key(api_key)?;
    let model = validate_model(model)?;
    let prompt_estimate = token_budget::estimate_chat_prompt_tokens_if_supported(model, &request)?;

    match chat_non_streaming(
        &base_url,
        api_key,
        model,
        request.clone(),
        prompt_estimate.clone(),
    )
    .await
    {
        Ok(response) => Ok(response),
        Err(non_stream_error) if should_retry_chat_as_stream(&non_stream_error) => {
            match chat_stream_response(&base_url, api_key, model, request, prompt_estimate).await {
                Ok(response) => Ok(response),
                Err(stream_error) => Err(errors::error(
                    "AI_PROVIDER_UNAVAILABLE",
                    format!(
                        "AI Provider 非流式响应读取失败，流式兜底也失败。非流式错误：{}；流式错误：{}",
                        summarize_body(&non_stream_error),
                        summarize_body(&stream_error)
                    ),
                )),
            }
        }
        Err(error) => Err(error),
    }
}

async fn chat_non_streaming(
    base_url: &str,
    api_key: &str,
    model: &str,
    request: AiProviderChatRequest,
    prompt_estimate: Option<AiProviderTokenEstimate>,
) -> Result<AiProviderResponse, String> {
    let body = build_chat_request_body(model, request, false)?;
    let client = provider_chat_client(base_url, api_key, PROVIDER_REQUEST_TIMEOUT)?;
    let response: ByotChatCompletionResponse = client
        .chat()
        .header("accept", "application/json")
        .map_err(map_openai_error)?
        .create_byot(body)
        .await
        .map_err(map_openai_error)?;

    parse_chat_completion_response(response, model, prompt_estimate)
}

async fn chat_stream_response(
    base_url: &str,
    api_key: &str,
    model: &str,
    request: AiProviderChatRequest,
    prompt_estimate: Option<AiProviderTokenEstimate>,
) -> Result<AiProviderResponse, String> {
    let body = build_chat_request_body(model, request, true)?;
    let client = provider_chat_client(&base_url, api_key, PROVIDER_STREAM_TIMEOUT)?;
    let mut stream = client
        .chat()
        .header("accept", "text/event-stream")
        .map_err(map_openai_error)?
        .create_stream_byot::<_, ByotChatCompletionStreamResponse>(body)
        .await
        .map_err(map_openai_error)?;
    let mut accumulator = StreamResponseAccumulator::default();

    while let Some(event) = stream.next().await {
        let chunk = event.map_err(map_openai_error)?;
        apply_stream_chunk(
            ParsedStreamChunk {
                raw_usage: chunk.usage.clone(),
                chunk,
            },
            &mut accumulator,
        )?;
    }

    stream_accumulator_to_response(accumulator, model, prompt_estimate)
}

pub async fn chat_stream<F, C>(
    base_url: &str,
    api_key: &str,
    model: &str,
    request: AiProviderChatRequest,
    mut on_event: F,
    is_cancelled: C,
) -> Result<(), String>
where
    F: FnMut(AiProviderStreamEvent) -> Result<(), String>,
    C: Fn() -> bool,
{
    let base_url = validate_base_url(base_url)?;
    let api_key = validate_api_key(api_key)?;
    let model = validate_model(model)?;
    let _prompt_estimate = token_budget::estimate_chat_prompt_tokens_if_supported(model, &request)?;

    if is_cancelled() {
        return Err(errors::error("AI_REQUEST_CANCELLED", "AI 请求已取消。"));
    }

    let body = build_chat_request_body(model, request, true)?;
    let client = provider_chat_client(&base_url, api_key, PROVIDER_STREAM_TIMEOUT)?;
    let mut stream = client
        .chat()
        .header("accept", "text/event-stream")
        .map_err(map_openai_error)?
        .create_stream_byot::<_, ByotChatCompletionStreamResponse>(body)
        .await
        .map_err(map_openai_error)?;
    let mut completion_tokens_estimate = Some(0_u64);
    let mut completion_text = String::new();

    while let Some(event) = stream.next().await {
        if is_cancelled() {
            return Err(errors::error("AI_REQUEST_CANCELLED", "AI 请求已取消。"));
        }

        handle_stream_chunk(
            model,
            {
                let chunk = event.map_err(map_openai_error)?;
                ParsedStreamChunk {
                    raw_usage: chunk.usage.clone(),
                    chunk,
                }
            },
            &mut completion_text,
            &mut completion_tokens_estimate,
            &mut on_event,
        )?;
    }

    Ok(())
}

pub async fn test(base_url: &str, api_key: &str, model: &str) -> Result<(), String> {
    let request = AiProviderChatRequest::new(vec![AiProviderMessage {
        role: "user".to_string(),
        content: "ping".to_string(),
    }]);

    chat(base_url, api_key, model, request).await.map(|_| ())
}

fn provider_chat_client(
    base_url: &str,
    api_key: &str,
    timeout: Duration,
) -> Result<ProviderClient, String> {
    let http_client = provider_http_client(timeout)?;
    let config = OpenAIConfig::new()
        .with_api_base(base_url)
        .with_api_key(api_key)
        .with_header("accept-encoding", "identity")
        .map_err(map_openai_error)?;

    Ok(Client::build(http_client, config))
}

fn provider_http_client(timeout: Duration) -> Result<Reqwest13Client, String> {
    if timeout == PROVIDER_STREAM_TIMEOUT {
        return PROVIDER_STREAM_CLIENT
            .get_or_init(|| build_provider_client(PROVIDER_STREAM_TIMEOUT))
            .clone();
    }

    PROVIDER_REQUEST_CLIENT
        .get_or_init(|| build_provider_client(PROVIDER_REQUEST_TIMEOUT))
        .clone()
}

fn build_provider_client(timeout: Duration) -> Result<Reqwest13Client, String> {
    Reqwest13Client::builder()
        .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
        .pool_idle_timeout(PROVIDER_POOL_IDLE_TIMEOUT)
        .pool_max_idle_per_host(PROVIDER_POOL_MAX_IDLE_PER_HOST)
        .timeout(timeout)
        .tcp_nodelay(true)
        .http1_only()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))
}

fn build_chat_messages(messages: Vec<AiProviderMessage>) -> Vec<Value> {
    messages
        .into_iter()
        .map(|message| {
            json!({
                "role": message.role,
                "content": message.content,
            })
        })
        .collect()
}

fn response_body_bytes_to_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .to_string()
}

fn build_chat_request_body(
    model: &str,
    request: AiProviderChatRequest,
    stream: bool,
) -> Result<Value, String> {
    let mut body = json!({
        "model": model,
        "messages": build_chat_messages(request.messages),
        "temperature": 0.2,
        "stream": stream,
    });

    if stream {
        body["stream_options"] = to_json_value(ChatCompletionStreamOptions {
            include_usage: Some(true),
            include_obfuscation: None,
        })?;
    }

    if request.force_tool_choice_none {
        body["tool_choice"] =
            to_json_value(ChatCompletionToolChoiceOption::Mode(ToolChoiceOptions::None))?;
    } else if !request.tools.is_empty() {
        body["tools"] = to_json_value(build_chat_tools(request.tools))?;
        body["tool_choice"] =
            to_json_value(ChatCompletionToolChoiceOption::Mode(ToolChoiceOptions::Auto))?;
    }

    Ok(body)
}

fn build_chat_tools(tools: Vec<AiProviderToolSpec>) -> Vec<ChatCompletionTools> {
    tools
        .into_iter()
        .map(|tool| {
            ChatCompletionTools::Function(ChatCompletionTool {
                function: FunctionObject {
                    name: tool.name,
                    description: Some(tool.description),
                    parameters: Some(tool.parameters),
                    strict: None,
                },
            })
        })
        .collect()
}

fn to_json_value<T>(value: T) -> Result<Value, String>
where
    T: serde::Serialize,
{
    serde_json::to_value(value).map_err(|error| {
        errors::error(
            "AI_RESPONSE_INVALID",
            format!("AI Provider 请求体序列化失败：{error}"),
        )
    })
}

fn parse_chat_completion_response(
    response: ByotChatCompletionResponse,
    model: &str,
    prompt_estimate: Option<AiProviderTokenEstimate>,
) -> Result<AiProviderResponse, String> {
    let Some(choice) = response.choices.into_iter().next() else {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "AI Provider did not return a completion choice.",
        ));
    };

    let content = choice
        .message
        .content
        .unwrap_or_default()
        .trim()
        .to_string();
    let tool_calls = normalize_openai_tool_calls(choice.message.tool_calls)?;

    if content.is_empty() && tool_calls.is_empty() {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "AI Provider did not return content or tool calls.",
        ));
    }

    Ok(AiProviderResponse::with_usage(
        content,
        model.to_string(),
        tool_calls,
        response.usage.map(AiProviderUsage::from_openai_usage),
        prompt_estimate,
    ))
}

fn normalize_openai_tool_calls(
    tool_calls: Vec<ByotToolCall>,
) -> Result<Vec<AiProviderToolCall>, String> {
    tool_calls
        .into_iter()
        .enumerate()
        .map(|(index, call)| {
            let is_function = call
                .r#type
                .as_deref()
                .map(|value| value == "function")
                .unwrap_or(true);
            if !is_function {
                return Err(errors::error(
                    "AI_RESPONSE_INVALID",
                    "暂不支持非 function tool call。",
                ));
            }
            let function = call.function.ok_or_else(|| {
                errors::error(
                    "AI_RESPONSE_INVALID",
                    "Tool call is missing function payload.",
                )
            })?;
            let name = function.name.trim();
            if name.is_empty() {
                return Err(errors::error(
                    "AI_RESPONSE_INVALID",
                    "Tool call function name is empty.",
                ));
            }
            let arguments = parse_tool_call_arguments(
                &function.arguments,
                "Tool call arguments are not valid JSON",
            )?;

            Ok(AiProviderToolCall {
                id: tool_call_id_or_default(call.id.as_deref(), index),
                name: name.to_string(),
                arguments,
            })
        })
        .collect()
}

fn parse_tool_call_arguments(arguments: &str, error_message: &str) -> Result<Value, String> {
    if arguments.trim().is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }

    serde_json::from_str::<Value>(arguments).map_err(|error| {
        errors::error(
            "AI_RESPONSE_INVALID",
            format!("{error_message}: {error}"),
        )
    })
}

fn tool_call_id_or_default(id: Option<&str>, index: usize) -> String {
    let trimmed = id.unwrap_or_default().trim();

    if trimmed.is_empty() {
        return format!("tool-call-{index}");
    }

    trimmed.to_string()
}

fn should_retry_chat_as_stream(error: &str) -> bool {
    error.contains("读取 AI Provider 响应体失败")
        || error.contains("响应体解码失败")
        || error.contains("Provider 返回体解码失败")
        || error.contains("AI Provider 非流式响应 JSON 解析失败")
        || error.contains("AI Provider 响应解析失败")
        || error.to_ascii_lowercase().contains("decode")
}

fn parse_stream_chunk_payload(payload: &str) -> Result<ParsedStreamChunk, String> {
    serde_json::from_str::<ByotChatCompletionStreamResponse>(payload)
        .map(|chunk| ParsedStreamChunk {
            raw_usage: chunk.usage.clone(),
            chunk,
        })
        .map_err(|error| {
            errors::error(
                "AI_RESPONSE_INVALID",
                format!("AI Provider 流式响应 chunk 解析失败：{error}"),
            )
        })
}

fn apply_stream_chunk(
    parsed_chunk: ParsedStreamChunk,
    accumulator: &mut StreamResponseAccumulator,
) -> Result<(), String> {
    if let Some(usage) = parsed_chunk.raw_usage {
        accumulator.usage = Some(AiProviderUsage::from_openai_usage(usage));
    }

    for choice in parsed_chunk.chunk.choices {
        if let Some(content) = choice.delta.content {
            accumulator.content.push_str(&content);
        }

        for tool_call in choice.delta.tool_calls {
            let index = tool_call.index.unwrap_or(accumulator.tool_calls.len());
            let partial = accumulator.tool_calls.entry(index).or_default();

            if let Some(id) = tool_call.id.filter(|id| !id.trim().is_empty()) {
                partial.id.get_or_insert(id);
            }

            let Some(function) = tool_call.function else {
                continue;
            };

            if let Some(name) = function.name.filter(|name| !name.trim().is_empty()) {
                if partial.name.is_empty() {
                    partial.name = name;
                } else if partial.name != name {
                    partial.name.push_str(&name);
                }
            }

            if let Some(arguments) = function.arguments {
                partial.arguments.push_str(&arguments);
            }
        }
    }

    Ok(())
}

fn handle_stream_chunk<F>(
    model: &str,
    parsed_chunk: ParsedStreamChunk,
    completion_text: &mut String,
    completion_tokens_estimate: &mut Option<u64>,
    on_event: &mut F,
) -> Result<(), String>
where
    F: FnMut(AiProviderStreamEvent) -> Result<(), String>,
{
    if let Some(usage) = parsed_chunk.raw_usage {
        on_event(AiProviderStreamEvent::Usage {
            usage: AiProviderUsage::from_openai_usage(usage),
        })?;
    }

    let delta = parsed_chunk
        .chunk
        .choices
        .into_iter()
        .filter_map(|choice| choice.delta.content)
        .collect::<String>();

    if !delta.is_empty() {
        let completion_tokens_estimate = update_completion_tokens_estimate(
            model,
            &delta,
            completion_text,
            completion_tokens_estimate,
        )?;
        on_event(AiProviderStreamEvent::Delta {
            delta,
            completion_tokens_estimate,
        })?;
    }

    Ok(())
}

fn stream_accumulator_to_response(
    accumulator: StreamResponseAccumulator,
    model: &str,
    prompt_estimate: Option<AiProviderTokenEstimate>,
) -> Result<AiProviderResponse, String> {
    let content = accumulator.content.trim().to_string();
    let tool_calls = normalize_stream_tool_calls(accumulator.tool_calls)?;
    let usage = accumulator.usage;

    if content.is_empty() && tool_calls.is_empty() {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "AI Provider 流式响应未返回文本或工具调用。",
        ));
    }

    Ok(AiProviderResponse::with_usage(
        content,
        model.to_string(),
        tool_calls,
        usage,
        prompt_estimate,
    ))
}

fn normalize_stream_tool_calls(
    tool_calls: BTreeMap<usize, PartialStreamToolCall>,
) -> Result<Vec<AiProviderToolCall>, String> {
    tool_calls
        .into_iter()
        .map(|(index, call)| {
            let name = call.name.trim();

            if name.is_empty() {
                return Err(errors::error(
                    "AI_RESPONSE_INVALID",
                    "流式工具调用缺少 function.name。",
                ));
            }

            let arguments = parse_tool_call_arguments(
                &call.arguments,
                "流式工具调用参数不是合法 JSON",
            )?;

            Ok(AiProviderToolCall {
                id: call.id.unwrap_or_else(|| format!("tool-call-{index}")),
                name: name.to_string(),
                arguments,
            })
        })
        .collect()
}

fn map_openai_error(error: OpenAIError) -> String {
    match error {
        OpenAIError::ApiError(api_error) => {
            let message = summarize_body(&api_error.message);
            let code = api_error.code.as_deref().unwrap_or_default();
            let kind = api_error.r#type.as_deref().unwrap_or_default();
            let lower_message = api_error.message.to_ascii_lowercase();

            if matches!(code, "invalid_api_key" | "authentication_error")
                || kind == "invalid_request_error" && lower_message.contains("api key")
                || lower_message.contains("unauthorized")
                || lower_message.contains("authentication")
            {
                return errors::error("AI_PROVIDER_AUTH_FAILED", format!("AI Provider 鉴权失败：{message}"));
            }

            if matches!(code, "rate_limit_exceeded" | "insufficient_quota")
                || kind == "rate_limit_error"
                || lower_message.contains("rate limit")
                || lower_message.contains("quota")
            {
                return errors::error("AI_PROVIDER_RATE_LIMITED", format!("AI Provider 触发限流：{message}"));
            }

            if kind == "server_error" || lower_message.contains("server error") {
                return errors::error(
                    "AI_PROVIDER_UNAVAILABLE",
                    format!("AI Provider 服务暂不可用：{message}"),
                );
            }

            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("AI Provider 返回错误：{message}"),
            )
        }
        OpenAIError::JSONDeserialize(_, content) => errors::error(
            "AI_RESPONSE_INVALID",
            format!(
                "AI Provider 非流式响应 JSON 解析失败：{}",
                summarize_body(&response_body_bytes_to_string(content.as_bytes()))
            ),
        ),
        OpenAIError::InvalidArgument(message) => errors::error(
            "AI_RESPONSE_INVALID",
            format!("AI Provider 请求无效：{}", summarize_body(&message)),
        ),
        OpenAIError::StreamError(error) => errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!("AI Provider 流式响应失败：{}", summarize_body(&error.to_string())),
        ),
        OpenAIError::Reqwest(error) => {
            let message = error.to_string();
            if error.is_status() {
                return errors::error(
                    "AI_PROVIDER_UNAVAILABLE",
                    format!("AI Provider 请求失败：{}", summarize_body(&message)),
                );
            }

            if error.is_timeout() {
                return errors::error(
                    "AI_PROVIDER_UNAVAILABLE",
                    format!("AI Provider 请求超时：{}", summarize_body(&message)),
                );
            }

            if error.is_decode() {
                return errors::error(
                    "AI_PROVIDER_UNAVAILABLE",
                    "Provider 返回体解码失败。已请求 identity 编码，请检查该兼容网关是否返回了损坏压缩、错误 Content-Encoding 或被中途截断的响应。",
                );
            }

            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("AI Provider 请求失败：{}", summarize_body(&message)),
            )
        }
        #[allow(unreachable_patterns)]
        other => errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!("AI Provider 请求失败：{}", summarize_body(&other.to_string())),
        ),
    }
}

fn update_completion_tokens_estimate(
    model: &str,
    delta: &str,
    completion_text: &mut String,
    completion_tokens_estimate: &mut Option<u64>,
) -> Result<Option<u64>, String> {
    if completion_tokens_estimate.is_none() {
        return Ok(None);
    }

    completion_text.push_str(delta);

    match token_budget::estimate_text_tokens(model, completion_text) {
        Ok(tokens) => {
            *completion_tokens_estimate = Some(tokens);
            Ok(Some(tokens))
        }
        Err(error) if error.contains("AI_TOKENIZER_UNSUPPORTED") => {
            *completion_tokens_estimate = None;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn validate_base_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');

    if trimmed.is_empty() {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "请填写 Provider API 地址。",
        ));
    }

    if !is_allowed_base_url(trimmed) {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "AI Provider 地址必须使用 HTTPS；本地调试仅允许 http://localhost、http://127.0.0.1 或 http://[::1]。",
        ));
    }

    Ok(trimmed.to_string())
}

fn is_allowed_base_url(value: &str) -> bool {
    value.starts_with("https://")
        || value.starts_with("http://localhost")
        || value.starts_with("http://127.0.0.1")
        || value.starts_with("http://[::1]")
}

fn validate_api_key(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    Ok(trimmed)
}

fn validate_model(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "请填写或选择模型名称。",
        ));
    }

    Ok(trimmed)
}

fn summarize_body(value: &str) -> String {
    redact_text(value)
        .text
        .chars()
        .take(MAX_PROVIDER_ERROR_BODY_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        apply_stream_chunk, build_chat_request_body, chat, parse_chat_completion_response,
        parse_stream_chunk_payload, response_body_bytes_to_string, stream_accumulator_to_response,
        summarize_body, update_completion_tokens_estimate, validate_base_url,
        ByotChatCompletionResponse, StreamResponseAccumulator,
    };
    use crate::ai::provider::{AiProviderChatRequest, AiProviderMessage, AiProviderToolSpec};
    use crate::ai::token_budget;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    #[test]
    fn summarize_body_redacts_provider_error_secrets() {
        let summary = summarize_body(r#"{"error":"bad","api_key":"sk-test-secret-value"}"#);

        assert!(!summary.contains("sk-test-secret-value"));
        assert!(summary.contains("[已脱敏：疑似敏感内容]"));
    }

    #[test]
    fn validate_base_url_accepts_https() {
        let value = validate_base_url("https://api.openai.com/v1/").unwrap();

        assert_eq!(value, "https://api.openai.com/v1");
    }

    #[test]
    fn validate_base_url_accepts_localhost_debug_urls() {
        assert!(validate_base_url("http://localhost:11434/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:11434/v1").is_ok());
        assert!(validate_base_url("http://[::1]:11434/v1").is_ok());
    }

    #[test]
    fn validate_base_url_rejects_plain_http_remote_urls() {
        assert!(validate_base_url("http://example.com/v1").is_err());
    }

    #[test]
    fn parses_openai_tool_calls_without_text_content() {
        let body = r#"{
          "choices": [{
            "message": {
              "content": null,
              "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {
                  "name": "search_text",
                  "arguments": "{\"query\":\"agent\",\"maxResults\":3}"
                }
              }]
            }
          }]
        }"#;
        let parsed: ByotChatCompletionResponse =
            serde_json::from_str(body).expect("body should parse");

        let response =
            parse_chat_completion_response(parsed, "gpt-test", None).expect("response");

        assert_eq!(response.content, "");
        assert_eq!(response.model, "gpt-test");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "search_text");
        assert_eq!(response.tool_calls[0].arguments["query"], "agent");
    }

    #[test]
    fn chat_request_body_includes_tool_specs_when_present() {
        let request = AiProviderChatRequest::new(vec![AiProviderMessage::user("inspect")])
            .with_tools(vec![AiProviderToolSpec {
                name: "get_project_tree".to_string(),
                description: "Read project tree.".to_string(),
                parameters: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {}
                }),
            }]);

        let body = build_chat_request_body("gpt-test", request, false).expect("body");

        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(
            body["tools"][0]["function"]["name"],
            json!("get_project_tree")
        );
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn chat_request_body_can_force_no_tool_choice_for_final_answer() {
        let request = AiProviderChatRequest::new(vec![AiProviderMessage::user("answer now")])
            .with_tool_choice_none();

        let body = build_chat_request_body("gpt-test", request, false).expect("body");

        assert_eq!(body["tool_choice"], "none");
        assert!(body["tools"].is_null());
    }

    #[test]
    fn stream_request_body_enables_usage_frames() {
        let request = AiProviderChatRequest::new(vec![AiProviderMessage::user("stream")]);

        let body = build_chat_request_body("gpt-test", request, true).expect("body");

        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn parses_non_streaming_usage_payload() {
        let body = r#"{
          "choices": [{
            "message": {
              "content": "ok"
            }
          }],
          "usage": {
            "prompt_tokens": 11,
            "completion_tokens": 7,
            "total_tokens": 18,
            "prompt_tokens_details": {
              "cached_tokens": 3
            },
            "completion_tokens_details": {
              "reasoning_tokens": 2
            }
          }
        }"#;
        let parsed: ByotChatCompletionResponse =
            serde_json::from_str(body).expect("body should parse");

        let response =
            parse_chat_completion_response(parsed, "gpt-test", None).expect("response");
        let usage = response.usage.expect("usage");

        assert_eq!(usage.input_tokens, 11);
        assert_eq!(usage.output_tokens, 7);
        assert_eq!(usage.total_tokens, 18);
        assert_eq!(usage.cached_input_tokens, 3);
        assert_eq!(usage.input_token_details.no_cache_tokens, 8);
        assert_eq!(usage.output_token_details.reasoning_tokens, 2);
        assert_eq!(usage.output_token_details.text_tokens, 5);
    }

    #[test]
    fn response_body_bytes_to_string_handles_bom_and_invalid_utf8_lossily() {
        let body = response_body_bytes_to_string(&[
            0xef, 0xbb, 0xbf, b'{', b'"', b'a', b'"', b':', 0xff, b'}',
        ]);

        assert!(!body.starts_with('\u{feff}'));
        assert!(body.contains('�'));
    }

    #[test]
    fn parses_stream_chunk_payload_with_unicode_content() {
        let parsed = parse_stream_chunk_payload(
            r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"content":"你好🙂"},"finish_reason":null}]}"#,
        )
        .expect("chunk should parse");

        assert_eq!(parsed.chunk.choices.len(), 1);
        assert_eq!(
            parsed.chunk.choices[0].delta.content.as_deref(),
            Some("你好🙂")
        );
        assert!(parsed.raw_usage.is_none());
    }

    #[test]
    fn stream_chunk_ignores_empty_and_role_only_delta() {
        let mut accumulator = StreamResponseAccumulator::default();

        apply_stream_chunk(
            parse_stream_chunk_payload(
                r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":null}]}"#,
            )
            .expect("empty delta should parse"),
            &mut accumulator,
        )
        .expect("empty delta should apply");
        apply_stream_chunk(
            parse_stream_chunk_payload(
                r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#,
            )
            .expect("role-only delta should parse"),
            &mut accumulator,
        )
        .expect("role-only delta should apply");
        apply_stream_chunk(
            parse_stream_chunk_payload(
                r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}"#,
            )
            .expect("content delta should parse"),
            &mut accumulator,
        )
        .expect("content delta should apply");

        assert_eq!(accumulator.content, "ok");
        assert!(accumulator.tool_calls.is_empty());
    }

    #[test]
    fn stream_chunk_records_usage_frame() {
        let mut accumulator = StreamResponseAccumulator::default();

        apply_stream_chunk(
            parse_stream_chunk_payload(
                r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}"#,
            )
            .expect("usage chunk should parse"),
            &mut accumulator,
        )
        .expect("usage chunk should apply");

        let usage = accumulator.usage.expect("usage");
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 4);
        assert_eq!(usage.total_tokens, 14);
    }

    #[test]
    fn completion_token_estimate_retokenizes_accumulated_text() {
        let model = "deepseek/deepseek-v4-flash";
        let mut visible_text = String::new();
        let mut estimate = Some(0_u64);

        let first =
            update_completion_tokens_estimate(model, "你", &mut visible_text, &mut estimate)
                .expect("first chunk should estimate");
        let second =
            update_completion_tokens_estimate(model, "好", &mut visible_text, &mut estimate)
                .expect("second chunk should estimate");
        let full_tokens = token_budget::estimate_text_tokens(model, "你好").expect("full tokens");

        assert!(first.unwrap_or_default() > 0);
        assert_eq!(second, Some(full_tokens));
        assert_eq!(visible_text, "你好");
    }

    #[test]
    fn stream_tool_calls_merge_by_index_and_parse_arguments_after_all_fragments() {
        let mut accumulator = StreamResponseAccumulator::default();
        let first_chunk = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [
                        {
                            "index": 1,
                            "id": "call-2",
                            "function": {
                                "name": "search_",
                                "arguments": "{\"query\""
                            }
                        },
                        {
                            "index": 0,
                            "id": "call-1",
                            "function": {
                                "name": "read_",
                                "arguments": "{\"path\""
                            }
                        }
                    ]
                }
            }]
        });
        let second_chunk = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [
                        {
                            "index": 1,
                            "function": {
                                "name": "text",
                                "arguments": ":\"agent\"}"
                            }
                        },
                        {
                            "index": 0,
                            "function": {
                                "name": "file",
                                "arguments": ":\"test.sh\"}"
                            }
                        }
                    ]
                }
            }]
        });

        apply_stream_chunk(
            parse_stream_chunk_payload(&first_chunk.to_string())
                .expect("first fragmented tool call chunk should parse"),
            &mut accumulator,
        )
        .expect("first fragmented tool call chunk should apply");
        apply_stream_chunk(
            parse_stream_chunk_payload(&second_chunk.to_string())
                .expect("second fragmented tool call chunk should parse"),
            &mut accumulator,
        )
        .expect("second fragmented tool call chunk should apply");

        let response = stream_accumulator_to_response(accumulator, "test-model", None)
            .expect("tool calls should parse only after all fragments");

        assert_eq!(response.tool_calls.len(), 2);
        assert_eq!(response.tool_calls[0].id, "call-1");
        assert_eq!(response.tool_calls[0].name, "read_file");
        assert_eq!(response.tool_calls[0].arguments["path"], "test.sh");
        assert_eq!(response.tool_calls[1].id, "call-2");
        assert_eq!(response.tool_calls[1].name, "search_text");
        assert_eq!(response.tool_calls[1].arguments["query"], "agent");
    }

    #[tokio::test]
    async fn chat_uses_identity_non_streaming_request_and_ignores_bad_encoding_header() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server address should be available");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            let mut reader = BufReader::new(stream.try_clone().expect("stream should clone"));
            let mut headers = String::new();
            let mut content_length = 0usize;

            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .expect("header line should read");
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    content_length = value.trim().parse().expect("content-length should parse");
                }
                headers.push_str(&lower);
            }

            let mut body = vec![0u8; content_length];
            reader
                .read_exact(&mut body)
                .expect("request body should read");
            let body = String::from_utf8(body).expect("request body should be utf-8");

            assert!(headers.contains("accept-encoding: identity"));
            assert!(body.contains("\"stream\":false"));

            let response_body = r#"{"choices":[{"message":{"content":"ok"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .expect("response should write");
        });

        let request = AiProviderChatRequest::new(vec![AiProviderMessage::user("ping")]);
        let response = chat(
            &format!("http://{address}/v1"),
            "test-key",
            "test-model",
            request,
        )
        .await
        .expect("plain JSON with a bad encoding header should still parse");

        server.join().expect("test server should finish");
        assert_eq!(response.content, "ok");
    }

    #[tokio::test]
    async fn chat_reuses_provider_connection_for_sequential_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server address should be available");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect once");

            for index in 0..2 {
                let request = read_http_request(&mut stream);

                assert!(request.headers.contains("accept: application/json"));
                assert!(request.headers.contains("accept-encoding: identity"));
                assert!(request.body.contains("\"stream\":false"));

                let response_body =
                    format!(r#"{{"choices":[{{"message":{{"content":"ok-{index}"}}}}]}}"#);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("response should write");
            }

            listener
                .set_nonblocking(true)
                .expect("listener should become nonblocking");
            assert!(listener.accept().is_err());
        });

        let first_request = AiProviderChatRequest::new(vec![AiProviderMessage::user("ping-1")]);
        let first_response = chat(
            &format!("http://{address}/v1"),
            "test-key",
            "test-model",
            first_request,
        )
        .await
        .expect("first response should parse");
        let second_request = AiProviderChatRequest::new(vec![AiProviderMessage::user("ping-2")]);
        let second_response = chat(
            &format!("http://{address}/v1"),
            "test-key",
            "test-model",
            second_request,
        )
        .await
        .expect("second response should parse");

        server.join().expect("test server should finish");
        assert_eq!(first_response.content, "ok-0");
        assert_eq!(second_response.content, "ok-1");
    }

    #[tokio::test]
    async fn chat_falls_back_to_stream_when_non_streaming_body_decode_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server address should be available");
        let server = std::thread::spawn(move || {
            let (mut first_stream, _) = listener.accept().expect("first client should connect");
            let first_request = read_http_request(&mut first_stream);
            assert!(first_request.headers.contains("accept-encoding: identity"));
            assert!(first_request.body.contains("\"stream\":false"));

            let broken_chunked_response = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: application/json\r\n",
                "Transfer-Encoding: chunked\r\n",
                "Connection: close\r\n",
                "\r\n",
                "not-a-valid-chunk\r\n"
            );
            first_stream
                .write_all(broken_chunked_response.as_bytes())
                .expect("broken response should write");

            let (mut second_stream, _) = listener.accept().expect("second client should connect");
            let second_request = read_http_request(&mut second_stream);
            assert!(second_request.headers.contains("accept: text/event-stream"));
            assert!(second_request.headers.contains("accept-encoding: identity"));
            assert!(second_request.body.contains("\"stream\":true"));

            write_http_response(
                &mut second_stream,
                "text/event-stream",
                "data: {\"choices\":[{\"delta\":{\"content\":\"兜底成功\"}}]}\n\ndata: [DONE]\n\n",
            );
        });

        let request = AiProviderChatRequest::new(vec![AiProviderMessage::user("ping")]);
        let response = chat(
            &format!("http://{address}/v1"),
            "test-key",
            "test-model",
            request,
        )
        .await
        .expect("stream fallback should recover from body decode failure");

        server.join().expect("test server should finish");
        assert_eq!(response.content, "兜底成功");
        assert!(response.tool_calls.is_empty());
    }

    #[tokio::test]
    async fn chat_falls_back_to_stream_and_reassembles_tool_calls() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server address should be available");
        let server = std::thread::spawn(move || {
            let (mut first_stream, _) = listener.accept().expect("first client should connect");
            let first_request = read_http_request(&mut first_stream);
            assert!(first_request.body.contains("\"stream\":false"));
            write_http_response(&mut first_stream, "application/json", "not-json");

            let (mut second_stream, _) = listener.accept().expect("second client should connect");
            let second_request = read_http_request(&mut second_stream);
            assert!(second_request.body.contains("\"stream\":true"));

            let first_chunk = json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "call-1",
                            "function": {
                                "name": "read_",
                                "arguments": "{\"path\""
                            }
                        }]
                    }
                }]
            });
            let second_chunk = json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "function": {
                                "name": "file",
                                "arguments": ":\"test.sh\"}"
                            }
                        }]
                    }
                }]
            });
            let response_body = format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                first_chunk, second_chunk
            );
            write_http_response(&mut second_stream, "text/event-stream", &response_body);
        });

        let request = AiProviderChatRequest::new(vec![AiProviderMessage::user("read file")])
            .with_tools(vec![AiProviderToolSpec {
                name: "read_file".to_string(),
                description: "Read file.".to_string(),
                parameters: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }),
            }]);
        let response = chat(
            &format!("http://{address}/v1"),
            "test-key",
            "test-model",
            request,
        )
        .await
        .expect("stream fallback should reassemble tool calls");

        server.join().expect("test server should finish");
        assert_eq!(response.content, "");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "call-1");
        assert_eq!(response.tool_calls[0].name, "read_file");
        assert_eq!(response.tool_calls[0].arguments["path"], "test.sh");
    }

    #[test]
    fn rejects_invalid_tool_call_arguments() {
        let body = r#"{
          "choices": [{
            "message": {
              "content": null,
              "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {
                  "name": "search_text",
                  "arguments": "{broken"
                }
              }]
            }
          }]
        }"#;
        let parsed: ByotChatCompletionResponse =
            serde_json::from_str(body).expect("body should parse");

        let error = parse_chat_completion_response(parsed, "gpt-test", None)
            .expect_err("invalid arguments should fail");

        assert!(error.contains("AI_RESPONSE_INVALID"));
    }

    struct TestHttpRequest {
        headers: String,
        body: String,
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> TestHttpRequest {
        let mut reader = BufReader::new(stream.try_clone().expect("stream should clone"));
        let mut headers = String::new();
        let mut content_length = 0usize;

        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("header line should read");
            if line == "\r\n" || line.is_empty() {
                break;
            }
            let lower = line.to_ascii_lowercase();
            if let Some(value) = lower.strip_prefix("content-length:") {
                content_length = value.trim().parse().expect("content-length should parse");
            }
            headers.push_str(&lower);
        }

        let mut body = vec![0u8; content_length];
        reader
            .read_exact(&mut body)
            .expect("request body should read");
        let body = String::from_utf8(body).expect("request body should be utf-8");

        TestHttpRequest { headers, body }
    }

    fn write_http_response(stream: &mut std::net::TcpStream, content_type: &str, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("response should write");
    }
}
