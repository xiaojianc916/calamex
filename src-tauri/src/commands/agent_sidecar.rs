use crate::agent_sidecar;
use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,
    AgentSidecarCheckpointRestoreRequest, AgentSidecarHealthPayload,
    AgentSidecarOrchestratePayload, AgentSidecarOrchestrateRequest,
    AgentSidecarOrchestrateResumeRequest, AgentSidecarResponsePayload, AgentSidecarWarmupPayload,
};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_health() -> Result<AgentSidecarHealthPayload, String> {
    agent_sidecar::health().await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_restart() -> Result<AgentSidecarHealthPayload, String> {
    agent_sidecar::restart().await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_warmup() -> Result<AgentSidecarWarmupPayload, String> {
    agent_sidecar::warmup().await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_chat(
    app: AppHandle,
    payload: AgentSidecarChatRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::chat(app, payload).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_resolve_approval(
    app: AppHandle,
    payload: AgentSidecarApprovalResolveRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::resolve_approval(app, payload).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_restore_checkpoint(
    app: AppHandle,
    payload: AgentSidecarCheckpointRestoreRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::restore_checkpoint(app, payload).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_orchestrate(
    app: AppHandle,
    payload: AgentSidecarOrchestrateRequest,
) -> Result<AgentSidecarOrchestratePayload, String> {
    agent_sidecar::orchestrate(app, payload).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_orchestrate_resume(
    app: AppHandle,
    payload: AgentSidecarOrchestrateResumeRequest,
) -> Result<AgentSidecarOrchestratePayload, String> {
    agent_sidecar::orchestrate_resume(app, payload).await
}
