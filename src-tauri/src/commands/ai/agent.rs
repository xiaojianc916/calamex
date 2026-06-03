use crate::ai::gateway;
use crate::ai::security::network_permission;
use crate::commands::contracts::{
    AiAgentClassifyTaskPayload, AiAgentClassifyTaskRequest, AiAgentNetworkPermissionPayload,
    AiAgentSetNetworkPermissionRequest,
};

#[tauri::command]
#[specta::specta]
pub async fn ai_agent_classify_task(
    payload: AiAgentClassifyTaskRequest,
) -> Result<AiAgentClassifyTaskPayload, String> {
    gateway::classify_task(payload).await
}

#[tauri::command]
#[specta::specta]
pub fn ai_agent_set_network_permission(
    payload: AiAgentSetNetworkPermissionRequest,
) -> Result<AiAgentNetworkPermissionPayload, String> {
    network_permission::set_network_permission(payload)
}
