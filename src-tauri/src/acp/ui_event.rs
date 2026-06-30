//! ACP `session/update` 通知 → 前端 `TAgentUiEvent` 的纯映射适配层。
//!
//! 背景：前端原生消费端（`onSidecarStream` → `IAgentSidecarStreamEventPayload.event`）
//! 吃的是 Mastra 域的 `TAgentUiEvent`（`message_delta` / `done` / `error` / ...，以
//! `type` 为判别式），而 ACP 线上协议下发的是官方 `SessionNotification`
//! （`update.sessionUpdate` 为判别式：`agent_message_chunk` / `agent_thought_chunk` /
//! `tool_call(_update)` / `plan` / `usage_update` ...）。两套词表不同，本模块在
//! 宿主侧把后者投影为前者，使 ACP 主聊天流可直接复用既有前端消费端
//! （见 src/composables/ai/sidecar-events.ts）。
//!
//! 设计对齐 sidecar 出站投影 `from-runtime-event.ts` 的对偶：
//! - `agent_message_chunk`（模型文本增量）→ message_delta{phase:"final"}
//! - `agent_thought_chunk`（推理增量）   → message_delta{phase:"stage"}
//!
//! 工具调用（ADR-20260617 · D1/D2）：ACP `tool_call` / `tool_call_update` 经**最小透传**
//! 投影为同名 `TAgentUiEvent`，整个 ACP `update` 对象（toolCallId/title/kind/status/
//! content[]/locations/rawInput/rawOutput 等）原样挂在 `acpUpdate` 下——宿主侧不解读
//! 其结构、不压平为文本、不伪造 Mastra 遥测 base 字段（runId/agentId/timestamp/seq…），
//! 交前端 ACL 按 `toolCallId` 归一到 thread 协议 VM（见 src/types/ai/sidecar.ts 的
//! tool_call(_update) 变体与 acp-tool-call.ts 的 SDK 类型）。
//!
//! 计划快照（`plan`）经最小透传投影为 `TAgentUiEvent{type:'plan'}`（acpUpdate 原样
//! 挂载，含 entries 的 content/priority/status 与可选 _meta 富载荷），交前端 ACL 归一到
//! 计划 VM。其余未列出的 session/update 变体仍显式返回 None，作为可扩展接入点。

// 过渡期：终态合成 helper（build_done_ui_event / build_error_ui_event）尚未接线到宿主
// chat_stream 补发点（接线在后续 slice）。接线后移除该 allow。
#![allow(dead_code)]

use serde_json::{Value, json};

/// message_delta 的 phase。final = 模型可见答案；stage = 推理/中间态。
/// 与前端 `TAgentUiEvent` 的 `phase?: 'stage' | 'final'` 及 buffer 的
/// `SIDECAR_MESSAGE_DELTA_PHASE_FALLBACK = 'stage'`（useAiAssistant.stream.ts）对齐。
const PHASE_FINAL: &str = "final";
const PHASE_STAGE: &str = "stage";

/// 从 ACP `ContentBlock` JSON 取纯文本：仅当 `type == "text"` 时返回其 `text`。
/// 其余内容块（image/audio/resource 等）在文本聊天流中无对应 UI 形态，返回 None。
fn text_from_content_block(content: &Value) -> Option<String> {
    if content.get("type").and_then(Value::as_str) == Some("text") {
        content
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
    } else {
        None
    }
}

/// 构造一条 message_delta `TAgentUiEvent`（以 `type` 为判别式，camelCase 线格式）。
fn message_delta(text: String, phase: &str) -> Value {
    json!({ "type": "message_delta", "text": text, "phase": phase })
}

/// 构造 ACP 工具调用 `TAgentUiEvent`（`type` 为 `tool_call` / `tool_call_update`）。
///
/// 最小透传（ADR-20260617 · D1/D2）：整个 ACP `update` 对象原样作为 `acpUpdate`，宿主侧
/// 不解读其结构、不压平为文本、不伪造 Mastra 遥测 base 字段（runId/agentId/timestamp/seq…）。
/// `update` 自带 `sessionUpdate`（== `kind`）与 `toolCallId`，满足前端 wire schema 的浅校验；
/// 前端 ACL 据 `toolCallId` 归一到 thread 协议 VM（见 src/types/ai/sidecar.ts）。
fn tool_call_ui_event(kind: &str, update: Value) -> Value {
    json!({ "type": kind, "acpUpdate": update })
}

