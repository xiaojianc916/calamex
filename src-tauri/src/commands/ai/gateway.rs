use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::gateway;
use crate::commands::contracts::{
    AiCancelRequest, AiChatRequest, AiChatStreamPayload, AiConfigPayload,
    AiConversationTitlePayload, AiConversationTitleRequest, AiInlineCompletionRangePayload,
    AiInlineCompletionRequest, AiInlineCompletionResult, AiProviderConnectionPayload,
    AiProviderConnectionRequest, AiProviderTestPayload, AiResolveApprovalRequest,
    AiSaveConfigRequest, AiSaveCredentialsRequest, AiSuggestionPoolPayload, AiSuggestionPoolRequest,
};
use tauri::AppHandle;

fn classify_provider_test_error_code(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("http 401")
        || normalized.contains("http 403")
        || normalized.contains("unauthorized")
        || normalized.contains("ai_provider_auth_failed")
    {
        "AI_PROVIDER_AUTH_FAILED"
    } else if normalized.contains("http 429")
        || normalized.contains("too many requests")
        || normalized.contains("rate limit")
    {
        "AI_PROVIDER_RATE_LIMITED"
    } else if normalized.contains("ai_provider_not_configured") || normalized.contains("http 404") {
        "AI_PROVIDER_NOT_CONFIGURED"
    } else if normalized.contains("ai_response_invalid") {
        "AI_RESPONSE_INVALID"
    } else {
        "AI_PROVIDER_UNAVAILABLE"
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
    match gateway::test_provider_config(
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
    .await
    {
        Ok(message) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message,
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: classify_provider_test_error_code(&error).to_string(),
            message: error,
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn ai_connect_provider(
    app: AppHandle,
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderConnectionPayload, String> {
    let config = gateway::connect_provider(
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
        config,
        test: AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message: "AI Provider 可用。".to_string(),
        },
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
    match gateway::test_provider(&app).await {
        Ok(message) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message,
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: classify_provider_test_error_code(&error).to_string(),
            message: error,
        }),
    }
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
    let resolved = app
        .state::<crate::acp::AcpRuntime>()
        .resolve_approval(session_id, tool_call_id, decision);
    Ok(resolved)
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
