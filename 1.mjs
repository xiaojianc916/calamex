// 1.mjs — ④ Slice B-rust：删除 Rust 侧 session/set_mode 全链路（零兼容层）
// 链路：client.rs → host.rs → runtime.rs → gateway.rs → tauri_bindings.rs
//        + contracts/ai_chat.rs + 生成绑定 src/bindings/tauri.ts
// 唯一标准管线 = session/set_config_option（config_option_update 事件通道）
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const ROOT = process.cwd()
const toLf = (s) => s.replace(/\r\n/g, "\n")
const t = (...lines) => lines.join("\n")

function replaceOnce(c, oldStr, newStr, label) {
	const i = c.indexOf(oldStr)
	if (i === -1) throw new Error("[中止] 锚点未找到:" + label)
	if (c.indexOf(oldStr, i + oldStr.length) !== -1)
		throw new Error("[中止] 锚点不唯一:" + label)
	return c.slice(0, i) + newStr + c.slice(i + oldStr.length)
}
const present = (c, tok, label) => {
	if (!c.includes(tok)) throw new Error("[中止] 自检失败(应保留):" + label + " · " + tok)
}
const absent = (c, tok, label) => {
	if (c.includes(tok)) throw new Error("[中止] 自检失败(应删除):" + label + " · " + tok)
}

// ───────────────────────────── 1) src-tauri/src/acp/client.rs ─────────────────────────────
function editClientRs(c) {
	// 1a 导入：去 SessionModeId / SetSessionModeRequest
	c = replaceOnce(c,
		t("    SessionConfigOptionValue, SessionConfigValueId, SessionId, SessionModeId, SessionNotification,",
		  "    SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason,"),
		t("    SessionConfigOptionValue, SessionConfigValueId, SessionId, SessionNotification,",
		  "    SetSessionConfigOptionRequest, StopReason,"),
		"client.rs/导入")
	// 1b NewSessionOutcome：去 modes 字段 + 重写 doc
	c = replaceOnce(c,
		t("/// `new_session` 的结果：会话标识 + 可选的可用模式清单。",
		  "///",
		  "/// `modes` 为 ACP `NewSessionResponse.modes`（`SessionModeState`：`currentModeId` +",
		  "/// `availableModes[]`）的原样 JSON——最小透传，宿主侧不重建 SDK 类型，交前端 ACL 解释",
		  "/// （对齐 tool_call 的 `acpUpdate` 整体透传）。`None` 表示 agent 未公示会话模式。",
		  "pub struct NewSessionOutcome {",
		  "    pub session_id: SessionId,",
		  "    pub modes: Option<Value>,",
		  "    /// ACP `NewSessionResponse.config_options`（`SessionConfigOption[]`：每项含",
		  "    /// `id`/`name`/`kind`/`currentValue` 等）的原样 JSON——与 `modes` 同构、最小透传，",
		  "    /// 交前端 ACL 解释。这是「模型/思考强度/模式等」可切换配置项的目录来源,对任意公示",
		  "    /// configOptions 的 agent 通用；默认选中项即 agent 在 currentValue 中回填的当前模型。",
		  "    /// `None` 表示 agent 未公示会话级配置项。",
		  "    pub config_options: Option<Value>,",
		  "}"),
		t("/// `new_session` 的结果：会话标识 + 可选的可用配置项清单。",
		  "pub struct NewSessionOutcome {",
		  "    pub session_id: SessionId,",
		  "    /// ACP `NewSessionResponse.config_options`（`SessionConfigOption[]`：每项含",
		  "    /// `id`/`name`/`kind`/`currentValue` 等）的原样 JSON——最小透传，宿主侧不重建 SDK",
		  "    /// 类型，交前端 ACL 解释。这是「模型/思考强度/模式等」可切换配置项的目录来源,对任意",
		  "    /// 公示 configOptions 的 agent 通用；默认选中项即 agent 在 currentValue 中回填的当前",
		  "    /// 模型。`None` 表示 agent 未公示会话级配置项。",
		  "    pub config_options: Option<Value>,",
		  "}"),
		"client.rs/NewSessionOutcome")
	// 1c 枚举变体 Command::SetSessionMode
	c = replaceOnce(c,
		t("    SetSessionMode {",
		  "        session_id: SessionId,",
		  "        mode_id: SessionModeId,",
		  "        reply: oneshot::Sender<Result<(), String>>,",
		  "    },",
		  "    SetSessionConfigOption {"),
		"    SetSessionConfigOption {",
		"client.rs/Command枚举")
	// 1d 句柄方法 set_session_mode
	c = replaceOnce(c,
		t("    pub async fn set_session_mode(",
		  "        &self,",
		  "        session_id: SessionId,",
		  "        mode_id: SessionModeId,",
		  "    ) -> Result<(), AcpClientError> {",
		  "        let (reply, rx) = oneshot::channel();",
		  "        self.cmd_tx",
		  "            .send(Command::SetSessionMode {",
		  "                session_id,",
		  "                mode_id,",
		  "                reply,",
		  "            })",
		  "            .map_err(|_| AcpClientError::NotRunning)?;",
		  "        rx.await",
		  "            .map_err(|_| AcpClientError::NotRunning)?",
		  "            .map_err(AcpClientError::Protocol)",
		  "    }",
		  "",
		  "    /// 设置一个会话级配置项（ACP `session/set_config_option`）。"),
		"    /// 设置一个会话级配置项（ACP `session/set_config_option`）。",
		"client.rs/句柄set_session_mode")
	// 1e NewSession 匹配臂：去 modes 行 + 改注释
	c = replaceOnce(c,
		t("                            // 最小透传：把 NewSessionResponse.modes（可用模式清单）原样序列化为",
		  "                            // JSON 一并回传（null → None），宿主侧据 thread_id 登记，供模式选择器消费。",
		  "                            let outcome = res.map(|r| NewSessionOutcome {",
		  "                                session_id: r.session_id,",
		  "                                modes: serde_json::to_value(&r.modes).ok().filter(|v| !v.is_null()),",
		  "                                config_options: serde_json::to_value(&r.config_options)",
		  "                                    .ok()",
		  "                                    .filter(|v| !v.is_null()),",
		  "                            });"),
		t("                            // 最小透传：把 NewSessionResponse.config_options（可用配置项清单）原样",
		  "                            // 序列化为 JSON 一并回传（null → None），宿主侧据 thread_id 登记，供配置项选择器消费。",
		  "                            let outcome = res.map(|r| NewSessionOutcome {",
		  "                                session_id: r.session_id,",
		  "                                config_options: serde_json::to_value(&r.config_options)",
		  "                                    .ok()",
		  "                                    .filter(|v| !v.is_null()),",
		  "                            });"),
		"client.rs/NewSession匹配臂")
	// 1f 命令循环臂 Command::SetSessionMode
	c = replaceOnce(c,
		t("                        Command::SetSessionMode {",
		  "                            session_id,",
		  "                            mode_id,",
		  "                            reply,",
		  "                        } => {",
		  "                            let res = cx",
		  "                                .send_request(SetSessionModeRequest::new(session_id, mode_id))",
		  "                                .block_task()",
		  "                                .await;",
		  "                            let _ = reply.send(res.map(|_| ()).map_err(|e| e.to_string()));",
		  "                        }",
		  "                        Command::SetSessionConfigOption {"),
		"                        Command::SetSessionConfigOption {",
		"client.rs/循环臂SetSessionMode")
	absent(c, "SessionModeId", "client.rs")
	absent(c, "SetSessionMode", "client.rs")
	absent(c, "pub modes:", "client.rs")
	present(c, "SetSessionConfigOption", "client.rs")
	present(c, "config_options: serde_json::to_value", "client.rs")
	return c
}

