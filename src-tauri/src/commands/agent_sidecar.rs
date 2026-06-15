use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,
    AgentSidecarCheckpointRestoreRequest, AgentSidecarHealthPayload,
    AgentSidecarModelConfigPayload, AgentSidecarOrchestratePayload, AgentSidecarOrchestrateRequest,
    AgentSidecarOrchestrateResumeRequest, AgentSidecarResponsePayload,
    AgentSidecarRollbackStepPath, AgentSidecarWarmupPayload,
};
use tauri::{AppHandle, Manager};

/// 取常驻 ACP 宿主：未建立时经 `AcpRuntime::get_or_spawn` 懒派生 stdio 子进程并缓存。
/// 失败（无法建立传输）归并为字符串错误，与命令既有错误契约一致。
fn acp_host(app: &AppHandle) -> Result<std::sync::Arc<crate::acp::AcpHost>, String> {
    app.state::<crate::acp::AcpRuntime>()
        .get_or_spawn(app)
        .map_err(|error| error.to_string())
}

/// 修剪并过滤空白可选字符串（与契约 `is_blank_optional_string` 跳过语义一致）：
/// `None` / 空 / 全空白 → `None`。
fn trimmed_non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

/// 把契约模型配置投影为客户端层 `ExtModelConfig`（与 `acp::bridge::model_config_to_ext`
/// 同源逻辑）：`api_key` 经 `into_inner` 取出明文，`base_url` 修剪空白。
fn model_config_to_ext(config: AgentSidecarModelConfigPayload) -> crate::acp::ExtModelConfig {
    crate::acp::ExtModelConfig {
        model_id: config.model_id,
        api_key: config.api_key.into_inner(),
        base_url: trimmed_non_empty(config.base_url),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_health(app: AppHandle) -> Result<AgentSidecarHealthPayload, String> {
    acp_host(&app)?
        .health()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_restart(app: AppHandle) -> Result<AgentSidecarHealthPayload, String> {
    // 重启常驻 ACP 宿主：关停旧 stdio 子进程/连接并重新派生，再探测健康作为重启
    // 结果（对齐旧 HTTP restart 返回 health 的契约）。
    let host = app
        .state::<crate::acp::AcpRuntime>()
        .restart(&app)
        .map_err(|error| error.to_string())?;
    host.health().await.map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_warmup(app: AppHandle) -> Result<AgentSidecarWarmupPayload, String> {
    // model_config 缺省：sidecar 退回到从启动期环境解析的默认模型配置（与 chat / orchestrate
    // 一致，模型配置在 ACP 子进程派生时即注入其环境）。
    acp_host(&app)?
        .warmup(crate::acp::WarmupExtRequest { model_config: None })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_chat(
    app: AppHandle,
    payload: AgentSidecarChatRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    // 会话连续性对齐 Zed session_id = thread.id()：先以 thread_id（缺省回退空串→host 内
    // 按工作区新建）解析稳定 SessionId，再投影为 agent/chat 扩展请求经 stdio 下发。
    let host = acp_host(&app)?;
    let session_id = host
        .ensure_session(
            payload.thread_id.as_deref().unwrap_or_default(),
            payload.workspace_root_path.as_deref(),
        )
        .await
        .map_err(|error| error.to_string())?;
    let request = crate::acp::chat_request_to_agent_chat_ext(payload, session_id.to_string());
    host.agent_chat(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_resolve_approval(
    app: AppHandle,
    payload: AgentSidecarApprovalResolveRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    // 同 chat：先解析稳定会话，再投影为 agent/chat/resolve 扩展请求；裁决在同一回合
    // 内唤醒挂起审批并续跑，返回下一段响应信封（与旧 HTTP /approval/resolve 返回同形）。
    let host = acp_host(&app)?;
    let session_id = host
        .ensure_session(
            payload.thread_id.as_deref().unwrap_or_default(),
            payload.workspace_root_path.as_deref(),
        )
        .await
        .map_err(|error| error.to_string())?;
    let request =
        crate::acp::approval_resolve_to_agent_chat_resolve_ext(payload, session_id.to_string());
    host.agent_chat_resolve(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_restore_checkpoint(
    app: AppHandle,
    payload: AgentSidecarCheckpointRestoreRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    acp_host(&app)?
        .restore_checkpoint(crate::acp::CheckpointRestoreRequest {
            run_id: payload.run_id,
            snapshot_id: trimmed_non_empty(payload.snapshot_id),
            step: payload.step.map(|step| match step {
                AgentSidecarRollbackStepPath::Single(value) => vec![value],
                AgentSidecarRollbackStepPath::Nested(values) => values,
            }),
            session_id: trimmed_non_empty(payload.session_id),
            model_config: payload.model_config.map(model_config_to_ext),
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_orchestrate(
    app: AppHandle,
    payload: AgentSidecarOrchestrateRequest,
) -> Result<AgentSidecarOrchestratePayload, String> {
    // session_id / model_config 不注入：host 以 thread_id 解析/建立会话，模型配置由 sidecar
    // 启动期环境解析（与主聊天一致）。
    acp_host(&app)?
        .orchestrate(crate::acp::AcpOrchestrateStart {
            goal: payload.goal,
            thread_id: payload.thread_id,
            execution_mode: payload.execution_mode,
            workspace_root_path: None,
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_orchestrate_resume(
    app: AppHandle,
    payload: AgentSidecarOrchestrateResumeRequest,
) -> Result<AgentSidecarOrchestratePayload, String> {
    // 续跑以 run_id 定位挂起运行；thread_id 不在续跑契约内，置 None（host 自行处理会话）。
    acp_host(&app)?
        .orchestrate_resume(crate::acp::AcpOrchestrateResume {
            run_id: payload.run_id,
            decision: payload.decision,
            reason: payload.reason,
            thread_id: None,
        })
        .await
        .map_err(|error| error.to_string())
}
