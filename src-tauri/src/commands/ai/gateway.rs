use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::gateway;
use crate::commands::contracts::{
    AiCancelRequest, AiConfigPayload,
    AiConversationTitlePayload, AiConversationTitleRequest, AiEnsureAcpSessionRequest,
    AiInlineCompletionRangePayload, AiInlineCompletionRequest,
    AiInlineCompletionResult, AiProviderConnectionPayload, AiProviderConnectionRequest,
    AiProviderTestPayload, AiResolveApprovalRequest, AiSaveConfigRequest, AiSaveCredentialsRequest,
    AiSetSeededModelsRequest, AiSessionConfigOptionsPayload,
    AiSetSessionConfigOptionRequest, AiSuggestionPoolPayload,
    AiSuggestionPoolRequest,
};
use tauri::AppHandle;

fn classify_provider_test_error_code(error: &str) -> String {
    // 优先解析结构化错误 JSON（由 errors::error() 构造的 AiErrorPayload）。
    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(error)
        && let Some(code) = payload.get("code").and_then(|v| v.as_str())
    {
        return code.to_string();
    }

    let normalized = error.to_ascii_lowercase();
    if normalized.contains("http 401")
        || normalized.contains("http 403")
        || normalized.contains("unauthorized")
        || normalized.contains("ai_provider_auth_failed")
    {
        "AI_PROVIDER_AUTH_FAILED".to_string()
    } else if normalized.contains("http 429")
        || normalized.contains("too many requests")
        || normalized.contains("rate limit")
    {
        "AI_PROVIDER_RATE_LIMITED".to_string()
    } else if normalized.contains("ai_provider_not_configured") || normalized.contains("http 404") {
        "AI_PROVIDER_NOT_CONFIGURED".to_string()
    } else if normalized.contains("ai_response_invalid") {
        "AI_RESPONSE_INVALID".to_string()
    } else {
        "AI_PROVIDER_UNAVAILABLE".to_string()
    }
}

/// 将一次连接测试的 `Result<成功说明, 结构化错误>` 归一化为前端契约 `AiProviderTestPayload`。
///
/// 成功 → ok:true + AI_PROVIDER_READY；失败 → ok:false + 解析出的结构化错误码 + 原始消息。
/// 供 ai_test_provider / ai_test_provider_config / ai_connect_provider 的验证结果共用，
/// 保证三条路径对「连通性结论」的呈现完全一致。
fn verification_to_test_payload(verification: Result<String, String>) -> AiProviderTestPayload {
    match verification {
        Ok(message) => AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message,
        },
        Err(error) => AiProviderTestPayload {
            ok: false,
            code: classify_provider_test_error_code(&error),
            message: error,
        },
    }
}

/// AI 模型/厂商配置变更后，让**正在运行的**外部 ACP 后端（Kimi）即时生效。
///
/// 背景（历史缺陷）：`ai_save_config` 此前只持久化 `ai.json` + 更新内存配置，从不触碰
/// `AcpRuntime`。而 Kimi（`kimi acp`）只在进程启动时由 `KimiProvisioner::prepare()` 把当前
/// 配置 seed 成托管 `config.toml` 的 `default_model` / provider 列表、**启动后不热加载**，
/// 故设置里切换模型对「已在运行的 Kimi」是空操作——表现为「无论选什么都用 kimi 模型」。
///
/// 修复：保存成功后，若 Kimi 后端**正在运行**则 `restart_backend(Kimi)`——重启会先关停旧
/// 宿主、重新 `prepare()`（用最新配置重写 `config.toml`）、再重派生子进程，使所选模型即时生效。
/// 未运行则不动：下次按需 `get_or_spawn` 时自然以最新配置 `prepare`，无需为「重新应用配置」
/// 平白拉起一个本未运行的后端（保持懒派生语义）。重启失败仅记录日志、不影响「配置已保存」这一
/// 既成结果（配置已落盘，下次拉起仍读取最新值）。
fn reconfigure_running_external_backends(app: &AppHandle) {
    use tauri::Manager as _;
    let runtime = app.state::<crate::acp::AcpRuntime>();
    if !runtime.is_backend_running(crate::acp::AcpBackendId::Kimi) {
        return;
    }
    match runtime.restart_backend(app, crate::acp::AcpBackendId::Kimi) {
        Ok(_) => log::info!(
            target: "acp",
            "AI 配置已保存，已重启运行中的 Kimi 后端以应用最新模型/厂商配置。"
        ),
        Err(error) => log::warn!(
            target: "acp",
            "AI 配置已保存，但重启运行中的 Kimi 后端失败（下次拉起仍会读取最新配置）：{error}"
        ),
    }
}

