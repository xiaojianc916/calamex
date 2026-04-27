use super::contracts::{
    AiAgentPlanPayload, AiAgentPlanRequest, AiApplyPatchPayload, AiApplyPatchRequest,
    AiBuildIndexPayload, AiBuildIndexRequest, AiCancelRequest, AiChatMessagePayload, AiChatPayload, AiChatRequest, AiChatStreamPayload,
    AiCodeActionPayload, AiCodeActionRequest, AiConfigPayload, AiInlineCompletionRangePayload,
    AiInlineCompletionRequest, AiInlineCompletionResult, AiProposePatchPayload,
    AiProposePatchRequest, AiProviderTestPayload, AiQueryIndexPayload, AiQueryIndexRequest,
    AiSaveConfigRequest, AiSaveCredentialsRequest, AiToolDefinitionPayload,
};
use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::gateway;
use crate::ai::stream_manager;
use tauri::AppHandle;
use crate::ai_index;
use crate::ai_patch;
use crate::ai_tools::registry;

#[tauri::command]
pub fn ai_get_config() -> Result<AiConfigPayload, String> {
    Ok(gateway::get_config())
}

#[tauri::command]
pub fn ai_save_config(payload: AiSaveConfigRequest) -> Result<AiConfigPayload, String> {
    gateway::save_config(
        &payload.provider_type,
        payload.selected_model,
        payload.base_url,
        payload.inline_completion_enabled,
        payload.chat_enabled,
        payload.agent_enabled,
    )
}

#[tauri::command]
pub fn ai_save_credentials(payload: AiSaveCredentialsRequest) -> Result<AiConfigPayload, String> {
    gateway::save_credentials(&payload.provider_type, &payload.api_key)
}

#[tauri::command]
pub fn ai_clear_credentials() -> Result<(), String> {
    gateway::clear_credentials()?;
    audit::emit(AiAuditEventKind::CredentialCleared);
    Ok(())
}

#[tauri::command]
pub async fn ai_test_provider() -> Result<AiProviderTestPayload, String> {
    match gateway::test_provider().await {
        Ok(()) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message: "AI Provider 可用。".to_string(),
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: "AI_PROVIDER_UNAVAILABLE".to_string(),
            message: error,
        }),
    }
}

#[tauri::command]
pub async fn ai_chat(payload: AiChatRequest) -> Result<AiChatPayload, String> {
    let response = gateway::chat(payload).await?;
    Ok(AiChatPayload {
        message: AiChatMessagePayload {
            id: format!("assistant-{}", chrono::Utc::now().timestamp_millis()),
            role: "assistant".to_string(),
            content: response.content,
            created_at: chrono::Utc::now().to_rfc3339(),
            references: Vec::new(),
        },
        provider_type: gateway::get_config().provider_type,
        model: response.model,
    })
}


#[tauri::command]
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
pub fn ai_cancel(payload: AiCancelRequest) -> Result<(), String> {
    let stream_id = payload.stream_id.trim();
    if stream_id.is_empty() {
        return Err("AI_REQUEST_CANCELLED: streamId ?????".to_string());
    }
    stream_manager::cancel(stream_id);
    Ok(())
}

#[tauri::command]
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

#[tauri::command]
pub async fn ai_code_action(payload: AiCodeActionRequest) -> Result<AiCodeActionPayload, String> {
    gateway::code_action(payload).await
}

#[tauri::command]
pub async fn ai_plan_task(payload: AiAgentPlanRequest) -> Result<AiAgentPlanPayload, String> {
    gateway::plan_task(payload).await
}

#[tauri::command]
pub fn ai_build_index(payload: AiBuildIndexRequest) -> Result<AiBuildIndexPayload, String> {
    ai_index::build_index(payload)
}

#[tauri::command]
pub fn ai_query_index(payload: AiQueryIndexRequest) -> Result<AiQueryIndexPayload, String> {
    ai_index::query_index(payload)
}

#[tauri::command]
pub fn ai_propose_patch(payload: AiProposePatchRequest) -> Result<AiProposePatchPayload, String> {
    ai_patch::propose_patch(payload)
}

#[tauri::command]
pub fn ai_apply_patch(payload: AiApplyPatchRequest) -> Result<AiApplyPatchPayload, String> {
    ai_patch::apply_patch(payload)
}

#[tauri::command]
pub fn ai_list_tools() -> Result<Vec<AiToolDefinitionPayload>, String> {
    Ok(registry::list_tools()
        .into_iter()
        .map(|tool| AiToolDefinitionPayload {
            name: tool.name.to_string(),
            read_only: tool.read_only,
            destructive: tool.destructive,
            requires_confirmation: tool.requires_confirmation,
        })
        .collect())
}
