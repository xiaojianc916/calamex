use serde::{Deserialize, Serialize};
use specta::Type;

use super::AgentSidecarModelConfigPayload;

// ============================================================================
// Agent sidecar native orchestration (orchestration workflow)
// ============================================================================

fn is_blank_optional_string(value: &Option<String>) -> bool {
    value
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarOrchestrateRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) goal: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
    /// Per-run execution preference (`interactive` | `autonomous`), threaded
    /// through verbatim like `thread_id` and validated by the sidecar (Zod
    /// enum, defaults to `interactive`). Omitted from the body when blank so the
    /// sidecar applies its default; the Rust layer never interprets the value.
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) execution_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarOrchestrateResumeRequest {
    pub(crate) run_id: String,
    pub(crate) decision: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarOrchestratePayload {
    pub(crate) run_id: String,
    /// Final orchestration result; passed through verbatim and validated by the
    /// frontend (Zod). Mapped to TS `unknown` via specta_typescript::Unknown to
    /// avoid serde_json::Number tripping specta's BigInt-forbidden check.
    #[serde(default)]
    #[specta(type = specta_typescript::Unknown)]
    pub(crate) result: serde_json::Value,
}
