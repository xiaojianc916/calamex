use super::errors;
use super::provider::{
    AiProviderChatRequest, AiProviderMessage, AiProviderResponse, AiProviderTokenEstimate,
    AiProviderToolCall, AiProviderToolSpec, AiProviderUsage,
};
use super::redaction::redact_text;
use super::token_budget;
use reqwest::header::{ACCEPT, ACCEPT_ENCODING};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const PROVIDER_STREAM_TIMEOUT: Duration = Duration::from_secs(180);
const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROVIDER_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const PROVIDER_POOL_MAX_IDLE_PER_HOST: usize = 8;
const MAX_PROVIDER_ERROR_BODY_CHARS: usize = 600;

static PROVIDER_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatCompletionChoice>,
    usage: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChoice {
    message: ChatCompletionMessage,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<OpenAiToolCall>,
}

#[derive(Debug, Deserialize)]
struct OpenAiToolCall {
    id: Option<String>,
    #[serde(default)]
    r#type: String,
    function: Option<OpenAiToolCallFunction>,
}

#[derive(Debug, Deserialize)]
struct OpenAiToolCallFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionStreamChunk {
    #[serde(default)]
    choices: Vec<ChatCompletionStreamChoice>,
    usage: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionStreamChoice {
    #[serde(default)]
    delta: Option<ChatCompletionStreamDelta>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionStreamDelta {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<OpenAiStreamToolCall>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamToolCall {
    index: Option<usize>,
    id: Option<String>,
    function: Option<OpenAiStreamToolCallFunction>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamToolCallFunction {
    name: Option<String>,
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
    let client = provider_client()?;

    let body = build_chat_request_body(model, request, false);

    let response = client
        .post(format!("{base_url}/chat/completions"))
        .timeout(PROVIDER_REQUEST_TIMEOUT)
        .bearer_auth(api_key)
        .header(ACCEPT, "application/json")
        .header(ACCEPT_ENCODING, "identity")
        .json(&body)
        .send()
        .await
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;

    let status = response.status();
    let body = read_response_body_lossy(response).await?;

    ensure_success_status(status, &body)?;

    parse_chat_completion_response(&body, model, prompt_estimate)
}

async fn chat_stream_response(
    base_url: &str,
    api_key: &str,
    model: &str,
    request: AiProviderChatRequest,
    prompt_estimate: Option<AiProviderTokenEstimate>,
) -> Result<AiProviderResponse, String> {
    let client = provider_client()?;

    let body = build_chat_request_body(model, request, true);

    let mut response = client
        .post(format!("{base_url}/chat/completions"))
        .timeout(PROVIDER_STREAM_TIMEOUT)
        .bearer_auth(api_key)
        .header(ACCEPT, "text/event-stream")
        .header(ACCEPT_ENCODING, "identity")
        .json(&body)
        .send()
        .await
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;

    let status = response.status();

    if !status.is_success() {
        let body = read_response_body_lossy(response).await?;

        return match ensure_success_status(status, &body) {
            Ok(()) => Err(errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                "AI Provider 流式响应状态异常。",
            )),
            Err(error) => Err(error),
        };
    }

    let mut buffer: Vec<u8> = Vec::new();
    let mut accumulator = StreamResponseAccumulator::default();

    while let Some(chunk) = response.chunk().await.map_err(|error| {
        errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!(
                "读取 AI Provider 流式响应失败：{}",
                provider_body_read_error_message(&error)
            ),
        )
    })? {
        buffer.extend_from_slice(&chunk);

        for line in drain_complete_utf8_lines(&mut buffer)? {
            if apply_stream_line(&line, &mut accumulator)? {
                return stream_accumulator_to_response(accumulator, model, prompt_estimate.clone());
            }
        }
    }

    if has_non_whitespace_bytes(&buffer) {
        let line = decode_stream_line_bytes(buffer)?;
        apply_stream_line(&line, &mut accumulator)?;
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

    let client = provider_client()?;

    let body = build_chat_request_body(model, request, true);

    let mut response = client
        .post(format!("{base_url}/chat/completions"))
        .timeout(PROVIDER_STREAM_TIMEOUT)
        .bearer_auth(api_key)
        .header(ACCEPT, "text/event-stream")
        .header(ACCEPT_ENCODING, "identity")
        .json(&body)
        .send()
        .await
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?;

    let status = response.status();

    if !status.is_success() {
        let body = read_response_body_lossy(response).await?;

        return ensure_success_status(status, &body);
    }

    let mut buffer: Vec<u8> = Vec::new();
    let mut completion_tokens_estimate = Some(0_u64);
    let mut completion_text = String::new();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| errors::error("AI_PROVIDER_UNAVAILABLE", error.to_string()))?
    {
        if is_cancelled() {
            return Err(errors::error("AI_REQUEST_CANCELLED", "AI 请求已取消。"));
        }

        buffer.extend_from_slice(&chunk);

        for line in drain_complete_utf8_lines(&mut buffer)? {
            if is_cancelled() {
                return Err(errors::error("AI_REQUEST_CANCELLED", "AI 请求已取消。"));
            }

            let should_finish = handle_sse_line(
                model,
                &line,
                &mut completion_text,
                &mut completion_tokens_estimate,
                &mut on_event,
            )?;

            if should_finish {
                return Ok(());
            }
        }
    }

    if is_cancelled() {
        return Err(errors::error("AI_REQUEST_CANCELLED", "AI 请求已取消。"));
    }

    if has_non_whitespace_bytes(&buffer) {
        let line = decode_stream_line_bytes(buffer)?;
        let should_finish = handle_sse_line(
            model,
            &line,
            &mut completion_text,
            &mut completion_tokens_estimate,
            &mut on_event,
        )?;

        if should_finish {
            return Ok(());
        }
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

fn provider_client() -> Result<reqwest::Client, String> {
    PROVIDER_CLIENT
        .get_or_init(build_provider_client)
        .as_ref()
        .map(reqwest::Client::clone)
        .map_err(String::clone)
}

fn build_provider_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
        .pool_idle_timeout(PROVIDER_POOL_IDLE_TIMEOUT)
        .pool_max_idle_per_host(PROVIDER_POOL_MAX_IDLE_PER_HOST)
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

async fn read_response_body_lossy(response: reqwest::Response) -> Result<String, String> {
    let bytes = response.bytes().await.map_err(|error| {
        errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!(
                "读取 AI Provider 响应体失败：{}",
                provider_body_read_error_message(&error)
            ),
        )
    })?;

    Ok(response_body_bytes_to_string(bytes.as_ref()))
}

fn response_body_bytes_to_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .to_string()
}

fn drain_complete_utf8_lines(buffer: &mut Vec<u8>) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();

    while let Some(line_end) = buffer.iter().position(|byte| *byte == b'\n') {
        let line_bytes = buffer.drain(..=line_end).collect::<Vec<u8>>();
        lines.push(decode_stream_line_bytes(line_bytes)?);
    }

    Ok(lines)
}

fn decode_stream_line_bytes(mut line_bytes: Vec<u8>) -> Result<String, String> {
    if line_bytes.ends_with(b"\n") {
        line_bytes.pop();
    }

    if line_bytes.ends_with(b"\r") {
        line_bytes.pop();
    }

    String::from_utf8(line_bytes).map_err(|error| {
        errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!("AI Provider 流式响应包含非法 UTF-8：{error}"),
        )
    })
}

