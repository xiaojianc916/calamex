//! 宿主侧「一次 prompt 回合」的响应重建。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中按 cargo feature
//! `acp_client` 门控的新增模块，落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! 设计完全对齐 sidecar 的出口成帧 `turn-egress.ts`：ACP 一次 `session/prompt`
//! 回合的线上输出只有两部分——
//! 1. 过程中的若干 `session/update` 通知（文本/推理增量、工具生命周期、计划快照）；
//! 2. 回合收尾：一条可选 `usage_update` 通知 + 一条仅含 `stopReason` 的
//!    `session/prompt` 响应。
//!
//! 它**不再**像旧 HTTP/NDJSON 路径那样下发一帧「最终 `AgentSidecarResponsePayload`」。
//! 因此宿主必须把收集到的 `session/update` 通知重建为既有命令契约要求的
//! `{ sessionId, events, result }` 信封：
//! * `events`：原样收集每条通知的 JSON（camelCase 线格式），与 `ai:sidecar-stream`
//!   下发的 `event` 同形，供既有前端 / 后续 ACP 前端逐条消费；
//! * `result`：拼接所有 `agent_message_chunk` 的文本内容——对齐 Zed
//!   `acp_thread.rs` 把 `agent_message_chunk` 累积进 assistant 消息缓冲的做法；
//!   `agent_thought_chunk`（推理增量）、工具生命周期、计划快照等均不计入最终回答。
//!
//! wire 形状取自实际生产者 sidecar `from-runtime-event.ts` + `session-stream.ts`：
//! `{ sessionId, update: { sessionUpdate: "agent_message_chunk",
//! content: { type: "text", text } } }`
//! 故本模块只读取这些既有字段，不臆造任何协议形态；非文本块 / 其它通知一律跳过。

#![allow(dead_code)]

use serde_json::Value;

use crate::commands::contracts::AgentSidecarResponsePayload;

/// 一次 `session/prompt` 回合内累积的 `session/update` 通知 → 宿主侧响应信封。
///
/// 接线时：常驻连接任务每收到一条通知便 `record` 一次（同一条通知也由
/// `EventSink` 下发到 `ai:sidecar-stream`）；回合的 `session/prompt` 响应返回后，
/// 调用 `into_response` 取得最终 `AgentSidecarResponsePayload`。
#[derive(Debug, Default)]
pub struct TurnAccumulator {
    events: Vec<Value>,
    answer: String,
}

impl TurnAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录一条 `session/update` 通知（`AcpStreamFrame.event`，形如
    /// `{ sessionId, update }`）。文本回答增量顺带累积进 `answer`。
    pub fn record(&mut self, event: Value) {
        if let Some(text) = agent_message_chunk_text(&event) {
            self.answer.push_str(text);
        }
        self.events.push(event);
    }

    /// 已累积的通知条数（主要用于测试 / 诊断）。
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// 是否尚未收到任何通知。
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// 回合收尾：组装 sidecar 响应信封。
    ///
    /// `result` 在没有任何文本回答时按既有契约置 `None`（对齐旧路径——无最终
    /// 文本时 `result` 缺省），否则为按到达顺序拼接的完整回答文本。
    pub fn into_response(self, session_id: String) -> AgentSidecarResponsePayload {
        let result = if self.answer.is_empty() {
            None
        } else {
            Some(self.answer)
        };

        AgentSidecarResponsePayload {
            session_id,
            events: self.events,
            result,
        }
    }
}

/// 从一条 `session/update` 通知中提取 `agent_message_chunk` 的文本内容。
///
/// 仅当 `update.sessionUpdate == "agent_message_chunk"` 且其 `content` 为文本块
/// 时返回文本切片；其它（推理增量 / 工具生命周期 / 计划快照 / 用量更新等）一律
/// 返回 `None`，不计入最终回答。
fn agent_message_chunk_text(event: &Value) -> Option<&str> {
    let update = event.get("update")?;

    if update.get("sessionUpdate").and_then(Value::as_str) != Some("agent_message_chunk") {
        return None;
    }

    content_block_text(update.get("content")?)
}

/// 提取 ACP `ContentBlock` 的文本（仅 `type == "text"` 且非空）；否则 `None`。
fn content_block_text(content: &Value) -> Option<&str> {
    if content.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }

    content
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 构造一条 agent_message_chunk 通知，线形对齐 from-runtime-event.ts 的
    /// `agent.text.delta` 投影 + session-stream.ts 的 `{ sessionId, update }` 信封。
    fn agent_message_chunk(session_id: &str, text: &str) -> Value {
        json!({
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {
                    "type": "text",
                    "text": text
                }
            }
        })
    }

    #[test]
    fn concatenates_agent_message_chunks_into_result() {
        let mut acc = TurnAccumulator::new();
        acc.record(agent_message_chunk("s1", "你好"));
        acc.record(agent_message_chunk("s1", "，世界"));

        let response = acc.into_response("s1".to_string());
        assert_eq!(response.session_id, "s1");
        assert_eq!(response.result.as_deref(), Some("你好，世界"));
        assert_eq!(response.events.len(), 2);
    }

    #[test]
    fn keeps_non_message_updates_in_events_but_excludes_from_result() {
        let mut acc = TurnAccumulator::new();

        acc.record(json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {
                    "type": "text",
                    "text": "思考"
                }
            }
        }));

        acc.record(json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "read",
                "kind": "read",
                "status": "in_progress"
            }
        }));

        acc.record(agent_message_chunk("s1", "答案"));

        let response = acc.into_response("s1".to_string());
        // 仅 agent_message_chunk 计入 result；推理增量 / 工具调用仍完整保留在 events。
        assert_eq!(response.result.as_deref(), Some("答案"));
        assert_eq!(response.events.len(), 3);
    }

    #[test]
    fn result_is_none_when_no_text_answer() {
        let mut acc = TurnAccumulator::new();

        acc.record(json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "plan",
                "entries": []
            }
        }));

        let response = acc.into_response("s1".to_string());
        assert_eq!(response.result, None);
        assert_eq!(response.events.len(), 1);
    }

    #[test]
    fn skips_empty_and_non_text_content_blocks() {
        let mut acc = TurnAccumulator::new();

        // 空文本块：不计入回答。
        acc.record(agent_message_chunk("s1", ""));
        // 非文本内容块（如图片）：不计入回答。
        acc.record(json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {
                    "type": "image",
                    "data": "...",
                    "mimeType": "image/png"
                }
            }
        }));

        let response = acc.into_response("s1".to_string());
        assert_eq!(response.result, None);
        // 即便不计入回答，原始通知仍完整收集到 events 中。
        assert_eq!(response.events.len(), 2);
    }

    #[test]
    fn extracts_text_from_confirmed_wire_shape() {
        let event = agent_message_chunk("sess-7", "片段");
        assert_eq!(agent_message_chunk_text(&event), Some("片段"));
    }

    #[test]
    fn ignores_malformed_or_missing_update() {
        // 缺 update 字段：安全返回 None，不 panic。
        assert_eq!(
            agent_message_chunk_text(&json!({ "sessionId": "s1" })),
            None
        );

        // update 非对象：安全返回 None。
        assert_eq!(
            agent_message_chunk_text(&json!({
                "sessionId": "s1",
                "update": 7
            })),
            None
        );
    }
}
