use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiAuditEventKind {
    ChatStarted,
    ChatCompleted,
    ChatFailed,
    ConfigUpdated,
    CredentialCleared,
    PatchProposed,
    PatchApplied,
    PatchFailed,
    SecretDetected,
}

pub fn emit(event: AiAuditEventKind) {
    tracing::info!(target: "ai.audit", event = ?event, "AI audit event");
}
