//! 宿主侧 ACP(Agent Client Protocol)stdio 客户端。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中新增、可逆、按 cargo
//! feature `acp_client` 门控的模块。默认构建(`default = ["desktop"]`)不会编译它,
//! 因此落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! 设计完全对齐官方 Rust crate `agent-client-protocol`(git 钉到 v0.14.0 的 SACP
//! 角色/构建器模型),不自创 JSON-RPC:
//!   * 用 `Client.builder()` 注册 `on_receive_notification`(把流式 `session/update`
//!     转发给 webview)与 `on_receive_request`(把权限请求路由给上层审批 UI)。
//!   * 用 `AcpAgent::from_args(...)` 作 stdio 传输:派生子进程
//!     `node dist/acp/stdio-entry.js`,由 crate 负责行分帧 / stderr 收集 /
//!     drop 时杀子进程。采用结构化词元而非单一命令行字符串,规避
//!     `shell_words::split` 对含空格 / 反斜杠路径(尤其 Windows)的误分词。
//!   * `connect_with(transport, |cx| async {...})` 内运行长生命周期命令循环,宿主侧
//!     (Tauri 命令)经 mpsc 投递 NewSession / Prompt / SetSessionMode / RestoreCheckpoint /
//!     ModelChat / WebSearch / WebFetch / Warmup / Health / Orchestrate / OrchestrateResume /
//!     AgentChat / AgentChatResolve / Cancel / Shutdown。

// 过渡期:本模块尚未接线到宿主命令(公开 API 暂无调用点)。接线后移除该 allow。
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use agent_client_protocol::schema::{
    CancelNotification, ContentBlock, InitializeRequest, NewSessionRequest, PermissionOptionId,
    PromptRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionId, SessionModeId,
    SessionNotification, SetSessionModeRequest, StopReason,
};
use agent_client_protocol::{
    AcpAgent, Agent, BoxFuture, Client, ConnectionTo, JsonRpcRequest, Responder,
    on_receive_notification, on_receive_request,
};

/// webview 流式帧:对齐现有 `ai:sidecar-stream` 的 `{sessionId, seq, event}` 契约。
/// `event` 直接是官方 `SessionNotification` 的 JSON(camelCase 线格式)。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStreamFrame {
    pub session_id: Option<String>,
    pub seq: u64,
    pub event: serde_json::Value,
}

/// 流式事件下沉口:与 Tauri 解耦,便于单测与后续接线(由调用方提供 emit 闭包)。
pub type EventSink = Arc<dyn Fn(AcpStreamFrame) + Send + Sync>;

/// 权限决策:由上层(审批 UI)给出。`Selected` 必须携带请求 options 中的某个 option_id。
pub enum PermissionDecision {
    Selected(PermissionOptionId),
    Cancelled,
}

/// 权限解析器:收到官方 `RequestPermissionRequest`,异步返回决策(等待用户审批)。
pub type PermissionResolver =
    Arc<dyn Fn(RequestPermissionRequest) -> BoxFuture<'static, PermissionDecision> + Send + Sync>;

/// 扩展方法的请求级模型配置(检查点回滚 / 预热共用)。
///
/// 字段镜像 sidecar 的请求级模型配置 schema:`ext-methods.ts` 的
/// `modelConfigParamsSchema`(检查点回滚)与 `models/llm-warmup.ts` 的
/// `requestScopedModelConfigSchema`(预热)同形,二者均为 camelCase 线格式。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtModelConfig {
    pub model_id: String,
    pub api_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// 检查点回滚扩展方法的请求。
