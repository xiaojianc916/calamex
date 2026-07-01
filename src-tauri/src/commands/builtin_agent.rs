use crate::commands::contracts::{
    AgentBackendKind, AgentExternalChatRequest, AgentExternalChatResultPayload,
    AgentSidecarCheckpointRestoreRequest, AgentSidecarHealthPayload,
    AgentSidecarModelConfigPayload, AgentSidecarResponsePayload,
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

/// 把契约层后端类型投影为 `acp` 层后端标识（ADR-0015）。match 穷尽：新增后端会触发编译错误。
fn backend_kind_to_acp(kind: AgentBackendKind) -> crate::acp::AcpBackendId {
    match kind {
        AgentBackendKind::Builtin => crate::acp::AcpBackendId::Builtin,
        AgentBackendKind::Kimi => crate::acp::AcpBackendId::Kimi,
        AgentBackendKind::Codex => crate::acp::AcpBackendId::Codex,
    }
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
        api_key: config.api_key,
        base_url: trimmed_non_empty(config.base_url),
    }
}

/// 组装 builtin 后端 session/new 的 _meta 模型目录（仅 builtin 用）的纯函数：把「全量可用模型
/// + 当前选中项」投影为边车可解析的目录对象。抽出可注入版便于单测，不触碰全局 AI 配置状态。
///
/// 为何经 _meta 下发：官方 session/set_config_option 仅携带被选中的 modelId、不含凭据，而 launch
/// 层有意不向 ACP 子进程注入模型 env（见 acp/launch.rs）。故 builtin 边车需在建会话时一次性拿到
/// 「用户全部可用模型 + 凭据 + 当前选中项」，据此公示官方 config_options 模型选择器（与 Kimi 同构），
/// 并在后续 set_config_option 切换时按 modelId 命中已下发的凭据。
///
/// 目录形状对齐边车 model-config-options.ts 的 IAcpModelCatalog：
/// { models: [{ modelId, apiKey, baseUrl? }], currentModelId? }——models 经 ExtModelConfig 的
/// camelCase 序列化逐条投影（与逐请求模型配置同形）；currentModelId 缺省时整字段省略（不下发
/// null）。models 为空且无当前项时返回 None（不附 _meta，回退既有行为）。
fn builtin_model_catalog_meta_from(
    seeded: Vec<AgentSidecarModelConfigPayload>,
    current_model_id: Option<String>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let models: Vec<crate::acp::ExtModelConfig> =
        seeded.into_iter().map(model_config_to_ext).collect();
    if models.is_empty() && current_model_id.is_none() {
        return None;
    }

    let mut catalog = serde_json::Map::new();
    catalog.insert(
        "models".to_string(),
        serde_json::to_value(&models).unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
    );
    if let Some(current_model_id) = current_model_id {
        catalog.insert(
            "currentModelId".to_string(),
            serde_json::Value::String(current_model_id),
        );
    }

    let mut meta = serde_json::Map::new();
    meta.insert(
        "calamex.dev/modelCatalog".to_string(),
        serde_json::Value::Object(catalog),
    );
    Some(meta)
}

/// 生产入口：从已保存 AI 配置组装 builtin session/new 的 _meta 模型目录。
/// models 取「用户真正可用（有 Key）」的全量 seeded 清单（seeded_sidecar_model_configs 已逐条
/// best-effort 跳过无凭据者）；currentModelId 取当前主模型（解析失败则省略）。
fn builtin_model_catalog_meta() -> Option<serde_json::Map<String, serde_json::Value>> {
    builtin_model_catalog_meta_from(
        crate::ai::gateway::seeded_sidecar_model_configs(),
        crate::ai::gateway::current_sidecar_model_config()
            .ok()
            .map(|config| config.model_id),
    )
}

