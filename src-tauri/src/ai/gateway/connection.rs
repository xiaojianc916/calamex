use super::config::{
    AiProviderConnectionCandidate, build_provider_connection_candidate, save_connected_model,
};
use super::*;
use crate::commands::contracts::{
    AgentSidecarChatRequest, AgentSidecarMessagePayload, AgentSidecarResponsePayload,
};
use tauri::Manager as _;

/// 连接测试的整体时间预算：覆盖 ACP 宿主冷启动（派生 Node sidecar + `initialize` 握手）
/// 加上一次上游 LLM 往返。一旦超过即判定为超时并返回结构化错误，避免命令永挂、也避免
/// 前端只能等到 IPC 层超时后抛出无法归因的「IPC 调用超时」。
///
/// 重要约束：前端 `aiTestProviderConfig` / `aiTestProvider` 的 IPC 超时（见
/// `src/services/tauri.ai.ts` 的 `AI_COMMAND_META`）必须 **大于** 此预算，否则会在后端给出
/// 干净错误之前先行中断，用户又会看到无法归因的超时。
const PROVIDER_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// `connect_provider` 的结果。
///
/// 「凭证与配置已保存」是确定结论（只要返回 `Ok` 即已落盘）。`connect_provider` 现为
/// **纯保存**，不再附带在线连通性验证；`verification` 在此模式下恒为 `Ok(保存确认文案)`，
/// 仅用于让命令层复用既有的 `verification_to_test_payload` 映射，向前端回传形状一致的
/// 「已保存」反馈。真正的连通性测试由用户显式点击「测试」触发
/// （见 `test_provider_config` / `test_provider`）。
pub struct ProviderConnectionOutcome {
    /// 保存后的权威配置快照（含 `has_credentials` 等派生字段）。
    pub config: AiConfigPayload,
    /// 保存结果说明。纯保存模式下恒为 `Ok(保存确认文案)`；保留 `Result` 形状以复用
    /// `verification_to_test_payload`，与「测试」路径回传给前端的载荷结构保持一致。
    pub verification: Result<String, String>,
}

fn build_test_request(
    candidate: &AiProviderConnectionCandidate,
) -> Result<AgentSidecarChatRequest, String> {
    let model_id = candidate
        .selected_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| errors::error("AI_PROVIDER_NOT_CONFIGURED", "请先选择模型。"))?;
    let api_key = candidate.api_key_for_test.trim();
    if api_key.is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    Ok(AgentSidecarChatRequest {
        session_id: None,
        mode: Some("ask".to_string()),
        goal: Some("测试模型连接".to_string()),
        messages: vec![AgentSidecarMessagePayload {
            role: "user".to_string(),
            content: "请只回复：连接成功".to_string(),
        }],
        workspace_root_path: None,
        context: Vec::new(),
        model_config: Some(crate::commands::contracts::AgentSidecarModelConfigPayload {
            model_id: model_id.to_string(),
            api_key: api_key.to_string().into(),
            base_url: candidate
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string()),
        }),
        thread_id: None,
    })
}

/// 执行一次性「工具型」模型透传（连接测试专用）。
///
/// 对齐 Zed 把这类 model-backed 工具调用作为独立模型请求、与 Agent 会话回合分离的做法：
/// 连接测试是一次性请求，故走 `calamex.dev/model/chat` 原始透传，而非标准会话回合
/// （`session/prompt`）的工具循环。
///
/// 整个透传（含 ACP 宿主冷启动与上游往返）受 [`PROVIDER_TEST_TIMEOUT`] 约束，超时即返回
/// `AI_PROVIDER_TIMEOUT`，保证调用方不会被无界等待挂死。
async fn run_test_model_chat(
    app: &AppHandle,
    request: AgentSidecarChatRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn(app)
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("无法建立 ACP 宿主连接：{error}"),
            )
        })?;

    let model_chat = host.model_chat(crate::acp::chat_request_to_model_chat_ext(request));

    match tokio::time::timeout(PROVIDER_TEST_TIMEOUT, model_chat).await {
        Ok(result) => result.map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("ACP 模型透传失败：{error}"),
            )
        }),
        Err(_elapsed) => Err(errors::error(
            "AI_PROVIDER_TIMEOUT",
            format!(
                "连接测试超时（超过 {} 秒未收到模型响应）。请检查网络、Base URL 与所选模型后重试。",
                PROVIDER_TEST_TIMEOUT.as_secs()
            ),
        )),
    }
}