///
/// 这是 SDK 官方推荐的扩展方法落地方式:用 `#[derive(JsonRpcRequest)]` + `#[request(...)]`
/// 把一个一等的带类型请求接入,`cx.send_request(...)` 原生可发,响应按 id 定型解析,
/// 不经枚举回退通道,因此无需 `_` 前缀。线方法名与 sidecar 的 `CHECKPOINT_RESTORE_METHOD`
/// (`calamex.dev/checkpoint/restore`)逐字一致;TS SDK 的 AgentSideConnection 对未知方法
/// 直接 `agent.extMethod(method, params)`(原样透传、不剥前缀),故两侧对得上。
/// 字段镜像 sidecar `ext-methods.ts` 的 `checkpointRestoreParamsSchema`。
/// 响应为整封 sidecar 响应信封(schemaVersion + sessionId + events + result),
/// 以 `serde_json::Value` 原样回传,交由宿主侧既有 `AgentSidecarResponsePayload` 解析。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/checkpoint/restore", response = Value)]
pub struct CheckpointRestoreRequest {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

/// `calamex.dev/model/chat` 扩展方法的单条消息。
///
/// 字段镜像 sidecar `ext-methods.ts` 的 `modelChatMessageSchema`(camelCase 线格式):
/// `role` 覆盖四类(system/user/assistant/tool),`content` 为纯文本;`tool_call_id`/`name`
/// 仅在工具消息回放时出现,可选透传。`role` 的合法取值由 sidecar 端 zod 统一校验,宿主侧
/// 以字符串原样透传、不在此重复其取值表(同 `WebSearchExtRequest.intent` 的处理),避免与
/// sidecar 的单一来源漂移。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// `calamex.dev/model/chat` 扩展方法的请求(原始模型透传,仿 Zed 的独立模型请求)。
///
/// 这是 ACP 标准会话回合(`session/prompt`)之外的「带外」工具型模型调用:一次性、无工具、
/// 无记忆、不读历史、不套 agent 系统提示;调用方 messages(含 system)原样下发。承载标题
/// 生成 / 行内补全 / 连接测试等「工具型」请求——对齐 Zed 把这类 model-backed 功能
/// (Thread title、Inline Assistant、Edit Prediction、Git commit message)与 Agent Panel 的
/// 智能体回合分离为独立模型请求的做法,而非塞进 agent thread 的工具循环。
///
/// 落地方式与同文件的 checkpoint/restore 等扩展一致:`#[derive(JsonRpcRequest)]` +
/// `#[request(...)]` 接入一等带类型请求,`cx.send_request(...)` 原生可发。线方法名与 sidecar
/// 的 `MODEL_CHAT_METHOD`(`calamex.dev/model/chat`)逐字一致。字段镜像 sidecar
/// `modelChatParamsSchema`。响应为整封 sidecar 响应信封(`toModelChatExtResult =
/// toAgentSidecarResponse`,与 chat/checkpoint 同构:schemaVersion + sessionId + events +
/// result),以 `serde_json::Value` 原样回传,交由宿主侧既有 `AgentSidecarResponsePayload` 解析。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/model/chat", response = Value)]
pub struct ModelChatExtRequest {
    pub messages: Vec<ModelChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

/// `calamex.dev/web/search` 扩展方法的请求。
///
/// 字段镜像 sidecar `web/types.ts` 的 `aiWebSearchInputSchema`(camelCase 线格式)。
/// `intent` / `recency` 的合法取值由 sidecar 端 zod 统一校验,宿主侧以字符串原样透传、
/// 不在此重复其取值表,避免与 sidecar 的单一来源漂移。
/// 响应为 `aiWebSearchPayloadSchema`,以 `serde_json::Value` 原样回传交由宿主侧解析。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/web/search", response = Value)]
pub struct WebSearchExtRequest {
    pub query: String,
    pub intent: String,
    pub max_results: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recency: Option<String>,
}

/// `calamex.dev/web/fetch` 扩展方法的请求。
///
/// 字段镜像 sidecar `web/types.ts` 的 `aiWebFetchInputSchema`(camelCase 线格式)。
/// 响应为 `aiWebFetchPayloadSchema`,以 `serde_json::Value` 原样回传交由宿主侧解析。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/web/fetch", response = Value)]
pub struct WebFetchExtRequest {
    pub url: String,
    pub reason: String,
    pub max_bytes: u64,
}

/// `calamex.dev/warmup` 扩展方法的请求。
///
/// 字段镜像 sidecar `ext-methods.ts` 的 `warmupParamsSchema`(可选 `modelConfig`)。
/// 缺省 `model_config` 时,sidecar 退回到从启动期环境解析的默认模型配置。
/// 响应为预热结果信封,以 `serde_json::Value` 原样回传交由宿主侧解析。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/warmup", response = Value)]
pub struct WarmupExtRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

/// `calamex.dev/health` 扩展方法的请求(无参数,序列化为 `{}`)。
///
/// 响应为健康信息信封,以 `serde_json::Value` 原样回传交由宿主侧解析。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/health", response = Value)]
pub struct HealthExtRequest {}

/// `calamex.dev/plan/orchestrate` 扩展方法的请求(原生计划编排启动)。
///
/// 标准会话回合(`session/prompt`)之外的「带外」编排能力:跑到审批挂起或终态,
/// 过程中的工作流事件经会话的 `session/update` 流式下发(故携带 `session_id` 以便
/// sidecar 在该会话上投影内部事件,见 agent.ts `handleOrchestrate`)。线方法名与
/// sidecar 的 `ORCHESTRATE_METHOD`(`calamex.dev/plan/orchestrate`)逐字一致;字段镜像
/// sidecar `ext-methods.ts` 的 `orchestrateParamsSchema`。`execution_mode` 的合法取值
/// (interactive/autonomous)由 sidecar 端 zod 统一校验,宿主侧以字符串原样透传、不在此
/// 重复其取值表(同 `WebSearchExtRequest.intent` 的处理);取值为空(None)时整字段省略,
/// 交由 sidecar 套用其默认值(interactive),宿主侧不臆造默认(镜像契约
/// `AgentSidecarOrchestrateRequest.execution_mode` 的 omit-when-blank 语义)。
/// 响应为编排终帧 `{ runId, status, result }`,以 `serde_json::Value` 原样回传,交由宿主侧
/// 解析(`status` 字段冗余,按 serde 默认忽略,同 HTTP orchestrate)。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/plan/orchestrate", response = Value)]
pub struct OrchestrateExtRequest {
    pub goal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

/// `calamex.dev/plan/orchestrate/resume` 扩展方法的请求(编排挂起点恢复)。
///
/// 恢复一个挂起在审批门(approve/reject/continue/cancel)的编排运行,按 `run_id` 定位;
/// 续跑阶段的工作流事件同样经会话的 `session/update` 流式下发(携带 `session_id` 以便
/// sidecar 在该会话上投影,见 agent.ts `handleOrchestrateResume`)。线方法名与 sidecar 的
/// `ORCHESTRATE_RESUME_METHOD`(`calamex.dev/plan/orchestrate/resume`)逐字一致;字段镜像
/// sidecar `orchestrateResumeParamsSchema`。`decision` 的合法取值由 sidecar 端 zod 统一校验,
/// 宿主侧以字符串原样透传。响应同 `OrchestrateExtRequest`:编排终帧 `{ runId, status, result }`。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/plan/orchestrate/resume", response = Value)]
pub struct OrchestrateResumeExtRequest {
    pub run_id: String,
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

/// `calamex.dev/agent/chat` 扩展方法的单条消息。
///
/// 字段镜像 sidecar `ext-methods.ts` 的 `agentChatMessageSchema`(camelCase 线格式):
/// `role` 覆盖四类(user/assistant/system/tool),`content` 为纯文本。与旧 http
/// `/agent/chat` 的 `agentMessageInputSchema` 逐字一致(无 toolCallId/name)。`role` 取值
/// 由 sidecar 端 zod 统一校验,宿主侧以字符串原样透传、不在此重复其取值表。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatMessage {
    pub role: String,
    pub content: String,
}

/// `calamex.dev/agent/chat` 上下文引用的行范围(1 基正整数)。
///
/// 字段镜像 sidecar `agentChatContextReferenceSchema.range`:startLine/endLine 均为正整数。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatContextRange {
    pub start_line: u32,
    pub end_line: u32,
}

/// `calamex.dev/agent/chat` 的上下文引用。
///
/// 字段逐字镜像 sidecar `agentChatContextReferenceSchema`(camelCase 线格式):
/// `path` 与 `range` 是「可空但必填」(zod `.nullable()`,非 `.optional()`),故缺值时
/// 序列化为显式 `null`(不省略键,即不加 skip_serializing_if),否则 sidecar 端 zod
/// 解析会因键缺失而失败。`kind` 用宽松字符串承接未来取值,由 sidecar 端校验。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatContextReference {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub path: Option<String>,
    pub range: Option<AgentChatContextRange>,
    pub content_preview: String,
    pub redacted: bool,
}

/// `calamex.dev/agent/chat` 扩展方法的请求(agent 模式对话回合,run-to-gate)。
///
/// 这是 ACP 标准会话回合(`session/prompt`)之外、承载 agent 模式富对话的「带外」能力:
/// 原生 `session/prompt` 的 `session/update` 投影有损(仅文本/思考增量),会丢失结构化补丁 /
/// 检查点 / 回滚 / 富审批字段 / plan_ready 等 agent UI 词表;故本扩展跑到审批门或终态,
/// 把过程增量经 `session/update` 仅作实时预览,真正权威的富事件由方法返回值的完整
/// `toAgentSidecarResponse` 信封承载(与旧 http `/agent/chat` 同构,前端无感)。
///
/// 落地方式与同文件其余扩展一致:`#[derive(JsonRpcRequest)]` + `#[request(...)]` 接入一等
/// 带类型请求,`cx.send_request(...)` 原生可发。线方法名与 sidecar 的 `AGENT_CHAT_METHOD`
/// (`calamex.dev/agent/chat`)逐字一致;字段镜像 sidecar `agentChatParamsSchema`。
/// `messages`/`context` 恒序列化为数组(空则 `[]`,与 schema 的 `.default([])` 相容);
/// 其余可选字段为空时整字段省略,交由 sidecar 套用其回退语义(mode→'agent'、goal→末条
/// user 消息 ?? '继续当前任务'),宿主侧不臆造默认。`mode` 等取值由 sidecar 端 zod 校验,
/// 宿主侧以字符串原样透传。响应为整封 sidecar 响应信封(schemaVersion + sessionId +
/// events + result),以 `serde_json::Value` 原样回传,交由宿主侧既有 `AgentSidecarResponsePayload` 解析。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/agent/chat", response = Value)]
pub struct AgentChatExtRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    pub messages: Vec<AgentChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root_path: Option<String>,
    pub context: Vec<AgentChatContextReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_step_id: Option<String>,
}

