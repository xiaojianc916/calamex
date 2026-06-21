use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::gateway;
use crate::commands::contracts::{
    AiCancelRequest, AiChatRequest, AiChatStreamPayload, AiConfigPayload,
    AiConversationTitlePayload, AiConversationTitleRequest, AiGetSessionConfigOptionsRequest,
    AiGetSessionModesRequest, AiInlineCompletionRangePayload, AiInlineCompletionRequest,
    AiInlineCompletionResult, AiProviderConnectionPayload, AiProviderConnectionRequest,
    AiProviderTestPayload, AiResolveApprovalRequest, AiSaveConfigRequest, AiSaveCredentialsRequest,
    AiSessionConfigOptionsPayload, AiSessionModesPayload, AiSetSessionConfigOptionRequest,
    AiSetSessionModeRequest, AiSuggestionPoolPayload, AiSuggestionPoolRequest,
};
use tauri::AppHandle;

fn classify_provider_test_error_code(error: &str) -> String {
    // 优先解析结构化错误 JSON（由 errors::error() 构造的 AiErrorPayload）。
    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(error) {
        if let Some(code) = payload.get("code").and_then(|v| v.as_str()) {
            return code.to_string();
        }
    }

    let normalized = error.to_ascii_lowercase();
    if normalized.contains("http 401")
        || normalized.contains("http 403")
        || normalized.contains("unauthorized")
        || normalized.contains("ai_provider_auth_failed")
    {
        "AI_PROVIDER_AUTH_FAILED".to_string()
    } else if normalized.contains("http 429")
        || normalized.contains("too many requests")
        || normalized.contains("rate limit")
    {
        "AI_PROVIDER_RATE_LIMITED".to_string()
    } else if normalized.contains("ai_provider_not_configured") || normalized.contains("http 404") {
        "AI_PROVIDER_NOT_CONFIGURED".to_string()
    } else if normalized.contains("ai_response_invalid") {
        "AI_RESPONSE_INVALID".to_string()
    } else {
        "AI_PROVIDER_UNAVAILABLE".to_string()
    }
}

/// 将一次连接测试的 `Result<成功说明, 结构化错误>` 归一化为前端契约 `AiProviderTestPayload`。
///
/// 成功 → ok:true + AI_PROVIDER_READY；失败 → ok:false + 解析出的结构化错误码 + 原始消息。
/// 供 ai_test_provider / ai_test_provider_config / ai_connect_provider 的验证结果共用，
/// 保证三条路径对「连通性结论」的呈现完全一致。
fn verification_to_test_payload(verification: Result<String, String>) -> AiProviderTestPayload {
    match verification {
        Ok(message) => AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message,
        },
        Err(error) => AiProviderTestPayload {
            ok: false,
            code: classify_provider_test_error_code(&error),
            message: error,
        },
    }
}

#[tauri::command]
#[specta::specta]
pub fn ai_get_config() -> Result<AiConfigPayload, String> {
    Ok(gateway::get_config())
}

#[tauri::command]
#[specta::specta]
pub fn ai_save_config(payload: AiSaveConfigRequest) -> Result<AiConfigPayload, String> {
    gateway::save_config(
        payload.role.as_deref(),
        &payload.provider_type,
        payload.selected_model,
        payload.base_url,
        payload.inline_completion_enabled,
        payload.chat_enabled,
        payload.agent_enabled,
    )
}

