//! 宿主侧 ACP 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中按 cargo feature
//! `acp_client` 门控的新增模块，落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! `client.rs` / `host.rs` 多处注明「入参为客户端层扩展请求类型，与 contract 的
//! 转换由接线层负责」——本模块即承担该转换职责：把 `commands::contracts` 的请求
//! 投影为 `client` 的带类型 ACP 扩展请求，避免上层重复手写映射、保持单一来源。
//!
//! 目前承载几类投影：
//!   1. 一次性「工具型」模型调用（标题生成 / 行内补全 / 连接测试）的请求投影：
//!      对齐 Zed 把这类 model-backed 功能（Thread title、Inline Assistant、Edit
//!      Prediction、Git commit message）与 Agent Panel 智能体回合分离为独立模型请求的
//!      做法（`calamex.dev/model/chat`），而非塞进标准会话回合（`session/prompt`）。
//!   2. agent 模式对话回合（run-to-gate）的请求投影：`agent/chat` 与其审批恢复
//!      `agent/chat/resolve`、反向提问恢复 `agent/ask-user/resume`（见
//!      `chat_request_to_agent_chat_ext` / `approval_resolve_to_agent_chat_resolve_ext` /
//!      `ask_user_resume_to_agent_ask_user_resume_ext`）。与「工具型」一次性模型透传不同，
//!      agent 对话是标准回合之外的「带外」富回合能力，会话连续性由命令层经
//!      `host.ensure_session` 解析后以 session_id 传入。
//!
//! 上述投影（model/chat、agent/chat、agent/chat/resolve、agent/ask-user/resume）均已由网关 /
//! 命令层 live 调用（见 `ai::gateway::conversation` 与 `commands::agent_sidecar`）。

use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarAskUserAnswerPayload,
    AgentSidecarAskUserResumeRequest, AgentSidecarChatRequest, AgentSidecarMessagePayload,
    AgentSidecarModelConfigPayload, AiContextReferencePayload,
};

use super::client::{
    AgentAskUserResumeExtRequest, AgentChatContextRange, AgentChatContextReference,
    AgentChatExtRequest, AgentChatMessage, AgentChatResolveExtRequest, AskUserAnswer,
    ExtModelConfig, ModelChatExtRequest, ModelChatMessage,
};

/// 修剪并过滤空白可选字符串：`None` / 空 / 全空白 → `None`，否则返回修剪后的 owned 串。
/// 与契约自身 `is_blank_optional_string` 的跳过语义一致，保证 ACP 路径与旧 HTTP 路径
/// 在「空白可选字段不上线」这一点上表现相同。
fn trimmed_non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

/// 把契约模型配置投影为客户端层 `ExtModelConfig`（逐请求模型配置）。
///
/// 一次性「工具型」调用按用途选用不同模型（如标题走 narrator、补全走主模型），故必须
/// 逐请求携带模型配置，而非依赖 sidecar 启动期默认。`api_key` 经 `into_inner` 取出明文
/// （`SecretString` 随后清零残留），仅在投影出的请求中短暂持有。
fn model_config_to_ext(config: AgentSidecarModelConfigPayload) -> ExtModelConfig {
    ExtModelConfig {
        model_id: config.model_id,
        api_key: config.api_key.into_inner(),
        base_url: trimmed_non_empty(config.base_url),
    }
}

/// 单条消息投影：`role` / `content` 原样透传（含 system 消息，由调用方按需前置）。
/// 工具回放字段（`toolCallId` / `name`）属于工具消息回放，一次性模型透传不涉及，置 `None`。
fn message_to_ext(message: AgentSidecarMessagePayload) -> ModelChatMessage {
    ModelChatMessage {
        role: message.role,
        content: message.content,
        tool_call_id: None,
        name: None,
    }
}