/// 构造可用斜杠命令更新 `TAgentUiEvent`（`type` 为 `available_commands_update`）。
///
/// 投影 ACP `available_commands_update`（外部 agent 声明本会话可用斜杠命令）：整份透传
/// ACP `availableCommands` 原始数组（逐字透传，不解读其结构、不伪造默认项），交前端 ACL
/// 归一到命令面板 VM（见 src/types/ai/sidecar.ts 的 TAgentUiEventAvailableCommandsUpdate
/// 与 from-acp-available-commands.ts）。
fn available_commands_ui_event(available_commands: &Value) -> Value {
    json!({ "type": "available_commands_update", "availableCommands": available_commands.clone() })
}

/// 构造用量更新 `TAgentUiEvent`（`type` 为 `usage_update`）。
///
/// 投影 ACP `usage_update`（外部 agent 上报本回合 token 用量）：整份透传 ACP `usage` 原始
/// 对象（逐字透传，不解读其结构、不本地折算），交前端 ACL 归一到用量 VM（见
/// src/types/ai/sidecar.ts 的 TAgentUiEventUsageUpdate 与 from-acp-usage.ts）。
fn usage_update_ui_event(usage: &Value) -> Value {
    json!({ "type": "usage_update", "usage": usage.clone() })
}

/// 构造会话配置项变更 `TAgentUiEvent`（`type` 为 `config_option_update`）。
///
/// 投影 ACP `config_option_update`（外部 agent 公示/更新本会话可配置项，含模型 / 模式 / 推理强度
/// 等，见 agentclientprotocol.com/protocol/v1/session-config-options）：整份透传 ACP `configOptions`
/// 原始数组（逐字透传，不解读其结构、不伪造默认项），交前端 ACL 归一到配置项选择器 VM（见
/// src/types/ai/sidecar.ts 的 TAgentUiEventConfigOptionUpdate 与 from-acp-session-config-options.ts）。
/// 该通知携带完整配置状态快照，前端整体替换（见 applyAcpConfigOptionUpdate）。
fn config_option_update_ui_event(config_options: &Value) -> Value {
    json!({ "type": "config_option_update", "configOptions": config_options.clone() })
}

/// 构造计划快照 `TAgentUiEvent`（`type` 为 `plan`）。
///
/// 投影 ACP `plan`（全量计划快照，client 整体替换）：最小透传整个 ACP `update` 对象
/// （含 `entries[]` 的 content/priority/status 与可选 `_meta` 富载荷）作为 `acpUpdate`，
/// 宿主侧不解读其结构、不压平，交前端 ACL 归一到计划 VM（见 src/types/ai/sidecar.ts 的
/// TAgentUiEventPlan 与 from-acp-plan.ts）。
fn plan_ui_event(update: Value) -> Value {
    json!({ "type": "plan", "acpUpdate": update })
}