// ───────────────────────────── 2) src-tauri/src/acp/host.rs ─────────────────────────────
function editHostRs(c) {
	// 2a 导入
	c = replaceOnce(c,
		t("use agent_client_protocol::schema::{",
		  "    ContentBlock, SessionId, SessionModeId, StopReason, ToolCallId,",
		  "};"),
		"use agent_client_protocol::schema::{ContentBlock, SessionId, StopReason, ToolCallId};",
		"host.rs/导入")
	// 2b 模块 doc bullet
	c = replaceOnce(c,
		t("//!   * `client`   —— 常驻 stdio 连接 + 命令句柄（new_session / prompt /",
		  "//!     set_session_mode / restore_checkpoint / model_chat / web_search / web_fetch /",
		  "//!     warmup / health / cancel / shutdown）；"),
		t("//!   * `client`   —— 常驻 stdio 连接 + 命令句柄（new_session / prompt /",
		  "//!     restore_checkpoint / model_chat / web_search / web_fetch /",
		  "//!     warmup / health / cancel / shutdown）；"),
		"host.rs/模块doc")
	// 2c 结构体 modes_by_thread 字段 + config_options_by_thread doc
	c = replaceOnce(c,
		t("    /// `thread_id ↔ 会话建立时 agent 公示的可用模式清单`（ACP `NewSessionResponse.modes`",
		  "    /// 原样 JSON：`currentModeId` + `availableModes[]`）。最小透传，宿主侧不重建 SDK 类型。",
		  "    modes_by_thread: Arc<Mutex<HashMap<String, serde_json::Value>>>,",
		  "    /// thread_id 到「会话建立时 agent 公示的可用配置项清单」的映射（ACP",
		  "    /// NewSessionResponse.config_options 原样 JSON：Vec SessionConfigOption）。",
		  "    /// 最小透传，宿主侧不重建 SDK 类型，与 modes_by_thread 同构。",
		  "    config_options_by_thread: Arc<Mutex<HashMap<String, serde_json::Value>>>,"),
		t("    /// thread_id 到「会话建立时 agent 公示的可用配置项清单」的映射（ACP",
		  "    /// NewSessionResponse.config_options 原样 JSON：Vec SessionConfigOption）。",
		  "    /// 最小透传，宿主侧不重建 SDK 类型。",
		  "    config_options_by_thread: Arc<Mutex<HashMap<String, serde_json::Value>>>,"),
		"host.rs/字段modes_by_thread")
	// 2c-2 available_commands_by_session doc 去 modes_by_thread 引用
	c = replaceOnce(c,
		t("    /// 命令面板恒空。sink 无条件按 ACP 会话 id 缓存，回合发起时以前端键重放，使面板稳定填充（与",
		  "    /// modes_by_thread / config_options_by_thread 的会话级缓存同构）。"),
		t("    /// 命令面板恒空。sink 无条件按 ACP 会话 id 缓存，回合发起时以前端键重放，使面板稳定填充（与",
		  "    /// config_options_by_thread 的会话级缓存同构）。"),
		"host.rs/available_commands doc")
	// 2d spawn 构造器
	c = replaceOnce(c,
		t("            sessions: Arc::new(Mutex::new(HashMap::new())),",
		  "            modes_by_thread: Arc::new(Mutex::new(HashMap::new())),",
		  "            config_options_by_thread: Arc::new(Mutex::new(HashMap::new())),"),
		t("            sessions: Arc::new(Mutex::new(HashMap::new())),",
		  "            config_options_by_thread: Arc::new(Mutex::new(HashMap::new())),"),
		"host.rs/spawn构造器")
	// 2e ensure_session 日志
	c = replaceOnce(c,
		t("        // 诊断：打印 agent 在 session/new 公示的可切换项（含模型 / 模式 / 配置项），用于确认外部 agent",
		  "        // （如 Kimi）是否通过 ACP modes / config_options 暴露模型切换——决定走哪条通道还是兑底。",
		  "        log::info!(",
		  '            target: "acp",',
		  '            "ACP session/new 完成（thread={thread_id}）：session_id={session_id}，agent 公示 modes={:?}，config_options={:?}",',
		  "            outcome.modes,",
		  "            outcome.config_options",
		  "        );"),
		t("        // 诊断：打印 agent 在 session/new 公示的可切换配置项，用于确认外部 agent（如 Kimi）",
		  "        // 是否通过 ACP config_options 暴露模型切换——决定走哪条通道还是兑底。",
		  "        log::info!(",
		  '            target: "acp",',
		  '            "ACP session/new 完成（thread={thread_id}）：session_id={session_id}，agent 公示 config_options={:?}",',
		  "            outcome.config_options",
		  "        );"),
		"host.rs/ensure_session日志")
	// 2f 登记块
	c = replaceOnce(c,
		t("            // 仅在 agent 公示了模式时登记；缺省不占位（保持 None 语义）。",
		  "            if let Some(modes) = outcome.modes {",
		  "                self.modes_by_thread",
		  "                    .lock()",
		  "                    .insert(thread_key.to_string(), modes);",
		  "            }",
		  "            // 与 modes 同构：仅在 agent 公示了配置项时登记；缺省不占位（保持 None 语义）。",
		  "            if let Some(config_options) = outcome.config_options {"),
		t("            // 仅在 agent 公示了配置项时登记；缺省不占位（保持 None 语义）。",
		  "            if let Some(config_options) = outcome.config_options {"),
		"host.rs/登记块")
	// 2g 方法 set_session_mode + session_modes
	c = replaceOnce(c,
		t("    /// 切换指定线程当前 ACP 会话的模式（标准 session/set_mode 请求）。",
		  "    ///",
		  "    /// 仅在本宿主已绑定该 thread_id 的会话时执行：命中则下发 session/set_mode 并返回",
		  "    /// Ok(true)；未绑定（空 thread / 无映射）则返回 Ok(false) 作为安全空操作，交由 runtime",
		  "    /// 广播给真正持有该线程的后端宿主。绝不在此 ensure_session 新建会话——模式切换只对既有",
		  "    /// 会话有意义（对齐 cancel_thread 的「无会话即空操作」语义）。纯转发，不修改本地状态。",
		  "    pub async fn set_session_mode(",
		  "        &self,",
		  "        thread_id: &str,",
		  "        mode_id: &str,",
		  "    ) -> Result<bool, AcpClientError> {",
		  "        let thread_key = thread_id.trim();",
		  "        if thread_key.is_empty() {",
		  "            return Ok(false);",
		  "        }",
		  "        let session_id = self.sessions.lock().get(thread_key).cloned();",
		  "        let Some(session_id) = session_id else {",
		  "            return Ok(false);",
		  "        };",
		  "        self.handle",
		  "            .set_session_mode(session_id, SessionModeId::from(mode_id.to_string()))",
		  "            .await?;",
		  "        Ok(true)",
		  "    }",
		  "",
		  "    /// 取某线程会话建立时 agent 公示的可用模式清单（ACP `NewSessionResponse.modes` 原样",
		  "    /// JSON：`currentModeId` + `availableModes[]`）。未绑定会话 / agent 未公示模式时为 `None`。",
		  "    /// 最小透传：宿主侧不重建 SDK 类型，交前端 ACL 解释（供 D7-③-c 模式选择器消费）。",
		  "    pub fn session_modes(&self, thread_id: &str) -> Option<serde_json::Value> {",
		  "        let thread_key = thread_id.trim();",
		  "        if thread_key.is_empty() {",
		  "            return None;",
		  "        }",
		  "        self.modes_by_thread.lock().get(thread_key).cloned()",
		  "    }",
		  ""),
		"",
		"host.rs/方法set_session_mode+session_modes")
	// 2h set_session_config_option doc 去 set_session_mode 引用
	c = replaceOnce(c,
		"    /// 与 set_session_mode 同构：仅在本宿主已绑定该 thread_id 的会话时执行——命中则下发",
		"    /// 仅在本宿主已绑定该 thread_id 的会话时执行——命中则下发",
		"host.rs/set_config_option doc")
	// 2i session_config_options doc 去 session_modes 引用
	c = replaceOnce(c,
		"    /// 最小透传：宿主侧不重建 SDK 类型，交前端 ACL 解释。与 session_modes 同构。",
		"    /// 最小透传：宿主侧不重建 SDK 类型，交前端 ACL 解释。",
		"host.rs/session_config_options doc")
	absent(c, "modes_by_thread", "host.rs")
	absent(c, "SessionModeId", "host.rs")
	absent(c, "set_session_mode", "host.rs")
	absent(c, "session_modes", "host.rs")
	present(c, "config_options_by_thread", "host.rs")
	present(c, "set_session_config_option", "host.rs")
	present(c, "session_config_options", "host.rs")
	return c
}

