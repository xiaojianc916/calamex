// scripts/acp-slice-2b-ii.mjs
// ACP 切换 Slice 2b-ii：把主聊天 chat_stream 接入 ACP 宿主（feature = "acp_client"），
// 旧 HTTP 路径保留为 chat_stream_legacy（待 #7 删除）。取消按 thread_id 改路由到 AcpRuntime。
// 全程精确字符串替换 + 出现次数断言：任一锚点漂移即整体中止、绝不落盘。
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = process.cwd()

/** @type {{file: string, edits: {find: string, replace: string, count?: number}[]}[]} */
const tasks = [
	{
		file: "src-tauri/src/ai/gateway/conversation.rs",
		edits: [
			// 1a. 拆分 chat_stream 为 feature 分发器 + chat_stream_legacy
			{
				find: `pub async fn chat_stream(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamStart, String> {
    audit::emit(AiAuditEventKind::ChatStarted);`,
				replace: `pub async fn chat_stream(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamStart, String> {
    #[cfg(feature = "acp_client")]
    {
        chat_stream_via_acp(app, payload).await
    }
    #[cfg(not(feature = "acp_client"))]
    {
        chat_stream_legacy(app, payload).await
    }
}

#[cfg(not(feature = "acp_client"))]
async fn chat_stream_legacy(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamStart, String> {
    audit::emit(AiAuditEventKind::ChatStarted);`,
			},
			// 1b. legacy 返回补 session_id: None；其后追加 ACP 路径与三个 emit 辅助
			{
				find: `    Ok(AiChatStreamStart {
        stream_id,
        assistant_message_id,
        provider_type: response_provider_type,
        model,
    })
}

pub async fn inline_complete(`,
				replace: `    Ok(AiChatStreamStart {
        stream_id,
        assistant_message_id,
        provider_type: response_provider_type,
        model,
        session_id: None,
    })
}

#[cfg(feature = "acp_client")]
async fn chat_stream_via_acp(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamStart, String> {
    audit::emit(AiAuditEventKind::ChatStarted);

    let config = current_config()?;
    ensure_chat_enabled(&config)?;

    let stream_id = next_runtime_id("ai-stream");
    let assistant_message_id = next_runtime_id("assistant");
    let response_provider_type = config.provider_type.clone();

    let model = config
        .selected_model
        .clone()
        .or_else(|| default_model(&config.provider_type))
        .unwrap_or_else(|| DEFAULT_MASTRA_MODEL.to_string());

    let input_references = payload.references.clone();
    let messages = collect_messages(payload.messages, input_references.clone())?;
    let prompt = messages
        .into_iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content)
        .ok_or_else(|| errors::error("AI_RESPONSE_INVALID", "请输入要发送给 AI 的内容。"))?;

    let thread_id = payload.thread_id.clone().unwrap_or_default();

    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn(&app)
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("无法建立 ACP 宿主连接：{error}"),
            )
        })?;

    let session_id = host
        .ensure_session(&thread_id, None)
        .await
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("无法建立 ACP 会话：{error}"),
            )
        })?;
    let session_key = session_id.to_string();

    let task_app = app.clone();
    let task_session_key = session_key.clone();
    let task_context = input_references;

    tokio::spawn(async move {
        let turn = crate::acp::AcpChatTurn {
            session_id: Some(task_session_key.clone()),
            mode: Some("ask".to_string()),
            prompt,
            workspace_root_path: None,
            context: task_context,
        };

        match host.chat(turn).await {
            Ok(response) => {
                audit::emit(AiAuditEventKind::ChatCompleted);
                let result_text = response.result.clone().unwrap_or_default();
                let usage = response
                    .events
                    .iter()
                    .rev()
                    .find(|event| {
                        event.get("type").and_then(|value| value.as_str()) == Some("done")
                    })
                    .and_then(|event| event.get("usage").cloned())
                    .filter(|usage| !usage.is_null());
                emit_acp_stream_done(&task_app, &task_session_key, &result_text, usage);
            }
            Err(error) => {
                audit::emit(AiAuditEventKind::ChatFailed);
                emit_acp_stream_error(&task_app, &task_session_key, &error.to_string());
            }
        }
    });

    Ok(AiChatStreamStart {
        stream_id,
        assistant_message_id,
        provider_type: response_provider_type,
        model,
        session_id: Some(session_key),
    })
}

#[cfg(feature = "acp_client")]
fn emit_acp_stream_frame(app: &AppHandle, session_key: &str, event: serde_json::Value) {
    let frame = crate::acp::AcpStreamFrame {
        session_id: Some(session_key.to_string()),
        seq: 0,
        event,
    };
    if let Err(error) = app.emit(crate::acp::ACP_STREAM_EVENT, &frame) {
        log::warn!("failed to emit acp chat stream frame to webview: {error}");
    }
}

#[cfg(feature = "acp_client")]
fn emit_acp_stream_done(
    app: &AppHandle,
    session_key: &str,
    result_text: &str,
    usage: Option<serde_json::Value>,
) {
    emit_acp_stream_frame(
        app,
        session_key,
        crate::acp::build_done_ui_event(result_text, usage),
    );
}

#[cfg(feature = "acp_client")]
fn emit_acp_stream_error(app: &AppHandle, session_key: &str, message: &str) {
    emit_acp_stream_frame(app, session_key, crate::acp::build_error_ui_event(message));
}

pub async fn inline_complete(`,
			},
		],
	},
	{
		file: "src-tauri/src/acp/runtime.rs",
		edits: [
			// 2a. ACP_STREAM_EVENT 提升为 pub(crate)，供主聊天 ACP 路径复用同一常量
			{
				find: `/// 流式帧 webview 事件名：对齐 \`client::AcpStreamFrame\` 文档约定的 \`ai:sidecar-stream\` 契约。
const ACP_STREAM_EVENT: &str = "ai:sidecar-stream";`,
				replace: `/// 流式帧 webview 事件名：对齐 \`client::AcpStreamFrame\` 文档约定的 \`ai:sidecar-stream\` 契约。
pub(crate) const ACP_STREAM_EVENT: &str = "ai:sidecar-stream";`,
			},
			// 2b. 新增 cancel_thread：仅在宿主已建立时生效，绝不因取消而懒派生 node
			{
				find: `    /// 关停并释放常驻连接（App 统一退出清理调用）。幂等：未建立时为安全的空操作。
    pub fn shutdown(&self) {`,
				replace: `    /// 取消指定线程（thread_id）当前进行中的回合；仅在 ACP 宿主已建立时生效。
    ///
    /// 缺省（宿主尚未懒建立）时为安全的空操作：取消本身绝不应触发 node 子进程派生。
    pub fn cancel_thread(&self, thread_id: &str) {
        if let Some(host) = self
            .host
            .lock()
            .expect("acp runtime mutex poisoned")
            .as_ref()
        {
            host.cancel_thread(thread_id);
        }
    }

    /// 关停并释放常驻连接（App 统一退出清理调用）。幂等：未建立时为安全的空操作。
    pub fn shutdown(&self) {`,
			},
		],
	},
	{
		file: "src-tauri/src/acp/mod.rs",
		edits: [
			// 3. crate 内重导出 ACP_STREAM_EVENT，保持事件名单一来源
			{
				find: `// 进程级生命周期：把单一 AcpHost 作为 Tauri 托管状态持有（对齐 Zed 连接持有模型）。
#[allow(unused_imports)]
pub use runtime::AcpRuntime;`,
				replace: `// 进程级生命周期：把单一 AcpHost 作为 Tauri 托管状态持有（对齐 Zed 连接持有模型）。
#[allow(unused_imports)]
pub use runtime::AcpRuntime;

// 主聊天 ACP 路径复用「流式帧 webview 事件名」常量（runtime 内单一定义）。
#[allow(unused_imports)]
pub(crate) use runtime::ACP_STREAM_EVENT;`,
			},
		],
	},
	{
		file: "src-tauri/src/ai/gateway/mod.rs",
		edits: [
			// 4. AiChatStreamStart 增加 session_id，向上回传 ACP 会话标识
			{
				find: `pub struct AiChatStreamStart {
    pub stream_id: String,
    pub assistant_message_id: String,
    pub provider_type: String,
    pub model: String,
}`,
				replace: `pub struct AiChatStreamStart {
    pub stream_id: String,
    pub assistant_message_id: String,
    pub provider_type: String,
    pub model: String,
    pub session_id: Option<String>,
}`,
			},
		],
	},
	{
		file: "src-tauri/src/commands/contracts/ai_chat.rs",
		edits: [
			// 5a. 出参 AiChatStreamPayload 增加 sessionId（前端据此订阅 ai:sidecar-stream）
			{
				find: `pub struct AiChatStreamPayload {
    pub(crate) stream_id: String,
    pub(crate) assistant_message_id: String,
    pub(crate) provider_type: String,
    pub(crate) model: String,
}`,
				replace: `pub struct AiChatStreamPayload {
    pub(crate) stream_id: String,
    pub(crate) assistant_message_id: String,
    pub(crate) provider_type: String,
    pub(crate) model: String,
    pub(crate) session_id: Option<String>,
}`,
			},
			// 5b. 取消入参 AiCancelRequest 增加 threadId（serde Option 缺省即 None，无需 default）
			{
				find: `pub struct AiCancelRequest {
    pub(crate) stream_id: String,
}`,
				replace: `pub struct AiCancelRequest {
    pub(crate) stream_id: String,
    pub(crate) thread_id: Option<String>,
}`,
			},
		],
	},
	{
		file: "src-tauri/src/commands/ai/gateway.rs",
		edits: [
			// 6a. ai_chat_stream 透传 session_id
			{
				find: `        provider_type: started.provider_type,
        model: started.model,
    })
}`,
				replace: `        provider_type: started.provider_type,
        model: started.model,
        session_id: started.session_id,
    })
}`,
			},
			// 6b. ai_cancel 注入 AppHandle，acp_client 下按 thread_id 路由取消
			{
				find: `#[tauri::command]
#[specta::specta]
pub fn ai_cancel(payload: AiCancelRequest) -> Result<(), String> {
    let stream_id = payload.stream_id.trim();
    if stream_id.is_empty() {
        return Err("AI_REQUEST_CANCELLED: streamId 不能为空。".to_string());
    }
    stream_manager::cancel(stream_id);
    Ok(())
}`,
				replace: `#[tauri::command]
#[specta::specta]
pub fn ai_cancel(app: AppHandle, payload: AiCancelRequest) -> Result<(), String> {
    #[cfg(feature = "acp_client")]
    {
        if let Some(thread_id) = payload
            .thread_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            use tauri::Manager as _;
            app.state::<crate::acp::AcpRuntime>().cancel_thread(thread_id);
            return Ok(());
        }
    }
    #[cfg(not(feature = "acp_client"))]
    {
        let _ = &app;
    }

    let stream_id = payload.stream_id.trim();
    if stream_id.is_empty() {
        return Err("AI_REQUEST_CANCELLED: streamId 不能为空。".to_string());
    }
    stream_manager::cancel(stream_id);
    Ok(())
}`,
			},
		],
	},
]

