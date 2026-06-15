//! 宿主侧 ACP 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求 / prompt 内容块。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中按 cargo feature
//! `acp_client` 门控的新增模块，落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! `client.rs` / `host.rs` 多处注明「入参为客户端层扩展请求类型，与 contract 的
//! 转换由接线层负责」——本模块即承担该转换职责：把 `commands::contracts` 的请求
//! 投影为 `client` 的带类型 ACP 扩展请求 / 标准会话回合的 prompt 内容块，避免上层
//! 重复手写映射、保持单一来源。
//!
//! 目前承载几类投影：
//!   1. 一次性「工具型」模型调用（标题生成 / 行内补全 / 连接测试）的请求投影：
//!      对齐 Zed 把这类 model-backed 功能（Thread title、Inline Assistant、Edit
//!      Prediction、Git commit message）与 Agent Panel 智能体回合分离为独立模型请求的
//!      做法（`calamex.dev/model/chat`），而非塞进标准会话回合（`session/prompt`）。
//!   2. 标准会话回合的「用户输入 → ACP prompt 内容块」投影（见
//!      `user_turn_to_content_blocks`）。
//!   3. agent 模式对话回合（run-to-gate）的请求投影：`agent/chat` 与其审批恢复
//!      `agent/chat/resolve`（见 `chat_request_to_agent_chat_ext` /
//!      `approval_resolve_to_agent_chat_resolve_ext`）。与「工具型」一次性模型透传不同，
//!      agent 对话是标准回合之外的「带外」富回合能力，会话连续性由命令层经
//!      `host.ensure_session` 解析后以 session_id 传入。

// 过渡期：投影函数部分已接线到宿主命令（agent/chat 两条经命令层 live 调用）；
// 一次性 model/chat 投影仍待接线，故暂留 allow，全量切换后移除。
#![allow(dead_code)]

use agent_client_protocol::schema::{
    ContentBlock, EmbeddedResource, EmbeddedResourceResource, TextContent, TextResourceContents,
};

use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest, AgentSidecarMessagePayload,
    AgentSidecarModelConfigPayload, AiContextReferencePayload,
};

use super::client::{
    AgentChatContextRange, AgentChatContextReference, AgentChatExtRequest, AgentChatMessage,
    AgentChatResolveExtRequest, ExtModelConfig, ModelChatExtRequest, ModelChatMessage,
};

/// 上下文引用投影预算（按值镜像旧路径 `ai/gateway/mod.rs` 的同名常量；旧常量为模块
/// 私有，此处以注释标注同源，待全量切换轮统一收口，避免为跨模块可见性而引入额外耦合）。
const MAX_CONTEXT_REFERENCES: usize = 8;
const MAX_REFERENCE_PREVIEW_CHARS: usize = 4_000;
const MAX_CONTEXT_BLOCK_CHARS: usize = 12_000;

/// `redacted` 引用的占位说明：不内嵌原文，仅告知模型该引用因敏感策略被省略。
const REDACTED_REFERENCE_NOTICE: &str = "[引用内容已按敏感信息策略省略]";

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
/// 与 `user_turn_to_content_blocks`（把引用内嵌为 prompt 资源块）不同，agent 对话回合按
/// sidecar `agentChatContextReferenceSchema` 把引用作为结构化对象整体下发，由 sidecar 自行
/// 决定如何注入提示。`path` / `range` 是「可空但必填」（见 `AgentChatContextReference`
/// 文档）：`path` 空白修剪为 `None`、缺值 `range` 为 `None`，二者经 serde 序列化为显式
/// `null`（不省略键）。
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

