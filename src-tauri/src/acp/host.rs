//! 宿主侧 ACP 编排核心（Layer 4）。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中按 cargo feature
//! `acp_client` 门控的新增模块，落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! 把同目录两层装配成单一编排面，对齐 sidecar 自身的 ACP Agent（见
//! `builtin-agent/src/acp/agent.ts`）与 Zed `agent_ui/acp_thread.rs` 的回合模型，
//! 不自创协议语义：
//!   * `client`   —— 常驻 stdio 连接 + 命令句柄（new_session / prompt /
//!     restore_checkpoint / model_chat / web_search / web_fetch /
//!     warmup / health / cancel / shutdown）；
//!   * `approval` —— 回合内反向 `session/request_permission` 的挂起登记表。
//!
//! 设计要点（均据一手源码核对，不臆造）：
//!   * **会话即线程**：对齐 Zed `session_id = thread.id()`——前端传稳定 `thread_id`，
//!     宿主持有 `thread_id ↔ SessionId` 映射并跨回合复用同一 ACP 会话
//!     （`ensure_session`）。
//!   * **模型配置不入 prompt**：模型凭据由 sidecar 进程环境变量在启动期解析。
//!   * **审批即回合内挂起**：危险工具经反向 `session/request_permission` 在回合内
//!     挂起，`resolve_approval` 经登记表唤醒同一回合续跑。
//!   * **流式即转发**：单一 `EventSink` 把每条 `session/update` 帧原样转发给接线层的
//!     emit（`runtime::stream_emitter`）；帧 → 前端 `TAgentUiEvent` 的投影由该 emit
//!     单点负责（见 `ui_event`），本层不投影。权威结果由各扩展方法的返回信封承载。
//!
//! 外部 ACP 编码 agent（Kimi Code / Codex 等，见 ADR-0015）走的是标准回合 `prompt`
//! 而非上述带外扩展方法：它们不认识 `calamex.dev/*`，只实现标准 session/prompt；
//! 过程增量全部经 `session/update` 帧由 `EventSink` 转发（投影见 `ui_event`）。

// 过渡期：本模块部分薄宿主方法（web_search / web_fetch / restore_checkpoint 等）尚未
// 全部接线到宿主命令，crate 外暂无调用点；接线后移除该 allow。
#![allow(dead_code)]

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::{ContentBlock, SessionId, StopReason, ToolCallId};

use crate::commands::contracts::{
    AgentSidecarHealthPayload, AgentSidecarResponsePayload,
    AgentSidecarWarmupPayload, AiWebFetchPayload, AiWebSearchPayload,
};

use super::approval::{ApprovalError, ApprovalRegistry, ApprovalRequestInfo};
use super::client::{
    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, CheckpointRestoreRequest,
    EventSink, HealthExtRequest, ModelChatExtRequest, WarmupExtRequest, WebFetchExtRequest,
    WebSearchExtRequest, spawn_acp_client,
};

/// 流式帧下沉口：把每条 `session/update` 帧转发给 webview（对齐 `ai:sidecar-stream`
/// 的 `{sessionId, seq, event}` 契约）。由宿主接线层提供 emit 闭包。
pub type StreamEmitter = Arc<dyn Fn(AcpStreamFrame) + Send + Sync>;

/// 待决审批下沉口：把回合内挂起的权限请求详情推给 webview 渲染审批 UI。
/// 由宿主接线层提供 emit 闭包；其回传决策经 `resolve_approval` 唤醒回合。
pub type ApprovalEmitter = Arc<dyn Fn(ApprovalRequestInfo) + Send + Sync>;

