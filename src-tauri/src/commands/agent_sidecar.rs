use crate::agent_sidecar;
use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,
    AgentSidecarCheckpointRestoreRequest, AgentSidecarExecuteRequest, AgentSidecarHealthPayload,
    AgentSidecarPlanApproveRequest, AgentSidecarPlanFinishRequest, AgentSidecarPlanQueryRequest,
    AgentSidecarPlanRejectRequest, AgentSidecarPlanReplanRequest, AgentSidecarPlanRequest,
    AgentSidecarPlanValidateRequest, AgentSidecarResponsePayload, AgentSidecarWarmupPayload,
};
use tauri::AppHandle;

#[tauri::command]
pub async fn agent_sidecar_health() -> Result<AgentSidecarHealthPayload, String> {
    agent_sidecar::health().await
}

#[tauri::command]
pub async fn agent_sidecar_restart() -> Result<AgentSidecarHealthPayload, String> {
    agent_sidecar::restart().await
}

#[tauri::command]
pub async fn agent_sidecar_warmup() -> Result<AgentSidecarWarmupPayload, String> {
    agent_sidecar::warmup().await
}

#[tauri::command]
pub async fn agent_sidecar_chat(
    app: AppHandle,
    payload: AgentSidecarChatRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::chat(app, payload).await
}

#[tauri::command]
pub async fn agent_sidecar_plan(
    app: AppHandle,
    payload: AgentSidecarPlanRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::plan(app, payload).await
}

#[tauri::command]
pub async fn agent_sidecar_plan_approve(
    payload: AgentSidecarPlanApproveRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::approve_plan(payload).await
}

#[tauri::command]
pub async fn agent_sidecar_plan_query(
    payload: AgentSidecarPlanQueryRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::query_plan(payload).await
}

#[tauri::command]
pub async fn agent_sidecar_plan_reject(
    payload: AgentSidecarPlanRejectRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::reject_plan(payload).await
}

#[tauri::command]
pub async fn agent_sidecar_plan_finish(
    payload: AgentSidecarPlanFinishRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::finish_plan(payload).await
}

#[tauri::command]
pub async fn agent_sidecar_plan_validate(
    payload: AgentSidecarPlanValidateRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::validate_plan(payload).await
}

#[tauri::command]
pub async fn agent_sidecar_plan_replan(
    payload: AgentSidecarPlanReplanRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::replan_plan(payload).await
}

#[tauri::command]
pub async fn agent_sidecar_execute(
    app: AppHandle,
    payload: AgentSidecarExecuteRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::execute(app, payload).await
}

#[tauri::command]
pub async fn agent_sidecar_resolve_approval(
    app: AppHandle,
    payload: AgentSidecarApprovalResolveRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::resolve_approval(app, payload).await
}

#[tauri::command]
pub async fn agent_sidecar_restore_checkpoint(
    app: AppHandle,
    payload: AgentSidecarCheckpointRestoreRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    agent_sidecar::restore_checkpoint(app, payload).await
}
