#[cfg(test)]
use super::prompt::build_identity_system_message;
use super::prompt::{
    build_conversation_title_prompt, build_inline_prompt, clip_title_source,
};
use super::*;
use crate::commands::contracts::{AgentSidecarChatRequest, AgentSidecarMessagePayload};
use tauri::Manager as _;

fn to_sidecar_message_payloads(
    messages: Vec<AiProviderMessage>,
) -> Vec<AgentSidecarMessagePayload> {
    messages
        .into_iter()
        .map(|message| AgentSidecarMessagePayload {
            role: message.role,
            content: message.content,
        })
        .collect()
}

fn sidecar_events_result_text(
    payload: &crate::commands::contracts::AgentSidecarResponsePayload,
) -> String {
    payload.result.clone().unwrap_or_default()
}

/// ACP 路径下的一次性模型调用辅助。
///
/// 若 request 尚未携带 model_config，则用传入的 model_config 补齐；
/// 随后通过托管态 AcpRuntime 获取（或惰性启动）ACP 宿主，发起 model/chat 透传。
async fn run_model_chat_via_acp(
    app: &AppHandle,
    mut request: AgentSidecarChatRequest,
    model_config: crate::commands::contracts::AgentSidecarModelConfigPayload,
) -> Result<crate::commands::contracts::AgentSidecarResponsePayload, String> {
    request.model_config.get_or_insert(model_config);
    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn(app)
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("无法建立 ACP 宿主连接：{error}"),
            )
        })?;
    host.model_chat(crate::acp::chat_request_to_model_chat_ext(request))
        .await
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("ACP 模型透传失败：{error}"),
            )
        })
}

pub async fn generate_conversation_title(
    app: &AppHandle,
    payload: AiConversationTitleRequest,
) -> Result<AiConversationTitlePayload, String> {
    let config = current_config()?;
    ensure_chat_enabled(&config)?;
    let narrator_config = &config.narrator;

    let user_message = clip_title_source(&payload.user_message);
    let assistant_message = clip_title_source(&payload.assistant_message);

    if user_message.trim().is_empty() || assistant_message.trim().is_empty() {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "第一轮问答内容为空，无法生成会话标题。",
        ));
    }

    let model = narrator_config
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_NARRATOR_MODEL);
    let request = AiProviderChatRequest::new(vec![
        AiProviderMessage::system(
            "你是会话标题生成器。只输出 5 到 10 个中文字符的标题，不要解释。",
        ),
        AiProviderMessage::user(build_conversation_title_prompt(
            &user_message,
            &assistant_message,
        )),
    ]);
    let request_payload = AgentSidecarChatRequest {
        session_id: None,
        mode: Some("ask".to_string()),
        goal: Some("生成会话标题".to_string()),
        messages: to_sidecar_message_payloads(request.messages),
        workspace_root_path: None,
        context: Vec::new(),
        model_config: None,
        thread_id: None,
    };
    let sidecar_response =
        run_model_chat_via_acp(app, request_payload, narrator_sidecar_model_config()?).await?;
    let title = normalize_conversation_title(&sidecar_events_result_text(&sidecar_response));

    if title.chars().count() < MIN_GENERATED_TITLE_CHARS {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "AI 生成的会话标题不符合 5 到 10 个字要求。",
        ));
    }

    Ok(AiConversationTitlePayload {
        title,
        model: model.to_string(),
    })
}

pub async fn inline_complete(
    app: &AppHandle,
    payload: AiInlineCompletionRequest,
) -> Result<AiInlineCompletionResult, String> {
    let config = current_config()?;

    if !config.inline_completion_enabled {
        return Ok(disabled_inline_complete(payload));
    }

    let prompt = build_inline_prompt(&payload);
    let request = AiProviderChatRequest::new(vec![AiProviderMessage {
        role: "user".to_string(),
        content: prompt,
    }]);

    let request_payload = AgentSidecarChatRequest {
        session_id: None,
        mode: Some("ask".to_string()),
        goal: Some("生成行内补全".to_string()),
        messages: to_sidecar_message_payloads(request.messages),
        workspace_root_path: None,
        context: Vec::new(),
        model_config: None,
        thread_id: None,
    };
    let response =
        run_model_chat_via_acp(app, request_payload, current_sidecar_model_config()?).await?;

    Ok(AiInlineCompletionResult {
        insert_text: sidecar_events_result_text(&response),
        range: AiInlineCompletionRangePayload {
            start_offset: payload.cursor_offset,
            end_offset: payload.cursor_offset,
        },
        confidence: "medium".to_string(),
    })
}

pub async fn classify_task(
    payload: AiAgentClassifyTaskRequest,
) -> Result<AiAgentClassifyTaskPayload, String> {
    AgentPlanner::classify_task(payload)
}

#[cfg(test)]
pub(super) fn with_identity_system_message(
    mut messages: Vec<AiProviderMessage>,
    model: &str,
) -> Vec<AiProviderMessage> {
    let mut result = Vec::with_capacity(messages.len() + 1);
    result.push(build_identity_system_message(model));
    result.append(&mut messages);
    result
}

fn disabled_inline_complete(payload: AiInlineCompletionRequest) -> AiInlineCompletionResult {
    AiInlineCompletionResult {
        insert_text: String::new(),
        range: AiInlineCompletionRangePayload {
            start_offset: payload.cursor_offset,
            end_offset: payload.cursor_offset,
        },
        confidence: "low".to_string(),
    }
}

pub(super) fn normalize_conversation_title(value: &str) -> String {
    let first_line = value
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut title = first_line
        .trim_start_matches(['-', '*', '#'])
        .trim()
        .to_string();

    for prefix in [
        "会话标题：",
        "会话标题:",
        "正式标题：",
        "正式标题:",
        "标题：",
        "标题:",
    ] {
        if title.starts_with(prefix) {
            title = title[prefix.len()..].trim().to_string();
            break;
        }
    }

    let trimmed = title.trim_matches(|item: char| {
        item.is_whitespace()
            || matches!(
                item,
                '"' | '\''
                    | '\u{201c}'
                    | '\u{201d}'
                    | '\u{2018}'
                    | '\u{2019}'
                    | '\u{300a}'
                    | '\u{300b}'
                    | '\u{3010}'
                    | '\u{3011}'
                    | '\u{300c}'
                    | '\u{300d}'
                    | '\u{300e}'
                    | '\u{300f}'
                    | '\u{3002}'
                    | '\u{ff0c}'
                    | ','
                    | '.'
                    | ':'
                    | '\u{ff1a}'
                    | '-'
                    | '\u{2014}'
            )
    });

    trimmed.chars().take(MAX_GENERATED_TITLE_CHARS).collect()
}