/// `calamex.dev/agent/chat/resolve` 扩展方法的请求(agent 对话审批恢复)。
///
/// 镜像旧 http `/approval/resolve` → `runtime.resolveApproval(approvalResolutionSchema.parse(body))`:
/// 携带上一段返回信封里 approval_required 的 `request_id` 与 `decision`,裁决后续跑同一回合并
/// 返回下一段响应信封(若再遇审批门则信封再携 approval_required)。线方法名与 sidecar 的
/// `AGENT_CHAT_RESOLVE_METHOD`(`calamex.dev/agent/chat/resolve`)逐字一致;字段镜像 sidecar
/// `agentChatResolveParamsSchema`(= agentChatParamsSchema + requestId + decision)。`decision`
/// 取值(approve/reject/cancel/modify)由 sidecar 端 zod 校验,宿主侧原样透传。响应同
/// `AgentChatExtRequest`:整封 sidecar 响应信封,以 `serde_json::Value` 原样回传。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/agent/chat/resolve", response = Value)]
pub struct AgentChatResolveExtRequest {
    pub request_id: String,
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    pub messages: Vec<AgentChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root_path: Option<String>,
    pub context: Vec<AgentChatContextReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_step_id: Option<String>,
}

/// 启动配置。采用结构化字段而非单一命令行字符串:
///   * `program`:ACP stdio 入口可执行程序(如 node 的绝对路径);
///   * `args`:传给程序的参数(如 `dist/acp/stdio-entry.js`);
///   * `env`:注入到子进程环境的变量。
///
/// 经 `AcpAgent::from_args` 逐词元传入(每个词元为独立元素,不经 shell 分词),
/// 从而规避 `from_str` 内 `shell_words::split` 对含空格 / 反斜杠路径(尤其 Windows)
/// 的误分词。
pub struct AcpClientConfig {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, thiserror::Error)]
pub enum AcpClientError {
    #[error("acp transport error: {0}")]
    Transport(String),
    #[error("acp protocol error: {0}")]
    Protocol(String),
    #[error("acp client task is not running")]
    NotRunning,
}