/// 宿主侧 ACP 编排句柄。可作为 Tauri 托管状态长驻：内部协作件均为
/// 可克隆/共享句柄，整体 `Send + Sync`。
pub struct AcpHost {
    handle: AcpClientHandle,
    approvals: ApprovalRegistry,
    /// `thread_id ↔ ACP SessionId` 映射（对齐 Zed `session_id = thread.id()`）。
    sessions: Arc<Mutex<HashMap<String, SessionId>>>,
    /// thread_id 到「会话建立时 agent 公示的可用配置项清单」的映射（ACP
    /// NewSessionResponse.config_options 原样 JSON：Vec SessionConfigOption）。
    /// 最小透传，宿主侧不重建 SDK 类型。
    config_options_by_thread: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    /// ACP 会话 id ↔ 前端流式关联键 的重写表（仅外部 agent 标准 prompt 回合用）。
    /// 外部 agent 发出的 session/update 帧以 ACP 会话 UUID 标记，而前端按预生成的
    /// sidecar:assistantMessageId 键过滤订阅；prompt_with_stream_key 在回合期间登记
    /// 「acp_session_id → 前端键」，sink 据此把外部帧的 session_id 重写为前端键后再下发，
    /// 回合结束即移除。无登记时 sink 原样透传（内置边车帧自带前端键，不命中重写表，行为不变）。
    stream_key_overrides: Arc<Mutex<HashMap<String, String>>>,
    /// ACP 会话 id ↔ 该会话最近一次 available_commands_update 的 availableCommands 原始数组。
    /// Kimi 等外部 agent 在 session/new 后经 setTimeout(0) 一次性下发可用斜杠命令（见 kimi-code
    /// packages/acp-adapter/src/server.ts scheduleAvailableCommandsUpdate），该 one-shot 早于/竞争
    /// 本回合 stream_key 重写登记、且会话复用后不再重发，仅靠回合内自然转发会被前端按键过滤丢弃 →
    /// 命令面板恒空。sink 无条件按 ACP 会话 id 缓存，回合发起时以前端键重放，使面板稳定填充（与
    /// config_options_by_thread 的会话级缓存同构）。
    available_commands_by_session: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    /// 流式帧下沉口克隆：供回合发起时主动以前端键重放缓存的可用命令（sink 内重写表只在帧自然到达
    /// 时生效，重放是宿主侧主动构造帧，故宿主直接持 emit）。
    emit: StreamEmitter,
}

impl AcpHost {
    /// 启动常驻 ACP 连接并装配编排面。
    pub fn spawn(
        config: AcpClientConfig,
        emit: StreamEmitter,
        on_approval: ApprovalEmitter,
    ) -> Result<Self, AcpClientError> {
        let approvals = ApprovalRegistry::new();
        let resolver = approvals.resolver(on_approval);

        // 外部 agent 帧重写表：sink 在转发前依此把「ACP 会话 UUID」标记重写为前端预生成键。
        let stream_key_overrides = Arc::new(Mutex::new(HashMap::new()));
        let overrides_for_sink = stream_key_overrides.clone();

        // 外部 agent 一次性下发的可用斜杠命令缓存（按 ACP 会话 id）：sink 无条件捕获，回合发起时重放。
        let available_commands_by_session: Arc<Mutex<HashMap<String, serde_json::Value>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let commands_cache_for_sink = available_commands_by_session.clone();

        // emit 克隆留给宿主侧主动重放（sink 内的重写表只在帧自然到达时生效）。
        let emit_for_host = emit.clone();

        // 单一下沉口：把每条 session/update 帧转发给 emit 闭包，但在转发前按 stream_key_overrides
        // 重写外部 agent 帧的 session_id（ACP UUID → 前端预生成键）。仅当该帧的 ACP 会话 id 命中
        // 重写表才改写（外部 prompt 回合期间登记），否则原样透传——内置边车帧自带前端键、不命中
        // 重写表，行为不变。其余投影语义同前：帧 → 前端 TAgentUiEvent 的投影由接线层的 emit
        // （runtime::stream_emitter）统一负责，本层不得再投影；终态 done/error 不走 session/update，
        // 由 chat_stream 经 app.emit 直接合成补发。
        let sink: EventSink = Arc::new(move |mut frame: AcpStreamFrame| {
            // 先按「原始 ACP 会话 id」捕获外部 agent 一次性下发的 available_commands_update，缓存供
            // 回合发起时以前端键重放（取键须在重写 session_id 之前，键须为 ACP 会话 UUID）；以 as_deref
            // 借用避免每帧对 session_id 的冗余克隆。配置项发现不在此通道：统一以 session/new 响应快照
            // 为唯一来源，回合内的 config_option_update 经标准转发投影由前端消费。
            if let Some(acp_session_id) = frame.session_id.as_deref()
                && let Some(commands) = extract_available_commands_update(&frame.event)
            {
                commands_cache_for_sink
                    .lock()
                    .insert(acp_session_id.to_string(), commands);
            }

            let remapped_stream_key = frame
                .session_id
                .as_deref()
                .and_then(|acp_session_id| overrides_for_sink.lock().get(acp_session_id).cloned());
            if let Some(stream_key) = remapped_stream_key {
                frame.session_id = Some(stream_key);
            }
            emit(frame)
        });

        let handle = spawn_acp_client(config, sink, resolver)?;
        Ok(Self {
            handle,
            approvals,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            config_options_by_thread: Arc::new(Mutex::new(HashMap::new())),
            stream_key_overrides,
            available_commands_by_session,
            emit: emit_for_host,
        })
    }

