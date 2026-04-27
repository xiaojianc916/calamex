use super::audit::{self, AiAuditEventKind};
use super::credential::CredentialStore;
use super::errors;
use super::openai_compatible;
use super::provider::{AiProviderChatRequest, AiProviderMessage, AiProviderResponse, MockProvider};
use super::redaction::redact_text;
use super::stream_manager;
use crate::commands::contracts::{
    AiAgentPlanPayload, AiAgentPlanRequest, AiChatRequest, AiCodeActionPayload,
    AiCodeActionRequest, AiConfigPayload, AiContextReferencePayload,
    AiInlineCompletionRangePayload, AiInlineCompletionRequest, AiInlineCompletionResult,
    AiTaskPlanStepPayload,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_AI_MESSAGES: usize = 32;
const MAX_MESSAGE_CHARS: usize = 16_000;
const MAX_CONTEXT_REFERENCES: usize = 8;
const MAX_CONTEXT_BLOCK_CHARS: usize = 12_000;
const MAX_REFERENCE_PREVIEW_CHARS: usize = 4_000;
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL: &str = "gpt-4.1-mini";
const DEFAULT_MOCK_MODEL: &str = "mock-ide-assistant";

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AiRuntimeConfig {
    provider_type: String,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
}

impl Default for AiRuntimeConfig {
    fn default() -> Self {
        Self {
            provider_type: "mock".to_string(),
            selected_model: Some(DEFAULT_MOCK_MODEL.to_string()),
            base_url: None,
            inline_completion_enabled: false,
            chat_enabled: true,
            agent_enabled: false,
        }
    }
}

static CONFIG: OnceLock<Mutex<AiRuntimeConfig>> = OnceLock::new();

fn config_state() -> &'static Mutex<AiRuntimeConfig> {
    CONFIG.get_or_init(|| Mutex::new(load_config_from_disk().unwrap_or_default()))
}

pub fn get_config() -> AiConfigPayload {
    let config = config_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    to_payload(config)
}

pub fn save_config(
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
) -> Result<AiConfigPayload, String> {
    validate_provider(provider_type)?;
    let normalized_base_url = normalize_base_url(provider_type, base_url)?;
    let model = selected_model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| default_model(provider_type));

    let mut guard = config_state()
        .lock()
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))?;
    guard.provider_type = provider_type.to_string();
    guard.selected_model = model;
    guard.base_url = normalized_base_url;
    guard.inline_completion_enabled = inline_completion_enabled;
    guard.chat_enabled = chat_enabled;
    guard.agent_enabled = agent_enabled;
    let payload = to_payload(guard.clone());
    persist_config(&guard)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);
    Ok(payload)
}

pub fn save_credentials(provider_type: &str, api_key: &str) -> Result<AiConfigPayload, String> {
    validate_provider(provider_type)?;
    if provider_type == "mock" {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "MockProvider 不需要 API Key。",
        ));
    }
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }
    CredentialStore::save(provider_type, trimmed)?;
    audit::emit(AiAuditEventKind::ConfigUpdated);
    Ok(get_config())
}

pub fn clear_credentials() -> Result<(), String> {
    CredentialStore::clear()
}

pub async fn test_provider() -> Result<(), String> {
    let config = current_config()?;
    if config.provider_type == "mock" {
        return Ok(());
    }
    let base_url = resolve_base_url(&config)?;
    let api_key = CredentialStore::get(&config.provider_type)?;
    let model = config
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_OPENAI_MODEL);
    openai_compatible::test(base_url, &api_key, model).await
}

