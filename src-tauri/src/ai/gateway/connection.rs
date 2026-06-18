use super::config::{
    AiProviderConnectionCandidate, build_provider_connection_candidate, save_connected_model,
};
use super::*;
use crate::commands::contracts::{
    AgentSidecarChatRequest, AgentSidecarMessagePayload, AgentSidecarResponsePayload,
};
use tauri::Manager as _;

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

    host.model_chat(crate::acp::chat_request_to_model_chat_ext(request))
        .await
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("ACP 模型透传失败：{error}"),
            )
        })
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
        let code = response.error_code.as_deref().unwrap_or("AI_PROVIDER_UNAVAILABLE");
        return Err(errors::error(code, error_message.clone()));
    }

    let reply = response.result.unwrap_or_default();
    let reply = reply.trim();

    if reply.is_empty() {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "模型连接成功但未返回任何内容，请确认所选模型与对应厂商 API Key 是否匹配可用。",
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

#[allow(clippy::too_many_arguments)]
pub async fn connect_provider(
    app: &AppHandle,
    role: Option<&str>,
    provider_id: Option<&str>,
    provider_type: &str,
    selected_model: Option<String>,
    base_url: Option<String>,
    inline_completion_enabled: bool,
    chat_enabled: bool,
    agent_enabled: bool,
    api_key: Option<&str>,
) -> Result<AiConfigPayload, String> {
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

    test_provider_connection_candidate(app, &candidate).await?;

    save_connected_model(role, candidate)
}