    /// 解析某 thread 对应的 ACP 会话（`thread_id ↔ SessionId`，贴 Zed 做法）：
    /// 命中映射则跨回合复用既有 `SessionId`；否则按工作区根新建会话并登记。
    pub async fn ensure_session(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        meta: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<SessionId, AcpClientError> {
        let thread_key = thread_id.trim();
        if !thread_key.is_empty()
            && let Some(existing) = self.sessions.lock().get(thread_key).cloned()
        {
            return Ok(existing);
        }

        let cwd = workspace_cwd(workspace_root_path);
        // meta 仅在「新建会话」分支被消费（命中复用分支已提前返回）：仅 builtin 命令层会携带
        // session/new 的 _meta 模型目录（含凭据 + 当前选中项），外部 agent 与内部复用回合传 None。
        let outcome = self.handle.new_session(cwd, meta).await?;
        let session_id = outcome.session_id;
        // 诊断：打印 agent 在 session/new 公示的可切换配置项，用于确认外部 agent（如 Kimi）
        // 是否通过 ACP config_options 暴露模型切换——决定走哪条通道还是兑底。
        log::info!(
            target: "acp",
            "ACP session/new 完成（thread={thread_id}）：session_id={session_id}，agent 公示 config_options={:?}",
            outcome.config_options
        );
        if !thread_key.is_empty() {
            self.sessions
                .lock()
                .insert(thread_key.to_string(), session_id.clone());
            // 仅在 agent 公示了配置项时登记；缺省不占位（保持 None 语义）。
            if let Some(config_options) = outcome.config_options {
                self.config_options_by_thread
                    .lock()
                    .insert(thread_key.to_string(), config_options);
            }
        }
        Ok(session_id)
    }

    /// 驱动一轮**标准 ACP 回合**（`session/prompt`）：解析/复用 thread 的会话后，把内容块
    /// 直接交给标准 `prompt`，返回回合终止原因 `StopReason`。
    ///
    /// 与带外的 `agent_chat`（自家 sidecar 扩展方法）不同，本方法走的是
    /// ACP 标准回合通道，供**外部 ACP 编码 agent**（Kimi Code / Codex 等，见 ADR-0015）使用——
    /// 它们不认识 `calamex.dev/*` 扩展方法，只实现标准 `prompt`。过程增量（文本/思考/工具
    /// 调用/计划等）经 `session/update` 帧由 `EventSink` 转发（投影见 `ui_event`），本方法仅
    /// 返回终态原因，不承载富信封（外部 agent 无自家信封）。
    pub async fn prompt(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        blocks: Vec<ContentBlock>,
    ) -> Result<StopReason, AcpClientError> {
        self.prompt_with_stream_key(thread_id, workspace_root_path, blocks, None)
            .await
    }

    /// 同 prompt，但额外接受前端预生成的「流式关联键」用于帧重写（外部 ACP agent 专用）。
    ///
    /// 背景：外部 agent 发出的 session/update 帧以 ACP 会话 UUID 标记，而前端在回合发起前只知道
    /// 自造的 sidecar:assistantMessageId 键并据此订阅过滤。若不重写，整轮 live 帧会被前端丢弃、
    /// 退化为末尾一次性渲染。
    ///
    /// 实现：解析/复用会话拿到 ACP 会话 id 后，若调用方提供了非空且不等于 ACP id 的 stream_key，
    /// 就在重写表登记「acp_session_id → stream_key」（sink 据此重写外部帧的 session_id），跑完
    /// prompt 后立即移除该登记（无论成败），把重写作用域严格限定在本回合。stream_key 为 None /
    /// 空白 / 恰等于 ACP id 时不登记，sink 原样透传（行为同旧 prompt）。
    pub async fn prompt_with_stream_key(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        blocks: Vec<ContentBlock>,
        stream_key: Option<&str>,
    ) -> Result<StopReason, AcpClientError> {
        // 标准回合复用命令层首次建立的会话（含 builtin 经 _meta 下发的模型目录），此处不再下发
        // 目录：meta 传 None（外部 agent 凭据自管；builtin 目录在 ensure_session 首建时已注入）。
        let session_id = self
            .ensure_session(thread_id, workspace_root_path, None)
            .await?;
        let acp_session_id = session_id.to_string();

        let override_key = stream_key
            .map(str::trim)
            .filter(|key| !key.is_empty() && *key != acp_session_id.as_str());
        let registered = if let Some(key) = override_key {
            self.stream_key_overrides
                .lock()
                .insert(acp_session_id.clone(), key.to_string());
            // 重写已登记 + 前端回合订阅已建立：以前端键重放缓存的可用命令，命令面板即时填充。
            self.replay_available_commands(&acp_session_id, key);
            true
        } else {
            false
        };

        let outcome = self.handle.prompt(session_id, blocks).await;

        if registered {
            self.stream_key_overrides.lock().remove(&acp_session_id);
        }

        outcome
    }

    /// 把某 ACP 会话已缓存的 available_commands 以前端流式键重放一帧 available_commands_update。
    ///
    /// 回合发起时调用：Kimi 等外部 agent 的可用斜杠命令是 session/new 后经 setTimeout(0) 的一次性
    /// 下发，会话复用后不再重发，且其到达时序早于/竞争本回合 stream_key 重写登记，仅靠自然转发会被
    /// 前端按键过滤丢弃 → 命令面板恒空。此处登记重写后主动以前端键补发一帧，使面板在每个回合订阅
    /// 建立后稳定填充。无缓存则空操作。
    fn replay_available_commands(&self, acp_session_id: &str, stream_key: &str) {
        let commands = self
            .available_commands_by_session
            .lock()
            .get(acp_session_id)
            .cloned();
        let Some(commands) = commands else {
            return;
        };
        (self.emit)(AcpStreamFrame {
            session_id: Some(stream_key.to_string()),
            seq: 0,
            event: build_available_commands_event(stream_key, &commands),
        });
    }

    /// 用纯文本驱动一轮**标准 ACP 回合**：把单段文本包成一个 `text` `ContentBlock` 后委托
    /// `prompt`。供外部 ACP agent（Kimi Code / Codex 等）的主聊天回合使用——它们只认标准
    /// `session/prompt`，不认识 `calamex.dev/*` 扩展方法。
    ///
    /// `ContentBlock` 经其线上 wire 形态（`{ "type": "text", "text": ... }`，与
    /// `session/update` 下发的 content 同形，见 `ui_event::text_from_content_block`）反序列化
    /// 构造，避免在宿主侧硬编码 SDK 具体构造路径；序列化我们自己的文本几乎不会失败，失败时
    /// 归为 `Protocol` 错误上抛。
    pub async fn prompt_text(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        text: &str,
    ) -> Result<StopReason, AcpClientError> {
        let block: ContentBlock = serde_json::from_value(serde_json::json!({
            "type": "text",
            "text": text,
        }))
        .map_err(|error| {
            AcpClientError::Protocol(format!("构造 ACP 文本内容块失败：{error}"))
        })?;
        self.prompt(thread_id, workspace_root_path, vec![block]).await
    }

    /// 投递一个审批决策，唤醒回合内挂起的权限请求（其 `prompt` 随后续跑并最终返回）。
    pub fn resolve_approval(
        &self,
        session_id: &str,
        tool_call_id: &str,
        decision: &str,
    ) -> Result<(), ApprovalError> {
        self.approvals.resolve(
            SessionId::from(session_id.to_string()),
            ToolCallId::from(tool_call_id.to_string()),
            decision,
        )
    }


    /// 切换指定线程当前 ACP 会话的某个配置项值（标准 session/set_config_option 请求）。
    ///
    /// 仅在本宿主已绑定该 thread_id 的会话时执行——命中则下发 session/set_config_option，并返回该
    /// 请求响应携带的「切换后完整配置项快照」（ACP SetSessionConfigOptionResponse.config_options
    /// 原样 JSON；agent 未在响应回填时回退到本宿主缓存的 session/new 快照）。未绑定（空 thread /
    /// 无映射）返回 Ok(None) 作为安全空操作，交由 runtime 广播给真正持有该线程的后端宿主。绝不在此
    /// ensure_session 新建会话——配置项切换只对既有会话有意义。
    pub async fn set_session_config_option(
        &self,
        thread_id: &str,
        config_id: &str,
        value_id: &str,
    ) -> Result<Option<serde_json::Value>, AcpClientError> {
        let thread_key = thread_id.trim();
        if thread_key.is_empty() {
            return Ok(None);
        }
        let session_id = self.sessions.lock().get(thread_key).cloned();
        let Some(session_id) = session_id else {
            return Ok(None);
        };
        let updated = self
            .handle
            .set_session_config_option(session_id, config_id.to_string(), value_id.to_string())
            .await?;
        // 响应携带切换后的完整配置项快照时，更新本线程缓存（保持 session_config_options 与最新值一致）。
        if let Some(config_options) = updated.clone() {
            self.config_options_by_thread
                .lock()
                .insert(thread_key.to_string(), config_options);
        }
        // 优先返回响应快照；agent 未回填时回退到缓存快照（既有会话必有 session/new 快照）。
        Ok(updated.or_else(|| self.config_options_by_thread.lock().get(thread_key).cloned()))
    }

    /// 取某线程会话建立时 agent 公示的可用配置项清单（ACP NewSessionResponse.config_options
    /// 原样 JSON：Vec SessionConfigOption）。未绑定会话 / agent 未公示配置项时为 None。
    /// 最小透传：宿主侧不重建 SDK 类型，交前端 ACL 解释。
    pub fn session_config_options(&self, thread_id: &str) -> Option<serde_json::Value> {
        let thread_key = thread_id.trim();
        if thread_key.is_empty() {
            return None;
        }
        self.config_options_by_thread
            .lock()
            .get(thread_key)
            .cloned()
    }

    /// 触发检查点回滚（扩展方法 `calamex.dev/checkpoint/restore`）。
    pub async fn restore_checkpoint(
        &self,
        request: CheckpointRestoreRequest,
    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {
        let value = self.handle.restore_checkpoint(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!(
                "invalid checkpoint restore response envelope: {error}"
            ))
        })
    }