pub async fn chat(payload: AiChatRequest) -> Result<AiProviderResponse, String> {
    audit::emit(AiAuditEventKind::ChatStarted);
    let config = current_config()?;
    let _thread_id = payload.thread_id.as_deref();
    let messages = collect_messages(payload.messages, payload.references)?;
    let request = AiProviderChatRequest { messages };

    let response = if config.provider_type == "mock" {
        MockProvider::chat(request)
    } else {
        let base_url = resolve_base_url(&config)?;
        let api_key = CredentialStore::get(&config.provider_type)?;
        let model = config
            .selected_model
            .as_deref()
            .unwrap_or(DEFAULT_OPENAI_MODEL);
        openai_compatible::chat(base_url, &api_key, model, request).await?
    };

    audit::emit(AiAuditEventKind::ChatCompleted);
    Ok(response)
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStreamEventPayload {
    pub stream_id: String,
    pub assistant_message_id: String,
    pub kind: String,
    pub delta: Option<String>,
    pub message: Option<String>,
    pub model: Option<String>,
}

pub struct AiChatStreamStart {
    pub stream_id: String,
    pub assistant_message_id: String,
    pub provider_type: String,
    pub model: String,
}

pub async fn chat_stream(app: AppHandle, payload: AiChatRequest) -> Result<AiChatStreamStart, String> {
    audit::emit(AiAuditEventKind::ChatStarted);
    let config = current_config()?;
    let messages = collect_messages(payload.messages, payload.references)?;
    let request = AiProviderChatRequest { messages };
    let stream_id = format!("ai-stream-{}", chrono::Utc::now().timestamp_millis());
    let assistant_message_id = format!("assistant-{}", chrono::Utc::now().timestamp_millis());
    let provider_type = config.provider_type.clone();
    let response_provider_type = provider_type.clone();
    let task_config = config.clone();
    let model = config
        .selected_model
        .clone()
        .or_else(|| default_model(&config.provider_type))
        .unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string());

    stream_manager::register(&stream_id);

    let task_stream_id = stream_id.clone();
    let task_assistant_message_id = assistant_message_id.clone();
    let task_model = model.clone();
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
            },
        );

        let result = if provider_type == "mock" {
            stream_mock_response(&app, &task_stream_id, &task_assistant_message_id, &task_model, request).await
        } else {
            let run = async {
                let base_url = resolve_base_url(&task_config)?.to_string();
                let api_key = CredentialStore::get(&task_config.provider_type)?;
                openai_compatible::chat_stream(
                    &base_url,
                    &api_key,
                    &task_model,
                    request,
                    |delta| {
                        emit_stream_event(
                            &app,
                            AiChatStreamEventPayload {
                                stream_id: task_stream_id.clone(),
                                assistant_message_id: task_assistant_message_id.clone(),
                                kind: "delta".to_string(),
                                delta: Some(delta),
                                message: None,
                                model: Some(task_model.clone()),
                            },
                        );
                        Ok(())
                    },
                    || stream_manager::is_cancelled(&task_stream_id),
                )
                .await
            };
            run.await
        };

        match result {
            Ok(()) => {
                if stream_manager::is_cancelled(&task_stream_id) {
                    emit_stream_event(
                        &app,
                        AiChatStreamEventPayload {
                            stream_id: task_stream_id.clone(),
                            assistant_message_id: task_assistant_message_id.clone(),
                            kind: "cancelled".to_string(),
                            delta: None,
                            message: Some("AI ????????".to_string()),
                            model: Some(task_model.clone()),
                        },
                    );
                } else {
                    audit::emit(AiAuditEventKind::ChatCompleted);
                    emit_stream_event(
                        &app,
                        AiChatStreamEventPayload {
                            stream_id: task_stream_id.clone(),
                            assistant_message_id: task_assistant_message_id.clone(),
                            kind: "done".to_string(),
                            delta: None,
                            message: None,
                            model: Some(task_model.clone()),
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

async fn stream_mock_response(
    app: &AppHandle,
    stream_id: &str,
    assistant_message_id: &str,
    model: &str,
    request: AiProviderChatRequest,
) -> Result<(), String> {
    let response = MockProvider::chat(request).content;
    for chunk in response.as_bytes().chunks(16) {
        if stream_manager::is_cancelled(stream_id) {
            return Err(errors::error("AI_REQUEST_CANCELLED", "AI ????????"));
        }
        let delta = String::from_utf8_lossy(chunk).to_string();
        emit_stream_event(
            app,
            AiChatStreamEventPayload {
                stream_id: stream_id.to_string(),
                assistant_message_id: assistant_message_id.to_string(),
                kind: "delta".to_string(),
                delta: Some(delta),
                message: None,
                model: Some(model.to_string()),
            },
        );
        tokio::time::sleep(std::time::Duration::from_millis(24)).await;
    }
    Ok(())
}

fn emit_stream_event(app: &AppHandle, payload: AiChatStreamEventPayload) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("ai:chat-stream", payload);
    }
}


pub async fn inline_complete(
    payload: AiInlineCompletionRequest,
) -> Result<AiInlineCompletionResult, String> {
    let config = current_config()?;
    if config.provider_type == "mock" || !config.inline_completion_enabled {
        return Ok(mock_inline_complete(payload));
    }

    let prompt = build_inline_prompt(&payload);
    let request = AiProviderChatRequest {
        messages: vec![AiProviderMessage {
            role: "user".to_string(),
            content: prompt,
        }],
    };
    let base_url = resolve_base_url(&config)?;
    let api_key = CredentialStore::get(&config.provider_type)?;
    let model = config
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_OPENAI_MODEL);
    let response = openai_compatible::chat(base_url, &api_key, model, request).await?;
    Ok(AiInlineCompletionResult {
        insert_text: response.content,
        range: AiInlineCompletionRangePayload {
            start_offset: payload.cursor_offset,
            end_offset: payload.cursor_offset,
        },
        confidence: "medium".to_string(),
    })
}

pub async fn code_action(payload: AiCodeActionRequest) -> Result<AiCodeActionPayload, String> {
    let config = current_config()?;
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
    let request = AiProviderChatRequest {
        messages: vec![AiProviderMessage {
            role: "user".to_string(),
            content: redact_text(&prompt).text,
        }],
    };
    let response = if config.provider_type == "mock" {
        MockProvider::chat(request)
    } else {
        let base_url = resolve_base_url(&config)?;
        let api_key = CredentialStore::get(&config.provider_type)?;
        let model = config
            .selected_model
            .as_deref()
            .unwrap_or(DEFAULT_OPENAI_MODEL);
        openai_compatible::chat(base_url, &api_key, model, request).await?
    };

    Ok(AiCodeActionPayload {
        explanation: response.content,
        suggested_patch: None,
        test_suggestion: if payload.kind == "generate_tests" {
            Some("建议基于返回内容在测试目录新增用例；应用前请先走 patch 预览。".to_string())
        } else {
            None
        },
        follow_up_questions: Vec::new(),
    })
}

pub async fn plan_task(payload: AiAgentPlanRequest) -> Result<AiAgentPlanPayload, String> {
    let goal = payload.goal.trim();
    if goal.is_empty() {
        return Err(errors::error(
            "AI_AGENT_STEP_FAILED",
            "请输入 Agent 任务目标。",
        ));
    }
    let context_count = payload.context.len();
    Ok(AiAgentPlanPayload {
        steps: vec![
            AiTaskPlanStepPayload {
                id: "understand".to_string(),
                title: format!("理解任务：{goal}"),
                status: "completed".to_string(),
            },
            AiTaskPlanStepPayload {
                id: "collect-context".to_string(),
                title: format!("读取有限上下文（{context_count} 个引用）"),
                status: "completed".to_string(),
            },
            AiTaskPlanStepPayload {
                id: "propose-patch".to_string(),
                title: "生成 patch 预览，不直接写入文件".to_string(),
                status: "requires-confirmation".to_string(),
            },
            AiTaskPlanStepPayload {
                id: "run-tests".to_string(),
                title: "等待用户确认后运行测试".to_string(),
                status: "requires-confirmation".to_string(),
            },
        ],
    })
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
        if message.role != "user" && message.role != "assistant" && message.role != "system" {
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

fn mock_inline_complete(payload: AiInlineCompletionRequest) -> AiInlineCompletionResult {
    let _request_shape = (
        &payload.file_path,
        &payload.language,
        &payload.suffix,
        payload
            .recent_edits
            .as_ref()
            .map(Vec::len)
            .unwrap_or_default(),
    );
    let insert_text = if payload.prefix.trim_end().ends_with("{") {
        "\n  // TODO: 在这里补充实现\n}".to_string()
    } else {
        "".to_string()
    };

    AiInlineCompletionResult {
        insert_text,
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
        payload.language, payload.file_path, payload.prefix, payload.suffix
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
        payload.kind, file_path, payload.language, diagnostics, payload.language, payload.selection
    )
}

fn current_config() -> Result<AiRuntimeConfig, String> {
    config_state()
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| errors::error("AI_PROVIDER_UNAVAILABLE", "AI 配置状态已损坏。"))
}

fn to_payload(config: AiRuntimeConfig) -> AiConfigPayload {
    let has_credentials = if config.provider_type == "mock" {
        true
    } else {
        CredentialStore::has_provider_secret(&config.provider_type)
    };
    let is_base_url_configured = config
        .base_url
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(config.provider_type == "mock");
    AiConfigPayload {
        provider_type: config.provider_type.clone(),
        selected_model: config.selected_model,
        base_url: config.base_url,
        is_base_url_configured,
        has_credentials,
        is_configured: has_credentials && is_base_url_configured,
        inline_completion_enabled: config.inline_completion_enabled,
        chat_enabled: config.chat_enabled,
        agent_enabled: config.agent_enabled,
    }
}

fn validate_provider(provider_type: &str) -> Result<(), String> {
    match provider_type {
        "mock" | "openai" | "deepseek" | "moonshot" | "dashscope" | "zhipu" | "siliconflow"
        | "openai-compatible" => Ok(()),
        _ => Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "当前版本只支持 MockProvider 与 OpenAI-compatible Provider。",
        )),
    }
}

fn normalize_base_url(
    provider_type: &str,
    base_url: Option<String>,
) -> Result<Option<String>, String> {
    if provider_type == "mock" {
        return Ok(None);
    }
    let value = base_url
        .map(|item| item.trim().trim_end_matches('/').to_string())
        .filter(|item| !item.is_empty())
        .or_else(|| default_base_url(provider_type))
        .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string());
    if !(value.starts_with("https://") || value.starts_with("http://localhost")) {
        return Err(errors::error(
            "AI_PROVIDER_NOT_CONFIGURED",
            "AI Provider 地址必须使用 HTTPS；本地调试仅允许 http://localhost。",
        ));
    }
    Ok(Some(value))
}