function countOccurrences(haystack, needle) {
	let n = 0
	let idx = 0
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		n++
		idx += needle.length
	}
	return n
}

function applyEdit(content, edit, file, index) {
	// 把锚点与内容统一归一到 LF 比较，规避脚本/源码 CRLF 差异
	const find = edit.find.replace(/\r\n/g, "\n")
	const replace = edit.replace.replace(/\r\n/g, "\n")
	const expected = edit.count ?? 1
	const actual = countOccurrences(content, find)
	if (actual !== expected) {
		throw new Error(
			`[${file}] 第 ${index + 1} 处编辑锚点匹配 ${actual} 次，期望 ${expected} 次，已中止（未写入任何文件）。\n` +
				`--- 锚点（前 200 字符）---\n${find.slice(0, 200)}\n--------------------------`,
		)
	}
	return content.split(find).join(replace)
}

const outputs = []
for (const task of tasks) {
	const abs = resolve(ROOT, task.file)
	const raw = readFileSync(abs, "utf8")
	const eol = raw.includes("\r\n") ? "\r\n" : "\n"
	let content = raw.replace(/\r\n/g, "\n")
	task.edits.forEach((edit, i) => {
		content = applyEdit(content, edit, task.file, i)
	})
	const final = eol === "\n" ? content : content.replace(/\n/g, eol)
	outputs.push({ abs, file: task.file, content: final, eol })
}

// 走到这里说明全部 10 处编辑均匹配成功，统一落盘（原子性）
for (const out of outputs) {
	writeFileSync(out.abs, out.content, "utf8")
	console.log(`✓ patched ${out.file} (eol=${out.eol === "\r\n" ? "CRLF" : "LF"})`)
}
console.log("\n全部 6 个文件 / 10 处编辑已应用成功。")