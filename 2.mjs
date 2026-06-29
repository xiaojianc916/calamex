// fix-restore-livechat-and-demolish-chat_stream.mjs
// 作用域(唯一标准管线 / 不留新旧杂糅):
//  A. 恢复被误删的 LIVE 一次性 model/chat 契约:AgentSidecarChatRequest + AgentSidecarMessagePayload
//     (+ AiContextReferencePayload import + 两个契约序列化测试) —— 修 E0432 x4
//  B. 彻底拆除死链 chat_stream 全管线(conversation/mod/prompt) —— 修 E0425/E0599/E0061
//  C. 移除 ai_chat_stream 命令 + 绑定注册 + 前端 service 方法
//  D. 修 ai_ensure_acp_session 的 ensure_session 2->3 参(补 None)
//  E. 删失活契约类型 AiChatRequest / AiChatStreamPayload / AiChatMessagePayload
//  F. 清理既有未用 import:gateway::ProviderConnectionOutcome 重导出、terminal AtomicU32
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toLf = (s) => s.replace(/\r\n/g, '\n');
const fromLf = (s, eol) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);

function replaceOnce(src, oldStr, newStr) {
  const i = src.indexOf(oldStr);
  if (i < 0) throw new Error('replaceOnce 未命中: ' + JSON.stringify(oldStr.slice(0, 70)));
  if (src.indexOf(oldStr, i + oldStr.length) >= 0)
    throw new Error('replaceOnce 歧义(多处命中): ' + JSON.stringify(oldStr.slice(0, 70)));
  return src.slice(0, i) + newStr + src.slice(i + oldStr.length);
}
function cutRange(src, startNeedle, endNeedle) {
  const s = src.indexOf(startNeedle);
  if (s < 0) throw new Error('cutRange 起点未命中: ' + JSON.stringify(startNeedle.slice(0, 60)));
  const e = src.indexOf(endNeedle, s + startNeedle.length);
  if (e < 0) throw new Error('cutRange 终点未命中: ' + JSON.stringify(endNeedle.slice(0, 60)));
  return src.slice(0, s) + src.slice(e);
}