/// 投递给常驻连接任务的命令。
enum Command {
    NewSession {
        cwd: PathBuf,
        reply: oneshot::Sender<Result<SessionId, String>>,
    },
    Prompt {
        session_id: SessionId,
        blocks: Vec<ContentBlock>,
        reply: oneshot::Sender<Result<StopReason, String>>,
    },
    SetSessionMode {
        session_id: SessionId,
        mode_id: SessionModeId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    RestoreCheckpoint {
        request: CheckpointRestoreRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    ModelChat {
        request: ModelChatExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    WebSearch {
        request: WebSearchExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    WebFetch {
        request: WebFetchExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Warmup {
        request: WarmupExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Health {
        request: HealthExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Orchestrate {
        request: OrchestrateExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    OrchestrateResume {
        request: OrchestrateResumeExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    AgentChat {
        request: AgentChatExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    AgentChatResolve {
        request: AgentChatResolveExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Cancel {
        session_id: SessionId,
    },
    Shutdown,
}

/// 宿主侧句柄:向常驻 ACP 连接任务投递命令。
#[derive(Clone)]
pub struct AcpClientHandle {
    cmd_tx: mpsc::UnboundedSender<Command>,
}

impl AcpClientHandle {
    /// 新建一个 ACP 会话,返回 `session/new` 的 session_id。
    pub async fn new_session(&self, cwd: PathBuf) -> Result<SessionId, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::NewSession { cwd, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 发送一轮 prompt,阻塞直到该回合结束,返回 `session/prompt` 的 stop_reason。
    ///
    /// 入参为已投影好的 ACP 内容块序列(用户文本 + 上下文引用),由接线层
    /// `bridge::user_turn_to_content_blocks` 统一构造;本层只负责原样下发,不在此
    /// 臆造内容块形态,对齐官方 `PromptRequest::new(session_id, blocks)`。
    pub async fn prompt(
        &self,
        session_id: SessionId,
        blocks: Vec<ContentBlock>,
    ) -> Result<StopReason, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Prompt {
                session_id,
                blocks,
                reply,
            })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 设置会话模式(`session/set_mode`)。
    ///
    /// 用于在 ask / plan / agent / patch / review 等模式间切换;`mode_id` 须取自
    /// 会话当前可用模式(`session/new` 响应或 `current_mode_update` 通知公示的 `modes`)。
    /// 由调用方构造 `SessionModeId`,本模块不臆造其构造方式,对齐官方
    /// `SetSessionModeRequest::new(session_id, mode_id)`。
    pub async fn set_session_mode(
        &self,
        session_id: SessionId,
        mode_id: SessionModeId,
    ) -> Result<(), AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::SetSessionMode {
                session_id,
                mode_id,
                reply,
            })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 触发检查点回滚(扩展方法 `calamex.dev/checkpoint/restore`)。
    ///
    /// 这是 ACP 标准会话回合之外的「带外」能力,经 sidecar 公示的扩展方法通道下发;
    /// 标准客户端(如 Zed)不识别该方法会安全忽略,核心会话流不受影响。
    /// 返回 sidecar 的整封响应信封(`serde_json::Value`),由宿主侧解析。
    pub async fn restore_checkpoint(
        &self,
        request: CheckpointRestoreRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::RestoreCheckpoint { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 原始模型透传(扩展方法 `calamex.dev/model/chat`)。
    ///
    /// 与检查点回滚同属标准会话回合之外的「带外」能力,经 sidecar 公示的扩展方法通道下发;
    /// 标准客户端(如 Zed)不识别该方法会安全忽略。承载标题生成 / 行内补全 / 连接测试等
    /// 一次性「工具型」模型调用。返回 sidecar 的整封响应信封(`serde_json::Value`),由宿主侧解析。
    pub async fn model_chat(&self, request: ModelChatExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::ModelChat { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 联网搜索(扩展方法 `calamex.dev/web/search`)。
    ///
    /// 与检查点回滚同属标准会话回合之外的「带外」能力,经 sidecar 公示的扩展方法通道下发;
    /// 标准客户端不识别该方法会安全忽略。返回 sidecar 的搜索结果信封(`serde_json::Value`),
    /// 由宿主侧解析为既有的 web 搜索结果契约。
    pub async fn web_search(&self, request: WebSearchExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::WebSearch { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 联网抓取(扩展方法 `calamex.dev/web/fetch`)。
    ///
    /// 经 sidecar 公示的扩展方法通道下发。返回 sidecar 的抓取结果信封(`serde_json::Value`),
    /// 由宿主侧解析为既有的 web 抓取结果契约。
    pub async fn web_fetch(&self, request: WebFetchExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::WebFetch { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 预热模型连接(扩展方法 `calamex.dev/warmup`)。
    ///
    /// 经 sidecar 公示的扩展方法通道下发。返回 sidecar 的预热结果信封(`serde_json::Value`),
    /// 由宿主侧解析为既有的预热结果契约。
    pub async fn warmup(&self, request: WarmupExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Warmup { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 探测 sidecar 健康状态(扩展方法 `calamex.dev/health`)。
    ///
    /// 经 sidecar 公示的扩展方法通道下发。返回 sidecar 的健康信息信封(`serde_json::Value`),
    /// 由宿主侧解析为既有的健康状态契约。
    pub async fn health(&self, request: HealthExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Health { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 启动一次原生计划编排(扩展方法 `calamex.dev/plan/orchestrate`)。
    ///
    /// 与检查点回滚同属标准会话回合之外的「带外」能力,经 sidecar 公示的扩展方法通道下发;
    /// 跑到审批挂起或终态,过程中的工作流事件经 `session/update` 流式下发(由 sidecar 在
    /// `session_id` 指定会话上投影)。返回 sidecar 的编排终帧 `{runId,status,result}`
    /// (`serde_json::Value`),由宿主侧解析。
    pub async fn orchestrate(
        &self,
        request: OrchestrateExtRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Orchestrate { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 恢复一个挂起的编排运行(扩展方法 `calamex.dev/plan/orchestrate/resume`)。
    ///
    /// 经 sidecar 公示的扩展方法通道下发;续跑阶段的工作流事件同样经 `session/update`
    /// 流式下发。返回 sidecar 的编排终帧 `{runId,status,result}`(`serde_json::Value`),
    /// 由宿主侧解析。
    pub async fn orchestrate_resume(
        &self,
        request: OrchestrateResumeExtRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::OrchestrateResume { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 发起一轮 agent 模式对话(扩展方法 `calamex.dev/agent/chat`)。
    ///
    /// 与编排同属标准会话回合之外的「带外」能力,经 sidecar 公示的扩展方法通道下发;
    /// run-to-gate:跑到审批门或终态,过程增量经 `session/update` 仅作实时预览,权威富事件
    /// 由返回信封承载。返回 sidecar 的整封响应信封(`serde_json::Value`),由宿主侧解析。
    pub async fn agent_chat(&self, request: AgentChatExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::AgentChat { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 恢复一轮挂起在审批门的 agent 对话(扩展方法 `calamex.dev/agent/chat/resolve`)。
    ///
    /// 经 sidecar 公示的扩展方法通道下发;裁决后续跑同一回合并返回下一段响应信封。
    /// 返回 sidecar 的整封响应信封(`serde_json::Value`),由宿主侧解析。
    pub async fn agent_chat_resolve(
        &self,
        request: AgentChatResolveExtRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::AgentChatResolve { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 取消指定会话当前操作(`session/cancel` 通知,fire-and-forget)。
    pub fn cancel(&self, session_id: SessionId) -> Result<(), AcpClientError> {
        self.cmd_tx
            .send(Command::Cancel { session_id })
            .map_err(|_| AcpClientError::NotRunning)
    }

    /// 请求常驻任务优雅结束(随后连接断开、子进程被回收)。
    pub fn shutdown(&self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
    }
}

/// 构造 `AcpAgent::from_args` 所需的词元序列:前导 `NAME=value` 为子进程环境变量,
/// 其后为程序与其参数。每个词元都是独立元素,不经 shell 分词,因此 Windows 下含
/// 空格的 node / 入口路径也安全(规避 `from_str` 的 `shell_words::split` 风险)。
fn build_agent_args(config: &AcpClientConfig) -> Vec<String> {
    let mut args: Vec<String> = config.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
    args.push(config.program.clone());
    args.extend(config.args.iter().cloned());
    args
}

/// 启动常驻 ACP 客户端连接任务,返回宿主侧命令句柄。
///
/// 传输用官方 `AcpAgent`(stdio 子进程);连接握手与会话生命周期完全交给 crate。
/// 连接任务跑在 Tauri 多线程运行时上(`ConnectTo` future 为 `Send`,无需 LocalSet)。
pub fn spawn_acp_client(
    config: AcpClientConfig,
    sink: EventSink,
    resolver: PermissionResolver,
) -> Result<AcpClientHandle, AcpClientError> {
    let transport = AcpAgent::from_args(build_agent_args(&config))
        .map_err(|e| AcpClientError::Transport(e.to_string()))?;

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();
    let seq = Arc::new(AtomicU64::new(0));

    let notif_sink = sink.clone();
    let notif_seq = seq.clone();

    tokio::spawn(async move {
        let result = Client
            .builder()
            .name("calamex")
            // 流式 session/update:Client 默认 dispatch 返回 Handled::No,通知会落到此处理器。
            .on_receive_notification(
                move |notif: SessionNotification, _cx| {
                    let sink = notif_sink.clone();
                    let seq = notif_seq.clone();
                    async move {
                        let event = serde_json::to_value(&notif).unwrap_or(serde_json::Value::Null);
                        let session_id = event
                            .get("sessionId")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let n = seq.fetch_add(1, Ordering::SeqCst);
                        sink(AcpStreamFrame {
                            session_id,
                            seq: n,
                            event,
                        });
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                on_receive_notification!(),
            )
            // 权限请求:异步交给上层审批 UI 决策。
            // 参数类型:handlers.rs 要求 AsyncFnMut(Req, Responder<Req::Response>, ConnectionTo<Host::Counterpart>)。
            // Host=Client,故连接参数是 ConnectionTo<Agent>(Client::Counterpart = Agent)。
            .on_receive_request(
                move |req: RequestPermissionRequest,
                      responder: Responder<RequestPermissionResponse>,
                      _cx: ConnectionTo<Agent>| {
                    let resolver = resolver.clone();
                    async move {
                        let outcome = match resolver(req).await {
                            PermissionDecision::Selected(option_id) => {
                                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                                    option_id,
                                ))
                            }
                            PermissionDecision::Cancelled => RequestPermissionOutcome::Cancelled,
                        };
                        responder.respond(RequestPermissionResponse::new(outcome))?;
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                on_receive_request!(),
            )
            .connect_with(transport, async move |cx| {
                // 1) 握手
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                // 2) 常驻命令循环(由宿主侧 mpsc 驱动)
                while let Some(command) = cmd_rx.recv().await {
                    match command {
                        Command::NewSession { cwd, reply } => {
                            let res = cx
                                .send_request(NewSessionRequest::new(cwd))
                                .block_task()
                                .await;
                            let _ =
                                reply.send(res.map(|r| r.session_id).map_err(|e| e.to_string()));
                        }
                        Command::Prompt {
                            session_id,
                            blocks,
                            reply,
                        } => {
                            let req = PromptRequest::new(session_id, blocks);
                            let res = cx.send_request(req).block_task().await;
                            let _ =
                                reply.send(res.map(|r| r.stop_reason).map_err(|e| e.to_string()));
                        }
                        Command::SetSessionMode {
                            session_id,
                            mode_id,
                            reply,
                        } => {
                            let res = cx
                                .send_request(SetSessionModeRequest::new(session_id, mode_id))
                                .block_task()
                                .await;
                            let _ = reply.send(res.map(|_| ()).map_err(|e| e.to_string()));
                        }
                        Command::RestoreCheckpoint { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::ModelChat { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::WebSearch { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::WebFetch { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Warmup { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Health { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Orchestrate { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::OrchestrateResume { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::AgentChat { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::AgentChatResolve { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Cancel { session_id } => {
                            if let Err(error) =
                                cx.send_notification(CancelNotification::new(session_id))
                            {
                                log::warn!("acp cancel notification failed: {error}");
                            }
                        }
                        Command::Shutdown => break,
                    }
                }

                Ok::<(), agent_client_protocol::Error>(())
            })
            .await;

        if let Err(error) = result {
            log::warn!("acp client connection ended with error: {error}");
        }
    });

    Ok(AcpClientHandle { cmd_tx })
}

#[cfg(test)]
mod tests {
    use super::