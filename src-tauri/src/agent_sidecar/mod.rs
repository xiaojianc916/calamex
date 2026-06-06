use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::ai::credential::CredentialStore;
use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,
    AgentSidecarCheckpointRestoreRequest, AgentSidecarHealthPayload,
    AgentSidecarModelConfigPayload, AgentSidecarResponsePayload, AgentSidecarWarmupPayload,
    AgentSidecarWarmupRequest, AiWebFetchInput, AiWebFetchPayload, AiWebSearchInput,
    AiWebSearchPayload,
};

mod orchestrate;
pub(crate) use orchestrate::{orchestrate, orchestrate_resume};

const DEFAULT_SIDECAR_URL: &str = "http://127.0.0.1:39871";
const SIDECAR_URL_ENV: &str = "XIAOJIANC_AGENT_SIDECAR_URL";
const SIDECAR_ROOT_ENV: &str = "XIAOJIANC_AGENT_SIDECAR_ROOT";
const NODE_EXE_ENV: &str = "XIAOJIANC_NODE_EXE";
const MCP_UVX_PATH_ENV: &str = "AGENT_MCP_UVX_PATH";
const SIDECAR_REQUEST_TIMEOUT_SECONDS: u64 = 30 * 60;
const SIDECAR_HEALTH_TIMEOUT_SECONDS: u64 = 2;
const SIDECAR_STARTUP_RETRY_MS: u64 = 250;
const SIDECAR_STARTUP_TIMEOUT_ENV: &str = "XIAOJIANC_AGENT_SIDECAR_STARTUP_TIMEOUT_SECONDS";
const SIDECAR_STARTUP_TIMEOUT_DEFAULT_SECONDS: u64 = 20;
const SIDECAR_STARTUP_TIMEOUT_MIN_SECONDS: u64 = 5;
const SIDECAR_STARTUP_TIMEOUT_MAX_SECONDS: u64 = 600;
const SIDECAR_STARTUP_ATTEMPTS: u32 = 2;
const SIDECAR_LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;
const SIDECAR_LOG_TAIL_CHARS: usize = 1200;
const NARRATOR_CHAT_RETRY_DELAYS_MS: &[u64] = &[1500, 3000, 5000, 9000, 16000, 30000, 60000];
const SIDECAR_PROTOCOL_VERSION: &str = "7";
const SIDECAR_IMPLEMENTATION_VERSION: &str = "deepseek-reasoning-transport-v6-plan-history";
const DEFAULT_SIDECAR_PORT: u16 = 39871;
/// 流式响应中单个未完成行的字节上限（16 MiB）。正常 NDJSON 事件远小于此；
/// 仅用于防御“始终不出现换行符的超长行”导致读缓冲无界增长 → OOM。
/// 仅在缓冲区残留的“未完成行”超过此上限时触发，不改变正常按行解析 / 下发的
/// 流式行为与前端视觉。
const SIDECAR_STREAM_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SidecarHealthStatus {
    Ready,
    Stale,
    Unavailable,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarHealthProbePayload {
    ok: bool,
    #[serde(rename = "engine")]
    _engine: Option<String>,
    protocol_version: Option<String>,
    implementation_version: Option<String>,
}

fn classify_sidecar_health(payload: &SidecarHealthProbePayload) -> SidecarHealthStatus {
    if !payload.ok {
        return SidecarHealthStatus::Unavailable;
    }

    if payload.protocol_version.as_deref() == Some(SIDECAR_PROTOCOL_VERSION)
        && payload.implementation_version.as_deref() == Some(SIDECAR_IMPLEMENTATION_VERSION)
    {
        SidecarHealthStatus::Ready
    } else {
        SidecarHealthStatus::Stale
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSidecarStreamEventPayload {
    session_id: String,
    seq: u64,
    event: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
enum AgentSidecarStreamFrame {
    #[serde(rename = "event")]
    Event { event: serde_json::Value },
    #[serde(rename = "response")]
    Response {
        response: AgentSidecarResponsePayload,
    },
    #[serde(rename = "error")]
    Error { error: String },
}

fn configured_base_url() -> String {
    canonicalize_local_base_url(normalize_base_url(
        env::var(SIDECAR_URL_ENV).ok().as_deref(),
    ))
}

/// 默认本地 sidecar 的 localhost / [::1] 写法统一规整为 127.0.0.1。
///
/// sidecar 仅监听 127.0.0.1；若配置/默认 URL 使用 `localhost`，在某些系统上会
/// 先解析到 IPv6 的 `::1`，导致健康探测与请求永连不上 → 每次都 15 秒超时。
/// 这里把三种等价的默认本地写法统一成 127.0.0.1，保证探测与请求地址一致。
fn canonicalize_local_base_url(base_url: String) -> String {
    if is_default_local_sidecar_url(&base_url) {
        DEFAULT_SIDECAR_URL.to_string()
    } else {
        base_url
    }
}

fn normalize_base_url(raw_url: Option<&str>) -> String {
    raw_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SIDECAR_URL)
        .trim_end_matches('/')
        .to_string()
}

fn build_sidecar_url(base_url: &str, path: &str) -> String {
    let normalized_base = normalize_base_url(Some(base_url));
    let normalized_path = path.trim_start_matches('/');
    format!("{normalized_base}/{normalized_path}")
}

/// 复用同一个 reqwest::Client 以共享底层连接池（keep-alive、TLS 会话复用），
/// 避免每次请求都新建客户端导致连接无法复用、握手开销叠加。
/// reqwest::Client 内部是 Arc，clone 成本极低，且 clone 出来的实例共享同一连接池。
fn shared_client(
    cell: &'static OnceLock<reqwest::Client>,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    if let Some(client) = cell.get() {
        return Ok(client.clone());
    }

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| {
            format!("AGENT_SIDECAR_CLIENT_ERROR: 创建 sidecar HTTP 客户端失败：{error}")
        })?;

    // 并发首次初始化时可能有多个线程同时 build；set 失败说明已有实例，复用既有的即可。
    let _ = cell.set(client.clone());
    Ok(cell.get().cloned().unwrap_or(client))
}

/// 长超时客户端：用于 chat / plan / execute 等可能长时间流式的请求。
fn client() -> Result<reqwest::Client, String> {
    static REQUEST_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    shared_client(
        &REQUEST_CLIENT,
        Duration::from_secs(SIDECAR_REQUEST_TIMEOUT_SECONDS),
    )
}

/// 短超时客户端：仅用于 /health 探测，避免探测请求复用长超时设置而迟迟不返回。
fn health_client() -> Result<reqwest::Client, String> {
    static HEALTH_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    shared_client(
        &HEALTH_CLIENT,
        Duration::from_secs(SIDECAR_HEALTH_TIMEOUT_SECONDS),
    )
}

/// 仅对默认本地 sidecar 的请求附加 Bearer 鉴权令牌；
/// 通过 XIAOJIANC_AGENT_SIDECAR_URL 指向的自定义远端不附加，
/// 避免把本地生成的令牌泄露给第三方端点。令牌缺失时原样返回（退回不鉴权的既有行为）。
fn apply_sidecar_auth(
    builder: reqwest::RequestBuilder,
    base_url: &str,
) -> reqwest::RequestBuilder {
    if is_default_local_sidecar_url(base_url)
        && let Some(token) = sidecar_auth_token()
    {
        return builder.bearer_auth(token);
    }
    builder
}

async fn decode_response<T: DeserializeOwned>(
    response: reqwest::Response,
    endpoint: &str,
) -> Result<T, String> {
    let status = response.status();
    let text = response.text().await.map_err(|error| {
        format!("AGENT_SIDECAR_READ_ERROR: 读取 sidecar 响应失败({endpoint})：{error}")
    })?;

    if !status.is_success() {
        let clipped = text.chars().take(480).collect::<String>();
        return Err(format!(
            "AGENT_SIDECAR_HTTP_ERROR: sidecar 返回 HTTP {status}({endpoint})：{clipped}"
        ));
    }

    serde_json::from_str(&text).map_err(|error| {
        format!("AGENT_SIDECAR_CONTRACT_ERROR: sidecar 响应无法解析({endpoint})：{error}")
    })
}

async fn get_json<T: DeserializeOwned>(endpoint: &str) -> Result<T, String> {
    let base_url = configured_base_url();
    ensure_default_sidecar_available(&base_url).await?;

    let url = build_sidecar_url(&base_url, endpoint);
    let response = apply_sidecar_auth(client()?.get(&url), &base_url)
        .send()
        .await
        .map_err(|error| {
            format!("AGENT_SIDECAR_UNAVAILABLE: 无法连接 Node sidecar({url})：{error}")
        })?;

    decode_response(response, endpoint).await
}

async fn post_json<TRequest, TResponse>(
    endpoint: &str,
    payload: &TRequest,
) -> Result<TResponse, String>
where
    TRequest: Serialize,
    TResponse: DeserializeOwned,
{
    let base_url = configured_base_url();
    ensure_default_sidecar_available(&base_url).await?;

    let url = build_sidecar_url(&base_url, endpoint);
    let response = apply_sidecar_auth(client()?.post(&url), &base_url)
        .json(payload)
        .send()
        .await
        .map_err(|error| {
            format!("AGENT_SIDECAR_UNAVAILABLE: 无法连接 Node sidecar({url})：{error}")
        })?;

    decode_response(response, endpoint).await
}

fn is_retryable_narrator_sidecar_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();

    normalized.contains(" http 429")
        || normalized.contains(" too many requests")
        || normalized.contains(" rate limit")
        || normalized.contains(" retry later")
        || normalized.contains("temporarily unavailable")
        || normalized.contains(" timeout")
        || normalized.contains(" timed out")
        || normalized.contains("就绪")
        || normalized.contains(" connection reset")
        || normalized.contains(" connection aborted")
        || normalized.contains(" broken pipe")
        || normalized.contains(" eof")
        || normalized.contains(" http 500")
        || normalized.contains(" http 502")
        || normalized.contains(" http 503")
        || normalized.contains(" http 504")
}