    /// 原始模型透传（扩展方法 `calamex.dev/model/chat`）。
    pub async fn model_chat(
        &self,
        request: ModelChatExtRequest,
    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {
        let value = self.handle.model_chat(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid model chat response envelope: {error}"))
        })
    }

    /// 联网搜索（扩展方法 `calamex.dev/web/search`）。
    pub async fn web_search(
        &self,
        request: WebSearchExtRequest,
    ) -> Result<AiWebSearchPayload, AcpClientError> {
        let value = self.handle.web_search(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid web search response payload: {error}"))
        })
    }

    /// 联网抓取（扩展方法 `calamex.dev/web/fetch`）。
    pub async fn web_fetch(
        &self,
        request: WebFetchExtRequest,
    ) -> Result<AiWebFetchPayload, AcpClientError> {
        let value = self.handle.web_fetch(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid web fetch response payload: {error}"))
        })
    }

    /// 预热模型连接（扩展方法 `calamex.dev/warmup`）。
    pub async fn warmup(
        &self,
        request: WarmupExtRequest,
    ) -> Result<AgentSidecarWarmupPayload, AcpClientError> {
        let value = self.handle.warmup(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid warmup response payload: {error}"))
        })
    }

    /// 探测 sidecar 健康状态（扩展方法 `calamex.dev/health`）。
    pub async fn health(&self) -> Result<AgentSidecarHealthPayload, AcpClientError> {
        let value = self.handle.health(HealthExtRequest {}).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid health response payload: {error}"))
        })
    }

    /// 取消指定会话的当前回合：先清除其全部挂起审批，再下发 ACP `session/cancel` 通知。
    pub fn cancel(&self, session_id: &str) {
        let session_id = SessionId::from(session_id.to_string());
        self.approvals.cancel_session(&session_id);
        if let Err(error) = self.handle.cancel(session_id) {
            log::warn!("acp host cancel failed: {error}");
        }
    }

    /// 按 `thread_id` 取消当前回合（「取消重键」入口）。
    pub fn cancel_thread(&self, thread_id: &str) {
        let thread_key = thread_id.trim();
        if thread_key.is_empty() {
            log::warn!("acp host cancel_thread: empty thread_id");
            return;
        }
        let session_id = self.sessions.lock().get(thread_key).cloned();
        match session_id {
            Some(session_id) => self.cancel(&session_id.to_string()),
            None => log::warn!("acp host cancel_thread: no session bound for thread {thread_key}"),
        }
    }

    /// 请求优雅关停：清空挂起审批并令常驻连接任务结束（子进程随之回收）。
    pub fn shutdown(&self) {
        self.approvals.clear();
        self.handle.shutdown();
    }
}