/// 把一次性 chat 请求投影为 `calamex.dev/model/chat` 扩展请求。
///
/// 仅投影「带外」一次性模型透传涉及的字段：`messages`（含 system）、`goal`、`session_id`、
/// `workspace_root_path`、`model_config`。`mode` / `context` / `thread_id` 是 ACP 标准
/// 会话回合（`session/prompt`）的概念，不属于一次性模型透传，故不投影——与 sidecar
/// `modelChatParamsSchema` 的字段集一致，不擅自扩展。
pub fn chat_request_to_model_chat_ext(request: AgentSidecarChatRequest) -> ModelChatExtRequest {
    ModelChatExtRequest {
        messages: request.messages.into_iter().map(message_to_ext).collect(),
        goal: trimmed_non_empty(request.goal),
        session_id: trimmed_non_empty(request.session_id),
        workspace_root_path: trimmed_non_empty(request.workspace_root_path),
        model_config: request.model_config.map(model_config_to_ext),
    }
}

/// 单条消息 → `AgentChatMessage`（agent 对话回合）：`role` / `content` 原样透传。
///
/// 与 `message_to_ext`（一次性 model/chat）的区别：agent 对话消息无工具回放字段
/// （`toolCallId` / `name`），故只映射 role/content，对齐 sidecar `agentChatMessageSchema`。
fn message_to_agent_chat(message: AgentSidecarMessagePayload) -> AgentChatMessage {
    AgentChatMessage {
        role: message.role,
        content: message.content,
    }
}

/// 单条上下文引用 → `AgentChatContextReference`：字段逐一映射。
///
/// agent 对话回合按 sidecar `agentChatContextReferenceSchema` 把引用作为结构化对象整体
/// 下发，由 sidecar 自行决定如何注入提示。`path` / `range` 是「可空但必填」（见
/// `AgentChatContextReference` 文档）：`path` 空白修剪为 `None`、缺值 `range` 为 `None`，
/// 二者经 serde 序列化为显式 `null`（不省略键）。
fn context_reference_to_agent_chat(
    reference: AiContextReferencePayload,
) -> AgentChatContextReference {
    AgentChatContextReference {
        id: reference.id,
        kind: reference.kind,
        label: reference.label,
        path: trimmed_non_empty(reference.path),
        range: reference.range.map(|range| AgentChatContextRange {
            start_line: range.start_line,
            end_line: range.end_line,
        }),
        content_preview: reference.content_preview,
        redacted: reference.redacted,
    }
}

/// 把一轮 agent 模式对话请求 + 已解析的稳定会话 → `calamex.dev/agent/chat` 扩展请求。
///
/// `session_id` 由命令层先经 `host.ensure_session(thread_id, workspace_root_path)` 解析后
/// 传入（会话连续性对齐 Zed `session_id = thread.id()`，由接线层负责，见 `host::agent_chat`
/// 文档）。`messages` / `context` 恒为数组；其余空白可选字段修剪为 `None`（serde 整字段
/// 省略，交由 sidecar 套用回退语义）。`AgentSidecarChatRequest` 无 plan 字段，故 plan_* 置
/// `None`（plan 续跑由 resolve 路径携带）。
pub fn chat_request_to_agent_chat_ext(
    request: AgentSidecarChatRequest,
    session_id: String,
) -> AgentChatExtRequest {
    AgentChatExtRequest {
        session_id: Some(session_id),
        mode: trimmed_non_empty(request.mode),
        goal: trimmed_non_empty(request.goal),
        messages: request
            .messages
            .into_iter()
            .map(message_to_agent_chat)
            .collect(),
        workspace_root_path: trimmed_non_empty(request.workspace_root_path),
        context: request
            .context
            .into_iter()
            .map(context_reference_to_agent_chat)
            .collect(),
        model_config: request.model_config.map(model_config_to_ext),
        thread_id: trimmed_non_empty(request.thread_id),
        plan_id: None,
        plan_version: None,
        plan_step_id: None,
    }
}