async fn post_json_with_narrator_retry<TRequest, TResponse>(
    endpoint: &str,
    payload: &TRequest,
) -> Result<TResponse, String>
where
    TRequest: Serialize,
    TResponse: DeserializeOwned,
{
    let total_attempts = NARRATOR_CHAT_RETRY_DELAYS_MS.len() + 1;
    let mut last_retryable_error: Option<String> = None;

    for attempt_index in 0..total_attempts {
        match post_json(endpoint, payload).await {
            Ok(response) => return Ok(response),
            Err(error) if is_retryable_narrator_sidecar_error(&error) => {
                last_retryable_error = Some(error);
            }
            Err(error) => return Err(error),
        }

        if let Some(&retry_delay_ms) = NARRATOR_CHAT_RETRY_DELAYS_MS.get(attempt_index) {
            tokio::time::sleep(Duration::from_millis(retry_delay_ms)).await;
        }
    }

    Err(last_retryable_error.unwrap_or_else(|| {
        format!("AGENT_SIDECAR_UNAVAILABLE: Narrator sidecar 重试 {total_attempts} 次后仍未成功。")
    }))
}

fn create_sidecar_session_id(prefix: &str) -> String {
    format!("{prefix}-{}", { jiff::Timestamp::now().as_nanosecond() })
}