/// 从一帧 session/update 事件 JSON 中提取 available_commands_update 的 availableCommands 数组。
/// 仅当 update.sessionUpdate 为 "available_commands_update" 且存在 availableCommands 时返回其克隆，
/// 否则返回 None（其余变体或字段缺失）。纯函数，便于单测。
fn extract_available_commands_update(event: &serde_json::Value) -> Option<serde_json::Value> {
    let update = event.get("update")?;
    if update
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str)
        != Some("available_commands_update")
    {
        return None;
    }
    update.get("availableCommands").cloned()
}

/// 构造一帧以前端流式键标记的 available_commands_update 事件 JSON（与 ui_event 投影同形：
/// sessionId + update.sessionUpdate + update.availableCommands）。纯函数，便于单测。
fn build_available_commands_event(
    stream_key: &str,
    commands: &serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "sessionId": stream_key,
        "update": {
            "sessionUpdate": "available_commands_update",
            "availableCommands": commands.clone(),
        }
    })
}

/// 修剪并过滤空白可选字符串：`None` / 空 / 全空白 → `None`，否则返回修剪后切片。
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// 新建会话的 cwd：优先用提供的工作区根路径；缺省回退到进程当前目录，再退到 `.`。
fn workspace_cwd(workspace_root_path: Option<&str>) -> PathBuf {
    match non_empty(workspace_root_path) {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_available_commands_update_returns_commands_for_matching_frame() {
        let event = serde_json::json!({
            "sessionId": "acp-uuid",
            "update": {
                "sessionUpdate": "available_commands_update",
                "availableCommands": [
                    { "name": "compact", "description": "压缩上下文" },
                    { "name": "help", "description": "帮助" }
                ]
            }
        });
        let commands = extract_available_commands_update(&event).unwrap();
        assert_eq!(commands.as_array().unwrap().len(), 2);
        assert_eq!(commands[0]["name"], "compact");
    }

    #[test]
    fn extract_available_commands_update_ignores_other_session_updates() {
        let event = serde_json::json!({
            "sessionId": "acp-uuid",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hi" }
            }
        });
        assert!(extract_available_commands_update(&event).is_none());
    }

    #[test]
    fn extract_available_commands_update_none_when_field_absent() {
        let event = serde_json::json!({
            "update": { "sessionUpdate": "available_commands_update" }
        });
        assert!(extract_available_commands_update(&event).is_none());
    }

    #[test]
    fn build_available_commands_event_targets_stream_key() {
        let commands = serde_json::json!([{ "name": "status", "description": "状态" }]);
        let event = build_available_commands_event("sidecar:assistant-1", &commands);
        assert_eq!(event["sessionId"], "sidecar:assistant-1");
        assert_eq!(event["update"]["sessionUpdate"], "available_commands_update");
        assert_eq!(event["update"]["availableCommands"][0]["name"], "status");
    }

    #[test]
    fn non_empty_trims_and_filters_blank() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some("")), None);
        assert_eq!(non_empty(Some("   ")), None);
        assert_eq!(non_empty(Some("  agent ")), Some("agent"));
    }

    #[test]
    fn workspace_cwd_prefers_provided_path() {
        assert_eq!(
            workspace_cwd(Some("/work/space")),
            PathBuf::from("/work/space")
        );
    }

    #[test]
    fn workspace_cwd_falls_back_when_blank() {
        // 空白工作区路径 → 回退到进程当前目录（或最终退到 "."）；至少非空。
        let cwd = workspace_cwd(Some("   "));
        assert!(!cwd.as_os_str().is_empty());
    }
}
