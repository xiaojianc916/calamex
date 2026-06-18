// D7-③-b-2-2 codemod: surface agent-advertised available session modes via a
// query command `ai_get_session_modes(thread_id) -> Option<JSON>`.
//
// Background: D7-③-b-2-1 already captures NewSessionResponse.modes into AcpHost
// state (host.session_modes(thread_id)). This slice exposes that read API end to
// end: a runtime accessor that broadcasts across backend hosts, an IPC contract
// (request + minimal-passthrough payload), a gateway command, and its binding
// registration. The modes JSON is forwarded verbatim (exported to TS as
// `unknown`, mirroring AgentSidecarResponsePayload.events) for the front-end ACL
// to interpret in ③-c. No fabricated stream event; the single ui_event
// projection point is untouched (available modes arrive in the NewSession
// response, not a session/update notification).
//
// Run from the repo root: `node scripts/acp-get-session-modes-command.mjs`.
// Then regenerate bindings (any cargo build/test that calls the specta export)
// and run the gate: `cargo clippy --all-targets -- -D warnings && cargo test`.
//
// Idempotent (per-file skipIf), CRLF-tolerant (normalize to LF for matching,
// restore original EOL on write). Each step requires exactly one anchor match.

import { readFileSync, writeFileSync } from 'node:fs'

const L = (...lines) => lines.join('\n')