async fn test_provider_connection_candidate(
    app: &AppHandle,
    candidate: &AiProviderConnectionCandidate,
) -> Result<String, String> {
    let started_at = std::time::Instant::now();
    let response = run_test_model_chat(app, build_test_request(candidate)?).await?;

    // 优先检查 sidecar 返回的结构化错误（如 401 认证失败），
    // 避免将 provider 错误误分类为 AI_RESPONSE_INVALID。
    if let Some(error_message) = &response.error_message {
        let code = response
            .error_code
            .as_deref()
            .unwrap_or("AI_PROVIDER_UNAVAILABLE");
        return Err(errors::error(code, error_message.clone()));
    }

    let reply = response.result.unwrap_or_default();
    let reply = reply.trim();

    if reply.is_empty() {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "模型连接成功但未返回任何内容，请确认所选模型与对应 API Key 是否匹配可用。",
        ));
    }

    let latency_ms = started_at.elapsed().as_millis();
    let model_label = candidate
        .selected_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("默认模型");
    let key_source = if candidate.api_key_from_saved {
        "已保存的 API Key"
    } else {
        "本次填写的 API Key"
    };

    Ok(format!(
        "连接正常：{model_label} 已成功响应（使用{key_source}，耗时 {latency_ms}ms）。"
    ))
}

pub async fn test_provider(app: &AppHandle) -> Result<String, String> {
    let config = current_config()?;
    let selected_model = config
        .selected_model
        .clone()
        .or_else(|| default_model(&config.provider_type));
    let provider_id = validate_model_provider(selected_model.as_deref(), None)?;
    let candidate = AiProviderConnectionCandidate {
        provider_id,
        provider_type: config.provider_type.clone(),
        selected_model,
        base_url: config.base_url.clone(),
        api_key_for_test: get_api_key_for_config(&config)?,
        api_key_from_saved: true,
        inline_completion_enabled: config.inline_completion_enabled,
        chat_enabled: config.chat_enabled,
        agent_enabled: config.agent_enabled,
    };

    test_provider_connection_candidate(app, &candidate).await
}

#[allow(clippy::too_many_arguments)]
pub async fn test_provider_config(
    app: &AppHandle,
    _role: Option<&str>,
    provider_id: Option<&str>,
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<String, String> {
    let candidate = build_provider_connection_candidate(
        provider_id,
        provider_type,
        selected_model,
        base_url,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
        api_key,
        false,
    )?;

    test_provider_connection_candidate(app, &candidate).await
}

/// 保存一个 AI Provider 的连接配置与凭证（纯保存，不做在线验证）。
///
/// 设计要点：保存与「连通性验证」彻底解耦。是否保存只取决于配置/凭证语义是否合法
/// （已由 `build_provider_connection_candidate` 校验），一旦合法即落盘（写入 keyring 与
/// ai.json），刷新/重启后依然存在。连通性测试**不**在保存路径内触发——它会随网络/上游
/// 波动，若把它当作能否保存的闸门，一次超时就会打断用户、甚至误报「连接测试未通过」，
/// 还会把用户刚填的 Key 拖在一次慢请求后。
///
/// 连接测试改为仅由用户显式点击「测试」触发（见 [`test_provider_config`] / [`test_provider`]）。
///
/// `_app` 仅为与命令层签名保持一致而保留；纯保存不需要 ACP 宿主，故不触发任何网络往返。
#[allow(clippy::too_many_arguments, clippy::unused_async)]
pub async fn connect_provider(
    _app: &AppHandle,
    role: Option<&str>,
    provider_id: Option<&str>,
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<ProviderConnectionOutcome, String> {
    let role = normalize_model_role(role)?;
    let candidate = build_provider_connection_candidate(
        provider_id,
        provider_type,
        selected_model,
        base_url,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
        api_key,
        true,
    )?;

    // 仅落盘：保存只取决于「配置/凭证语义合法」（已由 build_provider_connection_candidate
    // 校验），与「在线连通性」彻底解耦。
    let config = save_connected_model(role, &candidate)?;

    Ok(ProviderConnectionOutcome {
        config,
        // 纯保存模式不做在线验证，这里返回保存确认文案；连通性请通过「测试」按钮验证。
        verification: Ok("凭证与配置已保存。点击「测试」可验证连接。".to_string()),
    })
}