fn ensure_request_session_id(session_id: &mut Option<String>, prefix: &str) -> String {
    if let Some(existing) = session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return existing.to_string();
    }

    let next_session_id = create_sidecar_session_id(prefix);
    *session_id = Some(next_session_id.clone());
    next_session_id
}

fn emit_sidecar_stream_event(
    app: &AppHandle,
    session_id: &str,
    seq: u64,
    event: serde_json::Value,
) {
    let payload = AgentSidecarStreamEventPayload {
        session_id: session_id.to_string(),
        seq,
        event,
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("ai:sidecar-stream", payload);
    }
}

/// 从 sidecar UI 事件中提取“最终回答”阶段的增量文本。
///
/// 仅当事件为 `message_delta` 且 `phase` 为 `final` 或缺省时返回其 `text`；
/// `stage` 阶段（过渡性内容）、空文本以及其它事件类型一律返回 `None`，
/// 以便聊天网关只把真正属于回答的增量实时下发到 `ai:chat-stream`。
pub fn answer_delta_text(event: &serde_json::Value) -> Option<String> {
    if event.get("type").and_then(|value| value.as_str()) != Some("message_delta") {
        return None;
    }

    if let Some(phase) = event.get("phase").and_then(|value| value.as_str())
        && phase != "final"
    {
        return None;
    }

    event
        .get("text")
        .and_then(|value| value.as_str())
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string())
}

