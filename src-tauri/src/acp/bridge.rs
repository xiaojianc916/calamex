//! 宿主侧 ACP 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中按 cargo feature
//! `acp_client` 门控的新增模块，落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! `client.rs` / `host.rs` 多处注明「入参为客户端层扩展请求类型，与 contract 的
//! 转换由接线层负责」——本模块即承担该转换职责：把 `commands::contracts` 的请求
//! 投影为 `client` 的带类型 ACP 扩展请求，避免上层重复手写映射、保持单一来源。
//!
//! 目前承载一次性「工具型」模型调用（标题生成 / 行内补全 / 连接测试）的请求投影：
//! 对齐 Zed 把这类 model-backed 功能（Thread title、Inline Assistant、Edit Prediction、
//! Git commit message）与 Agent Panel 智能体回合分离为独立模型请求的做法
//! （`calamex.dev/model/chat`），而非塞进标准会话回合（`session/prompt`）的工具循环。

// 过渡期：投影函数尚未接线到宿主命令（live 调用在后续切换轮接入）。接线后移除该 allow。
#![allow(dead_code)]

use crate::commands::contracts::{
    AgentSidecarChatRequest, AgentSidecarMessagePayload, AgentSidecarModelConfigPayload,
};

use super::client::{ExtModelConfig, ModelChatExtRequest, ModelChatMessage};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