#[tauri::command]
#[specta::specta]
pub fn ai_get_config() -> Result<AiConfigPayload, String> {
    Ok(gateway::get_config())
}

#[tauri::command]
#[specta::specta]
pub fn ai_save_config(
    app: AppHandle,
    payload: AiSaveConfigRequest,
) -> Result<AiConfigPayload, String> {
    let config = gateway::save_config(
        payload.role.as_deref(),
        &payload.provider_type,
        payload.selected_model,
        payload.base_url,
        payload.inline_completion_enabled,
        payload.chat_enabled,
        payload.agent_enabled,
    )?;

    // 配置已落盘：让正在运行的外部后端（Kimi）即时应用新模型/厂商（详见函数文档）。
    reconfigure_running_external_backends(&app);

    Ok(config)
}

/// 下发「全量可原生切换模型清单」（seeded_models）并即时生效。
///
/// 前端把项目内置的可扩展模型目录（MASTRA_PROVIDER_PRESET.models）整体下发，后端落盘 ai.json
/// 后，作为 Kimi 启动时 seed 进 config.toml 的候选模型全集——使 Kimi 原生 session/set_config_option
/// 的切换候选池覆盖整张清单、零重启切换。与 ai_save_config 同构：清单变更可能新增/移除可切换模型，
/// 故落盘后 reconfigure_running_external_backends 重启运行中的 Kimi 以即时刷新候选池。
#[tauri::command]
#[specta::specta]
pub fn ai_set_seeded_models(
    app: AppHandle,
    payload: AiSetSeededModelsRequest,
) -> Result<AiConfigPayload, String> {
    let config = gateway::set_seeded_models(payload.models)?;

    // 候选池变更：让正在运行的 Kimi 重新 seed config.toml 并即时生效（详见 reconfigure 文档）。
    reconfigure_running_external_backends(&app);

    Ok(config)
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
    app: AppHandle,
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderTestPayload, String> {
    let verification = gateway::test_provider_config(
        &app,
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
    .await;

    Ok(verification_to_test_payload(verification))
}

#[tauri::command]
#[specta::specta]
pub async fn ai_connect_provider(
    app: AppHandle,
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderConnectionPayload, String> {
    // connect_provider 先持久化、再做非致命验证：返回 Ok 即代表凭证/配置已落盘，
    // test 字段如实反映在线验证结论（不再硬编码 ok:true）。
    let outcome = gateway::connect_provider(
        &app,
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

    // 「开始连接」也会改变所选模型/厂商与凭证；同 ai_save_config，连接成功后让正在运行的 Kimi 即时生效。
    reconfigure_running_external_backends(&app);

    Ok(AiProviderConnectionPayload {
        config: outcome.config,
        test: verification_to_test_payload(outcome.verification),
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
pub async fn ai_test_provider(app: AppHandle) -> Result<AiProviderTestPayload, String> {
    let verification = gateway::test_provider(&app).await;
    Ok(verification_to_test_payload(verification))
}

#[tauri::command]
#[specta::specta]
pub async fn ai_generate_conversation_title(
    app: AppHandle,
    payload: AiConversationTitleRequest,
) -> Result<AiConversationTitlePayload, String> {
    gateway::generate_conversation_title(&app, payload).await
}

#[tauri::command]
#[specta::specta]
pub fn ai_get_suggestion_pool_cache() -> Result<Option<AiSuggestionPoolPayload>, String> {
    gateway::get_suggestion_pool_cache()
}

#[tauri::command]
#[specta::specta]
pub async fn ai_generate_suggestion_pool(
    app: AppHandle,
    payload: AiSuggestionPoolRequest,
) -> Result<AiSuggestionPoolPayload, String> {
    gateway::generate_suggestion_pool(&app, payload).await
}

#[tauri::command]
#[specta::specta]
pub fn ai_cancel(app: AppHandle, payload: AiCancelRequest) -> Result<(), String> {
    let thread_id = payload
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AI_REQUEST_CANCELLED: threadId 不能为空。".to_string())?;

    use tauri::Manager as _;
    app.state::<crate::acp::AcpRuntime>()
        .cancel_thread(thread_id);
    Ok(())
}

/// 驱逐某线程的 ACP 会话态（删除对话时调用）：委托 AcpRuntime 向全部已建立宿主广播移除该线程的
/// thread↔session / config_options / available_commands 条目，根治这些按 thread/session 键的表随
/// 会话数单调增长的泄漏。threadId 空白视作无操作（对齐「删除本就不存在的对话」的良性调用）。
#[tauri::command]
#[specta::specta]
pub fn ai_evict_thread(app: AppHandle, thread_id: String) -> Result<(), String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Ok(());
    }
    use tauri::Manager as _;
    app.state::<crate::acp::AcpRuntime>().evict_thread(thread_id);
    Ok(())
}

/// 投递 ACP 反向权限请求（`session/request_permission`）的审批决策，唤醒回合内挂起的工具调用。
///
/// 与 `ai_cancel` 同构地委托给 Tauri 托管的 `AcpRuntime`：会话归属哪个后端宿主对命令层透明，
/// 由 runtime 向全部已建立宿主广播投递。三字段先行空白校验（前端总能从已渲染审批气泡取得）；
/// 返回是否命中某挂起审批——`false` 表示无匹配（多为已超时/被取消/重复投递的良性竞态，
/// 命令层不视作错误，交前端自行决定是否提示），与 runtime 的「安全空操作」语义一致。
#[tauri::command]
#[specta::specta]
pub fn ai_resolve_approval(
    app: AppHandle,
    payload: AiResolveApprovalRequest,
) -> Result<bool, String> {
    let session_id = payload.session_id.trim();
    if session_id.is_empty() {
        return Err("AI_APPROVAL_RESOLVE_INVALID: sessionId 不能为空。".to_string());
    }
    let tool_call_id = payload.tool_call_id.trim();
    if tool_call_id.is_empty() {
        return Err("AI_APPROVAL_RESOLVE_INVALID: toolCallId 不能为空。".to_string());
    }
    let decision = payload.decision.trim();
    if decision.is_empty() {
        return Err("AI_APPROVAL_RESOLVE_INVALID: decision 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let resolved =
        app.state::<crate::acp::AcpRuntime>()
            .resolve_approval(session_id, tool_call_id, decision);
    Ok(resolved)
}

/// 切换 ACP 会话的某个配置项值（标准 session/set_config_option），令外部 agent（Kimi Code /
/// Codex 等）在 agent 公示的模型 / 模式 / 思考强度等配置项间切换。
///
/// 与 ai_resolve_approval 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主对命令层
/// 透明，由 runtime 向全部已建立宿主广播下发。三字段先行空白校验；返回是否命中某已绑定会话——
/// false 表示无匹配（多为会话尚未建立/已结束的良性竞态，命令层不视作错误）。
#[tauri::command]
#[specta::specta]
pub async fn ai_set_session_config_option(
    app: AppHandle,
    payload: AiSetSessionConfigOptionRequest,
) -> Result<Option<AiSessionConfigOptionsPayload>, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: threadId 不能为空。".to_string());
    }
    let config_id = payload.config_id.trim();
    if config_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: configId 不能为空。".to_string());
    }
    let value_id = payload.value_id.trim();
    if value_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: valueId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let runtime = app.state::<crate::acp::AcpRuntime>();
    // 切换后的权威配置项快照由 session/set_config_option 响应直接回传（agent 未回填时回退到
    // 会话级缓存快照）；未命中任何已绑定会话则为 None。
    let config_options = runtime
        .set_session_config_option(thread_id, config_id, value_id)
        .await
        .map_err(|error| format!("AI_SET_SESSION_CONFIG_OPTION_FAILED: {error}"))?;
    Ok(config_options.map(|config_options| AiSessionConfigOptionsPayload { config_options }))
}

/// 握手并复用/建立某线程在指定后端上的 ACP 会话，并回传 agent 在 session/new 响应公示的可用配置项
/// 全集（v3 · 唯一标准管线）。
///
/// 配置项发现的唯一来源即此握手返回值：经 get_or_spawn_backend 懒建立目标后端宿主后 ensure_session
/// 建立/复用会话，agent 在 session/new 响应里以 config_options 公示「模型 / 模式 / 思考强度等」可切换
/// 配置项全集（含 currentValue 当前选中项），宿主据 thread_id 登记后由本命令原样回传前端选择器。会话
/// 复用回合（已存在映射）不重发 session/new，则回退到宿主缓存的同一快照；agent 未公示任何配置项时
/// 返回 None。后续 agent 主动发起的 config_option_update（标准回合内通知）经流式投影由前端增量并入，
/// 不在此通道。thread_id / backend 先行校验；未知 backend 报错。
#[tauri::command]
#[specta::specta]
pub async fn ai_ensure_acp_session(
    app: AppHandle,
    payload: AiEnsureAcpSessionRequest,
) -> Result<Option<AiSessionConfigOptionsPayload>, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_ENSURE_ACP_SESSION_INVALID: threadId 不能为空。".to_string());
    }
    let backend = match payload.backend.trim() {
        "builtin" => crate::acp::AcpBackendId::Builtin,
        "kimi" => crate::acp::AcpBackendId::Kimi,
        "codex" => crate::acp::AcpBackendId::Codex,
        other => {
            return Err(format!("AI_ENSURE_ACP_SESSION_INVALID: 未知 backend：{other}"));
        }
    };
    let workspace_root_path = payload
        .workspace_root_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    use tauri::Manager as _;
    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn_backend(&app, backend)
        .map_err(|error| format!("AI_ENSURE_ACP_SESSION_FAILED: {error}"))?;
    host.ensure_session(thread_id, workspace_root_path, None)
        .await
        .map_err(|error| format!("AI_ENSURE_ACP_SESSION_FAILED: {error}"))?;
    // 配置项发现的唯一来源：回传 agent 在 session/new 响应公示的可用配置项全集（会话复用回合回退到
    // 宿主缓存的同一快照；agent 未公示则为 None）。
    Ok(host
        .session_config_options(thread_id)
        .map(|config_options| AiSessionConfigOptionsPayload { config_options }))
}

#[tauri::command]
#[specta::specta]
pub async fn ai_inline_complete(
    app: AppHandle,
    payload: AiInlineCompletionRequest,
) -> Result<AiInlineCompletionResult, String> {
    let result = gateway::inline_complete(&app, payload).await?;
    Ok(AiInlineCompletionResult {
        insert_text: result.insert_text,
        range: AiInlineCompletionRangePayload {
            start_offset: result.range.start_offset,
            end_offset: result.range.end_offset,
        },
        confidence: result.confidence,
    })
}