fn decode_sidecar_stream_line(
    line: &str,
    endpoint: &str,
) -> Result<AgentSidecarStreamFrame, String> {
    serde_json::from_str::<AgentSidecarStreamFrame>(line).map_err(|error| {
        format!("AGENT_SIDECAR_CONTRACT_ERROR: sidecar 流式响应无法解析({endpoint})：{error}")
    })
}

fn decode_sidecar_stream_line_bytes(
    mut line_bytes: Vec<u8>,
    endpoint: &str,
) -> Result<String, String> {
    if line_bytes.ends_with(b"\n") {
        line_bytes.pop();
    }

    if line_bytes.ends_with(b"\r") {
        line_bytes.pop();
    }

    String::from_utf8(line_bytes).map_err(|error| {
        format!("AGENT_SIDECAR_CONTRACT_ERROR: sidecar 流式响应包含非法 UTF-8({endpoint})：{error}")
    })
}

fn drain_complete_sidecar_stream_lines(
    buffer: &mut Vec<u8>,
    endpoint: &str,
) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();

    while let Some(line_end) = buffer.iter().position(|byte| *byte == b'\n') {
        let line_bytes = buffer.drain(..=line_end).collect::<Vec<u8>>();
        lines.push(decode_sidecar_stream_line_bytes(line_bytes, endpoint)?);
    }

    Ok(lines)
}

/// 防御超长未完成行：当读缓冲中尚未出现换行符的残留字节超过上限时报错，
/// 避免恶意 / 异常的不换行响应把缓冲撑爆。正常流式（按 `\n` 成行下发）不受影响。
fn ensure_sidecar_stream_buffer_within_limit(
    buffer_len: usize,
    endpoint: &str,
) -> Result<(), String> {
    if buffer_len > SIDECAR_STREAM_MAX_LINE_BYTES {
        return Err(format!(
            "AGENT_SIDECAR_STREAM_ERROR: sidecar 流式响应单行超过 {SIDECAR_STREAM_MAX_LINE_BYTES} 字节上限({endpoint})"
        ));
    }
    Ok(())
}

fn has_non_whitespace_bytes(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .any(|byte| !matches!(*byte, b' ' | b'\t' | b'\r' | b'\n'))
}

fn consume_sidecar_stream_line<F>(
    app: &AppHandle,
    session_id: &str,
    seq: &mut u64,
    line: &str,
    endpoint: &str,
    on_event: &mut F,
) -> Result<Option<AgentSidecarResponsePayload>, String>
where
    F: FnMut(&serde_json::Value),
{
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    match decode_sidecar_stream_line(trimmed, endpoint)? {
        AgentSidecarStreamFrame::Event { event } => {
            on_event(&event);
            emit_sidecar_stream_event(app, session_id, *seq, event);
            *seq += 1;
            Ok(None)
        }
        AgentSidecarStreamFrame::Response { response } => Ok(Some(response)),
        AgentSidecarStreamFrame::Error { error } => Err(format!(
            "AGENT_SIDECAR_STREAM_ERROR: sidecar 流式执行失败({endpoint})：{error}"
        )),
    }
}

