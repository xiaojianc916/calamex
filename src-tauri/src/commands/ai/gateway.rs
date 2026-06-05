use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::gateway;
use crate::ai::stream as stream_manager;
use crate::commands::contracts::{
    AiCancelRequest, AiChatRequest, AiChatStreamPayload, AiConfigPayload,
    AiConversationTitlePayload, AiConversationTitleRequest, AiInlineCompletionRangePayload,
    AiInlineCompletionRequest, AiInlineCompletionResult, AiProviderConnectionPayload,
    AiProviderConnectionRequest, AiProviderTestPayload, AiSaveConfigRequest,
    AiSaveCredentialsRequest, AiSuggestionPoolPayload, AiSuggestionPoolRequest,
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
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderTestPayload, String> {
    match gateway::test_provider_config(
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
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderConnectionPayload, String> {
    let config = gateway::connect_provider(
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
pub async fn ai_test_provider() -> Result<AiProviderTestPayload, String> {
    match gateway::test_provider().await {
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
    payload: AiConversationTitleRequest,
) -> Result<AiConversationTitlePayload, String> {
    gateway::generate_conversation_title(payload).await
}

#[tauri::command]
#[specta::specta]
pub fn ai_get_suggestion_pool_cache() -> Result<Option<AiSuggestionPoolPayload>, String> {
    gateway::get_suggestion_pool_cache()
}

#[tauri::command]
#[specta::specta]
pub async fn ai_generate_suggestion_pool(
    payload: AiSuggestionPoolRequest,
) -> Result<AiSuggestionPoolPayload, String> {
    gateway::generate_suggestion_pool(payload).await
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
    })
}

#[tauri::command]
#[specta::specta]
pub fn ai_cancel(payload: AiCancelRequest) -> Result<(), String> {
    let stream_id = payload.stream_id.trim();
    if stream_id.is_empty() {
        return Err("AI_REQUEST_CANCELLED: streamId 不能为空。".to_string());
    }
    stream_manager::cancel(stream_id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn ai_inline_complete(
    payload: AiInlineCompletionRequest,
) -> Result<AiInlineCompletionResult, String> {
    let result = gateway::inline_complete(payload).await?;
    Ok(AiInlineCompletionResult {
        insert_text: result.insert_text,
        range: AiInlineCompletionRangePayload {
            start_offset: result.range.start_offset,
            end_offset: result.range.end_offset,
        },
        confidence: result.confidence,
    })
}
