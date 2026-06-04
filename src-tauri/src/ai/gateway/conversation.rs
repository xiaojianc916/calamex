use super::*;
use crate::agent_sidecar;
use crate::ai::provider::{AiProviderInputTokenDetails, AiProviderOutputTokenDetails};
use crate::commands::contracts::{AgentSidecarChatRequest, AgentSidecarMessagePayload};
use super::prompt::{
    build_context_block, build_conversation_title_prompt, build_identity_system_message,
    build_inline_prompt, clip_title_source,
};

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

/// 从 sidecar 事件流中提取最终 `done` 事件携带的官方用量（authoritative usage）。
///
/// sidecar 已在 `done` 事件里回传 Mastra/ai-sdk 的真实 `usage`（见 agent-sidecar
/// 的 `parseDoneTokenSnapshot`），这里只做无损映射到 `AiProviderUsage`：
/// - `inputTokens` / `outputTokens` 必须存在，缺任一则视为无可信用量并返回 `None`；
/// - `totalTokens` 缺失时回退为输入与输出之和；
/// - 明细 / 缓存 / 推理 token 等可选字段缺失时按 0 处理，绝不本地估算。
fn parse_done_event_usage(events: &[serde_json::Value]) -> Option<AiProviderUsage> {
    let usage = events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(|value| value.as_str()) == Some("done"))
        .and_then(|event| event.get("usage"))
        .filter(|usage| !usage.is_null())?;

    let read_u64 = |parent: &serde_json::Value, key: &str| -> Option<u64> {
        parent.get(key).and_then(serde_json::Value::as_u64)
    };

    let input_tokens = read_u64(usage, "inputTokens")?;
    let output_tokens = read_u64(usage, "outputTokens")?;
    let total_tokens = read_u64(usage, "totalTokens").unwrap_or(input_tokens + output_tokens);

    let input_details = usage.get("inputTokenDetails");
    let input_token_details = AiProviderInputTokenDetails {
        no_cache_tokens: input_details
            .and_then(|details| read_u64(details, "noCacheTokens"))
            .unwrap_or(0),
        cache_read_tokens: input_details
            .and_then(|details| read_u64(details, "cacheReadTokens"))
            .unwrap_or(0),
        cache_write_tokens: input_details
            .and_then(|details| read_u64(details, "cacheWriteTokens"))
            .unwrap_or(0),
    };

    let output_details = usage.get("outputTokenDetails");
    let output_token_details = AiProviderOutputTokenDetails {
        text_tokens: output_details
            .and_then(|details| read_u64(details, "textTokens"))
            .unwrap_or(0),
        reasoning_tokens: output_details
            .and_then(|details| read_u64(details, "reasoningTokens"))
            .unwrap_or(0),
    };

    let cached_input_tokens =
        read_u64(usage, "cachedInputTokens").unwrap_or(input_token_details.cache_read_tokens);
    let reasoning_tokens =
        read_u64(usage, "reasoningTokens").unwrap_or(output_token_details.reasoning_tokens);
    let raw = usage.get("raw").cloned().unwrap_or(serde_json::Value::Null);

    Some(AiProviderUsage {
        input_tokens,
        input_token_details,
        output_tokens,
        output_token_details,
        total_tokens,
        cached_input_tokens,
        reasoning_tokens,
        raw,
    })
}