/// 把一轮用户输入（文本 + 上下文引用）投影为 ACP 标准 prompt 的内容块序列。
///
/// 这是 #6 统一主管线的一环：主对话回合改走 ACP `session/prompt`，其入参为
/// `Vec<ContentBlock>`（多模态）。本投影对齐 Zed 的 @mention 落地
/// （`crates/acp_thread/src/mention.rs`）与官方 schema 的内容块模型，不自创协议形态：
///   * 用户文本 → 一条 `ContentBlock::Text`（置于首位，与 Zed 把用户散文与引用一并
///     组进 prompt 回合的模型一致；本期按「文本在前、引用在后」的稳定顺序投影）。
///   * 每条上下文引用 → 一条内嵌资源块 `ContentBlock::Resource`
///     （`EmbeddedResource` + `TextResourceContents`）。选用内嵌资源而非 `ResourceLink`，
///     因为：(a) 契约 `AiContextReferencePayload` 已携带 `content_preview`——内容在宿主侧
///     已就绪；(b) 官方 schema 注明内嵌资源 “Preferred for including context as it avoids
///     extra round-trips”；(c) 我们的 Mastra sidecar 为独立进程，无法按任意宿主 `file://`
///     路径回读文件，故必须把内容随 prompt 内嵌下发。
///   * 资源 `uri` 取 Zed 可观察的文件 URI 形状（`file:///...`，符号引用追加 `?symbol=`，
///     带行范围追加 `#L{start}:{end}`）；无文件路径的引用（无标题缓冲 / 诊断等）退回应用域
///     定位符 `calamex:reference/{id}`。该 uri 仅为随内嵌内容并行的定位信息（不触发回读），
///     故不强求 RFC-3986 round-trip，亦不引入 `url` crate 依赖（其非本 crate 直接依赖）。
///
/// 预算与脱敏对齐旧路径 `ai/gateway/prompt.rs::build_context_block`：引用条数上限
/// `MAX_CONTEXT_REFERENCES`、单条预览上限 `MAX_REFERENCE_PREVIEW_CHARS`、内嵌内容总量
/// 上限 `MAX_CONTEXT_BLOCK_CHARS`；`redacted` 引用不内嵌原文，仅置脱敏占位说明。
pub fn user_turn_to_content_blocks(
    text: &str,
    references: &[AiContextReferencePayload],
) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();

    // 用户散文置于首位（仅在非空白时；空白输入不产生文本块）。
    if !text.trim().is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(text.to_string())));
    }

    // 上下文引用 → 内嵌资源块，受条数 / 单条 / 总量三重预算约束（对齐旧路径）。
    let mut remaining_budget = MAX_CONTEXT_BLOCK_CHARS;
    for reference in references.iter().take(MAX_CONTEXT_REFERENCES) {
        if remaining_budget == 0 {
            break;
        }
        let body = reference_body(reference, remaining_budget);
        remaining_budget = remaining_budget.saturating_sub(body.chars().count());

        let resource = TextResourceContents::new(body, reference_uri(reference));
        blocks.push(ContentBlock::Resource(EmbeddedResource::new(
            EmbeddedResourceResource::TextResourceContents(resource),
        )));
    }

    blocks
}

/// 单条引用的内嵌正文：`redacted` 引用置脱敏占位说明（不内嵌原文）；否则按剩余总量与
/// 单条上限取较小者截断预览。
fn reference_body(reference: &AiContextReferencePayload, remaining_budget: usize) -> String {
    if reference.redacted {
        return REDACTED_REFERENCE_NOTICE.to_string();
    }
    let cap = MAX_REFERENCE_PREVIEW_CHARS.min(remaining_budget);
    truncate_chars(&reference.content_preview, cap)
}

/// 单条引用的资源定位符。
fn reference_uri(reference: &AiContextReferencePayload) -> String {
    match reference
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => {
            let mut uri = to_file_uri(path);
            // 符号引用追加 `?symbol=Name`（对齐 Zed `MentionUri::Symbol` 的 URI 形状）。
            if reference.kind == "symbol" && !reference.label.is_empty() {
                uri.push_str("?symbol=");
                uri.push_str(&reference.label);
            }
            if let Some(range) = &reference.range {
                uri.push('#');
                uri.push_str(&line_fragment(range.start_line, range.end_line));
            }
            uri
        }
        // 无文件路径的引用（无标题缓冲 / 诊断等）：退回应用域定位符。该 uri 仅作内嵌内容
        // 的并行标识（不触发回读），故用稳定唯一的引用 id 而不臆造文件系统路径。
        None => {
            let mut uri = format!("calamex:reference/{}", reference.id);
            if let Some(range) = &reference.range {
                uri.push('#');
                uri.push_str(&line_fragment(range.start_line, range.end_line));
            }
            uri
        }
    }
}

/// 把宿主文件路径投影为 Zed 可观察的 `file://` URI 形状（见 Zed
/// `crates/acp_thread/src/mention.rs` `MentionUri::to_uri`）：分隔符归一为正斜杠、三斜杠
/// 前缀；盘符路径形如 `file:///C:/...`。
///
/// 刻意不引入 `url` crate（非本 crate 直接依赖）、也不做 percent-encoding：该 uri 仅是随
/// 内嵌资源内容（`TextResourceContents`）并行下发的定位信息，永不被回读，故无需满足
/// RFC-3986 round-trip；非 ASCII 路径不编码属可接受的有意取舍。
fn to_file_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    }
}

