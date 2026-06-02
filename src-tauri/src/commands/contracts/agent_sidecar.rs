use serde::{Deserialize, Serialize};

use super::ai_chat::AiContextReferencePayload;
use super::secret::SecretString;

// ============================================================================
// Agent sidecar
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarMessagePayload {
    pub(crate) role: String,
    pub(crate) content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarModelConfigPayload {
    pub(crate) model_id: String,
    pub(crate) api_key: SecretString,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarWarmupRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
}

fn is_blank_optional_string(value: &Option<String>) -> bool {
    value
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarChatRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) mode: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) goal: Option<String>,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) goal: String,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) plan_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarExecuteRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) goal: String,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    pub(crate) plan_id: String,
    pub(crate) plan_version: u32,
    pub(crate) plan_step_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanValidateRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) goal: Option<String>,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    pub(crate) plan_id: String,
    pub(crate) plan_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanReplanRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) goal: String,
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    pub(crate) plan_id: String,
    pub(crate) plan_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanApproveRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) plan_id: String,
    pub(crate) version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanQueryRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) plan_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanRejectRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) plan_id: String,
    pub(crate) version: u32,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarPlanFinishRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) plan_id: String,
    pub(crate) version: u32,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarApprovalResolveRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) request_id: String,
    pub(crate) decision: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) goal: Option<String>,
    #[serde(default)]
    pub(crate) messages: Vec<AgentSidecarMessagePayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    #[serde(default)]
    pub(crate) context: Vec<AiContextReferencePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan_version: Option<u32>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) plan_step_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentSidecarRollbackStepPath {
    Single(String),
    Nested(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarCheckpointRestoreRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) run_id: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) step: Option<AgentSidecarRollbackStepPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarMcpHealthPayload {
    pub(crate) configured_servers: u32,
    pub(crate) server_names: Vec<String>,
    pub(crate) errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarHealthPayload {
    pub(crate) ok: bool,
    pub(crate) status: String,
    pub(crate) engine: String,
    pub(crate) version: Option<String>,
    pub(crate) protocol_version: Option<String>,
    pub(crate) implementation_version: Option<String>,
    pub(crate) mcp: AgentSidecarMcpHealthPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarWarmupPayload {
    pub(crate) ok: bool,
    pub(crate) provider_id: Option<String>,
    pub(crate) origin: Option<String>,
    pub(crate) status_code: Option<u16>,
    pub(crate) duration_ms: u64,
    pub(crate) skipped: bool,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarResponsePayload {
    pub(crate) session_id: String,
    pub(crate) events: Vec<serde_json::Value>,
    pub(crate) result: Option<String>,
}

#[cfg(test)]
mod agent_sidecar_contract_tests {
    use serde::Serialize;
    use serde_json::{Map, Value};

    use super::{
        AgentSidecarChatRequest, AgentSidecarCheckpointRestoreRequest, AgentSidecarExecuteRequest,
        AgentSidecarMessagePayload, AgentSidecarRollbackStepPath,
    };

    fn sidecar_message() -> AgentSidecarMessagePayload {
        AgentSidecarMessagePayload {
            role: "user".to_string(),
            content: "run".to_string(),
        }
    }

    fn serialize_object<T: Serialize>(value: &T) -> Map<String, Value> {
        let serialized = match serde_json::to_value(value) {
            Ok(serialized) => serialized,
            Err(error) => panic!("failed to serialize sidecar request: {error}"),
        };

        match serialized {
            Value::Object(object) => object,
            other => panic!("expected object, got {other:?}"),
        }
    }

    #[test]
    fn chat_request_omits_blank_optional_fields() {
        let request = AgentSidecarChatRequest {
            session_id: None,
            mode: Some(" ".to_string()),
            goal: Some("".to_string()),
            messages: vec![sidecar_message()],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: Some(" ".to_string()),
        };

        let object = serialize_object(&request);

        assert!(!object.contains_key("sessionId"));
        assert!(!object.contains_key("mode"));
        assert!(!object.contains_key("goal"));
        assert!(!object.contains_key("workspaceRootPath"));
        assert!(!object.contains_key("threadId"));
        assert!(object.contains_key("messages"));
        assert!(object.contains_key("context"));
    }

    #[test]
    fn chat_request_keeps_non_empty_thread_id() {
        let request = AgentSidecarChatRequest {
            session_id: Some("sidecar-chat-1".to_string()),
            mode: Some("ask".to_string()),
            goal: Some("继续".to_string()),
            messages: vec![sidecar_message()],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: Some("thread-chat-1".to_string()),
        };

        let object = serialize_object(&request);

        assert_eq!(
            object.get("threadId"),
            Some(&Value::String("thread-chat-1".to_string()))
        );
    }

    #[test]
    fn execute_request_omits_absent_optional_fields() {
        let request = AgentSidecarExecuteRequest {
            session_id: None,
            goal: "run".to_string(),
            messages: vec![sidecar_message()],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            plan_id: "plan-1".to_string(),
            plan_version: 1,
            plan_step_id: "step-1".to_string(),
        };

        let object = serialize_object(&request);

        assert!(!object.contains_key("sessionId"));
        assert!(!object.contains_key("workspaceRootPath"));
        assert_eq!(object.get("goal"), Some(&Value::String("run".to_string())));
    }

    #[test]
    fn execute_request_keeps_non_empty_optional_fields() {
        let request = AgentSidecarExecuteRequest {
            session_id: Some("agent-session-1".to_string()),
            goal: "run".to_string(),
            messages: vec![sidecar_message()],
            workspace_root_path: Some("D:/com.xiaojianc/my_desktop_app".to_string()),
            context: Vec::new(),
            model_config: None,
            plan_id: "plan-1".to_string(),
            plan_version: 1,
            plan_step_id: "step-1".to_string(),
        };

        let object = serialize_object(&request);

        assert_eq!(
            object.get("sessionId"),
            Some(&Value::String("agent-session-1".to_string()))
        );
        assert_eq!(
            object.get("workspaceRootPath"),
            Some(&Value::String(
                "D:/com.xiaojianc/my_desktop_app".to_string()
            ))
        );
    }

    #[test]
    fn restore_checkpoint_request_omits_absent_optional_fields() {
        let request = AgentSidecarCheckpointRestoreRequest {
            session_id: None,
            run_id: "run-1".to_string(),
            snapshot_id: None,
            step: None,
            model_config: None,
        };

        let object = serialize_object(&request);

        assert!(!object.contains_key("sessionId"));
        assert!(!object.contains_key("snapshotId"));
        assert!(!object.contains_key("step"));
        assert_eq!(
            object.get("runId"),
            Some(&Value::String("run-1".to_string()))
        );
    }

    #[test]
    fn restore_checkpoint_request_serializes_nested_step_path() {
        let request = AgentSidecarCheckpointRestoreRequest {
            session_id: Some("sidecar-rollback-1".to_string()),
            run_id: "run-1".to_string(),
            snapshot_id: Some("snapshot-1".to_string()),
            step: Some(AgentSidecarRollbackStepPath::Nested(vec![
                "durable-agentic-execution".to_string(),
                "durable-llm-execution".to_string(),
            ])),
            model_config: None,
        };

        let object = serialize_object(&request);

        assert_eq!(
            object.get("sessionId"),
            Some(&Value::String("sidecar-rollback-1".to_string()))
        );
        assert_eq!(
            object.get("snapshotId"),
            Some(&Value::String("snapshot-1".to_string()))
        );
        assert_eq!(
            object.get("step"),
            Some(&Value::Array(vec![
                Value::String("durable-agentic-execution".to_string()),
                Value::String("durable-llm-execution".to_string()),
            ]))
        );
    }
}