// ───────────────────────────── 3) src-tauri/src/acp/ui_event.rs ─────────────────────────────
function editUiEventRs(c) {
	// 3a 投影函数 current_mode_update_ui_event
	c = replaceOnce(c,
		t("/// 构造会话当前模式变更 `TAgentUiEvent`（`type` 为 `current_mode_update`）。",
		  "///",
		  "/// 投影 ACP `current_mode_update`（外部 agent 在回合中自行切换模式时下发新的 currentModeId）：",
		  "/// 仅透传 `currentModeId`（可为 null），交前端回灌模式选择器高亮（见 src/types/ai/sidecar.ts 的",
		  "/// TAgentUiEventCurrentModeUpdate 与 from-acp-session-modes.ts）。",
		  'fn current_mode_update_ui_event(current_mode_id: &Value) -> Value {',
		  '    json!({ "type": "current_mode_update", "currentModeId": current_mode_id.clone() })',
		  "}",
		  "",
		  "/// 构造会话配置项变更 `TAgentUiEvent`（`type` 为 `config_option_update`）。"),
		"/// 构造会话配置项变更 `TAgentUiEvent`（`type` 为 `config_option_update`）。",
		"ui_event.rs/投影函数")
	// 3b 匹配臂
	c = replaceOnce(c,
		t("        // 外部 agent 在回合中自行切换模式（标准 current_mode_update）：透传 currentModeId，",
		  "        // 交前端回灌模式选择器高亮（session/set_mode 协议）。",
		  '        "current_mode_update" => {',
		  '            let current_mode_id = update.get("currentModeId")?;',
		  "            Some(current_mode_update_ui_event(current_mode_id))",
		  "        }",
		  "        // 外部 agent 公示/更新本会话可配置项（标准 config_option_update，模型选择器即走此通道）："),
		"        // 外部 agent 公示/更新本会话可配置项（标准 config_option_update，模型选择器即走此通道）：",
		"ui_event.rs/匹配臂")
	// 3c 两个测试
	c = replaceOnce(c,
		t("    #[test]",
		  "    fn current_mode_update_passes_through_current_mode_id() {",
		  "        let n = notif(json!({",
		  '            "sessionUpdate": "current_mode_update",',
		  '            "currentModeId": "agent"',
		  "        }));",
		  "        let ui = session_notification_to_ui_event(n).unwrap();",
		  '        assert_eq!(ui["type"], "current_mode_update");',
		  '        assert_eq!(ui["currentModeId"], "agent");',
		  "    }",
		  "",
		  "    #[test]",
		  "    fn current_mode_update_without_field_yields_none() {",
		  '        let n = notif(json!({ "sessionUpdate": "current_mode_update" }));',
		  "        assert!(session_notification_to_ui_event(n).is_none());",
		  "    }",
		  "",
		  "    #[test]",
		  "    fn config_option_update_passes_through_raw_config_options() {"),
		t("    #[test]",
		  "    fn config_option_update_passes_through_raw_config_options() {"),
		"ui_event.rs/测试")
	absent(c, "current_mode_update", "ui_event.rs")
	present(c, "config_option_update", "ui_event.rs")
	return c
}

