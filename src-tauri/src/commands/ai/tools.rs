use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::security::network_permission::{self, validate_public_http_url};
use crate::ai::security::redaction::redact_text;
use crate::commands::contracts::{
    AiWebFetchInput, AiWebFetchPayload, AiWebSearchInput, AiWebSearchPayload,
};
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn ai_web_search(
    app: AppHandle,
    payload: AiWebSearchInput,
) -> Result<AiWebSearchPayload, String> {
    audit::emit(AiAuditEventKind::AgentWebSearchRequested);
    if redact_text(payload.query.trim()).blocked {
        audit::emit(AiAuditEventKind::AgentWebSearchDenied);
        return Err(crate::ai::errors::error(
            "AI_AGENT_WEB_SOURCE_BLOCKED",
            "搜索 query 命中敏感信息规则，已阻止联网。",
        ));
    }

    if let Err(error) = network_permission::ensure_network_allowed() {
        audit::emit(AiAuditEventKind::AgentWebSearchDenied);
        return Err(error);
    }

    // 经宿主侧 ACP stdio 扩展方法（`calamex.dev/web/search`）下发，取代旧 HTTP/NDJSON 路径；
    // sidecar 回传同一 `AiWebSearchPayload` 形状，前端无感知。
    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn(&app)
        .map_err(|error| error.to_string())?;
    let result = host
        .web_search(crate::acp::WebSearchExtRequest {
            query: payload.query,
            intent: payload.intent,
            max_results: payload.max_results as u32,
            recency: payload.recency,
        })
        .await
        .map_err(|error| error.to_string());
    if result.is_ok() {
        audit::emit(AiAuditEventKind::AgentWebSearchApproved);
    } else {
        audit::emit(AiAuditEventKind::AgentWebSearchDenied);
    }

    result
}

#[tauri::command]
#[specta::specta]
pub async fn ai_web_fetch(
    app: AppHandle,
    payload: AiWebFetchInput,
) -> Result<AiWebFetchPayload, String> {
    audit::emit(AiAuditEventKind::AgentWebFetchRequested);
    if let Err(error) = validate_public_http_url(&payload.url) {
        audit::emit(AiAuditEventKind::AgentWebFetchFailed);
        return Err(error);
    }

    if let Err(error) = network_permission::ensure_network_allowed() {
        audit::emit(AiAuditEventKind::AgentWebFetchFailed);
        return Err(error);
    }

    // 经宿主侧 ACP stdio 扩展方法（`calamex.dev/web/fetch`）下发，取代旧 HTTP/NDJSON 路径。
    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn(&app)
        .map_err(|error| error.to_string())?;
    let result = host
        .web_fetch(crate::acp::WebFetchExtRequest {
            url: payload.url,
            reason: payload.reason,
            max_bytes: payload.max_bytes as u64,
        })
        .await
        .map_err(|error| error.to_string());
    if result.is_ok() {
        audit::emit(AiAuditEventKind::AgentWebFetchCompleted);
    } else {
        audit::emit(AiAuditEventKind::AgentWebFetchFailed);
    }

    result
}