fn has_non_whitespace_bytes(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .any(|byte| !matches!(*byte, b' ' | b'\t' | b'\r' | b'\n'))
}

fn provider_body_read_error_message(error: &reqwest::Error) -> String {
    if error.is_decode() {
        return "Provider 返回体解码失败。已请求 identity 编码，请检查该兼容网关是否返回了损坏压缩、错误 Content-Encoding 或被中途截断的响应。"
            .to_string();
    }

    error.to_string()
}

fn build_chat_request_body(
    model: &str,
    request: AiProviderChatRequest,
    stream: bool,
) -> serde_json::Value {
    let mut body = json!({
        "model": model,
        "messages": build_chat_messages(request.messages),
        "temperature": 0.2,
        "stream": stream,
    });

    if stream {
        body["stream_options"] = json!({
            "include_usage": true,
        });
    }

    if request.force_tool_choice_none {
        body["tool_choice"] = json!("none");
    } else if !request.tools.is_empty() {
        body["tools"] = json!(build_chat_tools(request.tools));
        body["tool_choice"] = json!("auto");
    }

    body
}

fn build_chat_tools(tools: Vec<AiProviderToolSpec>) -> Vec<Value> {
    tools
        .into_iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                }
            })
        })
        .collect()
}

fn parse_chat_completion_response(
    body: &str,
    model: &str,
    prompt_estimate: Option<AiProviderTokenEstimate>,
) -> Result<AiProviderResponse, String> {
    let parsed = serde_json::from_str::<ChatCompletionResponse>(body).map_err(|error| {
        errors::error(
            "AI_RESPONSE_INVALID",
            format!("AI Provider 非流式响应 JSON 解析失败：{error}"),
        )
    })?;

    let Some(choice) = parsed.choices.into_iter().next() else {
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
        parsed.usage.map(AiProviderUsage::from_openai_usage),
        prompt_estimate,
    ))
}