// ───────────────────────────── 4) src-tauri/src/acp/runtime.rs ─────────────────────────────
function editRuntimeRs(c) {
	// R-a set_session_config_option doc
	c = replaceOnce(c,
		"    /// 至多一个宿主持有该线程，故某宿主下发失败即整体失败。与 set_session_mode 同构。",
		"    /// 至多一个宿主持有该线程，故某宿主下发失败即整体失败。",
		"runtime.rs/set_config_option doc")
	// R-b session_config_options doc
	c = replaceOnce(c,
		"    /// 无任何宿主 / 无匹配线程 / agent 未公示配置项时返回 None。最小透传。与 session_modes 同构。",
		"    /// 无任何宿主 / 无匹配线程 / agent 未公示配置项时返回 None。最小透传。",
		"runtime.rs/session_config_options doc")
	// R-c 方法 set_session_mode + session_modes
	c = replaceOnce(c,
		t("    /// 切换指定线程当前 ACP 会话的模式（标准 session/set_mode），令外部 agent（Kimi Code /",
		  "    /// Codex 等）在 agent 公示的模式（如 Auto / Plan / …）间真实切换。线程绑定的会话可能落在",
		  "    /// 任一后端宿主，故向全部已建立宿主广播下发：命中即记为已应用并返回 true。无任何宿主 /",
		  "    /// 无匹配线程时返回 Ok(false)（安全空操作——模式切换绝不应触发子进程派生）。至多一个宿主",
		  "    /// 持有该线程，故某宿主下发失败即整体失败。与 set_session_config_option 同构。",
		  "    pub async fn set_session_mode(",
		  "        &self,",
		  "        thread_id: &str,",
		  "        mode_id: &str,",
		  "    ) -> Result<bool, AcpClientError> {",
		  "        // 先取出 Arc 列表并释放锁，避免在广播下发（跨 await）期间持有 runtime 锁。",
		  "        let hosts = self.hosts.lock().all();",
		  "        let mut applied = false;",
		  "        for host in hosts {",
		  "            if host.set_session_mode(thread_id, mode_id).await? {",
		  "                applied = true;",
		  "            }",
		  "        }",
		  "        Ok(applied)",
		  "    }",
		  "",
		  "    /// 取某线程会话建立时 agent 公示的可用模式清单（ACP NewSessionResponse.modes 原样 JSON：",
		  "    /// SessionModeState = currentModeId + availableModes[]）。线程绑定的会话可能落在任一后端",
		  "    /// 宿主，故向全部已建立宿主查询并返回首个命中。无任何宿主 / 无匹配线程 / agent 未公示模式时",
		  "    /// 返回 None。最小透传。与 session_config_options 同构。",
		  "    pub fn session_modes(&self, thread_id: &str) -> Option<serde_json::Value> {",
		  "        // 先取出 Arc 列表并释放锁，避免在逐宿主查询期间持有 runtime 锁。",
		  "        let hosts = self.hosts.lock().all();",
		  "        hosts",
		  "            .into_iter()",
		  "            .find_map(|host| host.session_modes(thread_id))",
		  "    }",
		  "",
		  "    /// 关停并释放全部后端的常驻连接（App 统一退出清理调用）。幂等：无宿主时为安全空操作。",
		  "    pub fn shutdown(&self) {"),
		t("    /// 关停并释放全部后端的常驻连接（App 统一退出清理调用）。幂等：无宿主时为安全空操作。",
		  "    pub fn shutdown(&self) {"),
		"runtime.rs/方法set_session_mode+session_modes")
	// R-d 两个测试
	c = replaceOnce(c,
		t("    #[test]",
		  "    fn set_session_mode_on_unestablished_runtime_is_noop() {",
		  "        let runtime = AcpRuntime::default();",
		  "        // 无任何宿主时，模式切换为安全空操作：返回 Ok(false) 且绝不派生子进程。",
		  '        let applied = tauri::async_runtime::block_on(runtime.set_session_mode("thread-1", "auto"))',
		  '            .expect("set_session_mode on empty runtime should not error");',
		  "        assert!(!applied);",
		  "        assert!(runtime.hosts.lock().all().is_empty());",
		  "    }",
		  "",
		  "    #[test]",
		  "    fn session_modes_on_unestablished_runtime_is_none() {",
		  "        let runtime = AcpRuntime::default();",
		  "        // 无任何宿主时，模式查询为安全空操作：返回 None 且绝不派生子进程。",
		  '        assert!(runtime.session_modes("thread-1").is_none());',
		  "        assert!(runtime.hosts.lock().all().is_empty());",
		  "    }",
		  "",
		  "    #[test]",
		  "    fn webview_event_names_match_documented_contract() {"),
		t("    #[test]",
		  "    fn webview_event_names_match_documented_contract() {"),
		"runtime.rs/测试")
	absent(c, "set_session_mode", "runtime.rs")
	absent(c, "session_modes", "runtime.rs")
	present(c, "set_session_config_option", "runtime.rs")
	present(c, "session_config_options", "runtime.rs")
	return c
}

