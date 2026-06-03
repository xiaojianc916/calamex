use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::security::network_permission::{self, validate_public_http_url};
use crate::ai::security::redaction::redact_text;
use crate::commands::contracts::{
    AiWebFetchInput, AiWebFetchPayload, AiWebSearchInput, AiWebSearchPayload,
};

#[tauri::command]
#[specta::specta]
pub async fn ai_web_search(payload: AiWebSearchInput) -> Result<AiWebSearchPayload, String> {
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

    let result = crate::agent_sidecar::web_search(payload).await;
    if result.is_ok() {
        audit::emit(AiAuditEventKind::AgentWebSearchApproved);
    } else {
        audit::emit(AiAuditEventKind::AgentWebSearchDenied);
    }

    result
}

#[tauri::command]
#[specta::specta]
pub async fn ai_web_fetch(payload: AiWebFetchInput) -> Result<AiWebFetchPayload, String> {
    audit::emit(AiAuditEventKind::AgentWebFetchRequested);
    if let Err(error) = validate_public_http_url(&payload.url) {
        audit::emit(AiAuditEventKind::AgentWebFetchFailed);
        return Err(error);
    }

    if let Err(error) = network_permission::ensure_network_allowed() {
        audit::emit(AiAuditEventKind::AgentWebFetchFailed);
        return Err(error);
    }

    let result = crate::agent_sidecar::web_fetch(payload).await;
    if result.is_ok() {
        audit::emit(AiAuditEventKind::AgentWebFetchCompleted);
    } else {
        audit::emit(AiAuditEventKind::AgentWebFetchFailed);
    }

    result
}