#[tauri::command]
#[specta::specta]
pub fn ai_save_credentials(payload: AiSaveCredentialsRequest) -> Result<AiConfigPayload, String> {
    gateway::save_credentials(
        &payload.provider_id,
        payload.alias.as_deref(),
        &payload.api_key,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn ai_test_provider_config(
    app: AppHandle,
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderTestPayload, String> {
    let verification = gateway::test_provider_config(
        &app,
        payload.role.as_deref(),
        payload.provider_id.as_deref(),
        &payload.provider_type,
        payload.selected_model,
        payload.base_url,
        payload.inline_completion_enabled,
        payload.chat_enabled,
        payload.agent_enabled,
        payload.api_key.as_ref().map(|value| value.expose()),
    )
    .await;

    Ok(verification_to_test_payload(verification))
}

#[tauri::command]
#[specta::specta]
pub async fn ai_connect_provider(
    app: AppHandle,
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderConnectionPayload, String> {
    // connect_provider 先持久化、再做非致命验证：返回 Ok 即代表凭证/配置已落盘，
    // test 字段如实反映在线验证结论（不再硬编码 ok:true）。
    let outcome = gateway::connect_provider(
        &app,
        payload.role.as_deref(),
        payload.provider_id.as_deref(),
        &payload.provider_type,
        payload.selected_model,
        payload.base_url,
        payload.inline_completion_enabled,
        payload.chat_enabled,
        payload.agent_enabled,
        payload.api_key.as_ref().map(|value| value.expose()),
    )
    .await?;

    Ok(AiProviderConnectionPayload {
        config: outcome.config,
        test: verification_to_test_payload(outcome.verification),
    })
}

#[tauri::command]
#[specta::specta]
pub fn ai_clear_credentials() -> Result<(), String> {
    gateway::clear_credentials()?;
    audit::emit(AiAuditEventKind::CredentialCleared);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn ai_test_provider(app: AppHandle) -> Result<AiProviderTestPayload, String> {
    let verification = gateway::test_provider(&app).await;
    Ok(verification_to_test_payload(verification))
}

#[tauri::command]
#[specta::specta]
pub async fn ai_generate_conversation_title(
    app: AppHandle,
    payload: AiConversationTitleRequest,
) -> Result<AiConversationTitlePayload, String> {
    gateway::generate_conversation_title(&app, payload).await
}

#[tauri::command]
#[specta::specta]
pub fn ai_get_suggestion_pool_cache() -> Result<Option<AiSuggestionPoolPayload>, String> {
    gateway::get_suggestion_pool_cache()
}

#[tauri::command]
#[specta::specta]
pub async fn ai_generate_suggestion_pool(
    app: AppHandle,
    payload: AiSuggestionPoolRequest,
) -> Result<AiSuggestionPoolPayload, String> {
    gateway::generate_suggestion_pool(&app, payload).await
}

#[tauri::command]
#[specta::specta]
pub async fn ai_chat_stream(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamPayload, String> {
    let started = gateway::chat_stream(app, payload).await?;
    Ok(AiChatStreamPayload {
        stream_id: started.stream_id,
        assistant_message_id: started.assistant_message_id,
        provider_type: started.provider_type,
        model: started.model,
        session_id: started.session_id,
    })
}

#[tauri::command]
#[specta::specta]
pub fn ai_cancel(app: AppHandle, payload: AiCancelRequest) -> Result<(), String> {
    let thread_id = payload
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AI_REQUEST_CANCELLED: threadId 不能为空。".to_string())?;

    use tauri::Manager as _;
    app.state::<crate::acp::AcpRuntime>()
        .cancel_thread(thread_id);
    Ok(())
}

/// 投递 ACP 反向权限请求（`session/request_permission`）的审批决策，唤醒回合内挂起的工具调用。
///
/// 与 `ai_cancel` 同构地委托给 Tauri 托管的 `AcpRuntime`：会话归属哪个后端宿主对命令层透明，
/// 由 runtime 向全部已建立宿主广播投递。三字段先行空白校验（前端总能从已渲染审批气泡取得）；
/// 返回是否命中某挂起审批——`false` 表示无匹配（多为已超时/被取消/重复投递的良性竞态，
/// 命令层不视作错误，交前端自行决定是否提示），与 runtime 的「安全空操作」语义一致。
#[tauri::command]
#[specta::specta]
pub fn ai_resolve_approval(
    app: AppHandle,
    payload: AiResolveApprovalRequest,
) -> Result<bool, String> {
    let session_id = payload.session_id.trim();
    if session_id.is_empty() {
        return Err("AI_APPROVAL_RESOLVE_INVALID: sessionId 不能为空。".to_string());
    }
    let tool_call_id = payload.tool_call_id.trim();
    if tool_call_id.is_empty() {
        return Err("AI_APPROVAL_RESOLVE_INVALID: toolCallId 不能为空。".to_string());
    }
    let decision = payload.decision.trim();
    if decision.is_empty() {
        return Err("AI_APPROVAL_RESOLVE_INVALID: decision 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let resolved =
        app.state::<crate::acp::AcpRuntime>()
            .resolve_approval(session_id, tool_call_id, decision);
    Ok(resolved)
}

/// 切换 ACP 会话的某个配置项值（标准 session/set_config_option），令外部 agent（Kimi Code /
/// Codex 等）在 agent 公示的模型 / 模式 / 思考强度等配置项间切换。
///
/// 与 ai_set_session_mode 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主对命令层
/// 透明，由 runtime 向全部已建立宿主广播下发。三字段先行空白校验；返回是否命中某已绑定会话——
/// false 表示无匹配（多为会话尚未建立/已结束的良性竞态，命令层不视作错误）。
#[tauri::command]
#[specta::specta]
pub async fn ai_set_session_config_option(
    app: AppHandle,
    payload: AiSetSessionConfigOptionRequest,
) -> Result<bool, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: threadId 不能为空。".to_string());
    }
    let config_id = payload.config_id.trim();
    if config_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: configId 不能为空。".to_string());
    }
    let value_id = payload.value_id.trim();
    if value_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: valueId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let applied = app
        .state::<crate::acp::AcpRuntime>()
        .set_session_config_option(thread_id, config_id, value_id)
        .await
        .map_err(|error| format!("AI_SET_SESSION_CONFIG_OPTION_FAILED: {error}"))?;
    Ok(applied)
}

/// 取某线程会话建立时 agent 公示的可用配置项清单（ACP session/new 的
/// NewSessionResponse.config_options 原样 JSON：Vec SessionConfigOption），供前端配置项选择器在
/// 会话建立后填充候选项。
///
/// 与 ai_get_session_modes 同构地委托给 Tauri 托管的 AcpRuntime：由 runtime 向全部已建立宿主
/// 查询并返回首个命中。thread_id 先行空白校验；返回 None 表示尚无该线程会话或 agent 未公示
/// 配置项（前端据此隐藏选择器）。config_options 为最小透传的原样 JSON（导出 TS 为 unknown）。
#[tauri::command]
#[specta::specta]
pub fn ai_get_session_config_options(
    app: AppHandle,
    payload: AiGetSessionConfigOptionsRequest,
) -> Result<Option<AiSessionConfigOptionsPayload>, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_GET_SESSION_CONFIG_OPTIONS_INVALID: threadId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let config_options = app
        .state::<crate::acp::AcpRuntime>()
        .session_config_options(thread_id)
        .map(|config_options| AiSessionConfigOptionsPayload { config_options });
    Ok(config_options)
}

/// 切换 ACP 会话的当前模式（标准 session/set_mode），令外部 agent（Kimi Code / Codex 等）在
/// agent 公示的模式（如 Auto / Plan / …）间真实切换。当 Agent 为 Kimi 时，前端模式选择器直接
/// 驱动此命令，复用 Kimi 自身的模式切换语义，绝不本地伪造。
///
/// 与 ai_set_session_config_option 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主
/// 对命令层透明，由 runtime 向全部已建立宿主广播下发。两字段先行空白校验；返回是否命中某已绑定
/// 会话——false 表示无匹配（多为会话尚未建立/已结束的良性竞态，命令层不视作错误）。
#[tauri::command]
#[specta::specta]
pub async fn ai_set_session_mode(
    app: AppHandle,
    payload: AiSetSessionModeRequest,
) -> Result<bool, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_SET_SESSION_MODE_INVALID: threadId 不能为空。".to_string());
    }
    let mode_id = payload.mode_id.trim();
    if mode_id.is_empty() {
        return Err("AI_SET_SESSION_MODE_INVALID: modeId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let applied = app
        .state::<crate::acp::AcpRuntime>()
        .set_session_mode(thread_id, mode_id)
        .await
        .map_err(|error| format!("AI_SET_SESSION_MODE_FAILED: {error}"))?;
    Ok(applied)
}

/// 取某线程会话建立时 agent 公示的可用模式清单（ACP session/new 的 NewSessionResponse.modes
/// 原样 JSON：SessionModeState = currentModeId + availableModes[]），供前端模式选择器在会话建立
/// 后填充候选项并高亮当前模式（默认即 agent 公示的 currentModeId，如 Kimi 的 Auto）。
///
/// 与 ai_get_session_config_options 同构地委托给 Tauri 托管的 AcpRuntime：由 runtime 向全部已
/// 建立宿主查询并返回首个命中。thread_id 先行空白校验；返回 None 表示尚无该线程会话或 agent 未
/// 公示模式（前端据此回退内置模式）。modes 为最小透传的原样 JSON（导出 TS 为 unknown）。
#[tauri::command]
#[specta::specta]
pub fn ai_get_session_modes(
    app: AppHandle,
    payload: AiGetSessionModesRequest,
) -> Result<Option<AiSessionModesPayload>, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_GET_SESSION_MODES_INVALID: threadId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let modes = app
        .state::<crate::acp::AcpRuntime>()
        .session_modes(thread_id)
        .map(|modes| AiSessionModesPayload { modes });
    Ok(modes)
}

#[tauri::command]
#[specta::specta]
pub async fn ai_inline_complete(
    app: AppHandle,
    payload: AiInlineCompletionRequest,
) -> Result<AiInlineCompletionResult, String> {
    let result = gateway::inline_complete(&app, payload).await?;
    Ok(AiInlineCompletionResult {
        insert_text: result.insert_text,
        range: AiInlineCompletionRangePayload {
            start_offset: result.range.start_offset,
            end_offset: result.range.end_offset,
        },
        confidence: result.confidence,
    })
}