// ───────────────────────────── 5) src-tauri/src/commands/ai/gateway.rs ─────────────────────────────
function editGatewayRs(c) {
	// 5a 导入
	c = replaceOnce(c,
		t("use crate::commands::contracts::{",
		  "    AiCancelRequest, AiConfigPayload,",
		  "    AiConversationTitlePayload, AiConversationTitleRequest, AiEnsureAcpSessionRequest,",
		  "    AiGetSessionModesRequest, AiInlineCompletionRangePayload, AiInlineCompletionRequest,",
		  "    AiInlineCompletionResult, AiProviderConnectionPayload, AiProviderConnectionRequest,",
		  "    AiProviderTestPayload, AiResolveApprovalRequest, AiSaveConfigRequest, AiSaveCredentialsRequest,",
		  "    AiSetSeededModelsRequest, AiSessionConfigOptionsPayload, AiSessionModesPayload,",
		  "    AiSetSessionConfigOptionRequest, AiSetSessionModeRequest, AiSuggestionPoolPayload,",
		  "    AiSuggestionPoolRequest,",
		  "};"),
		t("use crate::commands::contracts::{",
		  "    AiCancelRequest, AiConfigPayload,",
		  "    AiConversationTitlePayload, AiConversationTitleRequest, AiEnsureAcpSessionRequest,",
		  "    AiInlineCompletionRangePayload, AiInlineCompletionRequest,",
		  "    AiInlineCompletionResult, AiProviderConnectionPayload, AiProviderConnectionRequest,",
		  "    AiProviderTestPayload, AiResolveApprovalRequest, AiSaveConfigRequest, AiSaveCredentialsRequest,",
		  "    AiSetSeededModelsRequest, AiSessionConfigOptionsPayload,",
		  "    AiSetSessionConfigOptionRequest, AiSuggestionPoolPayload,",
		  "    AiSuggestionPoolRequest,",
		  "};"),
		"gateway.rs/导入")
	// 5b set_session_config_option doc 引用
	c = replaceOnce(c,
		"/// 与 ai_set_session_mode 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主对命令层",
		"/// 与 ai_resolve_approval 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主对命令层",
		"gateway.rs/set_config_option doc")
	// 5c 两个命令 fn
	c = replaceOnce(c,
		t("/// 切换 ACP 会话的当前模式（标准 session/set_mode），令外部 agent（Kimi Code / Codex 等）在",
		  "/// agent 公示的模式（如 Auto / Plan / …）间真实切换。当 Agent 为 Kimi 时，前端模式选择器直接",
		  "/// 驱动此命令，复用 Kimi 自身的模式切换语义，绝不本地伪造。",
		  "///",
		  "/// 与 ai_set_session_config_option 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主",
		  "/// 对命令层透明，由 runtime 向全部已建立宿主广播下发。两字段先行空白校验；返回是否命中某已绑定",
		  "/// 会话——false 表示无匹配（多为会话尚未建立/已结束的良性竞态，命令层不视作错误）。",
		  "#[tauri::command]",
		  "#[specta::specta]",
		  "pub async fn ai_set_session_mode(",
		  "    app: AppHandle,",
		  "    payload: AiSetSessionModeRequest,",
		  ") -> Result<bool, String> {",
		  "    let thread_id = payload.thread_id.trim();",
		  "    if thread_id.is_empty() {",
		  '        return Err("AI_SET_SESSION_MODE_INVALID: threadId 不能为空。".to_string());',
		  "    }",
		  "    let mode_id = payload.mode_id.trim();",
		  "    if mode_id.is_empty() {",
		  '        return Err("AI_SET_SESSION_MODE_INVALID: modeId 不能为空。".to_string());',
		  "    }",
		  "",
		  "    use tauri::Manager as _;",
		  "    let applied = app",
		  "        .state::<crate::acp::AcpRuntime>()",
		  "        .set_session_mode(thread_id, mode_id)",
		  "        .await",
		  '        .map_err(|error| format!("AI_SET_SESSION_MODE_FAILED: {error}"))?;',
		  "    Ok(applied)",
		  "}",
		  "",
		  "/// 取某线程会话建立时 agent 公示的可用模式清单（ACP session/new 的 NewSessionResponse.modes",
		  "/// 原样 JSON：SessionModeState = currentModeId + availableModes[]），供前端模式选择器在会话建立",
		  "/// 后填充候选项并高亮当前模式（默认即 agent 公示的 currentModeId，如 Kimi 的 Auto）。",
		  "///",
		  "/// 与 ai_get_session_config_options 同构地委托给 Tauri 托管的 AcpRuntime：由 runtime 向全部已",
		  "/// 建立宿主查询并返回首个命中。thread_id 先行空白校验；返回 None 表示尚无该线程会话或 agent 未",
		  "/// 公示模式（前端据此回退内置模式）。modes 为最小透传的原样 JSON（导出 TS 为 unknown）。",
		  "#[tauri::command]",
		  "#[specta::specta]",
		  "pub fn ai_get_session_modes(",
		  "    app: AppHandle,",
		  "    payload: AiGetSessionModesRequest,",
		  ") -> Result<Option<AiSessionModesPayload>, String> {",
		  "    let thread_id = payload.thread_id.trim();",
		  "    if thread_id.is_empty() {",
		  '        return Err("AI_GET_SESSION_MODES_INVALID: threadId 不能为空。".to_string());',
		  "    }",
		  "",
		  "    use tauri::Manager as _;",
		  "    let modes = app",
		  "        .state::<crate::acp::AcpRuntime>()",
		  "        .session_modes(thread_id)",
		  "        .map(|modes| AiSessionModesPayload { modes });",
		  "    Ok(modes)",
		  "}",
		  "",
		  "#[tauri::command]",
		  "#[specta::specta]",
		  "pub async fn ai_inline_complete("),
		t("#[tauri::command]",
		  "#[specta::specta]",
		  "pub async fn ai_inline_complete("),
		"gateway.rs/命令fn")
	absent(c, "ai_set_session_mode", "gateway.rs")
	absent(c, "ai_get_session_modes", "gateway.rs")
	absent(c, "AiSetSessionModeRequest", "gateway.rs")
	absent(c, "AiGetSessionModesRequest", "gateway.rs")
	absent(c, "AiSessionModesPayload", "gateway.rs")
	present(c, "ai_set_session_config_option", "gateway.rs")
	present(c, "ai_ensure_acp_session", "gateway.rs")
	return c
}