const edits = {
  // ───────────────────────── A) 恢复 live 契约 ─────────────────────────
  'src-tauri/src/commands/contracts/builtin_agent.rs': (src) => {
    // A1 恢复 AiContextReferencePayload import(AgentSidecarChatRequest.context 需要)
    src = replaceOnce(
      src,
      'use super::secret::SecretString;',
      'use super::ai_chat::AiContextReferencePayload;\nuse super::secret::SecretString;',
    );
    // A2 在 ModelConfigPayload 之前插回 MessagePayload
    const modelCfgAnchor =
      '#[derive(Debug, Clone, Serialize, Deserialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AgentSidecarModelConfigPayload {';
    const msgStruct =
      '#[derive(Debug, Clone, Serialize, Deserialize, Type)]\n' +
      '#[serde(rename_all = "camelCase")]\n' +
      'pub struct AgentSidecarMessagePayload {\n' +
      '    pub(crate) role: String,\n' +
      '    pub(crate) content: String,\n' +
      '}';
    src = replaceOnce(src, modelCfgAnchor, msgStruct + '\n\n' + modelCfgAnchor);
    // A3 在 RollbackStepPath 之前插回 ChatRequest
    const rollbackAnchor =
      '#[derive(Debug, Clone, Serialize, Deserialize, Type)]\n#[serde(untagged)]\npub enum AgentSidecarRollbackStepPath {';
    const chatStruct =
      '#[derive(Debug, Clone, Serialize, Deserialize, Type)]\n' +
      '#[serde(rename_all = "camelCase")]\n' +
      'pub struct AgentSidecarChatRequest {\n' +
      '    #[serde(skip_serializing_if = "is_blank_optional_string")]\n' +
      '    pub(crate) session_id: Option<String>,\n' +
      '    #[serde(skip_serializing_if = "is_blank_optional_string")]\n' +
      '    pub(crate) mode: Option<String>,\n' +
      '    #[serde(skip_serializing_if = "is_blank_optional_string")]\n' +
      '    pub(crate) goal: Option<String>,\n' +
      '    pub(crate) messages: Vec<AgentSidecarMessagePayload>,\n' +
      '    #[serde(skip_serializing_if = "is_blank_optional_string")]\n' +
      '    pub(crate) workspace_root_path: Option<String>,\n' +
      '    #[serde(default)]\n' +
      '    pub(crate) context: Vec<AiContextReferencePayload>,\n' +
      '    #[serde(skip_serializing_if = "Option::is_none")]\n' +
      '    pub(crate) model_config: Option<AgentSidecarModelConfigPayload>,\n' +
      '    #[serde(skip_serializing_if = "is_blank_optional_string")]\n' +
      '    pub(crate) thread_id: Option<String>,\n' +
      '}';
    src = replaceOnce(src, rollbackAnchor, chatStruct + '\n\n' + rollbackAnchor);
    // A4 测试 use 列表补回两个类型
    src = replaceOnce(
      src,
      '    use super::{\n' +
        '        AgentBackendKind, AgentExternalChatRequest, AgentSidecarCheckpointRestoreRequest,\n' +
        '        AgentSidecarRollbackStepPath,\n' +
        '    };',
      '    use super::{\n' +
        '        AgentBackendKind, AgentExternalChatRequest, AgentSidecarChatRequest,\n' +
        '        AgentSidecarCheckpointRestoreRequest, AgentSidecarMessagePayload,\n' +
        '        AgentSidecarRollbackStepPath,\n' +
        '    };',
    );
    // A5 测试辅助 sidecar_message()
    const serObjAnchor = '    fn serialize_object<T: Serialize>(value: &T) -> Map<String, Value> {';
    const msgHelper =
      '    fn sidecar_message() -> AgentSidecarMessagePayload {\n' +
      '        AgentSidecarMessagePayload {\n' +
      '            role: "user".to_string(),\n' +
      '            content: "run".to_string(),\n' +
      '        }\n' +
      '    }';
    src = replaceOnce(src, serObjAnchor, msgHelper + '\n\n' + serObjAnchor);
    // A6 恢复两个 chat_request 序列化测试
    const restoreTestAnchor =
      '    #[test]\n    fn restore_checkpoint_request_omits_absent_optional_fields() {';
    const chatTests =
      '    #[test]\n' +
      '    fn chat_request_omits_blank_optional_fields() {\n' +
      '        let request = AgentSidecarChatRequest {\n' +
      '            session_id: None,\n' +
      '            mode: Some(" ".to_string()),\n' +
      '            goal: Some("".to_string()),\n' +
      '            messages: vec![sidecar_message()],\n' +
      '            workspace_root_path: None,\n' +
      '            context: Vec::new(),\n' +
      '            model_config: None,\n' +
      '            thread_id: Some(" ".to_string()),\n' +
      '        };\n\n' +
      '        let object = serialize_object(&request);\n\n' +
      '        assert!(!object.contains_key("sessionId"));\n' +
      '        assert!(!object.contains_key("mode"));\n' +
      '        assert!(!object.contains_key("goal"));\n' +
      '        assert!(!object.contains_key("workspaceRootPath"));\n' +
      '        assert!(!object.contains_key("threadId"));\n' +
      '        assert!(object.contains_key("messages"));\n' +
      '        assert!(object.contains_key("context"));\n' +
      '    }\n\n' +
      '    #[test]\n' +
      '    fn chat_request_keeps_non_empty_thread_id() {\n' +
      '        let request = AgentSidecarChatRequest {\n' +
      '            session_id: Some("sidecar-chat-1".to_string()),\n' +
      '            mode: Some("ask".to_string()),\n' +
      '            goal: Some("继续".to_string()),\n' +
      '            messages: vec![sidecar_message()],\n' +
      '            workspace_root_path: None,\n' +
      '            context: Vec::new(),\n' +
      '            model_config: None,\n' +
      '            thread_id: Some("thread-chat-1".to_string()),\n' +
      '        };\n\n' +
      '        let object = serialize_object(&request);\n\n' +
      '        assert_eq!(\n' +
      '            object.get("threadId"),\n' +
      '            Some(&Value::String("thread-chat-1".to_string()))\n' +
      '        );\n' +
      '    }';
    src = replaceOnce(src, restoreTestAnchor, chatTests + '\n\n' + restoreTestAnchor);
    return src;
  },

  // ───────────────────── E) 删失活契约类型 ─────────────────────
  'src-tauri/src/commands/contracts/ai_chat.rs': (src) => {
    src = cutRange(
      src,
      '#[derive(Debug, Clone, Deserialize, Serialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AiChatMessagePayload {',
      '#[derive(Debug, Clone, Deserialize, Serialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AiContextRangePayload {',
    );
    src = cutRange(
      src,
      '#[derive(Debug, Clone, Deserialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AiChatRequest {',
      '#[derive(Debug, Clone, Deserialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AiConversationTitleRequest {',
    );
    src = cutRange(
      src,
      '#[derive(Debug, Clone, Serialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AiChatStreamPayload {',
      '#[derive(Debug, Clone, Deserialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AiCancelRequest {',
    );
    return src;
  },

  // ───────────────────── B) 拆 chat_stream(conversation) ─────────────────────
  'src-tauri/src/ai/gateway/conversation.rs': (src) => {
    src = replaceOnce(
      src,
      'use super::prompt::{\n    build_context_block, build_conversation_title_prompt, build_inline_prompt, clip_title_source,\n};',
      'use super::prompt::{\n    build_conversation_title_prompt, build_inline_prompt, clip_title_source,\n};',
    );
    src = replaceOnce(src, 'use tauri::{Emitter as _, Manager as _};', 'use tauri::Manager as _;');
    // 删 chat_stream + chat_stream_via_acp + emit_acp_stream_{frame,done,error}
    src = cutRange(src, 'pub async fn chat_stream(', 'pub async fn inline_complete(');
    // 删 collect_messages
    src = cutRange(
      src,
      'fn collect_messages(',
      '#[cfg(test)]\npub(super) fn with_identity_system_message(',
    );
    return src;
  },

  // ───────────────────── B) 拆 build_context_block(prompt) ─────────────────────
  'src-tauri/src/ai/gateway/prompt.rs': (src) => {
    const anchor = 'pub(super) fn build_context_block(references: &[AiContextReferencePayload]) -> String {';
    const i = src.indexOf(anchor);
    if (i < 0) throw new Error('prompt.rs build_context_block 锚点未命中');
    return src.slice(0, i).replace(/\n+$/, '\n');
  },

  // ───────────────────── B+F) mod.rs 级联清理 ─────────────────────
  'src-tauri/src/ai/gateway/mod.rs': (src) => {
    // 收紧契约 import:删 AiChatRequest / AiContextReferencePayload
    src = replaceOnce(
      src,
      'use crate::commands::contracts::{\n' +
        '    AiAgentClassifyTaskPayload, AiAgentClassifyTaskRequest, AiChatRequest, AiConfigPayload,\n' +
        '    AiContextReferencePayload, AiConversationTitlePayload, AiConversationTitleRequest,\n' +
        '    AiCredentialStatusPayload, AiInlineCompletionRangePayload, AiInlineCompletionRequest,\n' +
        '    AiInlineCompletionResult, AiModelEndpointConfigPayload, AiSuggestionPoolPayload,\n' +
        '    AiSuggestionPoolRequest,\n' +
        '};',
      'use crate::commands::contracts::{\n' +
        '    AiAgentClassifyTaskPayload, AiAgentClassifyTaskRequest, AiConfigPayload,\n' +
        '    AiConversationTitlePayload, AiConversationTitleRequest, AiCredentialStatusPayload,\n' +
        '    AiInlineCompletionRangePayload, AiInlineCompletionRequest, AiInlineCompletionResult,\n' +
        '    AiModelEndpointConfigPayload, AiSuggestionPoolPayload, AiSuggestionPoolRequest,\n' +
        '};',
    );
    // redact_text 仅 collect_messages 用,删 import
    src = replaceOnce(src, 'use super::security::redaction::redact_text;\n', '');
    // 原子序列仅 next_runtime_id 用,收紧 std::sync import
    src = replaceOnce(
      src,
      'use std::sync::{\n    Mutex, OnceLock,\n    atomic::{AtomicU64, Ordering},\n};',
      'use std::sync::{Mutex, OnceLock};',
    );
    // 重导出去掉 chat_stream
    src = replaceOnce(
      src,
      'pub use conversation::{chat_stream, classify_task, generate_conversation_title, inline_complete};',
      'pub use conversation::{classify_task, generate_conversation_title, inline_complete};',
    );
    // 重导出去掉未用的 ProviderConnectionOutcome
    src = replaceOnce(
      src,
      'pub use connection::{\n    ProviderConnectionOutcome, connect_provider, test_provider, test_provider_config,\n};',
      'pub use connection::{connect_provider, test_provider, test_provider_config};',
    );
    // 删仅 chat_stream/collect_messages/build_context_block 用的 5 个常量
    src = replaceOnce(
      src,
      'const MAX_AI_MESSAGES: usize = 32;\n' +
        'const MAX_MESSAGE_CHARS: usize = 16_000;\n' +
        'const MAX_CONTEXT_REFERENCES: usize = 8;\n' +
        'const MAX_CONTEXT_BLOCK_CHARS: usize = 12_000;\n' +
        'const MAX_REFERENCE_PREVIEW_CHARS: usize = 4_000;\n' +
        'const MAX_TITLE_SOURCE_CHARS: usize = 1_200;',
      'const MAX_TITLE_SOURCE_CHARS: usize = 1_200;',
    );
    // 删 STREAM_SEQUENCE 静态
    src = replaceOnce(src, 'static STREAM_SEQUENCE: AtomicU64 = AtomicU64::new(1);\n', '');
    // 删 AiChatStreamStart 结构体
    src = cutRange(src, 'pub struct AiChatStreamStart {', 'fn config_state()');
    // 删 next_runtime_id
    src = cutRange(src, 'fn next_runtime_id(prefix: &str) -> String {', 'fn sanitize_fenced_text(');
    return src;
  },

  // ───────────────── C+D) 命令层:删 ai_chat_stream + 修 ensure_session 三参 ─────────────────
  'src-tauri/src/commands/ai/gateway.rs': (src) => {
    src = replaceOnce(
      src,
      '    AiCancelRequest, AiChatRequest, AiChatStreamPayload, AiConfigPayload,',
      '    AiCancelRequest, AiConfigPayload,',
    );
    src = cutRange(
      src,
      '#[tauri::command]\n#[specta::specta]\npub async fn ai_chat_stream(',
      '#[tauri::command]\n#[specta::specta]\npub fn ai_cancel(',
    );
    src = replaceOnce(
      src,
      'host.ensure_session(thread_id, workspace_root_path)\n        .await',
      'host.ensure_session(thread_id, workspace_root_path, None)\n        .await',
    );
    return src;
  },

  // ───────────────── C) 绑定注册去掉 ai_chat_stream ─────────────────
  'src-tauri/src/tauri_bindings.rs': (src) =>
    replaceOnce(src, '            ai::gateway::ai_chat_stream,\n', ''),

  // ───────────────── F) terminal 未用 AtomicU32 ─────────────────
  'src-tauri/src/commands/terminal/commands.rs': (src) =>
    replaceOnce(
      src,
      'use std::{\n    sync::{\n        Arc,\n        atomic::AtomicU32,\n    },\n    time::{Duration, Instant},\n};',
      'use std::{\n    sync::Arc,\n    time::{Duration, Instant},\n};',
    ),

  // ───────────────── C) 前端 service 去掉 chatStream ─────────────────
  'src/services/ipc/ai.service.ts': (src) => {
    src = replaceOnce(src, '  AiChatStreamPayload,\n', '');
    src = replaceOnce(src, '  IAiChatRequest,\n', '');
    src = replaceOnce(
      src,
      '  chatStream(payload: IAiChatRequest): Promise<AiChatStreamPayload> {\n' +
        '    return tauriService.aiChatStream(payload);\n' +
        '  },\n',
      '',
    );
    return src;
  },
};