/// 行范围片段 `L{start}:{end}`（对齐 Zed `MentionUri` 的 `#L{a}:{b}` 形状）。
/// 沿用契约 `AiContextRangePayload` 既有的行号基准，不在此重设基准。
fn line_fragment(start_line: u32, end_line: u32) -> String {
    format!("L{start_line}:{end_line}")
}

/// 按「字符」截断（避免在多字节 UTF-8 边界中间切断）。
fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        value.chars().take(max_chars).collect()
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
    fn user_turn_with_text_only_produces_single_text_block() {
        let blocks = user_turn_to_content_blocks("你好", &[]);
        assert_eq!(blocks.len(), 1);
        let value = serde_json::to_value(&blocks[0]).expect("内容块应可序列化");
        assert_eq!(value["type"], "text");
        assert_eq!(value["text"], "你好");
    }

    #[test]
    fn blank_text_is_omitted_but_references_still_projected() {
        let blocks =
            user_turn_to_content_blocks("   ", &[reference("file", Some("/a/b.rs"), "snippet")]);
        assert_eq!(blocks.len(), 1);
        let value = serde_json::to_value(&blocks[0]).expect("内容块应可序列化");
        assert_eq!(value["type"], "resource");
        assert_eq!(value["resource"]["uri"], "file:///a/b.rs");
        assert_eq!(value["resource"]["text"], "snippet");
    }

    #[test]
    fn windows_path_reference_uses_forward_slash_file_uri() {
        let blocks =
            user_turn_to_content_blocks("", &[reference("file", Some(r"C:\code\main.rs"), "x")]);
        let value = serde_json::to_value(&blocks[0]).expect("内容块应可序列化");
        assert_eq!(value["resource"]["uri"], "file:///C:/code/main.rs");
    }

    #[test]
    fn symbol_reference_appends_symbol_query_and_line_fragment() {
        let mut r = reference("symbol", Some("/src/lib.rs"), "fn foo");
        r.label = "foo".to_string();
        r.range = Some(AiContextRangePayload {
            start_line: 10,
            end_line: 20,
        });
        let blocks = user_turn_to_content_blocks("", &[r]);
        let value = serde_json::to_value(&blocks[0]).expect("内容块应可序列化");
        assert_eq!(
            value["resource"]["uri"],
            "file:///src/lib.rs?symbol=foo#L10:20"
        );
    }

    #[test]
    fn pathless_reference_falls_back_to_app_scoped_locator() {
        let mut r = reference("selection", None, "buf");
        r.id = "ctx-42".to_string();
        r.range = Some(AiContextRangePayload {
            start_line: 1,
            end_line: 3,
        });
        let blocks = user_turn_to_content_blocks("", &[r]);
        let value = serde_json::to_value(&blocks[0]).expect("内容块应可序列化");
        assert_eq!(value["resource"]["uri"], "calamex:reference/ctx-42#L1:3");
    }

    #[test]
    fn redacted_reference_omits_preview_content() {
        let mut r = reference("file", Some("/secret.rs"), "API_KEY=xyz");
        r.redacted = true;
        let blocks = user_turn_to_content_blocks("", &[r]);
        let value = serde_json::to_value(&blocks[0]).expect("内容块应可序列化");
        assert_eq!(value["resource"]["text"], "[引用内容已按敏感信息策略省略]");
        assert_ne!(value["resource"]["text"], "API_KEY=xyz");
    }

    #[test]
    fn respects_reference_count_cap() {
        let refs: Vec<_> = (0..12)
            .map(|i| reference("file", Some(&format!("/f{i}.rs")), "x"))
            .collect();
        let blocks = user_turn_to_content_blocks("hi", &refs);
        // 1 个文本块 + 8 个资源块（上限 MAX_CONTEXT_REFERENCES）。
        assert_eq!(blocks.len(), 1 + 8);
    }

    #[test]
    fn truncates_long_preview_to_char_budget() {
        let long = "测".repeat(5_000);
        let blocks = user_turn_to_content_blocks("", &[reference("file", Some("/big.rs"), &long)]);
        let value = serde_json::to_value(&blocks[0]).expect("内容块应可序列化");
        let text = value["resource"]["text"].as_str().expect("资源应为文本");
        // 单条预览上限 MAX_REFERENCE_PREVIEW_CHARS = 4000 字符。
        assert_eq!(text.chars().count(), 4_000);
    }
}
