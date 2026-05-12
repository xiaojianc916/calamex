use super::errors;
use super::provider::{
    AiProviderChatRequest, AiProviderMessage, AiProviderTokenEstimate, AiProviderToolSpec,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE},
    Engine as _,
};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tokenizers::Tokenizer;

const DEEPSEEK_TOKENIZER_JSON: &[u8] = include_bytes!("../../tokenizers/deepseek/tokenizer.json");
const QWEN_TOKENIZER_JSON: &[u8] = include_bytes!("../../tokenizers/qwen/tokenizer.json");
const O200K_TOKENIZER_JSON: &[u8] = include_bytes!("../../tokenizers/o200k/tokenizer.json");

const OPENAI_IMAGE_TILE_SIZE_PX: u32 = 512;
const OPENAI_GPT4O_TOKENS_PER_IMAGE_TILE: u64 = 170;

const DEEPSEEK_BOS_TOKEN: &str = "<｜begin▁of▁sentence｜>";
const DEEPSEEK_EOS_TOKEN: &str = "<｜end▁of▁sentence｜>";
const DEEPSEEK_USER_TOKEN: &str = "<｜User｜>";
const DEEPSEEK_ASSISTANT_TOKEN: &str = "<｜Assistant｜>";
const DEEPSEEK_LATEST_REMINDER_TOKEN: &str = "<｜latest_reminder｜>";
const DEEPSEEK_THINKING_START_TOKEN: &str = "<think>";
const DEEPSEEK_THINKING_END_TOKEN: &str = "</think>";
const DEEPSEEK_DSML_TOKEN: &str = "｜DSML｜";

static DEEPSEEK_TOKENIZER: OnceLock<Mutex<Result<Tokenizer, String>>> = OnceLock::new();
static QWEN_TOKENIZER: OnceLock<Mutex<Result<Tokenizer, String>>> = OnceLock::new();
static O200K_TOKENIZER: OnceLock<Mutex<Result<Tokenizer, String>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenizerFamily {
    DeepSeek,
    Qwen,
    O200k,
}

impl TokenizerFamily {
    fn name(self) -> &'static str {
        match self {
            Self::DeepSeek => "deepseek",
            Self::Qwen => "qwen",
            Self::O200k => "o200k",
        }
    }

    fn bytes(self) -> &'static [u8] {
        match self {
            Self::DeepSeek => DEEPSEEK_TOKENIZER_JSON,
            Self::Qwen => QWEN_TOKENIZER_JSON,
            Self::O200k => O200K_TOKENIZER_JSON,
        }
    }

    fn cell(self) -> &'static OnceLock<Mutex<Result<Tokenizer, String>>> {
        match self {
            Self::DeepSeek => &DEEPSEEK_TOKENIZER,
            Self::Qwen => &QWEN_TOKENIZER,
            Self::O200k => &O200K_TOKENIZER,
        }
    }
}

pub fn estimate_chat_prompt_tokens(
    model: &str,
    request: &AiProviderChatRequest,
) -> Result<AiProviderTokenEstimate, String> {
    let family = resolve_tokenizer_family(model).ok_or_else(|| {
        errors::error(
            "AI_TOKENIZER_UNSUPPORTED",
            format!("当前模型未配置本地 tokenizer，无法精确估算输入 token：{model}"),
        )
    })?;
    let input_tokens = count_prompt_tokens(model, family, request)?;

    Ok(AiProviderTokenEstimate {
        input_tokens,
        tokenizer: family.name().to_string(),
        model: model.to_string(),
    })
}

pub fn estimate_chat_prompt_tokens_if_supported(
    model: &str,
    request: &AiProviderChatRequest,
) -> Result<Option<AiProviderTokenEstimate>, String> {
    if resolve_tokenizer_family(model).is_none() {
        return Ok(None);
    }

    estimate_chat_prompt_tokens(model, request).map(Some)
}