/// 将单条 ACP `SessionNotification` JSON 投影为 0..1 条 `TAgentUiEvent` JSON。
///
/// 入参为 client 层 `AcpStreamFrame.event`（官方 `SessionNotification` 的 camelCase JSON：
/// `{ sessionId, update: { sessionUpdate, ... } }`）。返回 None 表示该通知在主聊天流中无
/// 对应 UI 事件（链路外 / 未接入变体），调用方据此跳过、不向 webview 下发。
pub fn session_notification_to_ui_event(mut notification: Value) -> Option<Value> {
    let update = notification.get_mut("update")?;
    let kind = update.get("sessionUpdate").and_then(Value::as_str)?.to_owned();
    match kind.as_str() {
        "agent_message_chunk" => {
            let text = text_from_content_block(update.get("content")?)?;
            Some(message_delta(text, PHASE_FINAL))
        }
        "agent_thought_chunk" => {
            let text = text_from_content_block(update.get("content")?)?;
            Some(message_delta(text, PHASE_STAGE))
        }
        // ACP 原生工具调用（ADR-20260617 · D1/D2）：最小透传，不解读/不压平。
        // 整个 ACP `update`（toolCallId/title/kind/status/content[]/locations/rawInput/
        // rawOutput 等）原样作为 `acpUpdate`，交前端 ACL 按 toolCallId 归一到 thread 协议 VM。
        "tool_call" | "tool_call_update" => {
            let owned_update = std::mem::take(update);
            Some(tool_call_ui_event(&kind, owned_update))
        }
        // 外部 agent 声明本会话可用的斜杠命令（标准 available_commands_update）：整份透传
        // availableCommands 原始数组，交前端 ACL 归一到命令面板 VM（D7-④）。
        "available_commands_update" => {
            let commands = update.get("availableCommands")?;
            Some(available_commands_ui_event(commands))
        }
        // 外部 agent 上报本回合 token 用量（标准 usage_update）：整份透传 usage 原始对象，
        // 交前端 ACL 归一到用量 VM（D7-⑦）。
        "usage_update" => {
            let usage = update.get("usage")?;
            Some(usage_update_ui_event(usage))
        }
        // 外部 agent 公示/更新本会话可配置项（标准 config_option_update，模型选择器即走此通道）：
        // 整份透传 configOptions 原始数组（完整快照），交前端 ACL 归一到配置项选择器 VM。Kimi 等
        // 在 session/new 后经一次性通知下发模型清单，缺此投影则该帧被丢弃、模型选择器恒空。
        "config_option_update" => {
            let config_options = update.get("configOptions")?;
            Some(config_option_update_ui_event(config_options))
        }
        // 外部/内置 agent 下发计划快照（标准 plan，全量条目替换）：最小透传整个 update
        // 作为 acpUpdate（含 entries 与可选 _meta 富载荷），交前端 ACL 归一到计划 VM。
        "plan" => {
            let owned_update = std::mem::take(update);
            Some(plan_ui_event(owned_update))
        }
        // 其余未列出的变体暂未投影。显式 None 作为可扩展接入点。
        _ => None,
    }
}

/// 合成终态 `done` `TAgentUiEvent`。
///
/// ACP prompt 回合不流式发 done（见模块文档）：宿主侧 chat_stream 在 host.chat() 返回后，
/// 以累计答案文本 + 可选用量信封合成本事件补发到 `ai:sidecar-stream`，使前端
/// `getLatestSidecarLiveEvents` 能据 done 收束流式状态。`usage` 原样透传 sidecar 的
/// `IAiLanguageModelUsage` JSON；缺失或为 null 时省略该字段（对齐前端 `usage?: ... | null`）。
pub fn build_done_ui_event(result: &str, usage: Option<Value>) -> Value {
    let mut event = json!({ "type": "done", "result": result });
    if let Some(usage) = usage
        && !usage.is_null()
    {
        event["usage"] = usage;
    }
    event
}

