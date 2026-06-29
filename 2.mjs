// d1s4b-rust-tripiece.mjs
// D1 Slice 4-B：删除 Rust 侧「三件套」（agent/chat、agent/chat/resolve、
// agent/ask-user/resume）的端到端管线：
//   tauri_bindings.rs   3 条 collect_commands
//   commands/builtin_agent.rs  3 个命令 + 契约导入裁剪
//   acp/mod.rs          bridge 再导出裁剪（显式列名）
//   acp/bridge.rs       6 个投影函数 + 导入 + 测试裁剪
//   acp/client.rs       7 个 ExtRequest 结构体 + Command 变体 + 句柄方法 + 循环臂 + 测试
//   acp/host.rs         4 个 AcpHost 方法 + client 导入裁剪
// 保留：model/chat（标题/补全）、external_chat、checkpoint/warmup/health、原生 prompt/审批/取消。
// 验证：cargo clippy --features acp_client --manifest-path src-tauri/Cargo.toml
//       cargo test   --features acp_client --manifest-path src-tauri/Cargo.toml
//       然后 cargo build（tauri-specta 重生 src/bindings/tauri.ts）
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n')
const toLf = (s) => s.split('\r\n').join('\n')
const fromLf = (s, eol) => (eol === '\r\n' ? s.split('\n').join('\r\n') : s)
const J = (...lines) => lines.join('\n')

const miss = (label, soft, msg) => {
  if (soft) {
    console.warn(`  ~ [${label}] 软锚点跳过：${msg}`)
    return true
  }
  throw new Error(`[${label}] ${msg}`)
}

const replaceOnce = (text, oldStr, newStr, label, soft = false) => {
  const i = text.indexOf(oldStr)
  if (i === -1) return miss(label, soft, `锚点未命中: ${oldStr.slice(0, 70)}`) ? text : text
  if (text.indexOf(oldStr, i + oldStr.length) !== -1)
    throw new Error(`[${label}] 锚点多次命中: ${oldStr.slice(0, 70)}`)
  return text.slice(0, i) + newStr + text.slice(i + oldStr.length)
}

// 保留 start 与 end，删除两者之间（含中段任意内容），以 joiner 衔接。
const removeBetween = (text, start, end, joiner, label, soft = false) => {
  const s = text.indexOf(start)
  if (s === -1) return miss(label, soft, `start 未命中: ${start.slice(0, 60)}`) ? text : text
  const sEnd = s + start.length
  if (text.indexOf(start, sEnd) !== -1)
    throw new Error(`[${label}] start 多次命中: ${start.slice(0, 60)}`)
  const e = text.indexOf(end, sEnd)
  if (e === -1) return miss(label, soft, `end 未命中: ${end.slice(0, 60)}`) ? text : text
  return text.slice(0, sEnd) + joiner + text.slice(e)
}

// 从 start 起删到文件尾，替换为 tail（用于尾部连续测试块）。
const cutToEnd = (text, start, tail, label) => {
  const i = text.indexOf(start)
  if (i === -1) throw new Error(`[${label}] start 未命中: ${start.slice(0, 60)}`)
  if (text.indexOf(start, i + start.length) !== -1)
    throw new Error(`[${label}] start 多次命中: ${start.slice(0, 60)}`)
  return text.slice(0, i) + tail
}

const edit = (rel, fn) => {
  const abs = `${ROOT}/${rel}`
  const raw = readFileSync(abs, 'utf8')
  const eol = detectEol(raw)
  const next = fn(toLf(raw))
  writeFileSync(abs, fromLf(next, eol), 'utf8')
  console.log(`✓ ${rel}`)
}

// ── 1) tauri_bindings.rs：删 3 条 collect_commands ───────────────
edit('src-tauri/src/tauri_bindings.rs', (t) => {
  t = replaceOnce(t, '            builtin_agent::builtin_agent_chat,\n', '', 'bindings/chat')
  t = replaceOnce(t, '            builtin_agent::builtin_agent_resolve_approval,\n', '', 'bindings/appr')
  t = replaceOnce(t, '            builtin_agent::builtin_agent_resolve_ask_user,\n', '', 'bindings/ask')
  return t
})

// ── 2) commands/builtin_agent.rs ───────────────────────────────
edit('src-tauri/src/commands/builtin_agent.rs', (t) => {
  // 2a. 契约导入：删仅被三件套消费的 3 个请求类型。
  t = replaceOnce(
    t,
    '    AgentSidecarApprovalResolveRequest, AgentSidecarAskUserResumeRequest, AgentSidecarChatRequest,\n',
    '',
    'cmd/import',
  )
  // 2b. 删 builtin_agent_chat（介于 warmup 与 external_chat 之间）。
  t = removeBetween(
    t,
    J(
      '        .warmup(crate::acp::WarmupExtRequest { model_config: None })',
      '        .await',
      '        .map_err(|error| error.to_string())',
      '}',
    ),
    '/// 外部 ACP 编码 agent（Kimi Code / Codex 等，ADR-0015）的标准回合命令',
    '\n\n',
    'cmd/chat',
  )
  // 2c. 删 builtin_agent_resolve_approval + builtin_agent_resolve_ask_user
  //     （介于 external_backend_label 与 restore_checkpoint 之间）。
  t = removeBetween(
    t,
    J('        crate::acp::AcpBackendId::Codex => "Codex",', '    }', '}'),
    J('#[tauri::command]', '#[specta::specta]', 'pub async fn builtin_agent_restore_checkpoint('),
    '\n\n',
    'cmd/resolve',
  )
  return t
})

