use serde::{Deserialize, Serialize};
use specta::Type;

use super::ai_chat::AiContextReferencePayload;
use super::secret::SecretString;

// ============================================================================
// Agent sidecar
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarMessagePayload {
    pub(crate) role: String,
    pub(crate) content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarModelConfigPayload {
    pub(crate) model_id: String,
    pub(crate) api_key: SecretString,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

/// `calamex.dev/agent/ask-user/resume` 单题作答（契约层）。
/// 镜像 sidecar `askUserAnswerParamsSchema`：questionId、optionIds（缺省 []）、text（可选）。
/// optionIds 恒序列化为数组（空则 []）；text 空白修剪由接线层负责，契约层仅在 None 时省略键。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarAskUserAnswerPayload {
    pub(crate) question_id: String,
    #[serde(default)]
    pub(crate) option_ids: Vec<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) text: Option<String>,
}

/// `calamex.dev/agent/ask-user/resume` 恢复请求（契约层）。
///
/// 结构镜像 `AgentSidecarApprovalResolveRequest` 的「agentChat 基底 + requestId」，但以
/// `outcome` + 结构化 `answers` 取代 `decision`：
///   * outcome 取值（selected/cancelled）由 sidecar zod 校验，原样透传；
///   * answers 为每题作答，outcome=cancelled 时通常缺省（serde 整字段省略，对齐 zod `.optional()`）。
/// 与 approval 恢复一致地携带 plan_*（plan 续跑定位），不含 `mode`（恢复不切换模式）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarAskUserResumeRequest {
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
    pub(crate) request_id: String,
    pub(crate) outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) answers: Option<Vec<AgentSidecarAskUserAnswerPayload>>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum AgentSidecarRollbackStepPath {
    Single(String),
    Nested(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarMcpHealthPayload {
    pub(crate) configured_servers: u32,
    pub(crate) server_names: Vec<String>,
    pub(crate) errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarWarmupPayload {
    pub(crate) ok: bool,
    pub(crate) provider_id: Option<String>,
    pub(crate) origin: Option<String>,
    pub(crate) status_code: Option<u16>,
    #[specta(type = u32)]
    pub(crate) duration_ms: u64,
    pub(crate) skipped: bool,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarResponsePayload {
    pub(crate) session_id: String,
    /// 逐事件透传的任意 JSON，由前端自行 Zod 校验；
    /// 用 specta_typescript::Unknown 将导出类型映射为 TS `unknown[]`，
    /// 避开 serde_json::Number 的 i64/u64 触发 specta BigInt-forbidden；
    /// serde 运行时仍为 Vec<serde_json::Value>，行为不变。
    #[specta(type = Vec<specta_typescript::Unknown>)]
    pub(crate) events: Vec<serde_json::Value>,
    pub(crate) result: Option<String>,
}

#[cfg(test)]
mod agent_sidecar_contract_tests {
    use serde::Serialize;
    use serde_json::{Map, Value};

    use super::{
        AgentSidecarAskUserAnswerPayload, AgentSidecarAskUserResumeRequest,
        AgentSidecarChatRequest, AgentSidecarCheckpointRestoreRequest, AgentSidecarMessagePayload,
        AgentSidecarRollbackStepPath,
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

    #[test]
    fn ask_user_resume_request_omits_blank_optionals_and_serializes_answers() {
        let request = AgentSidecarAskUserResumeRequest {
            session_id: None,
            request_id: "ask-1".to_string(),
            outcome: "selected".to_string(),
            answers: Some(vec![AgentSidecarAskUserAnswerPayload {
                question_id: "q1".to_string(),
                option_ids: vec!["opt_a".to_string()],
                text: Some("自定义".to_string()),
            }]),
            goal: Some("  ".to_string()),
            messages: Vec::new(),
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: Some(" ".to_string()),
            plan_id: None,
            plan_version: None,
            plan_step_id: None,
        };

        let object = serialize_object(&request);

        assert!(!object.contains_key("sessionId"));
        assert!(!object.contains_key("goal"));
        assert!(!object.contains_key("threadId"));
        assert_eq!(
            object.get("requestId"),
            Some(&Value::String("ask-1".to_string()))
        );
        assert_eq!(
            object.get("outcome"),
            Some(&Value::String("selected".to_string()))
        );
        let answers = object
            .get("answers")
            .and_then(Value::as_array)
            .expect("answers should be an array");
        assert_eq!(answers[0]["questionId"], Value::String("q1".to_string()));
        assert_eq!(
            answers[0]["optionIds"][0],
            Value::String("opt_a".to_string())
        );
        assert_eq!(answers[0]["text"], Value::String("自定义".to_string()));
        assert!(object.contains_key("messages"));
        assert!(object.contains_key("context"));
    }

    #[test]
    fn ask_user_resume_request_omits_answers_when_cancelled() {
        let request = AgentSidecarAskUserResumeRequest {
            session_id: None,
            request_id: "ask-1".to_string(),
            outcome: "cancelled".to_string(),
            answers: None,
            goal: None,
            messages: Vec::new(),
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: None,
            plan_id: None,
            plan_version: None,
            plan_step_id: None,
        };

        let object = serialize_object(&request);

        assert_eq!(
            object.get("outcome"),
            Some(&Value::String("cancelled".to_string()))
        );
        assert!(!object.contains_key("answers"));
    }

    #[test]
    fn ask_user_answer_payload_emits_empty_option_ids_array_and_omits_blank_text() {
        let answer = AgentSidecarAskUserAnswerPayload {
            question_id: "q1".to_string(),
            option_ids: Vec::new(),
            text: Some("  ".to_string()),
        };

        let object = serialize_object(&answer);

        assert_eq!(object.get("optionIds"), Some(&Value::Array(vec![])));
        assert!(!object.contains_key("text"));
    }
}