/// 逐请求模型配置补齐（可注入 fetch 版，供测试）：`cfg` 为 `None` 时调 `fetch`
/// 组装并填入；已携带时原样保留且不调 `fetch`。`fetch` 出错时错误原样上抛，
/// 不写入半成品配置。
fn ensure_model_config_with(
    cfg: &mut Option<AgentSidecarModelConfigPayload>,
    fetch: impl FnOnce() -> Result<AgentSidecarModelConfigPayload, String>,
) -> Result<(), String> {
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
/// BUILTIN_AGENT_MODEL/BUILTIN_AGENT_API_KEY 未注入而报“AI 模型未配置”。集中于此单点
/// 补齐，避免各命令重复书写、也避免未来改写时静默漏掉某条路径。
fn ensure_model_config(cfg: &mut Option<AgentSidecarModelConfigPayload>) -> Result<(), String> {
    ensure_model_config_with(cfg, crate::ai::gateway::current_sidecar_model_config)
}

#[tauri::command]
#[specta::specta]
pub async fn builtin_agent_health(app: AppHandle) -> Result<AgentSidecarHealthPayload, String> {
    acp_host(&app)?
        .health()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn builtin_agent_restart(app: AppHandle) -> Result<AgentSidecarHealthPayload, String> {
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
pub async fn builtin_agent_warmup(app: AppHandle) -> Result<AgentSidecarWarmupPayload, String> {
    // warmup 仅预热提供方连接，不需要真实回合模型，故此处不补齐 model_config。
    // sidecar 端在缺省时尝试从启动期环境解析（launch 层当前有意不注入模型 env，
    // 见 acp/launch.rs），无凭证时优雅跳过。注意：与 chat / resolve 不同——后者经命令层
    // ensure_model_config 从已保存配置逐请求补齐，不依赖进程环境。
    acp_host(&app)?
        .warmup(crate::acp::WarmupExtRequest { model_config: None })
        .await
        .map_err(|error| error.to_string())
}

/// 外部 ACP 编码 agent（Kimi Code / Codex 等，ADR-0015）的标准回合命令（`session/prompt`）。
///
/// 与 `builtin_agent_chat`（走自家边车的带外 `agent_chat` 扩展回合）不同：按后端类型经
/// `get_or_spawn_backend` 解析/派生对应的独立常驻宿主，解析稳定会话后以纯文本内容块驱动
/// 一轮标准 prompt。**不补齐 model_config**——外部 agent 的凭据由其自身 CLI 自管（见
/// acp/launch.rs；如 Kimi 凭据落 ~/.kimi，登录由其自身流程处理）。过程增量经 session/update 帧转发
/// （投影见 acp/ui_event.rs），本命令仅返回终态：会话标识 + 回合终止原因。
#[tauri::command]
#[specta::specta]
pub async fn builtin_agent_external_chat(
    app: AppHandle,
    payload: AgentExternalChatRequest,
) -> Result<AgentExternalChatResultPayload, String> {
    let backend = backend_kind_to_acp(payload.backend);
    let runtime = app.state::<crate::acp::AcpRuntime>();
    let host = runtime
        .get_or_spawn_backend(&app, backend)
        .map_err(|error| error.to_string())?;

    let AgentExternalChatRequest {
        text,
        thread_id,
        workspace_root_path,
        session_id: client_stream_session_id,
        ..
    } = payload;
    let thread_id = thread_id.as_deref().unwrap_or_default();
    let workspace_root_path = workspace_root_path.as_deref();

    // 把一轮回合收敛成单个 Result，便于在命令边界统一处置失败：ensure_session / prompt 共享
    // 同一条 ACP 连接，任一步失败都按同一策略（驱逐失效宿主 + 翻译提示）处理。
    let outcome: Result<AgentExternalChatResultPayload, crate::acp::AcpClientError> = async {
        // 先解析稳定 ACP 会话（thread_id ↔ SessionId，跨回合复用），作为回退用的会话 id。
        // 仅 builtin 后端经 session/new 的 _meta 下发模型目录（含凭据 + 当前选中项），供其边车
        // 公示官方 config_options 模型选择器、并在 set_config_option 切换时按 modelId 命中已下发
        // 凭据；外部 agent（Kimi/Codex）凭据自管，不下发（None）。详见 builtin_model_catalog_meta。
        let session_meta = match backend {
            crate::acp::AcpBackendId::Builtin => builtin_model_catalog_meta(),
            crate::acp::AcpBackendId::Kimi | crate::acp::AcpBackendId::Codex => None,
        };
        let acp_session_id = host
            .ensure_session(thread_id, workspace_root_path, session_meta)
            .await?;

        // 流式关联键：优先用前端预生成的 session_id（= sidecar:assistantMessageId），它在发起
        // 回合前就已知、可被 subscribeSidecarSessionStream 即时订阅；外部 agent 发出的
        // session/update 帧本身以 ACP 会话 UUID 标记，由宿主 sink 依此键重写后再下发（见
        // host.prompt_with_stream_key），使前端按预生成键过滤即可实时收帧。缺省/空白时回退到
        // ACP 会话 id（与旧行为一致）。
        let stream_session_id = client_stream_session_id
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| acp_session_id.to_string());

        let stop_reason = host
            .prompt_text(
                thread_id,
                workspace_root_path,
                &text,
                Some(stream_session_id.as_str()),
            )
            .await?;
        Ok(AgentExternalChatResultPayload {
            session_id: stream_session_id,
            stop_reason: format!("{stop_reason:?}"),
        })
    }
    .await;

    outcome.map_err(|error| {
        // 客户端任务已退出（外部 agent 进程未运行 / 初始化失败 / 未登录）：驱逐缓存的失效宿主，
        // 使下一次发送经 get_or_spawn_backend 重新派生新连接，而非永远卡在同一个已死连接上。
        if matches!(error, crate::acp::AcpClientError::NotRunning) {
            runtime.evict_backend(backend);
        }
        external_chat_error_message(backend, &error)
    })
}

/// 把外部 agent 回合错误翻译为面向用户的可操作提示。
///
/// NotRunning（"acp client task is not running"）= 该后端常驻 ACP 客户端任务已退出：多因外部
/// agent 子进程启动/初始化失败或连接断开（如首次需登录授权、工程内置依赖缺失）。给出明确的下一步，
/// 而非透传不透明的协议字符串；其余错误原样转字符串上抛。
fn external_chat_error_message(
    backend: crate::acp::AcpBackendId,
    error: &crate::acp::AcpClientError,
) -> String {
    if matches!(error, crate::acp::AcpClientError::NotRunning) {
        return format!(
            "{} agent 连接已断开或未能启动（可能正在初始化、首次需登录授权，或工程内置依赖未就绪）。请稍后重试。",
            external_backend_label(backend)
        );
    }
    error.to_string()
}

/// 外部后端的用户可读名称（用于错误提示）。match 穷尽：新增后端会触发编误错误。
fn external_backend_label(backend: crate::acp::AcpBackendId) -> &'static str {
    match backend {
        crate::acp::AcpBackendId::Builtin => "自研",
        crate::acp::AcpBackendId::Kimi => "Kimi",
        crate::acp::AcpBackendId::Codex => "Codex",
    }
}

#[tauri::command]
#[specta::specta]
pub async fn builtin_agent_restore_checkpoint(
    app: AppHandle,
    mut payload: AgentSidecarCheckpointRestoreRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    // 与 chat / resolve_* 同源：检查点恢复会驱动续跑回合，缺省时也需补齐主模型配置，
    // 否则 sidecar 退回未注入的环境兜底并报\"AI 模型未配置\"。
    ensure_model_config(&mut payload.model_config)?;

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
    fn builtin_model_catalog_meta_assembles_models_and_current() {
        let meta = builtin_model_catalog_meta_from(
            vec![
                sample_config("deepseek/deepseek-v4-pro"),
                sample_config("zhipuai/glm-4.7-flash"),
            ],
            Some("deepseek/deepseek-v4-pro".to_string()),
        )
        .expect("有模型时应组装出目录");
        let catalog = &meta["calamex.dev/modelCatalog"];
        assert_eq!(catalog["models"].as_array().unwrap().len(), 2);
        assert_eq!(catalog["models"][0]["modelId"], "deepseek/deepseek-v4-pro");
        // ExtModelConfig 的 api_key（SecretString）序列化为明文，与逐请求模型配置同形。
        assert_eq!(catalog["models"][0]["apiKey"], "secret-key");
        assert!(catalog["models"][0].get("baseUrl").is_none());
        assert_eq!(catalog["currentModelId"], "deepseek/deepseek-v4-pro");
    }

    #[test]
    fn builtin_model_catalog_meta_omits_current_when_absent() {
        let meta =
            builtin_model_catalog_meta_from(vec![sample_config("deepseek/deepseek-v4-pro")], None)
                .expect("仅有模型清单时也应组装出目录");
        let catalog = &meta["calamex.dev/modelCatalog"];
        assert_eq!(catalog["models"].as_array().unwrap().len(), 1);
        // 当前选中项缺省时不下发 currentModelId（整字段省略，不发 null）。
        assert!(catalog.get("currentModelId").is_none());
    }

    #[test]
    fn builtin_model_catalog_meta_none_when_empty() {
        // 无任何可用模型且无当前项时不附 _meta（回退既有行为）。
        assert!(builtin_model_catalog_meta_from(Vec::new(), None).is_none());
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
        assert_eq!(cfg.expect("应保留原配置").model_id, "zhipuai/glm-4.7-flash");
    }

    #[test]
    fn ensure_model_config_propagates_fetch_error() {
        let mut cfg: Option<AgentSidecarModelConfigPayload> = None;
        let result = ensure_model_config_with(&mut cfg, || Err("AI 模型未配置".to_string()));
        assert_eq!(result, Err("AI 模型未配置".to_string()));
        assert!(cfg.is_none(), "补齐失败时不应写入半成品配置");
    }
}