/// 把一轮 agent 对话审批恢复请求 + 已解析的稳定会话 → `calamex.dev/agent/chat/resolve`
/// 扩展请求。
///
/// `request_id` / `decision` 为恢复必填（裁决哪个挂起审批、如何裁决），原样透传，取值由
/// sidecar zod 校验。`session_id` 同 `chat_request_to_agent_chat_ext` 由命令层解析后传入。
/// `AgentSidecarApprovalResolveRequest` 无 `mode` 字段（恢复不切换模式），故 `mode` 置
/// `None`；其余字段与 chat 投影同构，并携带 plan_*（plan 续跑定位）。
pub fn approval_resolve_to_agent_chat_resolve_ext(
    request: AgentSidecarApprovalResolveRequest,
    session_id: String,
) -> AgentChatResolveExtRequest {
    AgentChatResolveExtRequest {
        request_id: request.request_id,
        decision: request.decision,
        session_id: Some(session_id),
        mode: None,
        goal: trimmed_non_empty(request.goal),
        messages: request
            .messages
            .into_iter()
            .map(message_to_agent_chat)
            .collect(),
        workspace_root_path: trimmed_non_empty(request.workspace_root_path),
        context: request
            .context
            .into_iter()
            .map(context_reference_to_agent_chat)
            .collect(),
        model_config: request.model_config.map(model_config_to_ext),
        thread_id: trimmed_non_empty(request.thread_id),
        plan_id: trimmed_non_empty(request.plan_id),
        plan_version: request.plan_version,
        plan_step_id: trimmed_non_empty(request.plan_step_id),
    }
}

/// 单题作答投影：`question_id` / `option_ids` 原样透传（option_ids 恒为数组，空则 []），
/// `text` 空白修剪为 `None`（serde 整字段省略，对齐 sidecar `askUserAnswerParamsSchema.text`
/// 的 `.optional()`）。
fn answer_to_ext(answer: AgentSidecarAskUserAnswerPayload) -> AskUserAnswer {
    AskUserAnswer {
        question_id: answer.question_id,
        option_ids: answer.option_ids,
        text: trimmed_non_empty(answer.text),
    }
}

