use super::*;
use crate::agent_sidecar;
use crate::commands::contracts::{AgentSidecarChatRequest, AgentSidecarMessagePayload};

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
            let sidecar_response = agent_sidecar::model_chat_streaming(
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
            )
            .await?;

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

            Ok::<_, String>((None, None))
        }
        .await;

        match result {
            Ok((final_usage, completion_tokens_estimate)) => {
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
                            completion_tokens: completion_tokens_estimate,
                            total_tokens: prompt_tokens
                                .zip(completion_tokens_estimate)
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
                        .or(completion_tokens_estimate);
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

pub async fn code_action(payload: AiCodeActionRequest) -> Result<AiCodeActionPayload, String> {
    let trimmed_selection = payload.selection.trim();

    if trimmed_selection.is_empty() {
        return Ok(AiCodeActionPayload {
            explanation: "当前没有选区，请先选择需要处理的代码。".to_string(),
            suggested_patch: None,
            test_suggestion: None,
            follow_up_questions: vec!["请选择代码后重新执行 AI Action。".to_string()],
        });
    }

    let prompt = build_code_action_prompt(&payload);
    let redacted_prompt = redact_text(&prompt);

    if redacted_prompt.blocked {
        audit::emit(AiAuditEventKind::SecretDetected);
    }

    let request = AiProviderChatRequest::new(vec![AiProviderMessage {
        role: "user".to_string(),
        content: redacted_prompt.text,
    }]);

    let response = agent_sidecar::model_chat_once(AgentSidecarChatRequest {
        session_id: None,
        mode: Some("ask".to_string()),
        goal: Some("执行代码动作".to_string()),
        messages: to_sidecar_message_payloads(request.messages),
        workspace_root_path: None,
        context: Vec::new(),
        model_config: None,
        thread_id: None,
    })
    .await?;

    Ok(AiCodeActionPayload {
        explanation: sidecar_events_result_text(&response),
        suggested_patch: None,
        test_suggestion: if payload.kind == "generate_tests" {
            Some("建议基于返回内容在测试目录新增用例；应用前请先走 patch 预览。".to_string())
        } else {
            None
        },
        follow_up_questions: Vec::new(),
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

pub(super) fn build_identity_system_message(model: &str) -> AiProviderMessage {
    AiProviderMessage::system(build_identity_system_prompt(model))
}

pub(super) fn build_identity_system_prompt(model: &str) -> String {
    let trimmed_model = match model.trim() {
        "" => "未指定",
        value => value,
    };
    let provider_label = infer_model_provider_label(trimmed_model);

    format!(
        "身份：你是小建C桌面应用中的 AI 编程助手。当前模型：{trimmed_model}，平台：{provider_label}。用户询问身份时按当前真实模型回答，不冒充其他模型或厂商。"
    )
}

fn infer_model_provider_label(model: &str) -> &'static str {
    let normalized = model.trim().to_ascii_lowercase();

    if normalized.starts_with("deepseek/") || normalized.contains("deepseek") {
        return "DeepSeek";
    }

    if is_anthropic_model(model) {
        return "Anthropic";
    }

    if normalized.starts_with("openai/") || normalized.starts_with("gpt-") {
        return "OpenAI";
    }

    if normalized.starts_with("google/") || normalized.contains("gemini") {
        return "Google";
    }

    if normalized.starts_with("qwen/") || normalized.contains("qwen") {
        return "通义千问";
    }

    "当前配置的 AI 服务平台"
}

fn is_anthropic_model(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();

    normalized.starts_with("anthropic/") || normalized.contains("claude")
}

fn build_context_block(references: &[AiContextReferencePayload]) -> String {
    if references.is_empty() {
        return String::new();
    }

    let mut block = String::new();

    for reference in references.iter().take(MAX_CONTEXT_REFERENCES) {
        let range = reference
            .range
            .as_ref()
            .map(|item| format!("{}-{}", item.start_line, item.end_line))
            .unwrap_or_else(|| "全文摘要".to_string());

        let path = reference.path.as_deref().unwrap_or("未保存");

        let preview: String = reference
            .content_preview
            .chars()
            .take(MAX_REFERENCE_PREVIEW_CHARS)
            .collect();

        let preview = sanitize_fenced_text(&preview);

        let redacted_label = if reference.redacted {
            "，已脱敏"
        } else {
            ""
        };

        block.push_str(&format!(
            "\n[{}] {} ({path}, {range}{redacted_label})\n```text\n{preview}\n```\n",
            reference.kind, reference.label
        ));

        if block.chars().count() >= MAX_CONTEXT_BLOCK_CHARS {
            let clipped: String = block.chars().take(MAX_CONTEXT_BLOCK_CHARS).collect();
            block = format!("{clipped}\n[上下文已按预算截断]\n");
            break;
        }
    }

    block
}

fn disabled_inline_complete(payload: AiInlineCompletionRequest) -> AiInlineCompletionResult {
    let _recent_edits_count = payload
        .recent_edits
        .as_ref()
        .map(Vec::len)
        .unwrap_or_default();

    AiInlineCompletionResult {
        insert_text: String::new(),
        range: AiInlineCompletionRangePayload {
            start_offset: payload.cursor_offset,
            end_offset: payload.cursor_offset,
        },
        confidence: "low".to_string(),
    }
}

fn build_inline_prompt(payload: &AiInlineCompletionRequest) -> String {
    format!(
        "只返回需要插入到光标处的代码，不要解释。\n语言：{}\n文件：{}\n前文：\n{}\n后文：\n{}",
        payload.language,
        payload.file_path,
        sanitize_fenced_text(&payload.prefix),
        sanitize_fenced_text(&payload.suffix)
    )
}

fn build_code_action_prompt(payload: &AiCodeActionRequest) -> String {
    let file_path = payload.file_path.as_deref().unwrap_or("未保存文件");

    let diagnostics = if payload.diagnostics.is_empty() {
        "无".to_string()
    } else {
        payload.diagnostics.join("\n")
    };

    format!(
        "你是 IDE AI。请执行代码动作：{}。\n规则：不要直接声称已修改文件；如需修改，只描述建议并等待 patch 预览确认。\n文件：{}\n语言：{}\n诊断：\n{}\n选区：\n```{}\n{}\n```",
        payload.kind,
        file_path,
        payload.language,
        sanitize_fenced_text(&diagnostics),
        payload.language,
        sanitize_fenced_text(&payload.selection)
    )
}

fn clip_title_source(value: &str) -> String {
    value.trim().chars().take(MAX_TITLE_SOURCE_CHARS).collect()
}

pub(super) fn build_conversation_title_prompt(
    user_message: &str,
    assistant_message: &str,
) -> String {
    format!(
        "请只依据下面第一轮问答生成中文会话标题。\n规则：\n- 只输出标题本身，不要解释、引号或标点\n- 标题必须为 5 到 10 个中文字符\n- 不要使用后续对话，因为后续对话未提供\n\n用户第一句：\n```text\n{}\n```\n\nAI 第一句：\n```text\n{}\n```",
        sanitize_fenced_text(user_message),
        sanitize_fenced_text(assistant_message)
    )
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
