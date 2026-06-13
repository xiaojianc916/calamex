//! ACP `session/update` 通知 → 前端 `TAgentUiEvent` 的纯映射适配层。
//!
//! 背景：前端原生消费端（`onSidecarStream` → `IAgentSidecarStreamEventPayload.event`）
//! 吃的是 Mastra 域的 `TAgentUiEvent`（`message_delta` / `done` / `error` / ...，以
//! `type` 为判别式），而 ACP 线上协议下发的是官方 `SessionNotification`
//! （`update.sessionUpdate` 为判别式：`agent_message_chunk` / `agent_thought_chunk` /
//! `tool_call(_update)` / `plan` / `usage_update` ...）。两套词表不同，本模块在宿主侧把
//! 后者投影为前者，使 ACP 主聊天流可直接复用既有前端消费端
//! （见 src/composables/ai/sidecar-events.ts）。
//!
//! 设计对齐 sidecar 出站投影 `from-runtime-event.ts` 的对偶：
//! - `agent_message_chunk`（模型文本增量）→ message_delta{phase:"final"}
//! - `agent_thought_chunk`（推理增量）   → message_delta{phase:"stage"}
//! 其余 session/update 变体在「ask 主聊天」回合不会出现（tool_call(_update)/plan 属
//! agent/plan 模式，且 approval/plan_ready 不进 session/update，见 output-event-stream.ts），
//! 故此处显式返回 None 作为可扩展接入点：后续 agent/plan 模式切流时再按 toolCallId
//! 投影为 agent_event（复用 from-runtime-event.ts 的 toolUseId 关联策略）。
//!
//! `done` / `error` 不是 session/update 通知：ACP prompt 回合不流式发 done，最终答案经
//! agent_message_chunk 增量送达、信封（result+usage）回到宿主（见 turn-egress.ts）。故终态
//! 由宿主侧 chat_stream 在 host.chat() 返回后用 build_done_ui_event / build_error_ui_event
//! 合成并补发。本模块纯函数、无 I/O、无状态，便于单测。

// 过渡期：本模块尚未接线到宿主流式发射点（接线在后续 slice）。接线后移除该 allow。
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

/// 将单条 ACP `SessionNotification` JSON 投影为 0..1 条 `TAgentUiEvent` JSON。
///
/// 入参为 client 层 `AcpStreamFrame.event`（官方 `SessionNotification` 的 camelCase JSON：
/// `{ sessionId, update: { sessionUpdate, ... } }`）。返回 None 表示该通知在主聊天流中无
/// 对应 UI 事件（链路外 / 未接入变体），调用方据此跳过、不向 webview 下发。
pub fn session_notification_to_ui_event(notification: &Value) -> Option<Value> {
    let update = notification.get("update")?;
    let kind = update.get("sessionUpdate").and_then(Value::as_str)?;
    match kind {
        "agent_message_chunk" => {
            let text = text_from_content_block(update.get("content")?)?;
            Some(message_delta(text, PHASE_FINAL))
        }
        "agent_thought_chunk" => {
            let text = text_from_content_block(update.get("content")?)?;
            Some(message_delta(text, PHASE_STAGE))
        }
        // 其余变体不在 ask 主聊天回合出现（tool_call(_update)/plan 属 agent/plan 模式；
        // usage_update 经信封回宿主用于合成 done；current_mode_update 等为会话元数据）。
        // 作为可扩展接入点显式返回 None，后续 agent/plan 切流时在此扩充投影。
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
    if let Some(usage) = usage {
        if !usage.is_null() {
            event["usage"] = usage;
        }
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
        let ui = session_notification_to_ui_event(&n).unwrap();
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
        let ui = session_notification_to_ui_event(&n).unwrap();
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
        assert!(session_notification_to_ui_event(&n).is_none());
    }

    #[test]
    fn unmapped_session_update_yields_none() {
        let n = notif(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "t1",
            "title": "read_file",
            "kind": "read",
            "status": "in_progress"
        }));
        assert!(session_notification_to_ui_event(&n).is_none());
    }

    #[test]
    fn missing_update_yields_none() {
        assert!(session_notification_to_ui_event(&json!({ "sessionId": "s" })).is_none());
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