pub fn estimate_text_tokens(model: &str, text: &str) -> Result<u64, String> {
    let family = resolve_tokenizer_family(model).ok_or_else(|| {
        errors::error(
            "AI_TOKENIZER_UNSUPPORTED",
            format!("当前模型未配置本地 tokenizer，无法估算输出 token：{model}"),
        )
    })?;

    count_text_tokens(family, text)
}

pub fn estimate_openai_tiled_image_tokens(width: u32, height: u32) -> Option<u64> {
    if width == 0 || height == 0 {
        return None;
    }

    let horizontal_tiles = width.div_ceil(OPENAI_IMAGE_TILE_SIZE_PX);
    let vertical_tiles = height.div_ceil(OPENAI_IMAGE_TILE_SIZE_PX);

    Some(
        u64::from(horizontal_tiles)
            * u64::from(vertical_tiles)
            * OPENAI_GPT4O_TOKENS_PER_IMAGE_TILE,
    )
}

fn resolve_tokenizer_family(model: &str) -> Option<TokenizerFamily> {
    let normalized = model.trim().to_ascii_lowercase();

    if normalized.contains("deepseek") {
        return Some(TokenizerFamily::DeepSeek);
    }

    if normalized.contains("qwen") || normalized.contains("dashscope") {
        return Some(TokenizerFamily::Qwen);
    }

    if normalized.contains("gpt-")
        || normalized.contains("openai/")
        || normalized.contains("o1")
        || normalized.contains("o3")
        || normalized.contains("o4")
        || normalized.contains("o200k")
    {
        return Some(TokenizerFamily::O200k);
    }

    None
}

fn count_prompt_tokens(
    model: &str,
    family: TokenizerFamily,
    request: &AiProviderChatRequest,
) -> Result<u64, String> {
    if family == TokenizerFamily::DeepSeek {
        return count_deepseek_v4_prompt_tokens(model, request);
    }

    let message_tokens = request.messages.iter().try_fold(0_u64, |total, message| {
        let role_tokens = count_text_tokens(family, &message.role)?;
        let content_tokens = count_message_content_tokens(family, &message.content)?;

        Ok::<u64, String>(total + role_tokens + content_tokens)
    })?;

    if request.tools.is_empty() {
        return Ok(message_tokens);
    }

    let tool_schema_tokens = count_text_tokens(
        family,
        &serde_json::to_string(&build_tool_schema_payload(&request.tools)).map_err(|error| {
            errors::error(
                "AI_TOKENIZER_FAILED",
                format!("序列化工具 schema 失败：{error}"),
            )
        })?,
    )?;

    Ok(message_tokens + tool_schema_tokens)
}