const files = [
	{
		path: 'src-tauri/src/acp/runtime.rs',
		skipIf: 'pub fn session_modes',
		steps: [
			{
				find: L(
					'    /// 关停并释放全部后端的常驻连接（App 统一退出清理调用）。幂等：无宿主时为安全空操作。',
					'    pub fn shutdown(&self) {',
				),
				replace: L(
					'    /// 取某线程会话建立时 agent 公示的可用模式清单（ACP NewSessionResponse.modes 原样 JSON：',
					'    /// currentModeId + availableModes[]）。线程绑定的会话可能落在任一后端宿主，故向全部**已建立**',
					'    /// 宿主查询并返回首个命中（Some）。无任何宿主 / 无匹配线程 / agent 未公示模式时返回 None',
					'    /// （安全空操作——查询绝不应触发 node 子进程派生）。最小透传，宿主侧不重建 SDK 类型，交前端',
					'    /// ACL 解释（供 D7-③-c 模式选择器消费）。',
					'    pub fn session_modes(&self, thread_id: &str) -> Option<serde_json::Value> {',
					'        // 先取出 Arc 列表并释放锁，避免在逐宿主查询期间持有 runtime 锁。',
					'        let hosts = self.hosts.lock().all();',
					'        hosts',
					'            .into_iter()',
					'            .find_map(|host| host.session_modes(thread_id))',
					'    }',
					'',
					'    /// 关停并释放全部后端的常驻连接（App 统一退出清理调用）。幂等：无宿主时为安全空操作。',
					'    pub fn shutdown(&self) {',
				),
			},
			{
				find: L(
					'        let applied = tauri::async_runtime::block_on(runtime.set_session_mode("thread-1", "code"))',
					'            .expect("set_session_mode on empty runtime should not error");',
					'        assert!(!applied);',
					'        assert!(runtime.hosts.lock().all().is_empty());',
					'    }',
				),
				replace: L(
					'        let applied = tauri::async_runtime::block_on(runtime.set_session_mode("thread-1", "code"))',
					'            .expect("set_session_mode on empty runtime should not error");',
					'        assert!(!applied);',
					'        assert!(runtime.hosts.lock().all().is_empty());',
					'    }',
					'',
					'    #[test]',
					'    fn session_modes_on_unestablished_runtime_is_none() {',
					'        let runtime = AcpRuntime::default();',
					'        // 无任何宿主时，模式查询为安全空操作：返回 None 且绝不派生子进程。',
					'        assert!(runtime.session_modes("thread-1").is_none());',
					'        assert!(runtime.hosts.lock().all().is_empty());',
					'    }',
				),
			},
		],
	},
	{
		path: 'src-tauri/src/commands/contracts/ai_chat.rs',
		skipIf: 'AiGetSessionModesRequest',
		steps: [
			{
				find: L(
					'pub struct AiSetSessionModeRequest {',
					'    pub(crate) thread_id: String,',
					'    pub(crate) mode_id: String,',
					'}',
				),
				replace: L(
					'pub struct AiSetSessionModeRequest {',
					'    pub(crate) thread_id: String,',
					'    pub(crate) mode_id: String,',
					'}',
					'',
					'/// ACP 会话可用模式清单的查询请求（契约层）。',
					'///',
					'/// 对齐 acp::AcpRuntime::session_modes(thread_id)：thread_id 定位目标会话（宿主持有',
					'/// thread_id ↔ SessionId 映射，并在会话建立时登记 agent 公示的可用模式）。必填且非空（前端',
					'/// 总能从当前线程取得），空白校验由接线层负责。',
					'#[derive(Debug, Clone, Deserialize, Type)]',
					'#[serde(rename_all = "camelCase")]',
					'pub struct AiGetSessionModesRequest {',
					'    pub(crate) thread_id: String,',
					'}',
					'',
					'/// ACP 会话可用模式清单的响应载荷（契约层）。',
					'///',
					'/// modes 为 agent 在 NewSessionResponse 公示的可用模式清单原样 JSON（SessionModeState：',
					'/// currentModeId + availableModes[]）。最小透传，宿主侧不重建 SDK 类型，交前端 ACL 解释（对齐',
					'/// tool_call 的 acpUpdate 整体透传）。用 specta_typescript::Unknown 将导出 TS 映射为 unknown，',
					'/// 避开 serde_json::Number 的 i64/u64 触发 specta BigInt-forbidden（对齐',
					'/// AgentSidecarResponsePayload.events）；serde 运行时仍为 serde_json::Value，行为不变。',
					'#[derive(Debug, Clone, Serialize, Type)]',
					'#[serde(rename_all = "camelCase")]',
					'pub struct AiSessionModesPayload {',
					'    #[specta(type = specta_typescript::Unknown)]',
					'    pub(crate) modes: serde_json::Value,',
					'}',
				),
			},
		],
	},
	{
		path: 'src-tauri/src/commands/ai/gateway.rs',
		skipIf: 'ai_get_session_modes',
		steps: [
			{
				find: L(
					'use crate::commands::contracts::{',
					'    AiCancelRequest, AiChatRequest, AiChatStreamPayload, AiConfigPayload,',
					'    AiConversationTitlePayload, AiConversationTitleRequest, AiInlineCompletionRangePayload,',
					'    AiInlineCompletionRequest, AiInlineCompletionResult, AiProviderConnectionPayload,',
					'    AiProviderConnectionRequest, AiProviderTestPayload, AiResolveApprovalRequest,',
					'    AiSaveConfigRequest, AiSaveCredentialsRequest, AiSetSessionModeRequest,',
					'    AiSuggestionPoolPayload, AiSuggestionPoolRequest,',
					'};',
				),
				replace: L(
					'use crate::commands::contracts::{',
					'    AiCancelRequest, AiChatRequest, AiChatStreamPayload, AiConfigPayload,',
					'    AiConversationTitlePayload, AiConversationTitleRequest, AiGetSessionModesRequest,',
					'    AiInlineCompletionRangePayload, AiInlineCompletionRequest, AiInlineCompletionResult,',
					'    AiProviderConnectionPayload, AiProviderConnectionRequest, AiProviderTestPayload,',
					'    AiResolveApprovalRequest, AiSaveConfigRequest, AiSaveCredentialsRequest, AiSessionModesPayload,',
					'    AiSetSessionModeRequest, AiSuggestionPoolPayload, AiSuggestionPoolRequest,',
					'};',
				),
			},
			{
				find: L(
					'    let applied = app',
					'        .state::<crate::acp::AcpRuntime>()',
					'        .set_session_mode(thread_id, mode_id)',
					'        .await',
					'        .map_err(|error| format!("AI_SET_SESSION_MODE_FAILED: {error}"))?;',
					'    Ok(applied)',
					'}',
					'',
					'#[tauri::command]',
					'#[specta::specta]',
					'pub async fn ai_inline_complete(',
				),
				replace: L(
					'    let applied = app',
					'        .state::<crate::acp::AcpRuntime>()',
					'        .set_session_mode(thread_id, mode_id)',
					'        .await',
					'        .map_err(|error| format!("AI_SET_SESSION_MODE_FAILED: {error}"))?;',
					'    Ok(applied)',
					'}',
					'',
					'/// 取某线程会话建立时 agent 公示的可用模式清单（ACP session/new 的 NewSessionResponse.modes',
					'/// 原样 JSON：currentModeId + availableModes[]），供前端模式选择器在会话建立后填充候选模式。',
					'///',
					'/// 与 ai_set_session_mode 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主对命令层',
					'/// 透明，由 runtime 向全部已建立宿主查询并返回首个命中。thread_id 先行空白校验；返回 None 表示',
					'/// 尚无该线程会话或 agent 未公示模式（前端据此隐藏选择器）。modes 为最小透传的原样 JSON（导出',
					'/// TS 为 unknown），交前端 ACL 解释（对齐 acpUpdate 整体透传）。',
					'#[tauri::command]',
					'#[specta::specta]',
					'pub fn ai_get_session_modes(',
					'    app: AppHandle,',
					'    payload: AiGetSessionModesRequest,',
					') -> Result<Option<AiSessionModesPayload>, String> {',
					'    let thread_id = payload.thread_id.trim();',
					'    if thread_id.is_empty() {',
					'        return Err("AI_GET_SESSION_MODES_INVALID: threadId 不能为空。".to_string());',
					'    }',
					'',
					'    use tauri::Manager as _;',
					'    let modes = app',
					'        .state::<crate::acp::AcpRuntime>()',
					'        .session_modes(thread_id)',
					'        .map(|modes| AiSessionModesPayload { modes });',
					'    Ok(modes)',
					'}',
					'',
					'#[tauri::command]',
					'#[specta::specta]',
					'pub async fn ai_inline_complete(',
				),
			},
		],
	},
	{
		path: 'src-tauri/src/tauri_bindings.rs',
		skipIf: 'ai_get_session_modes',
		steps: [
			{
				find: L(
					'            ai::gateway::ai_set_session_mode,',
					'            ai::gateway::ai_inline_complete,',
				),
				replace: L(
					'            ai::gateway::ai_set_session_mode,',
					'            ai::gateway::ai_get_session_modes,',
					'            ai::gateway::ai_inline_complete,',
				),
			},
		],
	},
]

let changed = 0
for (const file of files) {
	const raw = readFileSync(file.path, 'utf8')
	const isCrlf = raw.includes('\r\n')
	let work = raw.split('\r\n').join('\n')
	if (work.includes(file.skipIf)) {
		console.log(`skip ${file.path} (already applied)`)
		continue
	}
	file.steps.forEach((step, i) => {
		const count = work.split(step.find).length - 1
		if (count !== 1) {
			throw new Error(
				`expected exactly 1 anchor in ${file.path} (step ${i + 1}), found ${count}`,
			)
		}
		work = work.replace(step.find, () => step.replace)
	})
	const out = isCrlf ? work.split('\n').join('\r\n') : work
	writeFileSync(file.path, out, 'utf8')
	console.log(`patched ${file.path}`)
	changed++
}
console.log(`done: ${changed} file(s) patched`)