pub async fn generate_conversation_title(
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
    let sidecar_response = agent_sidecar::narrator_model_chat_once(AgentSidecarChatRequest {
        session_id: None,
        mode: Some("ask".to_string()),
        goal: Some("生成会话标题".to_string()),
        messages: to_sidecar_message_payloads(request.messages),
        workspace_root_path: None,
        context: Vec::new(),
        model_config: None,
        thread_id: None,
    })
    .await?;
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
    audit::emit(AiAuditEventKind::ChatStarted);

    let config = current_config()?;
    ensure_chat_enabled(&config)?;

    let stream_id = next_runtime_id("ai-stream");
    let assistant_message_id = next_runtime_id("assistant");
    let response_provider_type = config.provider_type.clone();
    let task_config = config.clone();

    let input_references = payload.references.clone();
    let model = config
        .selected_model
        .clone()
        .or_else(|| default_model(&config.provider_type))
        .unwrap_or_else(|| DEFAULT_MASTRA_MODEL.to_string());
    let messages = with_identity_system_message(
        collect_messages(payload.messages, input_references.clone())?,
        &model,
    );
    let request = AiProviderChatRequest::new(messages);
    // 已移除本地 tokenizer 估算：prompt/total token 一律以官方返回的 usage 为准。
    let prompt_tokens: Option<u64> = None;

    stream_manager::register(&stream_id);
    // 取消令牌：与该 stream 绑定，供下方流式请求用 select! 竞速。
    // cancel 命令调用 stream_manager::cancel 时，此克隆体会被唤醒。
    let cancel_token = stream_manager::token(&stream_id);

    let task_stream_id = stream_id.clone();
    let task_assistant_message_id = assistant_message_id.clone();
    let task_model = model.clone();
    let task_messages = request.messages.clone();
    let task_context = input_references;

    tokio::spawn(async move {
        emit_stream_event(
            &app,
            AiChatStreamEventPayload {
                stream_id: task_stream_id.clone(),
                assistant_message_id: task_assistant_message_id.clone(),
                kind: "start".to_string(),
                delta: None,
                message: None,
                model: Some(task_model.clone()),
                prompt_tokens,
                completion_tokens: None,
                total_tokens: prompt_tokens,
                usage: None,
            },
        );

        let result = async {
            let _ = task_config;
            let mut streamed_any = false;
            let streaming = agent_sidecar::model_chat_streaming(
                app.clone(),
                AgentSidecarChatRequest {
                    session_id: Some(task_stream_id.clone()),
                    mode: Some("ask".to_string()),
                    goal: Some(
                        task_messages
                            .iter()
                            .rev()
                            .find(|message| message.role == "user")
                            .map(|message| message.content.clone())
                            .unwrap_or_else(|| "继续当前任务".to_string()),
                    ),
                    messages: to_sidecar_message_payloads(task_messages.clone()),
                    workspace_root_path: None,
                    context: task_context.clone(),
                    model_config: None,
                    thread_id: payload.thread_id.clone(),
                },
                |event| {
                    if let Some(delta) = agent_sidecar::answer_delta_text(event) {
                        streamed_any = true;
                        emit_stream_event(
                            &app,
                            AiChatStreamEventPayload {
                                stream_id: task_stream_id.clone(),
                                assistant_message_id: task_assistant_message_id.clone(),
                                kind: "delta".to_string(),
                                delta: Some(delta),
                                message: None,
                                model: Some(task_model.clone()),
                                prompt_tokens,
                                completion_tokens: None,
                                total_tokens: prompt_tokens,
                                usage: None,
                            },
                        );
                    }
                },
            );

            // 真正中断取消：用 select! 让流式请求与取消信号竞速。一旦取消触发，
            // 直接丢弃 `streaming` future —— 这会级联 drop 其内部持有的 reqwest 响应，
            // 关闭底层 TCP 连接，从而真正中断进行中的请求，而非等它自然结束。
            let sidecar_response = match cancel_token.clone() {
                Some(token) => {
                    tokio::select! {
                        biased;
                        () = token.cancelled() => {
                            return Err(
                                "AI_REQUEST_CANCELLED: 用户已取消进行中的 AI 请求。".to_string(),
                            );
                        }
                        response = streaming => response?,
                    }
                }
                None => streaming.await?,
            };

            if !streamed_any {
                let final_text = sidecar_events_result_text(&sidecar_response);
                if !final_text.is_empty() {
                    emit_stream_event(
                        &app,
                        AiChatStreamEventPayload {
                            stream_id: task_stream_id.clone(),
                            assistant_message_id: task_assistant_message_id.clone(),
                            kind: "delta".to_string(),
                            delta: Some(final_text),
                            message: None,
                            model: Some(task_model.clone()),
                            prompt_tokens,
                            completion_tokens: None,
                            total_tokens: prompt_tokens,
                            usage: None,
                        },
                    );
                }
            }

            let final_usage = parse_done_event_usage(&sidecar_response.events);
            let completion_tokens = final_usage.as_ref().map(|usage| usage.output_tokens);

            Ok::<_, String>((final_usage, completion_tokens))
        }
        .await;

        match result {
            Ok((final_usage, completion_tokens)) => {
                if stream_manager::is_cancelled(&task_stream_id) {
                    emit_stream_event(
                        &app,
                        AiChatStreamEventPayload {
                            stream_id: task_stream_id.clone(),
                            assistant_message_id: task_assistant_message_id.clone(),
                            kind: "cancelled".to_string(),
                            delta: None,
                            message: Some("AI 请求已取消。".to_string()),
                            model: Some(task_model.clone()),
                            prompt_tokens,
                            completion_tokens,
                            total_tokens: prompt_tokens
                                .zip(completion_tokens)
                                .map(|(input_tokens, output_tokens)| input_tokens + output_tokens),
                            usage: final_usage,
                        },
                    );
                } else {
                    audit::emit(AiAuditEventKind::ChatCompleted);
                    let final_prompt_tokens = final_usage
                        .as_ref()
                        .map(|usage| usage.input_tokens)
                        .or(prompt_tokens);
                    let final_completion_tokens = final_usage
                        .as_ref()
                        .map(|usage| usage.output_tokens)
                        .or(completion_tokens);
                    let final_total_tokens = final_usage
                        .as_ref()
                        .map(|usage| usage.total_tokens)
                        .or_else(|| {
                            final_prompt_tokens
                                .zip(final_completion_tokens)
                                .map(|(input_tokens, output_tokens)| input_tokens + output_tokens)
                        });

                    emit_stream_event(
                        &app,
                        AiChatStreamEventPayload {
                            stream_id: task_stream_id.clone(),
                            assistant_message_id: task_assistant_message_id.clone(),
                            kind: "done".to_string(),
                            delta: None,
                            message: None,
                            model: Some(task_model.clone()),
                            prompt_tokens: final_prompt_tokens,
                            completion_tokens: final_completion_tokens,
                            total_tokens: final_total_tokens,
                            usage: final_usage,
                        },
                    );
                }
            }
            Err(error) => {
                audit::emit(AiAuditEventKind::ChatFailed);

                let kind = if error.contains("AI_REQUEST_CANCELLED") {
                    "cancelled"
                } else {
                    "error"
                };

                emit_stream_event(
                    &app,
                    AiChatStreamEventPayload {
                        stream_id: task_stream_id.clone(),
                        assistant_message_id: task_assistant_message_id.clone(),
                        kind: kind.to_string(),
                        delta: None,
                        message: Some(error),
                        model: Some(task_model.clone()),
                        prompt_tokens,
                        completion_tokens: None,
                        total_tokens: prompt_tokens,
                        usage: None,
                    },
                );
            }
        }

        stream_manager::finish(&task_stream_id);
    });

    Ok(AiChatStreamStart {
        stream_id,
        assistant_message_id,
        provider_type: response_provider_type,
        model,
    })
}

pub async fn inline_complete(
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

    let response = agent_sidecar::model_chat_once(AgentSidecarChatRequest {
        session_id: None,
        mode: Some("ask".to_string()),
        goal: Some("生成行内补全".to_string()),
        messages: to_sidecar_message_payloads(request.messages),
        workspace_root_path: None,
        context: Vec::new(),
        model_config: None,
        thread_id: None,
    })
    .await?;

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
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '《'
                    | '》'
                    | '【'
                    | '】'
                    | '「'
                    | '」'
                    | '『'
                    | '』'
                    | '。'
                    | '，'
                    | ','
                    | '.'
                    | ':'
                    | '：'
                    | '-'
                    | '—'
            )
    });

    trimmed.chars().take(MAX_GENERATED_TITLE_CHARS).collect()
}

fn emit_stream_event(app: &AppHandle, payload: AiChatStreamEventPayload) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("ai:chat-stream", payload);
    }
}