fn count_deepseek_v4_prompt_tokens(
    model: &str,
    request: &AiProviderChatRequest,
) -> Result<u64, String> {
    let prompt = render_deepseek_v4_prompt(model, request)?;

    count_text_tokens(TokenizerFamily::DeepSeek, &prompt)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeepseekThinkingMode {
    Chat,
    Thinking,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeepseekPromptMessage {
    role: String,
    content: String,
}

fn render_deepseek_v4_prompt(
    model: &str,
    request: &AiProviderChatRequest,
) -> Result<String, String> {
    let thinking_mode = resolve_deepseek_thinking_mode(model);
    let messages = normalize_deepseek_messages(&request.messages);
    let tool_attach_index = resolve_deepseek_tool_attach_index(&messages, request.tools.is_empty());
    let mut prompt = String::from(DEEPSEEK_BOS_TOKEN);

    if !request.tools.is_empty() && tool_attach_index.is_none() {
        prompt.push_str(&render_deepseek_tools(&request.tools)?);
    }

    for (index, message) in messages.iter().enumerate() {
        prompt.push_str(&render_deepseek_message(
            index,
            message,
            messages.get(index + 1),
            request.tools.as_slice(),
            tool_attach_index,
            thinking_mode,
        )?);
    }

    Ok(prompt)
}

fn resolve_deepseek_thinking_mode(model: &str) -> DeepseekThinkingMode {
    let normalized = model.trim().to_ascii_lowercase();

    if normalized.contains("reasoner")
        || normalized.contains("v4-pro")
        || normalized.contains("thinking")
    {
        return DeepseekThinkingMode::Thinking;
    }

    DeepseekThinkingMode::Chat
}

fn normalize_deepseek_messages(messages: &[AiProviderMessage]) -> Vec<DeepseekPromptMessage> {
    let mut normalized: Vec<DeepseekPromptMessage> = Vec::new();

    for message in messages {
        let role = message.role.trim().to_ascii_lowercase();

        if role == "tool" {
            let tool_content = render_deepseek_tool_result_message(&message.content);
            if let Some(previous) = normalized
                .last_mut()
                .filter(|previous| previous.role == "user")
            {
                if !previous.content.is_empty() {
                    previous.content.push_str("\n\n");
                }
                previous.content.push_str(&tool_content);
            } else {
                normalized.push(DeepseekPromptMessage {
                    role: "user".to_string(),
                    content: tool_content,
                });
            }
            continue;
        }

        if role == "user" {
            if let Some(previous) = normalized
                .last_mut()
                .filter(|previous| previous.role == "user")
            {
                if !previous.content.is_empty() {
                    previous.content.push_str("\n\n");
                }
                previous.content.push_str(&message.content);
                continue;
            }
        }

        normalized.push(DeepseekPromptMessage {
            role,
            content: message.content.clone(),
        });
    }

    normalized
}

fn render_deepseek_tool_result_message(content: &str) -> String {
    format!("<tool_result>{content}</tool_result>")
}

fn resolve_deepseek_tool_attach_index(
    messages: &[DeepseekPromptMessage],
    tools_empty: bool,
) -> Option<usize> {
    if tools_empty {
        return None;
    }

    messages
        .iter()
        .position(|message| matches!(message.role.as_str(), "system" | "developer"))
}

fn render_deepseek_message(
    index: usize,
    message: &DeepseekPromptMessage,
    next_message: Option<&DeepseekPromptMessage>,
    tools: &[AiProviderToolSpec],
    tool_attach_index: Option<usize>,
    thinking_mode: DeepseekThinkingMode,
) -> Result<String, String> {
    let mut prompt = String::new();

    match message.role.as_str() {
        "system" => {
            prompt.push_str(&message.content);
            if tool_attach_index == Some(index) {
                prompt.push_str("\n\n");
                prompt.push_str(&render_deepseek_tools(tools)?);
            }
        }
        "developer" => {
            prompt.push_str(DEEPSEEK_USER_TOKEN);
            prompt.push_str(&message.content);
            if tool_attach_index == Some(index) {
                prompt.push_str("\n\n");
                prompt.push_str(&render_deepseek_tools(tools)?);
            }
        }
        "assistant" => {
            prompt.push_str(&message.content);
            prompt.push_str(DEEPSEEK_EOS_TOKEN);
        }
        "latest_reminder" => {
            prompt.push_str(DEEPSEEK_LATEST_REMINDER_TOKEN);
            prompt.push_str(&message.content);
        }
        _ => {
            prompt.push_str(DEEPSEEK_USER_TOKEN);
            prompt.push_str(&message.content);
        }
    }

    if should_append_deepseek_assistant_prefix(&message.role, next_message) {
        prompt.push_str(DEEPSEEK_ASSISTANT_TOKEN);
        prompt.push_str(match thinking_mode {
            DeepseekThinkingMode::Thinking => DEEPSEEK_THINKING_START_TOKEN,
            DeepseekThinkingMode::Chat => DEEPSEEK_THINKING_END_TOKEN,
        });
    }

    Ok(prompt)
}

fn should_append_deepseek_assistant_prefix(
    role: &str,
    next_message: Option<&DeepseekPromptMessage>,
) -> bool {
    if !matches!(role, "user" | "developer") {
        return false;
    }

    next_message
        .map(|message| matches!(message.role.as_str(), "assistant" | "latest_reminder"))
        .unwrap_or(true)
}

fn render_deepseek_tools(tools: &[AiProviderToolSpec]) -> Result<String, String> {
    if tools.is_empty() {
        return Ok(String::new());
    }

    let mut tool_schemas = Vec::with_capacity(tools.len());

    for tool in tools {
        let schema = serde_json::to_string(&json!({
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }))
        .map_err(|error| {
            errors::error(
                "AI_TOKENIZER_FAILED",
                format!("序列化 DeepSeek 工具 schema 失败：{error}"),
            )
        })?;
        tool_schemas.push(schema);
    }

    let tool_schemas = tool_schemas.join("\n");

    Ok(format!(
        "## Tools\n\nYou have access to a set of tools to help answer the user's question. You can invoke tools by writing a \"<{DEEPSEEK_DSML_TOKEN}tool_calls>\" block like the following:\n\n<{DEEPSEEK_DSML_TOKEN}tool_calls>\n<{DEEPSEEK_DSML_TOKEN}invoke name=\"$TOOL_NAME\">\n<{DEEPSEEK_DSML_TOKEN}parameter name=\"$PARAMETER_NAME\" string=\"true|false\">$PARAMETER_VALUE</{DEEPSEEK_DSML_TOKEN}parameter>\n...\n</{DEEPSEEK_DSML_TOKEN}invoke>\n<{DEEPSEEK_DSML_TOKEN}invoke name=\"$TOOL_NAME2\">\n...\n</{DEEPSEEK_DSML_TOKEN}invoke>\n</{DEEPSEEK_DSML_TOKEN}tool_calls>\nString parameters should be specified as is and set `string=\"true\"`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set `string=\"false\"`.\n\nIf thinking_mode is enabled (triggered by {DEEPSEEK_THINKING_START_TOKEN}), you MUST output your complete reasoning inside {DEEPSEEK_THINKING_START_TOKEN}...{DEEPSEEK_THINKING_END_TOKEN} BEFORE any tool calls or final response.\n\nOtherwise, output directly after {DEEPSEEK_THINKING_END_TOKEN} with tool calls or final response.\n### Available Tool Schemas\n\n{tool_schemas}\n\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n"
    ))
}

fn count_message_content_tokens(family: TokenizerFamily, content: &str) -> Result<u64, String> {
    if family != TokenizerFamily::O200k || !content.contains("data:image/") {
        return count_text_tokens(family, content);
    }

    let normalized = normalize_openai_image_content(content)?;
    let text_tokens = count_text_tokens(family, &normalized.text)?;

    Ok(text_tokens + normalized.image_tokens)
}

fn count_text_tokens(family: TokenizerFamily, text: &str) -> Result<u64, String> {
    if text.is_empty() {
        return Ok(0);
    }

    with_tokenizer(family, |tokenizer| {
        tokenizer
            .encode(text, false)
            .map(|encoding| encoding.len() as u64)
            .map_err(|error| {
                errors::error(
                    "AI_TOKENIZER_FAILED",
                    format!("tokenizer({}) 编码失败：{error}", family.name()),
                )
            })
    })
}

fn with_tokenizer<T>(
    family: TokenizerFamily,
    callback: impl FnOnce(&Tokenizer) -> Result<T, String>,
) -> Result<T, String> {
    let tokenizer = family
        .cell()
        .get_or_init(|| Mutex::new(load_tokenizer(family)));
    let guard = tokenizer.lock().map_err(|_| {
        errors::error(
            "AI_TOKENIZER_FAILED",
            format!("tokenizer({}) 状态锁已损坏。", family.name()),
        )
    })?;

    match guard.as_ref() {
        Ok(tokenizer) => callback(tokenizer),
        Err(error) => Err(error.clone()),
    }
}

fn load_tokenizer(family: TokenizerFamily) -> Result<Tokenizer, String> {
    Tokenizer::from_bytes(family.bytes()).map_err(|error| {
        errors::error(
            "AI_TOKENIZER_FAILED",
            format!("加载 tokenizer({}) 失败：{error}", family.name()),
        )
    })
}

fn build_tool_schema_payload(tools: &[AiProviderToolSpec]) -> Vec<Value> {
    tools
        .iter()
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

#[cfg(test)]
fn estimate_image_tokens_from_content(family: TokenizerFamily, content: &str) -> u64 {
    if family != TokenizerFamily::O200k || !content.contains("data:image/") {
        return 0;
    }

    normalize_openai_image_content(content)
        .map(|normalized| normalized.image_tokens)
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalizedImageContent {
    text: String,
    image_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DataImageUrl {
    start: usize,
    end: usize,
    payload: String,
}

fn normalize_openai_image_content(content: &str) -> Result<NormalizedImageContent, String> {
    let image_urls = find_base64_image_data_urls(content);

    if image_urls.is_empty() {
        return Ok(NormalizedImageContent {
            text: content.to_string(),
            image_tokens: 0,
        });
    }

    let mut text = String::with_capacity(content.len());
    let mut cursor = 0;
    let mut image_tokens = 0_u64;

    for image_url in image_urls {
        text.push_str(&content[cursor..image_url.start]);
        text.push('\n');
        cursor = image_url.end;

        let parsed_text_dimensions = parse_image_dimensions(content);
        let parsed_binary_dimensions = match decode_image_payload(&image_url.payload) {
            Ok(decoded) => parse_image_dimensions_from_bytes(&decoded),
            Err(error) => {
                if parsed_text_dimensions.is_none() {
                    return Err(error);
                }

                None
            }
        };
        let (width, height) = parsed_binary_dimensions
            .or(parsed_text_dimensions)
            .ok_or_else(|| {
                errors::error(
                    "AI_TOKENIZER_FAILED",
                    "无法解析图片尺寸，无法按 provider 公式估算图片 token。".to_string(),
                )
            })?;

        image_tokens += estimate_openai_tiled_image_tokens(width, height).ok_or_else(|| {
            errors::error(
                "AI_TOKENIZER_FAILED",
                "图片尺寸无效，无法按 provider 公式估算图片 token。".to_string(),
            )
        })?;
    }

    text.push_str(&content[cursor..]);

    Ok(NormalizedImageContent { text, image_tokens })
}

fn find_base64_image_data_urls(content: &str) -> Vec<DataImageUrl> {
    const DATA_IMAGE_PREFIX: &str = "data:image/";
    const BASE64_MARKER: &str = ";base64,";

    let mut urls = Vec::new();
    let mut search_start = 0;

    while let Some(relative_start) = content[search_start..].find(DATA_IMAGE_PREFIX) {
        let start = search_start + relative_start;
        let Some(relative_marker) = content[start..].find(BASE64_MARKER) else {
            search_start = start + DATA_IMAGE_PREFIX.len();
            continue;
        };
        let payload_start = start + relative_marker + BASE64_MARKER.len();
        let payload_end = content[payload_start..]
            .char_indices()
            .find_map(|(offset, character)| {
                (!is_base64_data_url_character(character)).then_some(payload_start + offset)
            })
            .unwrap_or(content.len());

        if payload_end > payload_start {
            urls.push(DataImageUrl {
                start,
                end: payload_end,
                payload: content[payload_start..payload_end].to_string(),
            });
        }

        search_start = payload_end.max(start + DATA_IMAGE_PREFIX.len());
    }

    urls
}

fn is_base64_data_url_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=' | '-' | '_')
}

fn decode_image_payload(payload: &str) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(payload.as_bytes())
        .or_else(|_| URL_SAFE.decode(payload.as_bytes()))
        .map_err(|error| {
            errors::error(
                "AI_TOKENIZER_FAILED",
                format!("解析图片 base64 失败，无法估算图片 token：{error}"),
            )
        })
}

fn parse_image_dimensions_from_bytes(bytes: &[u8]) -> Option<(u32, u32)> {
    parse_png_dimensions(bytes)
        .or_else(|| parse_jpeg_dimensions(bytes))
        .or_else(|| parse_webp_dimensions(bytes))
}

fn parse_png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }

    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);

    Some((width, height))
}

