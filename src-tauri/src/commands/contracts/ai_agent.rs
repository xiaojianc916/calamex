use serde::{Deserialize, Serialize};

use super::ai_chat::AiContextReferencePayload;

// ============================================================================
// AI – agent plan / index
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentClassifyTaskRequest {
    pub(crate) goal: String,
    pub(crate) context: Vec<AiContextReferencePayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentClassifyTaskPayload {
    pub(crate) classification: String,
    pub(crate) should_enter_plan_mode: bool,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentSetNetworkPermissionRequest {
    pub(crate) permission: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentNetworkPermissionPayload {
    pub(crate) permission: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebSearchInput {
    pub(crate) query: String,
    pub(crate) intent: String,
    pub(crate) max_results: usize,
    pub(crate) recency: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebSearchResultPayload {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) snippet: String,
    pub(crate) source_type: String,
    pub(crate) fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebSearchPayload {
    pub(crate) results: Vec<AiWebSearchResultPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebFetchInput {
    pub(crate) url: String,
    pub(crate) reason: String,
    pub(crate) max_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebFetchResultPayload {
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) text_ref: String,
    pub(crate) excerpt: String,
    pub(crate) bytes: usize,
    pub(crate) fetched_at: String,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWebFetchPayload {
    pub(crate) source: AiWebFetchResultPayload,
}