// ───────────────────────────── 6) src-tauri/src/tauri_bindings.rs ─────────────────────────────
function editTauriBindingsRs(c) {
	c = replaceOnce(c,
		t("            ai::gateway::ai_ensure_acp_session,",
		  "            ai::gateway::ai_set_session_mode,",
		  "            ai::gateway::ai_get_session_modes,",
		  "            ai::gateway::ai_inline_complete,"),
		t("            ai::gateway::ai_ensure_acp_session,",
		  "            ai::gateway::ai_inline_complete,"),
		"tauri_bindings.rs/collect_commands")
	absent(c, "ai_set_session_mode", "tauri_bindings.rs")
	absent(c, "ai_get_session_modes", "tauri_bindings.rs")
	present(c, "ai_set_session_config_option", "tauri_bindings.rs")
	return c
}

// ───────────────────────────── 7) src-tauri/src/commands/contracts/ai_chat.rs ─────────────────────────────
function editAiChatRs(c) {
	// 6b AiSessionConfigOptionsPayload doc 去 AiSessionModesPayload 引用
	c = replaceOnce(c,
		"/// 不重建 SDK 类型，交前端 ACL 解释（对齐 AiSessionModesPayload.modes 的整体透传）。用",
		"/// 不重建 SDK 类型，交前端 ACL 解释（最小透传整体 JSON）。用",
		"ai_chat.rs/ConfigOptionsPayload doc")
	// 6a 三个结构体
	c = replaceOnce(c,
		t("/// ACP 标准 session/set_mode 的会话级模式切换请求（契约层）。",
		  "///",
		  "/// 对齐 acp::AcpRuntime::set_session_mode(thread_id, mode_id)：",
		  "///   * thread_id —— 定位目标会话（宿主持有 thread_id ↔ SessionId 映射，跨回合复用）；",
		  "///   * mode_id —— 目标模式的 ACP SessionModeId 原值，逐字透传，绝不本地映射。",
		  "///",
		  "/// 二者均必填且非空（前端总能从已渲染的模式选择器取得），空白校验由接线层负责。",
		  "/// 与 AiSetSessionConfigOptionRequest 同构。",
		  '#[derive(Debug, Clone, Deserialize, Type)]',
		  '#[serde(rename_all = "camelCase")]',
		  "pub struct AiSetSessionModeRequest {",
		  "    pub(crate) thread_id: String,",
		  "    pub(crate) mode_id: String,",
		  "}",
		  "",
		  "/// ACP 会话可用模式清单的查询请求（契约层）。",
		  "///",
		  "/// 对齐 acp::AcpRuntime::session_modes(thread_id)：thread_id 定位目标会话（宿主持有 thread_id",
		  "/// ↔ SessionId 映射，并在会话建立时登记 agent 公示的可用模式）。必填且非空，空白校验由接线层",
		  "/// 负责。与 AiGetSessionConfigOptionsRequest 同构。",
		  '#[derive(Debug, Clone, Deserialize, Type)]',
		  '#[serde(rename_all = "camelCase")]',
		  "pub struct AiGetSessionModesRequest {",
		  "    pub(crate) thread_id: String,",
		  "}",
		  "",
		  "/// ACP 会话可用模式清单的响应载荷（契约层）。",
		  "///",
		  "/// modes 为 agent 在 NewSessionResponse 公示的可用模式清单原样 JSON（SessionModeState：",
		  "/// currentModeId + availableModes[]）。最小透传，宿主侧不重建 SDK 类型，交前端 ACL 解释。用",
		  "/// specta_typescript::Unknown 将导出 TS 映射为 unknown，避开 serde_json::Number 触发 specta",
		  "/// BigInt-forbidden；serde 运行时仍为 serde_json::Value，行为不变。与 AiSessionConfigOptionsPayload",
		  "/// 同构。",
		  '#[derive(Debug, Clone, Serialize, Type)]',
		  '#[serde(rename_all = "camelCase")]',
		  "pub struct AiSessionModesPayload {",
		  "    #[specta(type = specta_typescript::Unknown)]",
		  "    pub(crate) modes: serde_json::Value,",
		  "}",
		  "",
		  "// ============================================================================",
		  "// AI – inline completion"),
		t("// ============================================================================",
		  "// AI – inline completion"),
		"ai_chat.rs/三结构体")
	absent(c, "AiSetSessionModeRequest", "ai_chat.rs")
	absent(c, "AiGetSessionModesRequest", "ai_chat.rs")
	absent(c, "AiSessionModesPayload", "ai_chat.rs")
	absent(c, "SessionMode", "ai_chat.rs")
	present(c, "AiSessionConfigOptionsPayload", "ai_chat.rs")
	present(c, "AiSetSessionConfigOptionRequest", "ai_chat.rs")
	return c
}