/// 合成 `error` `TAgentUiEvent`（回合失败时由宿主侧补发）。
pub fn build_error_ui_event(message: &str) -> Value {
    json!({ "type": "error", "message": message })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notif(update: Value) -> Value {
        json!({ "sessionId": "sess_1", "update": update })
    }

    #[test]
    fn agent_message_chunk_maps_to_final_message_delta() {
        let n = notif(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "你好" }
        }));
        let ui = session_notification_to_ui_event(n).unwrap();
        assert_eq!(ui["type"], "message_delta");
        assert_eq!(ui["text"], "你好");
        assert_eq!(ui["phase"], "final");
    }

    #[test]
    fn agent_thought_chunk_maps_to_stage_message_delta() {
        let n = notif(json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": "让我想想" }
        }));
        let ui = session_notification_to_ui_event(n).unwrap();
        assert_eq!(ui["type"], "message_delta");
        assert_eq!(ui["text"], "让我想想");
        assert_eq!(ui["phase"], "stage");
    }

    #[test]
    fn non_text_content_block_yields_none() {
        let n = notif(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "image", "data": "...", "mimeType": "image/png" }
        }));
        assert!(session_notification_to_ui_event(n).is_none());
    }

    #[test]
    fn tool_call_passes_through_whole_update_as_acp_update() {
        // 最小透传：整个 ACP update 原样落在 acpUpdate，不解读/不压平/不伪造 base 字段。
        let update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "t1",
            "title": "read_file",
            "kind": "read",
            "status": "in_progress",
            "content": [{ "type": "content", "content": { "type": "text", "text": "..." } }],
            "locations": [{ "path": "/a/b.rs" }],
            "rawInput": { "path": "/a/b.rs" }
        });
        let ui = session_notification_to_ui_event(notif(update.clone())).unwrap();
        assert_eq!(ui["type"], "tool_call");
        assert_eq!(ui["acpUpdate"], update);
    }

    #[test]
    fn tool_call_update_passes_through_whole_update_as_acp_update() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "t1",
            "status": "completed",
            "rawOutput": { "ok": true }
        });
        let ui = session_notification_to_ui_event(notif(update.clone())).unwrap();
        assert_eq!(ui["type"], "tool_call_update");
        assert_eq!(ui["acpUpdate"], update);
    }

    #[test]
    fn available_commands_update_passes_through_raw_array() {
        let commands = json!([
            { "name": "plan", "description": "生成计划" },
            { "name": "test", "description": "运行测试", "input": { "hint": "范围" } }
        ]);
        let n = notif(json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": commands.clone()
        }));
        let ui = session_notification_to_ui_event(n).unwrap();
        assert_eq!(ui["type"], "available_commands_update");
        assert_eq!(ui["availableCommands"], commands);
    }

    #[test]
    fn available_commands_update_without_field_yields_none() {
        let n = notif(json!({ "sessionUpdate": "available_commands_update" }));
        assert!(session_notification_to_ui_event(n).is_none());
    }

    #[test]
    fn usage_update_passes_through_raw_usage() {
        let usage = json!({ "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 });
        let n = notif(json!({
            "sessionUpdate": "usage_update",
            "usage": usage.clone()
        }));
        let ui = session_notification_to_ui_event(n).unwrap();
        assert_eq!(ui["type"], "usage_update");
        assert_eq!(ui["usage"], usage);
    }

    #[test]
    fn usage_update_without_field_yields_none() {
        let n = notif(json!({ "sessionUpdate": "usage_update" }));
        assert!(session_notification_to_ui_event(n).is_none());
    }

    #[test]
    fn config_option_update_passes_through_raw_config_options() {
        let config_options = json!([
            {
                "id": "model",
                "name": "Model",
                "type": "select",
                "currentValue": "kimi-k2",
                "options": [
                    { "value": "kimi-k2", "name": "Kimi K2" },
                    { "value": "kimi-k2-turbo", "name": "Kimi K2 Turbo" }
                ]
            }
        ]);
        let n = notif(json!({
            "sessionUpdate": "config_option_update",
            "configOptions": config_options.clone()
        }));
        let ui = session_notification_to_ui_event(n).unwrap();
        assert_eq!(ui["type"], "config_option_update");
        assert_eq!(ui["configOptions"], config_options);
    }

    #[test]
    fn config_option_update_without_field_yields_none() {
        let n = notif(json!({ "sessionUpdate": "config_option_update" }));
        assert!(session_notification_to_ui_event(n).is_none());
    }

    #[test]
    fn plan_passes_through_whole_update_as_acp_update() {
        // 最小透传：整个 ACP plan update（含 entries 与可选 _meta）原样落在 acpUpdate。
        let update = json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "读取文件", "priority": "high", "status": "pending" },
                { "content": "应用补丁", "priority": "medium", "status": "in_progress" }
            ]
        });
        let ui = session_notification_to_ui_event(notif(update.clone())).unwrap();
        assert_eq!(ui["type"], "plan");
        assert_eq!(ui["acpUpdate"], update);
    }

    #[test]
    fn unmapped_session_update_yields_none() {
        let n = notif(json!({
            "sessionUpdate": "unknown_future_update",
            "payload": {}
        }));
        assert!(session_notification_to_ui_event(n).is_none());
    }

    #[test]
    fn missing_update_yields_none() {
        assert!(session_notification_to_ui_event(json!({ "sessionId": "s" })).is_none());
    }

    #[test]
    fn build_done_includes_usage_when_present() {
        let usage = json!({ "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 });
        let done = build_done_ui_event("答案", Some(usage.clone()));
        assert_eq!(done["type"], "done");
        assert_eq!(done["result"], "答案");
        assert_eq!(done["usage"], usage);
    }

    #[test]
    fn build_done_omits_usage_when_null_or_absent() {
        let done_absent = build_done_ui_event("答案", None);
        assert_eq!(done_absent["type"], "done");
        assert!(done_absent.get("usage").is_none());

        let done_null = build_done_ui_event("答案", Some(Value::Null));
        assert!(done_null.get("usage").is_none());
    }

    #[test]
    fn build_error_carries_message() {
        let err = build_error_ui_event("出错了");
        assert_eq!(err["type"], "error");
        assert_eq!(err["message"], "出错了");
    }
}