fn default_model(provider_type: &str) -> Option<String> {
    match provider_type {
        "mock" => Some(DEFAULT_MOCK_MODEL.to_string()),
        "openai" | "openai-compatible" => Some(DEFAULT_OPENAI_MODEL.to_string()),
        "deepseek" => Some("deepseek-v4-pro".to_string()),
        "moonshot" => Some("moonshot-v1-8k".to_string()),
        "dashscope" => Some("qwen-plus".to_string()),
        "zhipu" => Some("glm-4-plus".to_string()),
        "siliconflow" => Some("Qwen/Qwen2.5-Coder-32B-Instruct".to_string()),
        _ => None,
    }
}

fn default_base_url(provider_type: &str) -> Option<String> {
    match provider_type {
        "openai" => Some(DEFAULT_OPENAI_BASE_URL.to_string()),
        "deepseek" => Some("https://api.deepseek.com".to_string()),
        "moonshot" => Some("https://api.moonshot.cn/v1".to_string()),
        "dashscope" => Some("https://dashscope.aliyuncs.com/compatible-mode/v1".to_string()),
        "zhipu" => Some("https://open.bigmodel.cn/api/paas/v4".to_string()),
        "siliconflow" => Some("https://api.siliconflow.cn/v1".to_string()),
        _ => None,
    }
}

fn resolve_base_url(config: &AiRuntimeConfig) -> Result<&str, String> {
    config
        .base_url
        .as_deref()
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "请先配置 Provider API 地址。"))
}

fn config_file_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))?;
    Some(base.join("Calamex").join("ai-config.json"))
}

fn load_config_from_disk() -> Option<AiRuntimeConfig> {
    let path = config_file_path()?;
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<AiRuntimeConfig>(&content).ok()
}

fn persist_config(config: &AiRuntimeConfig) -> Result<(), String> {
    let Some(path) = config_file_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                &format!("AI 配置目录创建失败：{error}"),
            )
        })?;
    }
    let content = serde_json::to_string_pretty(config).map_err(|error| {
        errors::error(
            "AI_RESPONSE_INVALID",
            &format!("AI 配置序列化失败：{error}"),
        )
    })?;
    fs::write(path, content).map_err(|error| {
        errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            &format!("AI 配置保存失败：{error}"),
        )
    })
}