// ───────────────────────────── 8) src/bindings/tauri.ts（生成绑定，手改＝specta 重生成结果）─────────────────────────────
function editBindingsTs(c) {
	// 7a aiSetSessionConfigOption JSDoc 引用
	c = replaceOnce(c,
		"\t *  与 ai_set_session_mode 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主对命令层",
		"\t *  与 ai_resolve_approval 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主对命令层",
		"tauri.ts/setConfigOption JSDoc")
	// 7b 两个命令 fn
	c = replaceOnce(c,
		t("\t/**",
		  "\t *  切换 ACP 会话的当前模式（标准 session/set_mode），令外部 agent（Kimi Code / Codex 等）在",
		  "\t *  agent 公示的模式（如 Auto / Plan / …）间真实切换。当 Agent 为 Kimi 时，前端模式选择器直接",
		  "\t *  驱动此命令，复用 Kimi 自身的模式切换语义，绝不本地伪造。",
		  "\t * ",
		  "\t *  与 ai_set_session_config_option 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主",
		  "\t *  对命令层透明，由 runtime 向全部已建立宿主广播下发。两字段先行空白校验；返回是否命中某已绑定",
		  "\t *  会话——false 表示无匹配（多为会话尚未建立/已结束的良性竞态，命令层不视作错误）。",
		  "\t */",
		  '\taiSetSessionMode: (payload: AiSetSessionModeRequest) => __TAURI_INVOKE<boolean>("ai_set_session_mode", { payload }),',
		  "\t/**",
		  "\t *  取某线程会话建立时 agent 公示的可用模式清单（ACP session/new 的 NewSessionResponse.modes",
		  "\t *  原样 JSON：SessionModeState = currentModeId + availableModes[]），供前端模式选择器在会话建立",
		  "\t *  后填充候选项并高亮当前模式（默认即 agent 公示的 currentModeId，如 Kimi 的 Auto）。",
		  "\t * ",
		  "\t *  与 ai_get_session_config_options 同构地委托给 Tauri 托管的 AcpRuntime：由 runtime 向全部已",
		  "\t *  建立宿主查询并返回首个命中。thread_id 先行空白校验；返回 None 表示尚无该线程会话或 agent 未",
		  "\t *  公示模式（前端据此回退内置模式）。modes 为最小透传的原样 JSON（导出 TS 为 unknown）。",
		  "\t */",
		  "\taiGetSessionModes: (payload: AiGetSessionModesRequest) => __TAURI_INVOKE<{",
		  "\tmodes: unknown,",
		  '} | null>("ai_get_session_modes", { payload }),',
		  '\taiInlineComplete: (payload: AiInlineCompletionRequest) => __TAURI_INVOKE<AiInlineCompletionResult>("ai_inline_complete", { payload }),'),
		'\taiInlineComplete: (payload: AiInlineCompletionRequest) => __TAURI_INVOKE<AiInlineCompletionResult>("ai_inline_complete", { payload }),',
		"tauri.ts/命令fn")
	// 7c AiGetSessionModesRequest 类型
	c = replaceOnce(c,
		t("/**",
		  " *  ACP 会话可用模式清单的查询请求（契约层）。",
		  " * ",
		  " *  对齐 acp::AcpRuntime::session_modes(thread_id)：thread_id 定位目标会话（宿主持有 thread_id",
		  " *  ↔ SessionId 映射，并在会话建立时登记 agent 公示的可用模式）。必填且非空，空白校验由接线层",
		  " *  负责。与 AiGetSessionConfigOptionsRequest 同构。",
		  " */",
		  "export type AiGetSessionModesRequest = {",
		  "\tthreadId: string,",
		  "};",
		  "",
		  "export type AiInlineCompletionRangePayload = {"),
		"export type AiInlineCompletionRangePayload = {",
		"tauri.ts/AiGetSessionModesRequest")
	// 7d AiSessionConfigOptionsPayload 类型 doc 引用
	c = replaceOnce(c,
		" *  不重建 SDK 类型，交前端 ACL 解释（对齐 AiSessionModesPayload.modes 的整体透传）。用",
		" *  不重建 SDK 类型，交前端 ACL 解释（最小透传整体 JSON）。用",
		"tauri.ts/ConfigOptionsPayload doc")
			// ============================================================
	// 7e · 删除 AiSessionModesPayload 响应载荷类型（config_options 为唯一标准管线）
	// ============================================================
	c = replaceOnce(
		c,
		t(
			"/**",
			" *  ACP 会话可用模式清单的响应载荷（契约层）。",
			" * ",
			" *  modes 为 agent 在 NewSessionResponse 公示的可用模式清单原样 JSON（SessionModeState：",
			" *  currentModeId + availableModes[]）。最小透传，宿主侧不重建 SDK 类型，交前端 ACL 解释。用",
			" *  specta_typescript::Unknown 将导出 TS 映射为 unknown，避开 serde_json::Number 触发 specta",
			" *  BigInt-forbidden；serde 运行时仍为 serde_json::Value，行为不变。与 AiSessionConfigOptionsPayload",
			" *  同构。",
			" */",
			"export type AiSessionModesPayload = {",
			"\tmodes: unknown,",
			"};",
			"",
			"",
		),
		"",
		"tauri.ts/删 AiSessionModesPayload 类型",
	)

	// ============================================================
	// 7f · 删除 AiSetSessionModeRequest 契约类型
	// ============================================================
	c = replaceOnce(
		c,
		t(
			"/**",
			" *  ACP 标准 session/set_mode 的会话级模式切换请求（契约层）。",
			" * ",
			" *  对齐 acp::AcpRuntime::set_session_mode(thread_id, mode_id)：",
			" *    * thread_id —— 定位目标会话（宿主持有 thread_id ↔ SessionId 映射，跨回合复用）；",
			" *    * mode_id —— 目标模式的 ACP SessionModeId 原值，逐字透传，绝不本地映射。",
			" * ",
			" *  二者均必填且非空（前端总能从已渲染的模式选择器取得），空白校验由接线层负责。",
			" *  与 AiSetSessionConfigOptionRequest 同构。",
			" */",
			"export type AiSetSessionModeRequest = {",
			"\tthreadId: string,",
			"\tmodeId: string,",
			"};",
			"",
			"",
		),
		"",
		"tauri.ts/删 AiSetSessionModeRequest 类型",
	)

	// —— tauri.ts 文件级自检：模式命令/契约类型彻底消失，配置项命令仍在 ——
	for (const tok of [
		"aiSetSessionMode",
		"aiGetSessionModes",
		"AiSetSessionModeRequest",
		"AiGetSessionModesRequest",
		"AiSessionModesPayload",
	]) {
		absent(c, tok, "tauri.ts")
	}
	present(c, "aiSetSessionConfigOption", "tauri.ts")

	return c
}