// ── 3) acp/mod.rs：bridge 再导出裁剪（显式列名）──────────────────
edit('src-tauri/src/acp/mod.rs', (t) => {
  t = replaceOnce(
    t,
    J(
      'pub use bridge::{',
      '    approval_resolve_to_agent_chat_resolve_ext, ask_user_resume_to_agent_ask_user_resume_ext,',
      '    chat_request_to_agent_chat_ext, chat_request_to_model_chat_ext,',
      '};',
    ),
    'pub use bridge::chat_request_to_model_chat_ext;',
    'mod/bridge-reexport',
  )
  // 注释更新（软）。
  t = replaceOnce(
    t,
    J(
      '// 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求。四条投影（agent/chat、',
      '// agent/chat/resolve、agent/ask-user/resume、一次性 model/chat）均已由命令层 / 网关 live 调用。',
    ),
    '// 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求（一次性 model/chat），已由网关 live 调用。',
    'mod/comment',
    true,
  )
  return t
})

// ── 4) acp/bridge.rs ───────────────────────────────────────────
edit('src-tauri/src/acp/bridge.rs', (t) => {
  // 4a. 模块文档裁剪（软）：去掉 agent/* 投影段，仅留 model/chat。
  t = removeBetween(
    t,
    '//!      做法（`calamex.dev/model/chat`），而非塞进标准会话回合（`session/prompt`）。',
    'use crate::commands::contracts::{',
    '\n//!\n//! 上述投影（model/chat）已由网关 live 调用（见 `ai::gateway::conversation`）。\n\n',
    'bridge/doc',
    true,
  )
  // 4b. 契约导入裁剪。
  t = replaceOnce(
    t,
    J(
      'use crate::commands::contracts::{',
      '    AgentSidecarApprovalResolveRequest, AgentSidecarAskUserAnswerPayload,',
      '    AgentSidecarAskUserResumeRequest, AgentSidecarChatRequest, AgentSidecarMessagePayload,',
      '    AgentSidecarModelConfigPayload, AiContextReferencePayload,',
      '};',
    ),
    J(
      'use crate::commands::contracts::{',
      '    AgentSidecarChatRequest, AgentSidecarMessagePayload, AgentSidecarModelConfigPayload,',
      '};',
    ),
    'bridge/contracts-import',
  )
  // 4c. client 导入裁剪。
  t = replaceOnce(
    t,
    J(
      'use super::client::{',
      '    AgentAskUserResumeExtRequest, AgentChatContextRange, AgentChatContextReference,',
      '    AgentChatExtRequest, AgentChatMessage, AgentChatResolveExtRequest, AskUserAnswer,',
      '    ExtModelConfig, ModelChatExtRequest, ModelChatMessage,',
      '};',
    ),
    'use super::client::{ExtModelConfig, ModelChatExtRequest, ModelChatMessage};',
    'bridge/client-import',
  )
  // 4d. 删 6 个 agent 投影函数（保留 chat_request_to_model_chat_ext 与 #[cfg(test)]）。
  t = removeBetween(
    t,
    J(
      'pub fn chat_request_to_model_chat_ext(request: AgentSidecarChatRequest) -> ModelChatExtRequest {',
      '    ModelChatExtRequest {',
      '        messages: request.messages.into_iter().map(message_to_ext).collect(),',
      '        goal: trimmed_non_empty(request.goal),',
      '        session_id: trimmed_non_empty(request.session_id),',
      '        workspace_root_path: trimmed_non_empty(request.workspace_root_path),',
      '        model_config: request.model_config.map(model_config_to_ext),',
      '    }',
      '}',
    ),
    J('#[cfg(test)]', 'mod tests {'),
    '\n\n',
    'bridge/fns',
  )
  // 4e. 测试：删 AiContextRangePayload 导入。
  t = replaceOnce(t, '    use crate::commands::contracts::AiContextRangePayload;\n', '', 'bridge/test-import')
  // 4f. 测试：删辅助构造器 reference / approval_resolve_request / ask_user_answer / ask_user_resume_request
  //     （介于 base_request 与首个保留测试之间）。
  t = removeBetween(
    t,
    J(
      '            model_config: Some(AgentSidecarModelConfigPayload {',
      '                model_id: "zhipuai/glm-4.7-flash".to_string(),',
      '                api_key: "secret-key".into(),',
      '                base_url: None,',
      '            }),',
      '            thread_id: None,',
      '        }',
      '    }',
    ),
    J('    #[test]', '    fn projects_messages_preserving_role_and_content_with_tool_fields_none() {'),
    '\n\n',
    'bridge/test-helpers',
  )
  // 4g. 测试：删尾部 9 个 agent/approval/ask 测试，恢复 mod 收尾。
  t = cutToEnd(
    t,
    J('    #[test]', '    fn chat_request_projects_to_agent_chat_with_resolved_session() {'),
    '}\n',
    'bridge/test-tail',
  )
  return t
})