fn normalize_openai_tool_calls(
    tool_calls: Vec<OpenAiToolCall>,
) -> Result<Vec<AiProviderToolCall>, String> {
    tool_calls
        .into_iter()
        .enumerate()
        .filter(|(_, call)| call.r#type.is_empty() || call.r#type == "function")
        .map(|(index, call)| {
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
            let arguments = if function.arguments.trim().is_empty() {
                Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str::<Value>(&function.arguments).map_err(|error| {
                    errors::error(
                        "AI_RESPONSE_INVALID",
                        format!("Tool call arguments are not valid JSON: {error}"),
                    )
                })?
            };

            Ok(AiProviderToolCall {
                id: call.id.unwrap_or_else(|| format!("tool-call-{index}")),
                name: name.to_string(),
                arguments,
            })
        })
        .collect()
}

fn should_retry_chat_as_stream(error: &str) -> bool {
    error.contains("读取 AI Provider 响应体失败")
        || error.contains("响应体解码失败")
        || error.contains("Provider 返回体解码失败")
        || error.contains("AI Provider 非流式响应 JSON 解析失败")
        || error.to_ascii_lowercase().contains("decode")
}

fn apply_stream_line(
    line: &str,
    accumulator: &mut StreamResponseAccumulator,
) -> Result<bool, String> {
    let trimmed = line.trim();

    if trimmed.is_empty() || trimmed.starts_with(':') {
        return Ok(false);
    }

    let Some(data) = trimmed.strip_prefix("data:") else {
        return Ok(false);
    };

    let payload = data.trim();

    if payload.is_empty() {
        return Ok(false);
    }

    if payload == "[DONE]" {
        return Ok(true);
    }

    apply_stream_payload(payload, accumulator)?;

    Ok(false)
}

fn apply_stream_payload(
    payload: &str,
    accumulator: &mut StreamResponseAccumulator,
) -> Result<(), String> {
    let parsed = serde_json::from_str::<ChatCompletionStreamChunk>(payload).map_err(|error| {
        errors::error(
            "AI_RESPONSE_INVALID",
            format!("AI Provider 流式响应 chunk 解析失败：{error}"),
        )
    })?;

    if let Some(usage) = parsed.usage {
        accumulator.usage = Some(AiProviderUsage::from_openai_usage(usage));
    }

    for choice in parsed.choices {
        let Some(delta) = choice.delta else {
            continue;
        };

        if let Some(content) = delta.content {
            accumulator.content.push_str(&content);
        }

        for tool_call in delta.tool_calls {
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

            let arguments = if call.arguments.trim().is_empty() {
                Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str::<Value>(&call.arguments).map_err(|error| {
                    errors::error(
                        "AI_RESPONSE_INVALID",
                        format!("流式工具调用参数不是合法 JSON：{error}"),
                    )
                })?
            };

            Ok(AiProviderToolCall {
                id: call.id.unwrap_or_else(|| format!("tool-call-{index}")),
                name: name.to_string(),
                arguments,
            })
        })
        .collect()
}

fn handle_sse_line<F>(
    model: &str,
    line: &str,
    completion_text: &mut String,
    completion_tokens_estimate: &mut Option<u64>,
    on_event: &mut F,
) -> Result<bool, String>
where
    F: FnMut(AiProviderStreamEvent) -> Result<(), String>,
{
    let (outcome, delta, usage) = parse_stream_line(line)?;

    if let Some(usage) = usage {
        on_event(AiProviderStreamEvent::Usage { usage })?;
    }

    if let Some(delta) = delta {
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
    }

    Ok(matches!(outcome, StreamLineOutcome::Done))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamLineOutcome {
    Continue,
    Done,
}

fn parse_stream_line(
    line: &str,
) -> Result<(StreamLineOutcome, Option<String>, Option<AiProviderUsage>), String> {
    let trimmed = line.trim();

    if trimmed.is_empty() || trimmed.starts_with(':') {
        return Ok((StreamLineOutcome::Continue, None, None));
    }

    let Some(data) = trimmed.strip_prefix("data:") else {
        return Ok((StreamLineOutcome::Continue, None, None));
    };

    let payload = data.trim();

    if payload.is_empty() {
        return Ok((StreamLineOutcome::Continue, None, None));
    }

    if payload == "[DONE]" {
        return Ok((StreamLineOutcome::Done, None, None));
    }

    let parsed = serde_json::from_str::<ChatCompletionStreamChunk>(payload).map_err(|error| {
        errors::error(
            "AI_RESPONSE_INVALID",
            format!("AI stream chunk 解析失败：{error}"),
        )
    })?;
    let usage = parsed.usage.map(AiProviderUsage::from_openai_usage);
    let delta = parsed
        .choices
        .into_iter()
        .filter_map(|choice| choice.delta)
        .filter_map(|delta| delta.content)
        .collect::<String>();

    Ok((
        StreamLineOutcome::Continue,
        (!delta.is_empty()).then_some(delta),
        usage,
    ))
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

fn ensure_success_status(status: StatusCode, body: &str) -> Result<(), String> {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(errors::error(
            "AI_PROVIDER_AUTH_FAILED",
            "AI Provider 鉴权失败。",
        ));
    }

    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(errors::error(
            "AI_PROVIDER_RATE_LIMITED",
            "AI Provider 触发限流。",
        ));
    }

    if !status.is_success() {
        return Err(errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!("AI Provider 返回错误 {status}: {}", summarize_body(body)),
        ));
    }

    Ok(())
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
        apply_stream_line, build_chat_request_body, chat, drain_complete_utf8_lines,
        parse_chat_completion_response, response_body_bytes_to_string,
        stream_accumulator_to_response, summarize_body, update_completion_tokens_estimate,
        validate_base_url, StreamResponseAccumulator,
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

        let response = parse_chat_completion_response(body, "gpt-test", None).expect("response");

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

        let body = build_chat_request_body("gpt-test", request, false);

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

        let body = build_chat_request_body("gpt-test", request, false);

        assert_eq!(body["tool_choice"], "none");
        assert!(body["tools"].is_null());
    }

    #[test]
    fn stream_request_body_enables_usage_frames() {
        let request = AiProviderChatRequest::new(vec![AiProviderMessage::user("stream")]);

        let body = build_chat_request_body("gpt-test", request, true);

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
            "prompt_cache_hit_tokens": 3,
            "prompt_cache_miss_tokens": 8,
            "completion_tokens_details": {
              "reasoning_tokens": 2
            }
          }
        }"#;

        let response = parse_chat_completion_response(body, "gpt-test", None).expect("response");
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
    fn stream_line_buffer_waits_for_complete_utf8_line_before_decoding() {
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"你好🙂\"}}]}\n";
        let split_at = line.find('你').expect("line should contain chinese") + 2;
        let bytes = line.as_bytes();
        let mut buffer = Vec::new();

        buffer.extend_from_slice(&bytes[..split_at]);
        let lines = drain_complete_utf8_lines(&mut buffer).expect("partial chunk should parse");
        assert!(lines.is_empty());

        buffer.extend_from_slice(&bytes[split_at..]);
        let lines = drain_complete_utf8_lines(&mut buffer).expect("full line should parse");

        assert_eq!(lines, vec![line.trim_end_matches('\n').to_string()]);
        assert!(!lines[0].contains('�'));
        assert!(buffer.is_empty());
    }

    #[test]
    fn stream_line_buffer_supports_lf_and_crlf_line_endings() {
        let mut buffer =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\ndata: [DONE]\n".to_vec();

        let lines = drain_complete_utf8_lines(&mut buffer).expect("lines should decode");

        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0],
            "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}"
        );
        assert_eq!(lines[1], "data: [DONE]");
        assert!(buffer.is_empty());
    }

    #[test]
    fn stream_line_done_marker_returns_finish_without_waiting_more_chunks() {
        let mut accumulator = StreamResponseAccumulator::default();

        let should_finish =
            apply_stream_line("data: [DONE]", &mut accumulator).expect("done should parse");

        assert!(should_finish);
        assert!(accumulator.content.is_empty());
        assert!(accumulator.tool_calls.is_empty());
    }

    #[test]
    fn stream_payload_ignores_empty_and_role_only_delta() {
        let mut accumulator = StreamResponseAccumulator::default();

        let empty_delta =
            apply_stream_line(r#"data: {"choices":[{"delta":{}}]}"#, &mut accumulator)
                .expect("empty delta should parse");
        let role_delta = apply_stream_line(
            r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#,
            &mut accumulator,
        )
        .expect("role-only delta should parse");
        let content_delta = apply_stream_line(
            r#"data: {"choices":[{"delta":{"content":"ok"}}]}"#,
            &mut accumulator,
        )
        .expect("content delta should parse");

        assert!(!empty_delta);
        assert!(!role_delta);
        assert!(!content_delta);
        assert_eq!(accumulator.content, "ok");
        assert!(accumulator.tool_calls.is_empty());
    }

    #[test]
    fn stream_payload_records_usage_frame() {
        let mut accumulator = StreamResponseAccumulator::default();

        apply_stream_line(
            r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}"#,
            &mut accumulator,
        )
        .expect("usage chunk should parse");

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

        apply_stream_line(&format!("data: {first_chunk}"), &mut accumulator)
            .expect("first fragmented tool call chunk should parse");
        apply_stream_line(&format!("data: {second_chunk}"), &mut accumulator)
            .expect("second fragmented tool call chunk should parse");

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

        let error = parse_chat_completion_response(body, "gpt-test", None)
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