async fn post_json_streaming_events_with_handler<TRequest, F>(
    app: &AppHandle,
    endpoint: &str,
    stream_endpoint: &str,
    payload: &TRequest,
    session_id: &str,
    on_event: &mut F,
) -> Result<AgentSidecarResponsePayload, String>
where
    TRequest: Serialize,
    F: FnMut(&serde_json::Value),
{
    let base_url = configured_base_url();
    ensure_default_sidecar_available(&base_url).await?;

    let url = build_sidecar_url(&base_url, stream_endpoint);
    let mut response = apply_sidecar_auth(client()?.post(&url), &base_url)
        .json(payload)
        .send()
        .await
        .map_err(|error| {
            format!("AGENT_SIDECAR_UNAVAILABLE: 无法连接 Node sidecar({url})：{error}")
        })?;

    let status = response.status();
    if status.as_u16() == 404 {
        return post_json(endpoint, payload).await;
    }
    if !status.is_success() {
        return decode_response(response, stream_endpoint).await;
    }

    let mut buffer: Vec<u8> = Vec::new();
    let mut seq = 0_u64;
    let mut final_response: Option<AgentSidecarResponsePayload> = None;

    while let Some(chunk) = response.chunk().await.map_err(|error| {
        format!("AGENT_SIDECAR_READ_ERROR: 读取 sidecar 流式响应失败({stream_endpoint})：{error}")
    })? {
        buffer.extend_from_slice(&chunk);

        for line in drain_complete_sidecar_stream_lines(&mut buffer, stream_endpoint)? {
            if let Some(response) = consume_sidecar_stream_line(
                app,
                session_id,
                &mut seq,
                &line,
                stream_endpoint,
                on_event,
            )? {
                final_response = Some(response);
            }
        }

        // 完整行均已抽走后，buffer 仅剩“未完成行”。一旦其超过上限即判定为异常并报错，
        // 防止永不换行的响应把缓冲无界撑大。正常按行下发的流式行为与视觉不受影响。
        ensure_sidecar_stream_buffer_within_limit(buffer.len(), stream_endpoint)?;
    }

    if has_non_whitespace_bytes(&buffer) {
        let line = decode_sidecar_stream_line_bytes(std::mem::take(&mut buffer), stream_endpoint)?;

        if let Some(response) = consume_sidecar_stream_line(
            app,
            session_id,
            &mut seq,
            &line,
            stream_endpoint,
            on_event,
        )? {
            final_response = Some(response);
        }
    }

    final_response.ok_or_else(|| {
        format!("AGENT_SIDECAR_CONTRACT_ERROR: sidecar 流式响应缺少最终结果({stream_endpoint})")
    })
}

async fn post_json_streaming_events<TRequest>(
    app: &AppHandle,
    endpoint: &str,
    stream_endpoint: &str,
    payload: &TRequest,
    session_id: &str,
) -> Result<AgentSidecarResponsePayload, String>
where
    TRequest: Serialize,
{
    let mut noop = |_event: &serde_json::Value| {};
    post_json_streaming_events_with_handler(
        app,
        endpoint,
        stream_endpoint,
        payload,
        session_id,
        &mut noop,
    )
    .await
}

fn is_default_local_sidecar_url(base_url: &str) -> bool {
    matches!(
        normalize_base_url(Some(base_url)).as_str(),
        "http://127.0.0.1:39871" | "http://localhost:39871" | "http://[::1]:39871"
    )
}

/// 进程级单飞锁：串行化对默认 sidecar 的并发 (重)启动，
/// 避免多个请求同时各自 spawn 出多个 Node 进程抢占同一端口。
fn sidecar_spawn_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn startup_timeout_seconds() -> u64 {
    clamp_startup_timeout_seconds(env_or_user_env(SIDECAR_STARTUP_TIMEOUT_ENV).as_deref())
}

fn clamp_startup_timeout_seconds(raw: Option<&str>) -> u64 {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|secs| {
            secs.clamp(
                SIDECAR_STARTUP_TIMEOUT_MIN_SECONDS,
                SIDECAR_STARTUP_TIMEOUT_MAX_SECONDS,
            )
        })
        .unwrap_or(SIDECAR_STARTUP_TIMEOUT_DEFAULT_SECONDS)
}