fn parse_jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return None;
    }

    let mut index = 2;

    while index + 3 < bytes.len() {
        if bytes[index] != 0xff {
            index += 1;
            continue;
        }

        while index < bytes.len() && bytes[index] == 0xff {
            index += 1;
        }

        if index >= bytes.len() {
            break;
        }

        let marker = bytes[index];
        index += 1;

        if marker == 0xd9 || marker == 0xda {
            break;
        }

        if index + 1 >= bytes.len() {
            break;
        }

        let segment_length = u16::from_be_bytes([bytes[index], bytes[index + 1]]) as usize;
        if segment_length < 2 || index + segment_length > bytes.len() {
            break;
        }

        if is_jpeg_start_of_frame(marker) && segment_length >= 7 {
            let height = u16::from_be_bytes([bytes[index + 3], bytes[index + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u32;
            return Some((width, height));
        }

        index += segment_length;
    }

    None
}

fn is_jpeg_start_of_frame(marker: u8) -> bool {
    matches!(
        marker,
        0xc0 | 0xc1 | 0xc2 | 0xc3 | 0xc5 | 0xc6 | 0xc7 | 0xc9 | 0xca | 0xcb | 0xcd | 0xce | 0xcf
    )
}

fn parse_webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 16 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }

    let mut index = 12;

    while index + 8 <= bytes.len() {
        let chunk_type = &bytes[index..index + 4];
        let chunk_size = u32::from_le_bytes(bytes[index + 4..index + 8].try_into().ok()?) as usize;
        let payload_start = index + 8;
        let payload_end = payload_start.checked_add(chunk_size)?;

        if payload_end > bytes.len() {
            return None;
        }

        match chunk_type {
            b"VP8X" if chunk_size >= 10 => {
                let width =
                    read_le_u24(&bytes[payload_start + 4..payload_start + 7])?.saturating_add(1);
                let height =
                    read_le_u24(&bytes[payload_start + 7..payload_start + 10])?.saturating_add(1);
                return Some((width, height));
            }
            b"VP8 " if chunk_size >= 10 => {
                let frame = &bytes[payload_start..payload_end];
                if frame.len() < 10 || frame[3..6] != [0x9d, 0x01, 0x2a] {
                    return None;
                }

                let width = u16::from_le_bytes([frame[6], frame[7]]) as u32 & 0x3fff;
                let height = u16::from_le_bytes([frame[8], frame[9]]) as u32 & 0x3fff;
                return Some((width, height));
            }
            b"VP8L" if chunk_size >= 5 => {
                let frame = &bytes[payload_start..payload_end];
                if frame.first().copied() != Some(0x2f) {
                    return None;
                }

                let width = 1 + (u32::from(frame[1]) | ((u32::from(frame[2]) & 0x3f) << 8));
                let height = 1
                    + (((u32::from(frame[2]) & 0xc0) >> 6)
                        | (u32::from(frame[3]) << 2)
                        | ((u32::from(frame[4]) & 0x0f) << 10));
                return Some((width, height));
            }
            _ => {}
        }

        index = payload_end + (chunk_size % 2);
    }

    None
}