// ============================================================
// 驱动：读 → 改 → 各文件自检 → 全局残留扫描 → 全绿才落盘（LF）
// ============================================================
// 顶部 import 需含：
//   import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
//   import { join, relative, sep } from "node:path"

const REPO_ROOT = process.cwd()
const SRC_TAURI = join(REPO_ROOT, "src-tauri", "src")

// 8 个目标文件 ↔ 上半段定义的编辑函数（函数名若与你的命名不同，按你的替换）
const TARGETS = [
	{ rel: "src-tauri/src/acp/client.rs", edit: editClientRs },
	{ rel: "src-tauri/src/acp/host.rs", edit: editHostRs },
	{ rel: "src-tauri/src/acp/ui_event.rs", edit: editUiEventRs },
	{ rel: "src-tauri/src/acp/runtime.rs", edit: editRuntimeRs },
	{ rel: "src-tauri/src/commands/ai/gateway.rs", edit: editGatewayRs },
	{ rel: "src-tauri/src/commands/contracts/ai_chat.rs", edit: editAiChatRs },
	{ rel: "src-tauri/src/tauri_bindings.rs", edit: editTauriBindingsRs },
	{ rel: "src/bindings/tauri.ts", edit: editBindingsTs },
]

// 全链路禁词（子串匹配）；B-builtin 的 builtin-agent/** 不在本片扫描范围
const FORBIDDEN = [
	"session_mode",
	"session/set_mode",
	"SessionMode",
	"current_mode_update",
	"modes_by_thread",
]

// 1) 读 + 改 + 文件级自检（编辑函数内部 replaceOnce/自检自带 throw），改后内容先留内存
const transformed = new Map()
for (const { rel, edit } of TARGETS) {
	const abs = join(REPO_ROOT, rel)
	const original = toLf(readFileSync(abs, "utf8"))
	const next = edit(original)
	if (next === original) {
		throw new Error(`[中止] 空改动:${rel} · 锚点已失效或文件已处理`)
	}
	transformed.set(rel, next)
}

// 2) 全局残留扫描：src-tauri/src/** 全部 .rs + src/bindings/tauri.ts
//    已编辑文件用「改后内容」覆盖比对，未编辑文件读盘原文
function walkRs(dir) {
	const out = []
	for (const name of readdirSync(dir)) {
		const abs = join(dir, name)
		const st = statSync(abs)
		if (st.isDirectory()) out.push(...walkRs(abs))
		else if (name.endsWith(".rs")) out.push(abs)
	}
	return out
}

const scanAbsList = [
	...walkRs(SRC_TAURI),
	join(REPO_ROOT, "src", "bindings", "tauri.ts"),
]

const residual = []
for (const abs of scanAbsList) {
	const rel = relative(REPO_ROOT, abs).split(sep).join("/")
	const text = transformed.has(rel)
		? transformed.get(rel)
		: toLf(readFileSync(abs, "utf8"))
	text.split("\n").forEach((line, i) => {
		for (const tok of FORBIDDEN) {
			if (line.includes(tok)) {
				residual.push(`${rel}:${i + 1} · ${tok} · ${line.trim()}`)
				break
			}
		}
	})
}

if (residual.length > 0) {
	throw new Error(
		"[中止] 仍有 session/set_mode 残留（未写盘）：\n" + residual.join("\n"),
	)
}

// 3) 全绿 → 落盘（统一 LF）
for (const { rel } of TARGETS) {
	writeFileSync(join(REPO_ROOT, rel), transformed.get(rel), "utf8")
}

console.log(`✓ B-rust 完成：已删除 Rust 侧 session/set_mode 全链路，写盘 ${TARGETS.length} 个文件`)
for (const { rel } of TARGETS) console.log("  - " + rel)