// ── 应用 + 写回(保留 EOL) ──
const applied = [];
for (const [rel, fn] of Object.entries(edits)) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error('文件不存在: ' + rel);
  const raw = readFileSync(abs, 'utf8');
  const eol = detectEol(raw);
  const next = fn(toLf(raw));
  writeFileSync(abs, fromLf(next, eol), 'utf8');
  applied.push(rel);
}

// ── 定义形式守卫(预防回归/误删) ──
const must = (rel, has, missing) => {
  const s = toLf(readFileSync(join(ROOT, rel), 'utf8'));
  for (const m of has) if (!s.includes(m)) throw new Error(`[守卫] ${rel} 应包含但缺失: ${m}`);
  for (const m of missing) if (s.includes(m)) throw new Error(`[守卫] ${rel} 应已删除但残留: ${m}`);
};
must('src-tauri/src/commands/contracts/builtin_agent.rs',
  ['pub struct AgentSidecarChatRequest {', 'pub struct AgentSidecarMessagePayload {',
   'use super::ai_chat::AiContextReferencePayload;'], []);
must('src-tauri/src/commands/contracts/ai_chat.rs',
  ['pub struct AiContextReferencePayload {', 'pub struct AiContextRangePayload {'],
  ['pub struct AiChatRequest {', 'pub struct AiChatStreamPayload {', 'pub struct AiChatMessagePayload {']);