fn read_le_u24(bytes: &[u8]) -> Option<u32> {
    if bytes.len() != 3 {
        return None;
    }

    Some(u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16))
}

fn parse_image_dimensions(content: &str) -> Option<(u32, u32)> {
    for separator in ['×', 'x', 'X'] {
        let Some(separator_index) = content.find(separator) else {
            continue;
        };
        let left = content[..separator_index]
            .chars()
            .rev()
            .take_while(|item| item.is_ascii_digit() || item.is_whitespace())
            .collect::<String>();
        let width_text = left.chars().rev().collect::<String>();
        let height_text = content[separator_index + separator.len_utf8()..]
            .chars()
            .take_while(|item| item.is_ascii_digit() || item.is_whitespace())
            .collect::<String>();
        let Some(width) = width_text.trim().parse::<u32>().ok() else {
            continue;
        };
        let Some(height) = height_text.trim().parse::<u32>().ok() else {
            continue;
        };

        return Some((width, height));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        estimate_chat_prompt_tokens, estimate_image_tokens_from_content,
        estimate_openai_tiled_image_tokens, estimate_text_tokens, render_deepseek_v4_prompt,
        TokenizerFamily, DEEPSEEK_ASSISTANT_TOKEN, DEEPSEEK_BOS_TOKEN, DEEPSEEK_THINKING_END_TOKEN,
        DEEPSEEK_THINKING_START_TOKEN, DEEPSEEK_USER_TOKEN,
    };
    use crate::ai::provider::{AiProviderChatRequest, AiProviderMessage, AiProviderToolSpec};
    use serde_json::json;

    #[test]
    fn estimates_prompt_with_messages_and_tools() {
        let request = AiProviderChatRequest::new(vec![
            AiProviderMessage::system("你是小建C桌面应用中的 AI 编程助手。"),
            AiProviderMessage::user("请解释这个脚本。"),
        ])
        .with_tools(vec![AiProviderToolSpec {
            name: "read_file".to_string(),
            description: "读取文件".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
        }]);

        let estimate =
            estimate_chat_prompt_tokens("deepseek/deepseek-chat", &request).expect("estimate");

        assert!(estimate.input_tokens > 0);
        assert_eq!(estimate.tokenizer, "deepseek");
    }

    #[test]
    fn renders_deepseek_v4_prompt_with_chat_marker() {
        let request = AiProviderChatRequest::new(vec![
            AiProviderMessage::system("系统提示"),
            AiProviderMessage::user("你好"),
        ]);

        let prompt =
            render_deepseek_v4_prompt("deepseek/deepseek-v4-flash", &request).expect("prompt");

        assert!(prompt.starts_with(DEEPSEEK_BOS_TOKEN));
        assert!(prompt.contains(DEEPSEEK_USER_TOKEN));
        assert!(prompt.contains(DEEPSEEK_ASSISTANT_TOKEN));
        assert!(prompt.ends_with(DEEPSEEK_THINKING_END_TOKEN));
    }

    #[test]
    fn renders_deepseek_v4_prompt_with_thinking_marker_for_reasoning_models() {
        let request = AiProviderChatRequest::new(vec![AiProviderMessage::user("分析一下")]);

        let prompt =
            render_deepseek_v4_prompt("deepseek/deepseek-v4-pro", &request).expect("prompt");

        assert!(prompt.ends_with(DEEPSEEK_THINKING_START_TOKEN));
    }

    #[test]
    fn renders_deepseek_tools_as_official_schema_block() {
        let request = AiProviderChatRequest::new(vec![
            AiProviderMessage::system("系统提示"),
            AiProviderMessage::user("读取文件"),
        ])
        .with_tools(vec![AiProviderToolSpec {
            name: "read_file".to_string(),
            description: "读取文件".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
        }]);

        let prompt =
            render_deepseek_v4_prompt("deepseek/deepseek-v4-flash", &request).expect("prompt");

        assert!(prompt.contains("### Available Tool Schemas"));
        assert!(prompt.contains(r#""name":"read_file""#));
        assert!(prompt.contains(r#""description":"读取文件""#));
        assert!(!prompt.contains(r#""type":"function""#));
    }

    #[test]
    fn counts_whitespace_text_tokens_when_provider_would_see_them() {
        let tokens = estimate_text_tokens("deepseek/deepseek-v4-flash", " ").expect("tokens");

        assert!(tokens > 0);
    }

    #[test]
    fn estimates_completion_text_with_o200k() {
        let tokens = estimate_text_tokens("openai/gpt-4o", "你好，world").expect("tokens");

        assert!(tokens > 0);
    }

    #[test]
    fn estimates_openai_image_tiles() {
        assert_eq!(estimate_openai_tiled_image_tokens(1024, 768), Some(680));
        assert_eq!(estimate_openai_tiled_image_tokens(0, 768), None);
        assert_eq!(
            estimate_image_tokens_from_content(
                TokenizerFamily::O200k,
                "data:image/png;base64,abc\n尺寸：1024 × 768",
            ),
            680,
        );
    }

    #[test]
    fn estimates_data_url_image_by_tiles_instead_of_base64_text() {
        let image =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

        assert_eq!(
            estimate_image_tokens_from_content(TokenizerFamily::O200k, image),
            170,
        );
    }
}