async fn ensure_default_sidecar_available(base_url: &str) -> Result<(), String> {
    if !is_default_local_sidecar_url(base_url) {
        return Ok(());
    }

    if probe_sidecar_health(base_url).await == SidecarHealthStatus::Ready {
        return Ok(());
    }

    // 单飞：串行化并发的 (重)启动。拿到锁前可能已被其它请求启动完成。
    let _guard = sidecar_spawn_lock().lock().await;

    match probe_sidecar_health(base_url).await {
        SidecarHealthStatus::Ready => return Ok(()),
        SidecarHealthStatus::Stale => {
            restart_stale_default_sidecar()?;
        }
        SidecarHealthStatus::Unavailable => {}
    }

    let timeout_secs = startup_timeout_seconds();
    let mut last_error: Option<String> = None;
    for _ in 0..SIDECAR_STARTUP_ATTEMPTS {
        let spawned_child = spawn_default_sidecar_if_absent()?;
        match wait_for_default_sidecar_ready(base_url, timeout_secs, spawned_child).await {
            Ok(()) => return Ok(()),
            // 进程确定性崩溃（如依赖缺失导致 ERR_MODULE_NOT_FOUND）：重试只会重复崩溃，
            // 直接快速失败，把修复建议 + 日志末尾返回，不再空等整个就绪超时。
            Err(error) if is_crashed_sidecar_error(&error) => return Err(error),
            Err(error) => {
                last_error = Some(error);
                // 本轮窗口内仍未就绪：清掉可能卡死/半启动的进程后再试一轮。
                let _ = restart_stale_default_sidecar();
            }
        }
    }

    let mut error = last_error.unwrap_or_else(|| {
        format!(
            "AGENT_SIDECAR_UNAVAILABLE: Node sidecar 已尝试启动，但未在 {timeout_secs} 秒内就绪。"
        )
    });
    if let Some(tail) = read_sidecar_log_tail() {
        error.push_str("\n--- service.log（末尾）---\n");
        error.push_str(&tail);
    }
    Err(error)
}

