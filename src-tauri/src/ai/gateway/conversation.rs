#[cfg(test)]
use super::prompt::build_identity_system_message;
use super::prompt::{
    build_context_block, build_conversation_title_prompt, build_inline_prompt, clip_title_source,
};
use super::*;
use crate::commands::contracts::{AgentSidecarChatRequest, AgentSidecarMessagePayload};
use tauri::{Emitter as _, Manager as _};

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

pub async fn chat_stream(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamStart, String> {
    chat_stream_via_acp(app, payload).await
}

async fn chat_stream_via_acp(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamStart, String> {
    audit::emit(AiAuditEventKind::ChatStarted);

    let config = current_config()?;
    ensure_chat_enabled(&config)?;

    let stream_id = next_runtime_id("ai-stream");
    let assistant_message_id = next_runtime_id("assistant");
    let response_provider_type = config.provider_type.clone();

    let model = config
        .selected_model
        .clone()
        .or_else(|| default_model(&config.provider_type))
        .unwrap_or_else(|| DEFAULT_MASTRA_MODEL.to_string());

    let input_references = payload.references.clone();
    let messages = collect_messages(payload.messages, input_references.clone())?;

    // 保留旧路径的「至少一条 user 消息」前置校验：collect_messages 仅保证结果非空且
    // 角色合法，不保证存在 user 消息；缺失时与旧路径一致地拒绝。
    if !messages.iter().any(|message| message.role == "user") {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "请输入要发送给 AI 的内容。",
        ));
    }

    let thread_id = payload.thread_id.clone().unwrap_or_default();

    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn(&app)
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("无法建立 ACP 宿主连接：{error}"),
            )
        })?;

    let session_id = host
        .ensure_session(&thread_id, None)
        .await
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("无法建立 ACP 会话：{error}"),
            )
        })?;
    let session_key = session_id.to_string();

    // Batch 2c 接线：主聊天回合改走 agent/chat 扩展方法（满信封），替代原生 host.chat
    // 的有损 session/update 累积路径。ask 模式语义不变；过程增量仍经同一 EventSink
    // 实时预览，权威结果（result + usage）由返回信封承载，由下方 done 合成补发。
    //
    // 上下文已由 collect_messages 注入末条 user 消息并随之脱敏（secret 检测覆盖引用
    // 内容），故结构化 context 置空：既避免重复注入，也不绕过脱敏。model_config 按
    // launch.rs 约定的「逐请求通道」注入当前已保存的主模型配置（model + key）——
    // launch 层刻意不注入模型 env（env 仅作可选预热），故此处必须逐请求携带，
    // 否则 sidecar 解析不到模型配置会直接返回错误、回合空转。
    let chat_request = AgentSidecarChatRequest {
        session_id: None,
        mode: Some("ask".to_string()),
        goal: None,
        messages: to_sidecar_message_payloads(messages),
        workspace_root_path: None,
        context: Vec::new(),
        model_config: Some(current_sidecar_model_config()?),
        thread_id: payload.thread_id.clone(),
    };
    let request = crate::acp::chat_request_to_agent_chat_ext(chat_request, session_key.clone());

    let task_app = app.clone();
    let task_session_key = session_key.clone();

    tokio::spawn(async move {
        match host.agent_chat(request).await {
            Ok(response) => {
                audit::emit(AiAuditEventKind::ChatCompleted);
                let result_text = response.result.clone().unwrap_or_default();
                let usage = response
                    .events
                    .iter()
                    .rev()
                    .find(|event| {
                        event.get("type").and_then(|value| value.as_str()) == Some("done")
                    })
                    .and_then(|event| event.get("usage").cloned())
                    .filter(|usage| !usage.is_null());
                emit_acp_stream_done(&task_app, &task_session_key, &result_text, usage);
            }
            Err(error) => {
                audit::emit(AiAuditEventKind::ChatFailed);
                emit_acp_stream_error(&task_app, &task_session_key, &error.to_string());
            }
        }
    });

    Ok(AiChatStreamStart {
        stream_id,
        assistant_message_id,
        provider_type: response_provider_type,
        model,
        session_id: session_key,
    })
}

fn emit_acp_stream_frame(app: &AppHandle, session_key: &str, event: serde_json::Value) {
    let frame = crate::acp::AcpStreamFrame {
        session_id: Some(session_key.to_string()),
        seq: 0,
        event,
    };
    if let Err(error) = app.emit(crate::acp::ACP_STREAM_EVENT, &frame) {
        log::warn!("failed to emit acp chat stream frame to webview: {error}");
    }
}

fn emit_acp_stream_done(
    app: &AppHandle,
    session_key: &str,
    result_text: &str,
    usage: Option<serde_json::Value>,
) {
    emit_acp_stream_frame(
        app,
        session_key,
        crate::acp::build_done_ui_event(result_text, usage),
    );
}

fn emit_acp_stream_error(app: &AppHandle, session_key: &str, message: &str) {
    emit_acp_stream_frame(app, session_key, crate::acp::build_error_ui_event(message));
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

fn collect_messages(
    messages: Vec<crate::commands::contracts::AiChatMessagePayload>,
    references: Vec<AiContextReferencePayload>,
) -> Result<Vec<AiProviderMessage>, String> {
    if messages.is_empty() {
        audit::emit(AiAuditEventKind::ChatFailed);

        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "请输入要发送给 AI 的内容。",
        ));
    }

    if messages.len() > MAX_AI_MESSAGES {
        audit::emit(AiAuditEventKind::ChatFailed);

        return Err(errors::error(
            "AI_CONTEXT_TOO_LARGE",
            "对话轮次过多，请清空部分历史后重试。",
        ));
    }

    let context_block = build_context_block(&references);
    let last_user_index = messages.iter().rposition(|message| message.role == "user");

    let mut result = Vec::new();

    for (index, message) in messages.into_iter().enumerate() {
        if !matches!(
            message.role.as_str(),
            "user" | "assistant" | "system" | "tool"
        ) {
            continue;
        }

        let mut combined_content = message.content;

        if Some(index) == last_user_index && !context_block.trim().is_empty() {
            combined_content = format!(
                "{combined_content}\n\n---\n以下是 IDE 收集的结构化上下文。上下文仅用于回答当前问题，不代表用户要求你直接修改文件；如需修改必须输出建议或 patch 预览。\n{context_block}"
            );
        }

        let raw_content: String = combined_content.chars().take(MAX_MESSAGE_CHARS).collect();
        let redacted = redact_text(&raw_content);

        if redacted.blocked {
            audit::emit(AiAuditEventKind::SecretDetected);
        }

        if redacted.text.trim().is_empty() {
            continue;
        }

        result.push(AiProviderMessage {
            role: message.role,
            content: redacted.text,
        });
    }

    if result.is_empty() {
        audit::emit(AiAuditEventKind::ChatFailed);

        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "请输入要发送给 AI 的内容。",
        ));
    }

    Ok(result)
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