/// 把一轮 ask_user 反向提问恢复请求 + 已解析的稳定会话 → `calamex.dev/agent/ask-user/resume`
/// 扩展请求。
///
/// `request_id` / `outcome` 为恢复必填（裁决哪个挂起提问、整体结果 selected/cancelled），
/// 原样透传，取值由 sidecar zod 校验。`answers` 仅在 outcome=selected 时携带每题作答；
/// outcome=cancelled 时通常为 `None`（serde 整字段省略，对齐 zod `.optional()`）。
/// `session_id` 同 `approval_resolve_to_agent_chat_resolve_ext` 由命令层解析后传入。结构与
/// approval 恢复同构（messages/context 恒为数组、空白可选字段修剪为 `None`、携带 plan_*、
/// 不切换 `mode`），仅以 outcome + 结构化 answers 取代 decision。
pub fn ask_user_resume_to_agent_ask_user_resume_ext(
    request: AgentSidecarAskUserResumeRequest,
    session_id: String,
) -> AgentAskUserResumeExtRequest {
    AgentAskUserResumeExtRequest {
        request_id: request.request_id,
        outcome: request.outcome,
        answers: request
            .answers
            .map(|answers| answers.into_iter().map(answer_to_ext).collect()),
        session_id: Some(session_id),
        mode: None,
        goal: trimmed_non_empty(request.goal),
        messages: request
            .messages
            .into_iter()
            .map(message_to_agent_chat)
            .collect(),
        workspace_root_path: trimmed_non_empty(request.workspace_root_path),
        context: request
            .context
            .into_iter()
            .map(context_reference_to_agent_chat)
            .collect(),
        model_config: request.model_config.map(model_config_to_ext),
        thread_id: trimmed_non_empty(request.thread_id),
        plan_id: trimmed_non_empty(request.plan_id),
        plan_version: request.plan_version,
        plan_step_id: trimmed_non_empty(request.plan_step_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::contracts::AiContextRangePayload;

    fn message(role: &str, content: &str) -> AgentSidecarMessagePayload {
        AgentSidecarMessagePayload {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    fn base_request() -> AgentSidecarChatRequest {
        AgentSidecarChatRequest {
            session_id: None,
            mode: Some("ask".to_string()),
            goal: Some("生成会话标题".to_string()),
            messages: vec![
                message("system", "你是会话标题生成器。"),
                message("user", "请为这段对话生成标题"),
            ],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: Some(AgentSidecarModelConfigPayload {
                model_id: "zhipuai/glm-4.7-flash".to_string(),
                api_key: "secret-key".into(),
                base_url: None,
            }),
            thread_id: None,
        }
    }

    fn reference(kind: &str, path: Option<&str>, preview: &str) -> AiContextReferencePayload {
        AiContextReferencePayload {
            id: "ref-1".to_string(),
            kind: kind.to_string(),
            label: "label".to_string(),
            path: path.map(str::to_string),
            range: None,
            content_preview: preview.to_string(),
            redacted: false,
        }
    }

    fn approval_resolve_request() -> AgentSidecarApprovalResolveRequest {
        AgentSidecarApprovalResolveRequest {
            session_id: None,
            request_id: "appr-1".to_string(),
            decision: "approve".to_string(),
            goal: Some("继续".to_string()),
            messages: vec![message("user", "ok")],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: Some("thread-1".to_string()),
            plan_id: Some("plan-1".to_string()),
            plan_version: Some(2),
            plan_step_id: Some("step-1".to_string()),
        }
    }

    fn ask_user_answer(
        question_id: &str,
        option_ids: &[&str],
        text: Option<&str>,
    ) -> AgentSidecarAskUserAnswerPayload {
        AgentSidecarAskUserAnswerPayload {
            question_id: question_id.to_string(),
            option_ids: option_ids.iter().map(|item| item.to_string()).collect(),
            text: text.map(str::to_string),
        }
    }

    fn ask_user_resume_request() -> AgentSidecarAskUserResumeRequest {
        AgentSidecarAskUserResumeRequest {
            session_id: None,
            request_id: "ask-1".to_string(),
            outcome: "selected".to_string(),
            answers: Some(vec![ask_user_answer("q1", &["opt_a"], Some("自定义"))]),
            goal: Some("继续".to_string()),
            messages: vec![message("user", "ok")],
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: Some("thread-1".to_string()),
            plan_id: Some("plan-1".to_string()),
            plan_version: Some(2),
            plan_step_id: Some("step-1".to_string()),
        }
    }

    #[test]
    fn projects_messages_preserving_role_and_content_with_tool_fields_none() {
        let ext = chat_request_to_model_chat_ext(base_request());
        assert_eq!(ext.messages.len(), 2);
        assert_eq!(ext.messages[0].role, "system");
        assert_eq!(ext.messages[0].content, "你是会话标题生成器。");
        assert!(ext.messages[0].tool_call_id.is_none());
        assert!(ext.messages[0].name.is_none());
        assert_eq!(ext.messages[1].role, "user");
        assert_eq!(ext.messages[1].content, "请为这段对话生成标题");
    }

    #[test]
    fn projects_only_out_of_band_fields_and_maps_model_config() {
        let ext = chat_request_to_model_chat_ext(base_request());
        assert_eq!(ext.goal.as_deref(), Some("生成会话标题"));
        assert_eq!(ext.session_id, None);
        assert_eq!(ext.workspace_root_path, None);

        let model_config = ext.model_config.expect("应投影出逐请求模型配置");
        assert_eq!(model_config.model_id, "zhipuai/glm-4.7-flash");
        assert_eq!(model_config.api_key, "secret-key");
        assert_eq!(model_config.base_url, None);
    }

    #[test]
    fn trims_blank_optional_fields_to_none() {
        let mut request = base_request();
        request.goal = Some("   ".to_string());
        request.session_id = Some(String::new());
        request.workspace_root_path = Some("  ".to_string());

        let ext = chat_request_to_model_chat_ext(request);
        assert_eq!(ext.goal, None);
        assert_eq!(ext.session_id, None);
        assert_eq!(ext.workspace_root_path, None);
    }

    #[test]
    fn trims_model_config_base_url_and_keeps_non_empty() {
        let mut request = base_request();
        request.model_config = Some(AgentSidecarModelConfigPayload {
            model_id: "deepseek/deepseek-v4-pro".to_string(),
            api_key: "k".into(),
            base_url: Some("  https://api.example.com  ".to_string()),
        });

        let ext = chat_request_to_model_chat_ext(request);
        let model_config = ext.model_config.expect("应投影出模型配置");
        assert_eq!(
            model_config.base_url.as_deref(),
            Some("https://api.example.com")
        );
    }

    #[test]
    fn projected_request_serializes_to_camel_case_wire_shape() {
        let ext = chat_request_to_model_chat_ext(base_request());
        let value = serde_json::to_value(&ext).expect("投影请求应可序列化");

        assert_eq!(value["messages"][0]["role"], "system");
        assert!(value["messages"][0].get("toolCallId").is_none());
        assert!(value["messages"][0].get("name").is_none());
        assert_eq!(value["goal"], "生成会话标题");
        assert!(value.get("sessionId").is_none());
        assert!(value.get("workspaceRootPath").is_none());
        assert_eq!(value["modelConfig"]["modelId"], "zhipuai/glm-4.7-flash");
        assert_eq!(value["modelConfig"]["apiKey"], "secret-key");
        assert!(value["modelConfig"].get("baseUrl").is_none());
    }

    #[test]
    fn chat_request_projects_to_agent_chat_with_resolved_session() {
        let ext = chat_request_to_agent_chat_ext(base_request(), "sess-1".to_string());
        assert_eq!(ext.session_id.as_deref(), Some("sess-1"));
        assert_eq!(ext.mode.as_deref(), Some("ask"));
        assert_eq!(ext.goal.as_deref(), Some("生成会话标题"));
        assert_eq!(ext.messages.len(), 2);
        assert_eq!(ext.messages[0].role, "system");
        assert_eq!(ext.messages[0].content, "你是会话标题生成器。");
        // chat 无 plan 字段
        assert_eq!(ext.plan_id, None);
        assert_eq!(ext.plan_version, None);
        assert_eq!(ext.plan_step_id, None);
    }

    #[test]
    fn chat_request_to_agent_chat_trims_blank_optionals() {
        let mut request = base_request();
        request.mode = Some("  ".to_string());
        request.goal = Some(String::new());
        request.workspace_root_path = Some("   ".to_string());
        request.thread_id = Some(" ".to_string());

        let ext = chat_request_to_agent_chat_ext(request, "s".to_string());
        assert_eq!(ext.mode, None);
        assert_eq!(ext.goal, None);
        assert_eq!(ext.workspace_root_path, None);
        assert_eq!(ext.thread_id, None);
    }

    #[test]
    fn chat_request_context_maps_range_and_blank_path_to_none() {
        let mut request = base_request();
        let mut r = reference("symbol", Some("  "), "preview");
        r.range = Some(AiContextRangePayload {
            start_line: 5,
            end_line: 9,
        });
        request.context = vec![r];

        let ext = chat_request_to_agent_chat_ext(request, "s".to_string());
        assert_eq!(ext.context.len(), 1);
        // 空白 path → None（序列化为 null）
        assert_eq!(ext.context[0].path, None);
        let range = ext.context[0].range.as_ref().expect("range 应保留");
        assert_eq!(range.start_line, 5);
        assert_eq!(range.end_line, 9);
    }

    #[test]
    fn agent_chat_context_nullable_fields_serialize_to_null() {
        let mut request = base_request();
        request.context = vec![reference("selection", None, "buf")];
        let ext = chat_request_to_agent_chat_ext(request, "s".to_string());
        let value = serde_json::to_value(&ext).expect("应可序列化");
        // path/range 「可空但必填」——键必须存在且为 null
        assert!(value["context"][0]["path"].is_null());
        assert!(value["context"][0]["range"].is_null());
        // messages/context 恒为数组
        assert!(value["messages"].is_array());
        assert!(value["context"].is_array());
    }

    #[test]
    fn approval_resolve_projects_request_id_decision_and_omits_mode() {
        let ext = approval_resolve_to_agent_chat_resolve_ext(
            approval_resolve_request(),
            "sess-1".to_string(),
        );
        assert_eq!(ext.request_id, "appr-1");
        assert_eq!(ext.decision, "approve");
        assert_eq!(ext.session_id.as_deref(), Some("sess-1"));
        // resolve 不切换模式
        assert_eq!(ext.mode, None);
        assert_eq!(ext.goal.as_deref(), Some("继续"));
        assert_eq!(ext.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(ext.plan_id.as_deref(), Some("plan-1"));
        assert_eq!(ext.plan_version, Some(2));
        assert_eq!(ext.plan_step_id.as_deref(), Some("step-1"));
    }

    #[test]
    fn approval_resolve_serializes_request_id_and_omits_mode_key() {
        let mut req = approval_resolve_request();
        req.context = vec![reference("selection", None, "buf")];
        let ext = approval_resolve_to_agent_chat_resolve_ext(req, "s".to_string());
        let value = serde_json::to_value(&ext).expect("应可序列化");
        assert_eq!(value["requestId"], "appr-1");
        assert_eq!(value["decision"], "approve");
        assert!(value["context"][0]["path"].is_null());
        assert!(value["context"][0]["range"].is_null());
        // 无 mode 字段
        assert!(value.get("mode").is_none());
    }

    #[test]
    fn ask_user_resume_projects_request_id_outcome_answers_and_omits_mode() {
        let ext = ask_user_resume_to_agent_ask_user_resume_ext(
            ask_user_resume_request(),
            "sess-1".to_string(),
        );
        assert_eq!(ext.request_id, "ask-1");
        assert_eq!(ext.outcome, "selected");
        assert_eq!(ext.session_id.as_deref(), Some("sess-1"));
        // resume 不切换模式
        assert_eq!(ext.mode, None);
        assert_eq!(ext.goal.as_deref(), Some("继续"));
        let answers = ext.answers.as_ref().expect("answers 应保留");
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].question_id, "q1");
        assert_eq!(answers[0].option_ids, vec!["opt_a".to_string()]);
        assert_eq!(answers[0].text.as_deref(), Some("自定义"));
        assert_eq!(ext.plan_id.as_deref(), Some("plan-1"));
        assert_eq!(ext.plan_version, Some(2));
        assert_eq!(ext.plan_step_id.as_deref(), Some("step-1"));
    }

    #[test]
    fn ask_user_resume_cancelled_keeps_answers_none_and_serializes_without_mode() {
        let mut req = ask_user_resume_request();
        req.outcome = "cancelled".to_string();
        req.answers = None;
        let ext = ask_user_resume_to_agent_ask_user_resume_ext(req, "s".to_string());
        assert_eq!(ext.outcome, "cancelled");
        assert!(ext.answers.is_none());
        let value = serde_json::to_value(&ext).expect("应可序列化");
        assert!(value.get("answers").is_none());
        assert!(value.get("mode").is_none());
        assert_eq!(value["requestId"], "ask-1");
        assert_eq!(value["outcome"], "cancelled");
    }

    #[test]
    fn ask_user_resume_trims_blank_text_to_none_and_keeps_empty_option_ids_array() {
        let mut req = ask_user_resume_request();
        req.answers = Some(vec![ask_user_answer("q1", &[], Some("  "))]);
        let ext = ask_user_resume_to_agent_ask_user_resume_ext(req, "s".to_string());
        let answers = ext.answers.as_ref().expect("answers 应保留");
        assert!(answers[0].text.is_none());
        assert!(answers[0].option_ids.is_empty());
        let value = serde_json::to_value(&ext).expect("应可序列化");
        assert_eq!(value["answers"][0]["optionIds"], serde_json::json!([]));
        assert!(value["answers"][0].get("text").is_none());
    }
}