async fn wait_for_default_sidecar_ready(
    base_url: &str,
    timeout_secs: u64,
    mut spawned_child: Option<Child>,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    while tokio::time::Instant::now() < deadline {
        match probe_sidecar_health(base_url).await {
            SidecarHealthStatus::Ready => return Ok(()),
            SidecarHealthStatus::Stale => {
                restart_stale_default_sidecar()?;
                spawned_child = spawn_default_sidecar_if_absent()?;
            }
            SidecarHealthStatus::Unavailable => {
                // 快速失败：本轮 spawn 的进程若已退出（如依赖缺失导致 ERR_MODULE_NOT_FOUND），
                // 继续轮询只会空等到超时，这里一旦发现崩溃就立即带诊断返回。
                if let Some(crash_error) = take_crashed_sidecar_error(&mut spawned_child) {
                    return Err(crash_error);
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(SIDECAR_STARTUP_RETRY_MS)).await;
    }

    Err(format!(
        "AGENT_SIDECAR_UNAVAILABLE: Node sidecar 已尝试启动，但未在 {timeout_secs} 秒内就绪。"
    ))
}

pub async fn restart() -> Result<AgentSidecarHealthPayload, String> {
    let base_url = configured_base_url();
    if !is_default_local_sidecar_url(&base_url) {
        return Err("AGENT_SIDECAR_UNAVAILABLE: 仅支持重启默认本地 Node sidecar。".to_string());
    }

    {
        let _guard = sidecar_spawn_lock().lock().await;
        restart_stale_default_sidecar()?;
        let spawned_child = spawn_default_sidecar()?;
        wait_for_default_sidecar_ready(&base_url, startup_timeout_seconds(), Some(spawned_child))
            .await?;
    }
    health().await
}

async fn probe_sidecar_health(base_url: &str) -> SidecarHealthStatus {
    let Ok(client) = health_client() else {
        return SidecarHealthStatus::Unavailable;
    };
    let url = build_sidecar_url(base_url, "/health");

    let Ok(response) = client.get(url).send().await else {
        return SidecarHealthStatus::Unavailable;
    };

    if !response.status().is_success() {
        return SidecarHealthStatus::Unavailable;
    }

    let Ok(payload) = response.json::<SidecarHealthProbePayload>().await else {
        return SidecarHealthStatus::Unavailable;
    };

    classify_sidecar_health(&payload)
}

fn restart_stale_default_sidecar() -> Result<(), String> {
    let pids = find_listening_pids_for_port(DEFAULT_SIDECAR_PORT)?;
    for pid in pids {
        terminate_process(pid)?;
    }

    Ok(())
}

/// 应用退出时收口默认本地 sidecar：杀掉其监听进程及整棵子进程树
/// （连同派生的 Node / MCP / uvx 等子进程，配合 terminate_process 的 `/T`）。
/// 仅作用于默认本地 sidecar；指向自定义远端（XIAOJIANC_AGENT_SIDECAR_URL）时不处理。
/// 尽力而为：任何一步失败都只记录日志，绝不 panic 或阻断退出流程。
pub fn shutdown_default_sidecar() {
    if !is_default_local_sidecar_url(&configured_base_url()) {
        return;
    }

    match find_listening_pids_for_port(DEFAULT_SIDECAR_PORT) {
        Ok(pids) => {
            for pid in pids {
                if let Err(error) = terminate_process(pid) {
                    eprintln!("退出清理：结束 sidecar 进程 {pid} 失败：{error}");
                }
            }
        }
        Err(error) => {
            eprintln!("退出清理：查询 sidecar 监听进程失败：{error}");
        }
    }
}

/// 端口是否已有进程在监听。用于在 spawn 前去重：若已有 sidecar 在启动中，
/// 就不要再拉起一个会因 EADDRINUSE 崩溃的重复进程。
fn is_port_listening(port: u16) -> bool {
    find_listening_pids_for_port(port)
        .map(|pids| !pids.is_empty())
        .unwrap_or(false)
}

#[cfg(windows)]
fn find_listening_pids_for_port(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|error| format!("AGENT_SIDECAR_UNAVAILABLE: 查询旧 sidecar 进程失败：{error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_netstat_listening_pids(&stdout, port))
}

#[cfg(not(windows))]
fn find_listening_pids_for_port(_port: u16) -> Result<Vec<u32>, String> {
    Ok(Vec::new())
}

fn parse_netstat_listening_pids(output: &str, port: u16) -> Vec<u32> {
    let port_suffix = format!(":{port}");
    let mut pids = Vec::new();

    for line in output.lines() {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 5 {
            continue;
        }

        if !columns[0].eq_ignore_ascii_case("TCP")
            || !columns[1].ends_with(&port_suffix)
            || !columns[3].eq_ignore_ascii_case("LISTENING")
        {
            continue;
        }

        let Ok(pid) = columns[4].parse::<u32>() else {
            continue;
        };

        if !pids.contains(&pid) {
            pids.push(pid);
        }
    }

    pids
}

/// 解析 `tasklist /FI "IMAGENAME eq node.exe" /NH /FO CSV` 的输出：命中目标 PID 时会
/// 输出含 `node.exe` 的 CSV 行，未命中则输出 “INFO: No tasks ...”。大小写不敏感比较，
/// 以兼容不同区域设置 / 版本下镜像名的大小写差异。
fn tasklist_reports_node_image(stdout: &str) -> bool {
    stdout.to_ascii_lowercase().contains("node.exe")
}

/// 在对端口监听进程执行破坏性的 `taskkill /T /F` 前，确认该 PID 当前仍是 node.exe
/// （sidecar 运行时）。`find_listening_pids_for_port` 的 netstat 快照与真正下手之间存在
/// 时间窗：监听进程可能已退出、其 PID 被系统回收给无关进程，此时直接 `/T /F` 会误杀
/// 无辜进程及其整棵子进程树。校验镜像名把误杀面收敛到“极小窗口内 PID 又恰好被另一个
/// node 进程复用”的可忽略概率。探测失败时保守放行（返回 true），维持既有按端口清理行为。
#[cfg(windows)]
fn process_image_is_node(pid: u32) -> bool {
    let mut command = Command::new("tasklist");
    command
        .args([
            "/FI",
            &format!("PID eq {pid}"),
            "/FI",
            "IMAGENAME eq node.exe",
            "/NH",
            "/FO",
            "CSV",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    crate::commands::configure_std_command_for_background(&mut command);

    let Ok(output) = command.output() else {
        return true;
    };

    tasklist_reports_node_image(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<(), String> {
    // PID 复用防护：仅当目标 PID 当前仍是 node.exe（sidecar 运行时）时才执行破坏性的
    // taskkill /T /F，避免端口监听进程在 netstat 快照后退出、PID 被系统回收给无关进程
    // 时误杀整棵无辜进程树。探测失败则保守放行，维持既有清理行为。
    if !process_image_is_node(pid) {
        eprintln!("跳过结束进程 {pid}：当前已非 node.exe，疑似 PID 已被系统回收复用");
        return Ok(());
    }

    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::commands::configure_std_command_for_background(&mut command);

    let status = command.status().map_err(|error| {
        format!("AGENT_SIDECAR_UNAVAILABLE: 结束旧 sidecar 进程 {pid} 失败：{error}")
    })?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "AGENT_SIDECAR_UNAVAILABLE: 结束旧 sidecar 进程 {pid} 失败，退出码：{status}"
        ))
    }
}

#[cfg(not(windows))]
fn terminate_process(_pid: u32) -> Result<(), String> {
    Ok(())
}

/// 运行时可写目录：统一落到用户主目录下的 `.calamex/ai-service`，与 AI 配置 /
/// 编辑历史共用同一品牌根（见 `storage_paths`），避免数据散落在 LOCALAPPDATA 等多处。
/// 主目录始终可写，既规避只读安装目录写入失败，也让同机数据集中、便于备份与排查。
fn sidecar_runtime_dir() -> PathBuf {
    crate::storage_paths::local_root().join("ai-service")
}

/// 本地 sidecar 鉴权令牌：进程内只生成 / 读取一次，并持久化到运行时目录。
/// 持久化的意义在于宿主重启后若旧 sidecar 仍在监听端口，二者仍能共享同一令牌，
/// 不至于因令牌不一致而全部 401。生成 / 读取失败时返回 None
/// （退回到“不鉴权”的既有行为，绝不因此阻断 sidecar 启动）。
fn sidecar_auth_token() -> Option<String> {
    static TOKEN: OnceLock<Option<String>> = OnceLock::new();
    TOKEN.get_or_init(load_or_create_sidecar_auth_token).clone()
}

fn load_or_create_sidecar_auth_token() -> Option<String> {
    let token_path = sidecar_runtime_dir().join("auth.token");

    // 复用已持久化的令牌：宿主重启后与仍在运行的旧 sidecar 保持一致。
    if let Ok(existing) = fs::read_to_string(&token_path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let token = generate_sidecar_auth_token()?;

    if let Some(parent) = token_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // 写盘失败不致命：本进程仍可用内存中的令牌（注入 env 与请求头一致），
    // 仅牺牲“跨宿主重启复用仍在运行的旧 sidecar”这一项。
    let _ = fs::write(&token_path, &token);

    Some(token)
}

/// 用操作系统 CSPRNG 生成 32 字节随机令牌，并以十六进制编码为 64 个字符。
fn generate_sidecar_auth_token() -> Option<String> {
    use std::fmt::Write as _;

    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).ok()?;

    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    Some(token)
}

/// sidecar 运行日志文件路径（位于用户级可写运行时目录下）。
/// App 启动 sidecar 时把 stdout/stderr 重定向到这里，便于排查
/// sidecar 进程在流式过程中崩溃 / 抛未捕获异常的原因。
fn sidecar_log_path() -> PathBuf {
    sidecar_runtime_dir().join("service.log")
}

/// 打开 sidecar 日志文