must('src-tauri/src/ai/gateway/conversation.rs', [],
  ['fn chat_stream(', 'fn chat_stream_via_acp(', 'fn collect_messages(', 'Emitter as _']);
must('src-tauri/src/ai/gateway/prompt.rs', [], ['build_context_block']);
must('src-tauri/src/ai/gateway/mod.rs', ['pub use conversation::{classify_task,'],
  ['chat_stream', 'AiChatStreamStart', 'next_runtime_id', 'STREAM_SEQUENCE', 'ProviderConnectionOutcome']);
must('src-tauri/src/commands/ai/gateway.rs',
  ['host.ensure_session(thread_id, workspace_root_path, None)'], ['pub async fn ai_chat_stream(']);
must('src-tauri/src/tauri_bindings.rs', [], ['ai_chat_stream']);
must('src-tauri/src/commands/terminal/commands.rs', [], ['atomic::AtomicU32']);
must('src/services/ipc/ai.service.ts', [], ['chatStream(', 'aiChatStream']);

console.log('✅ 完成,已改写 ' + applied.length + ' 个文件:\n  - ' + applied.join('\n  - '));
console.log('\n下一步(建议先不带 -D warnings,让残留 dead_code 以告警呈现):');
console.log('  cargo clippy --features acp_client --manifest-path src-tauri/Cargo.toml --all-targets');
console.log('  cargo test --features acp_client --manifest-path src-tauri/Cargo.toml');