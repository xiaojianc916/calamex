use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarAskUserResumeRequest, AgentSidecarChatRequest,
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

/// 逐请求模型配置补齐（可注入 fetch 版，供测试）：`cfg` 为 `None` 时调 `fetch`
/// 组装并填入；已携带时原样保留且不调 `fetch`。`fetch` 出错时错误原样上抛，
/// 不写入半成品配置。
fn ensure_model_config_with<F>(
    cfg: &mut Option<AgentSidecarModelConfigPayload>,
    fetch: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<AgentSidecarModelConfigPayload, String>,
{
    if cfg.is_none() {
        *cfg = Some(fetch()?);
    }
    Ok(())
}

/// 逐请求模型配置补齐的生产入口：驱动回合的命令（chat / resolve_approval /
/// resolve_ask_user）在 payload 未携带 `model_config` 时，统一从已保存的 AI 配置补齐。
///
/// 为何必要：launch 层有意不向 ACP 子进程注入模型 env（模型配置走逐请求通道，
/// 见 acp/launch.rs）。若回合不携带 model_config，sidecar 会退回环境兜底并因
/// AGENT_SIDECAR_MODEL/AGENT_SIDECAR_API_KEY 未注入而报“AI 模型未配置”。集中于此单点
/// 补齐，避免各命令重复书写、也避免未来改写时静默漏掉某条路径。
fn ensure_model_config(cfg: &mut Option<AgentSidecarModelConfigPayload>) -> Result<(), String> {
    ensure_model_config_with(cfg, crate::ai::gateway::current_sidecar_model_config)
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
    // warmup 仅预热提供方连接，不需要真实回合模型，故此处不补齐 model_config。
    // sidecar 端在缺省时尝试从启动期环境解析（launch 层当前有意不注入模型 env，
    // 见 acp/launch.rs），无凭证时优雅跳过。注意：与 chat / resolve 不同——后者经命令层
    // ensure_model_config 从已保存配置逐请求补齐，不依赖进程环境。
    acp_host(&app)?
        .warmup(crate::acp::WarmupExtRequest { model_config: None })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_chat(
    app: AppHandle,
    mut payload: AgentSidecarChatRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    // 会话连续性对齐 Zed session_id = thread.id()：先以 thread_id（缺省回退空串→host 内
    // 按工作区新建）解析稳定 ACP SessionId，维持 thread 级别的会话连续性。
    let host = acp_host(&app)?;

    // 补齐模型配置（单点，见 ensure_model_config）：payload 未携带时从已保存配置补齐，
    // 否则 sidecar 退回未注入的环境兜底并报“AI 模型未配置”，导致整轮空白、回合秒结束。
    ensure_model_config(&mut payload.model_config)?;

    let acp_session_id = host
        .ensure_session(
            payload.thread_id.as_deref().unwrap_or_default(),
            payload.workspace_root_path.as_deref(),
        )
        .await
        .map_err(|error| error.to_string())?;

    // 流式帧关联键：使用前端提供的 session_id（= `sidecar:${assistantMessageId}`）
    // 而非 ACP ensure_session UUID。
    //
    // 根因：sidecar handleAgentChat 以 input.sessionId 标记发出的 session/update 帧；
    // 若此字段为 ACP UUID，前端 subscribeSidecarSessionStream 按前端自造的
    // `sidecar:${assistantMessageId}` 过滤时永远不匹配，整轮 live 帧全被丢弃，
    // 导致整轮空白、末尾一次性渲染。
    //
    // handleAgentChat 不依赖 session_id 做 ACP 路由（extMethod 不经标准 session/prompt），
    // 该字段仅用于标记下发的帧，可安全替换为前端已知的关联键。
    // 回退到 ACP session_id 以兼容 payload.session_id 未传的场景。
    let stream_session_id = payload
        .session_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| acp_session_id.to_string());

    let request = crate::acp::chat_request_to_agent_chat_ext(payload, stream_session_id);
    host.agent_chat(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_sidecar_resolve_approval(
    app: AppHandle,
    mut payload: AgentSidecarApprovalResolveRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    // 同 chat：先解析稳定会话，再投影为 agent/chat/resolve 扩展请求；裁决在同一回合
    // 内唤醒挂起审批并续跑，返回下一段响应信封（与旧 HTTP /approval/resolve 返回同形）。
    // 注：resolve 路径前端以上一轮信封里的 ACP session_id 订阅，ensure_session 对同
    // thread_id 返回同一 ACP id，两者已对齐，无需额外处理。
    let host = acp_host(&app)?;

    // 与 chat 同源：续跑同一回合仍需主模型，payload 缺省 model_config 时从已保存配置补齐，
    // 避免 sidecar 退回未注入的环境而报“AI 模型未配置”。
    ensure_model_config(&mut payload.model_config)?;

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
pub async fn agent_sidecar_resolve_ask_user(
    app: AppHandle,
    mut payload: AgentSidecarAskUserResumeRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    // 同 resolve_approval：先解析稳定会话，再投影为 agent/ask-user/resume 扩展请求；
    // 回灌 outcome + 结构化 answers 在同一回合内唤醒挂起的反向提问并续跑，返回下一段响应信封。
    let host = acp_host(&app)?;

    // 与 chat / resolve_approval 同源：续跑仍需主模型，缺省时从已保存配置补齐。
    ensure_model_config(&mut payload.model_config)?;

    let session_id = host
        .ensure_session(
            payload.thread_id.as_deref().unwrap_or_default(),
            payload.workspace_root_path.as_deref(),
        )
        .await
        .map_err(|error| error.to_string())?;
    let request =
        crate::acp::ask_user_resume_to_agent_ask_user_resume_ext(payload, session_id.to_string());
    host.agent_ask_user_resume(request)
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
    // session_id 不注入：host 以 thread_id 解析/建立会话。
    // 注意：编排路径目前未逐请求补齐 model_config（AcpOrchestrateStart 无该字段），
    // sidecar 端会退回启动期环境解析，而 launch 层当前不注入模型 env；编排在
    // feature flag 后面、主聊天不走此路。若后续启用编排，需比照 chat 补齐
    // model_config（需扩展 AcpOrchestrateStart，独立改动）。
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config(model_id: &str) -> AgentSidecarModelConfigPayload {
        AgentSidecarModelConfigPayload {
            model_id: model_id.to_string(),
            api_key: "secret-key".into(),
            base_url: None,
        }
    }

    #[test]
    fn ensure_model_config_fills_when_absent() {
        let mut cfg: Option<AgentSidecarModelConfigPayload> = None;
        ensure_model_config_with(&mut cfg, || Ok(sample_config("deepseek/deepseek-v4-pro")))
            .expect("缺省时应补齐成功");
        let filled = cfg.expect("缺省时应被补齐");
        assert_eq!(filled.model_id, "deepseek/deepseek-v4-pro");
    }

    #[test]
    fn ensure_model_config_keeps_existing_without_invoking_fetch() {
        let mut cfg = Some(sample_config("zhipuai/glm-4.7-flash"));
        let mut fetch_called = false;
        ensure_model_config_with(&mut cfg, || {
            fetch_called = true;
            Ok(sample_config("deepseek/deepseek-v4-pro"))
        })
        .expect("已有配置时应直接返回");
        assert!(!fetch_called, "已携带 model_config 时不应再读取已保存配置");
        assert_eq!(
            cfg.expect("应保留原配置").model_id,
            "zhipuai/glm-4.7-flash"
        );
    }

    #[test]
    fn ensure_model_config_propagates_fetch_error() {
        let mut cfg: Option<AgentSidecarModelConfigPayload> = None;
        let result = ensure_model_config_with(&mut cfg, || Err("AI 模型未配置".to_string()));
        assert_eq!(result, Err("AI 模型未配置".to_string()));
        assert!(cfg.is_none(), "补齐失败时不应写入半成品配置");
    }
}