// ── 5) acp/client.rs ───────────────────────────────────────────
edit('src-tauri/src/acp/client.rs', (t) => {
  // 5a. 删 7 个 agent ExtRequest/辅助结构体（介于 HealthExtRequest 与 AcpClientConfig 之间）。
  t = removeBetween(t, 'pub struct HealthExtRequest {}', 'pub struct AcpClientConfig {', '\n\n', 'client/structs')
  // 5b. 删 Command 枚举 3 个变体（介于 Health 与 Shutdown 之间）。
  t = removeBetween(
    t,
    J(
      '    Health {',
      '        request: HealthExtRequest,',
      '        reply: oneshot::Sender<Result<Value, String>>,',
      '    },',
    ),
    '    Shutdown,',
    '\n',
    'client/enum',
  )
  // 5c. 删 AcpClientHandle 的 3 个句柄方法（介于 health 与 cancel 之间）。
  t = removeBetween(
    t,
    J(
      '    pub async fn health(&self, request: HealthExtRequest) -> Result<Value, AcpClientError> {',
      '        let (reply, rx) = oneshot::channel();',
      '        self.cmd_tx',
      '            .send(Command::Health { request, reply })',
      '            .map_err(|_| AcpClientError::NotRunning)?;',
      '        rx.await',
      '            .map_err(|_| AcpClientError::NotRunning)?',
      '            .map_err(AcpClientError::Protocol)',
      '    }',
    ),
    '    pub fn cancel(&self, session_id: SessionId) -> Result<(), AcpClientError> {',
    '\n\n',
    'client/methods',
  )
  // 5d. 删命令循环 3 个 match 臂（介于 Health 臂与 Shutdown 臂之间）。
  t = removeBetween(
    t,
    J(
      '                        Command::Health { request, reply } => {',
      '                            let res = cx.send_request(request).block_task().await;',
      '                            let _ = reply.send(res.map_err(|e| e.to_string()));',
      '                        }',
    ),
    '                        Command::Shutdown => break,',
    '\n',
    'client/arms',
  )
  // 5e. 删 6 个 agent 测试（介于 web_search 测试与「取消死锁回归测试」段之间）。
  t = removeBetween(
    t,
    J('        assert!(value.get("recency").is_none());', '    }'),
    '    // ---- 取消死锁回归测试 ----',
    '\n\n',
    'client/tests',
  )
  return t
})

// ── 6) acp/host.rs ─────────────────────────────────────────────
edit('src-tauri/src/acp/host.rs', (t) => {
  // 6a. 文档：client 句柄清单去 agent_chat*（软）。
  t = replaceOnce(
    t,
    J('//!     warmup / health / agent_chat /', '//!     agent_chat_resolve / agent_ask_user_resume / cancel / shutdown）；'),
    '//!     warmup / health / cancel / shutdown）；',
    'host/doc-bullets',
    true,
  )
  // 6b. 文档：删「对话即带外」整段、并修「流式即转发」末句（软）。
  t = removeBetween(
    t,
    '//!     单点负责（见 `ui_event`），本层不投影。',
    '//!\n//! 外部 ACP 编码 agent',
    '权威结果由各扩展方法的返回信封承载。\n',
    'host/doc-band',
    true,
  )
  // 6c. client 导入裁剪。
  t = replaceOnce(
    t,
    J(
      'use super::client::{',
      '    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, AgentAskUserResumeExtRequest,',
      '    AgentChatExtRequest, AgentChatResolveExtRequest, CheckpointRestoreRequest, EventSink,',
      '    HealthExtRequest, ModelChatExtRequest,',
      '    WarmupExtRequest, WebFetchExtRequest, WebSearchExtRequest, spawn_acp_client,',
      '};',
    ),
    J(
      'use super::client::{',
      '    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, CheckpointRestoreRequest,',
      '    EventSink, HealthExtRequest, ModelChatExtRequest, WarmupExtRequest, WebFetchExtRequest,',
      '    WebSearchExtRequest, spawn_acp_client,',
      '};',
    ),
    'host/client-import',
  )
  // 6d. 删 AcpHost 的 4 个方法：agent_chat / agent_chat_with_stream_key /
  //     agent_chat_resolve / agent_ask_user_resume（介于 health 与 cancel 之间）。
  t = removeBetween(
    t,
    J(
      '    pub async fn health(&self) -> Result<AgentSidecarHealthPayload, AcpClientError> {',
      '        let value = self.handle.health(HealthExtRequest {}).await?;',
      '        serde_json::from_value(value).map_err(|error| {',
      '            AcpClientError::Protocol(format!("invalid health response payload: {error}"))',
      '        })',
      '    }',
    ),
    '    /// 取消指定会话的当前回合',
    '\n\n',
    'host/methods',
  )
  return t
})

console.log('done: D1 Slice 4-B (Rust tri-piece removed)')