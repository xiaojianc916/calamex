// r3-acp-evict-thread-backend.mjs
// 用法：node r3-acp-evict-thread-backend.mjs [--write]
// 作用：新增「删除对话即驱逐该线程 ACP 会话态」的后端能力，根治 AcpHost 三张按 thread/session
//       键的表（sessions / config_options_by_thread / available_commands_by_session）随会话数
//       单调增长的泄漏。host.evict_thread → runtime.evict_thread(广播) → ai_evict_thread 命令 + 注册。
import { readFileSync, writeFileSync } from "node:fs";

const WRITE = process.argv.includes("--write");
const HOST = "src-tauri/src/acp/host.rs";
const RUNTIME = "src-tauri/src/acp/runtime.rs";
const GATEWAY = "src-tauri/src/commands/ai/gateway.rs";
const BINDINGS = "src-tauri/src/tauri_bindings.rs";

const PLAN = {
	[HOST]: [
		{
			before: `    /// 请求优雅关停：清空挂起审批并令常驻连接任务结束（子进程随之回收）。
    pub fn shutdown(&self) {`,
			after: `    /// 驱逐某线程的全部会话态：从 \`thread_id ↔ SessionId\`、\`config_options_by_thread\`、
    /// \`available_commands_by_session\` 三张表移除该线程/会话条目。对齐 Zed「线程实体 drop 即释放其
    /// 连接与 per-thread 状态」——前端删除对话时经命令层调用，根治这三张按 thread/session 键的表随
    /// 会话数单调增长的泄漏。幂等：未绑定该线程时为安全空操作。删除≠取消回合，故不下发 session/cancel。
    pub fn evict_thread(&self, thread_id: &str) {
        let thread_key = thread_id.trim();
        if thread_key.is_empty() {
            return;
        }
        let removed_session = self.sessions.lock().remove(thread_key);
        self.config_options_by_thread.lock().remove(thread_key);
        if let Some(session_id) = removed_session {
            self.available_commands_by_session
                .lock()
                .remove(&session_id.to_string());
        }
    }

    /// 请求优雅关停：清空挂起审批并令常驻连接任务结束（子进程随之回收）。
    pub fn shutdown(&self) {`,
		},
	],
	[RUNTIME]: [
		{
			before: `    pub fn cancel_thread(&self, thread_id: &str) {
        // 先取出 Arc 列表并释放锁，避免在广播取消期间持有 runtime 锁。
        let hosts = self.hosts.lock().all();
        for host in hosts {
            host.cancel_thread(thread_id);
        }
    }`,
			after: `    pub fn cancel_thread(&self, thread_id: &str) {
        // 先取出 Arc 列表并释放锁，避免在广播取消期间持有 runtime 锁。
        let hosts = self.hosts.lock().all();
        for host in hosts {
            host.cancel_thread(thread_id);
        }
    }

    /// 驱逐某线程在全部**已建立**后端宿主上的会话态（thread↔session / config_options /
    /// available_commands）。前端删除对话时经命令层调用；线程绑定的会话可能落在任一后端，故广播。
    /// 缺省（无任何宿主）为安全空操作——驱逐绝不应触发 node 子进程派生。
    pub fn evict_thread(&self, thread_id: &str) {
        // 先取出 Arc 列表并释放锁，避免在广播期间持有 runtime 锁。
        let hosts = self.hosts.lock().all();
        for host in hosts {
            host.evict_thread(thread_id);
        }
    }`,
		},
	],
	[GATEWAY]: [
		{
			before: `#[tauri::command]
#[specta::specta]
pub fn ai_cancel(app: AppHandle, payload: AiCancelRequest) -> Result<(), String> {
    let thread_id = payload
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AI_REQUEST_CANCELLED: threadId 不能为空。".to_string())?;

    use tauri::Manager as _;
    app.state::<crate::acp::AcpRuntime>()
        .cancel_thread(thread_id);
    Ok(())
}`,
			after: `#[tauri::command]
#[specta::specta]
pub fn ai_cancel(app: AppHandle, payload: AiCancelRequest) -> Result<(), String> {
    let thread_id = payload
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AI_REQUEST_CANCELLED: threadId 不能为空。".to_string())?;

    use tauri::Manager as _;
    app.state::<crate::acp::AcpRuntime>()
        .cancel_thread(thread_id);
    Ok(())
}

/// 驱逐某线程的 ACP 会话态（删除对话时调用）：委托 AcpRuntime 向全部已建立宿主广播移除该线程的
/// thread↔session / config_options / available_commands 条目，根治这些按 thread/session 键的表随
/// 会话数单调增长的泄漏。threadId 空白视作无操作（对齐「删除本就不存在的对话」的良性调用）。
#[tauri::command]
#[specta::specta]
pub fn ai_evict_thread(app: AppHandle, thread_id: String) -> Result<(), String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Ok(());
    }
    use tauri::Manager as _;
    app.state::<crate::acp::AcpRuntime>().evict_thread(thread_id);
    Ok(())
}`,
		},
	],
	[BINDINGS]: [
		{
			before: `            ai::gateway::ai_cancel,`,
			after: `            ai::gateway::ai_cancel,
            ai::gateway::ai_evict_thread,`,
		},
	],
};

const files = {};
for (const path of Object.keys(PLAN)) {
	const raw = readFileSync(path, "utf8");
	files[path] = { isCRLF: raw.includes("\r\n"), src: raw.replace(/\r\n/g, "\n") };
}
if (files[HOST].src.includes("pub fn evict_thread") && files[BINDINGS].src.includes("ai::gateway::ai_evict_thread")) {
	console.log("[skip] 已应用过，幂等退出。");
	process.exit(0);
}
const errors = [];
for (const [path, hunks] of Object.entries(PLAN)) {
	for (const [i, h] of hunks.entries()) {
		const n = files[path].src.split(h.before).length - 1;
		if (n !== 1) errors.push(`${path} 第 ${i + 1} 个锚点命中 ${n} 次（需 1 次）`);
	}
}
if (errors.length) {
	console.error("[abort] 锚点核对失败，未写入任何文件：\n  - " + errors.join("\n  - "));
	process.exit(1);
}
for (const [path, hunks] of Object.entries(PLAN)) {
	let src = files[path].src;
	for (const h of hunks) src = src.split(h.before).join(h.after);
	files[path].out = files[path].isCRLF ? src.replace(/\n/g, "\r\n") : src;
}
if (WRITE) {
	for (const path of Object.keys(PLAN)) writeFileSync(path, files[path].out, "utf8");
	console.log("[written] host.rs + runtime.rs + gateway.rs + tauri_bindings.rs 已更新。请跑 cargo fmt → cargo clippy → cargo test。");
} else {
	console.log("[dry-run] 4 文件锚点各命中 1 次。加 --write 落盘。");
}