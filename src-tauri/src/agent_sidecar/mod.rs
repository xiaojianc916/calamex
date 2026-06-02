use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::ai::credential::CredentialStore;
use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,
    AgentSidecarCheckpointRestoreRequest, AgentSidecarExecuteRequest, AgentSidecarHealthPayload,
    AgentSidecarModelConfigPayload, AgentSidecarPlanApproveRequest, AgentSidecarPlanFinishRequest,
    AgentSidecarPlanQueryRequest, AgentSidecarPlanRejectRequest, AgentSidecarPlanReplanRequest,
    AgentSidecarPlanRequest, AgentSidecarPlanValidateRequest, AgentSidecarResponsePayload,
    AgentSidecarWarmupPayload, AgentSidecarWarmupRequest,
    AiWebFetchInput, AiWebFetchPayload, AiWebSearchInput, AiWebSearchPayload,
};

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
    canonicalize_local_base_url(normalize_base_url(env::var(SIDECAR_URL_ENV).ok().as_deref()))
}

/// 默认本地 sidecar 的 localhost / [::1] 写法统一规整为 127.0.0.1。
///
/// sidecar 仅监听 127.0.0.1；若配置/默认 URL 使用 `localhost`，在某些系统上会
/// 先解析到 IPv6 的 `::1`，导致健康探测与请求永远连不上 → 每次都 15 秒超时。
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

fn client_with_timeout(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| {
            format!("AGENT_SIDECAR_CLIENT_ERROR: 创建 sidecar HTTP 客户端失败：{error}")
        })
}

fn client() -> Result<reqwest::Client, String> {
    client_with_timeout(Duration::from_secs(SIDECAR_REQUEST_TIMEOUT_SECONDS))
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
    let response = client()?.get(&url).send().await.map_err(|error| {
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
    let response = client()?
        .post(&url)
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
    format!(
        "{prefix}-{}",
        { jiff::Timestamp::now().as_nanosecond() }
    )
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

    if let Some(phase) = event.get("phase").and_then(|value| value.as_str()) {
        if phase != "final" {
            return None;
        }
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
    let mut response = client()?
        .post(&url)
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
        spawn_default_sidecar_if_absent()?;
        match wait_for_default_sidecar_ready(base_url, timeout_secs).await {
            Ok(()) => return Ok(()),
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
        error.push_str("\n--- agent-sidecar.log（末尾）---\n");
        error.push_str(&tail);
    }
    Err(error)
}

async fn wait_for_default_sidecar_ready(base_url: &str, timeout_secs: u64) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    while tokio::time::Instant::now() < deadline {
        match probe_sidecar_health(base_url).await {
            SidecarHealthStatus::Ready => return Ok(()),
            SidecarHealthStatus::Stale => {
                restart_stale_default_sidecar()?;
                spawn_default_sidecar_if_absent()?;
            }
            SidecarHealthStatus::Unavailable => {}
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

    restart_stale_default_sidecar()?;
    spawn_default_sidecar()?;
    wait_for_default_sidecar_ready(&base_url, startup_timeout_seconds()).await?;
    health().await
}

async fn probe_sidecar_health(base_url: &str) -> SidecarHealthStatus {
    let Ok(client) = client_with_timeout(Duration::from_secs(SIDECAR_HEALTH_TIMEOUT_SECONDS))
    else {
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

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<(), String> {
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/F"])
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

/// sidecar 运行日志文件路径（位于 agent-sidecar 根目录下）。
/// App 启动 sidecar 时把 stdout/stderr 重定向到这里，便于排查
/// sidecar 进程在流式过程中崩溃 / 抛未捕获异常的原因。
fn sidecar_log_path(sidecar_root: &Path) -> PathBuf {
    sidecar_root.join("agent-sidecar.log")
}

/// 打开 sidecar 日志文件（append 追加），返回供 stdout / stderr 复用的两个句柄。
/// 不再每次 spawn 都截断，以免并发启动时互相清空、丢失崩溃诊断；
/// 超过上限则滚动一代（.old）以防无限增长。
/// 任意一步失败都安全回退到 `Stdio::null()`，绝不阻断 sidecar 启动。
fn open_sidecar_log_stdio(sidecar_root: &Path) -> (Stdio, Stdio) {
    let log_path = sidecar_log_path(sidecar_root);
    rotate_sidecar_log_if_oversized(&log_path);

    let Ok(stdout_file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    else {
        return (Stdio::null(), Stdio::null());
    };

    match stdout_file.try_clone() {
        Ok(stderr_file) => (Stdio::from(stdout_file), Stdio::from(stderr_file)),
        Err(_) => (Stdio::null(), Stdio::null()),
    }
}

/// 日志超过上限时滚动一代（重命名为 agent-sidecar.log.old），
/// 保留上一段日志用于排查，同时避免 append 模式无限增长。
fn rotate_sidecar_log_if_oversized(log_path: &Path) {
    let Ok(metadata) = fs::metadata(log_path) else {
        return;
    };
    if metadata.len() <= SIDECAR_LOG_MAX_BYTES {
        return;
    }
    let backup = log_path.with_file_name("agent-sidecar.log.old");
    let _ = fs::rename(log_path, backup);
}

/// 读取 sidecar 日志末尾若干字符，用于在启动失败时把诊断信息附到错误上。
fn read_sidecar_log_tail() -> Option<String> {
    let sidecar_root = resolve_sidecar_root().ok()?;
    let content = fs::read_to_string(sidecar_log_path(&sidecar_root)).ok()?;
    let trimmed = content.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let char_count = trimmed.chars().count();
    let skip = char_count.saturating_sub(SIDECAR_LOG_TAIL_CHARS);
    Some(trimmed.chars().skip(skip).collect())
}

/// 仅在端口尚无监听者时才 spawn，避免并发重复拉起导致 EADDRINUSE。
fn spawn_default_sidecar_if_absent() -> Result<(), String> {
    if is_port_listening(DEFAULT_SIDECAR_PORT) {
        return Ok(());
    }
    spawn_default_sidecar()
}

fn spawn_default_sidecar() -> Result<(), String> {
    let sidecar_root = resolve_sidecar_root()?;
    let node = resolve_node_executable()?;

    let (sidecar_stdout, sidecar_stderr) = open_sidecar_log_stdio(&sidecar_root);

    let mut command = Command::new(node);

    // 优先使用预编译产物 dist/server.js（无需运行时 tsx 转译，冷启动更快更稳）；
    // 不存在时回退到 tsx + src/server.ts，保持开发态与未构建场景可用。
    let compiled_server = sidecar_root.join("dist").join("server.js");
    if compiled_server.is_file() {
        command.arg(&compiled_server);
    } else {
        let tsx_cli = sidecar_root
            .join("node_modules")
            .join("tsx")
            .join("dist")
            .join("cli.mjs");
        let server = sidecar_root.join("src").join("server.ts");

        if !tsx_cli.is_file() {
            return Err(format!(
                "AGENT_SIDECAR_UNAVAILABLE: 未找到 sidecar TSX 启动器：{}",
                tsx_cli.display()
            ));
        }

        if !server.is_file() {
            return Err(format!(
                "AGENT_SIDECAR_UNAVAILABLE: 未找到 sidecar 入口：{}",
                server.display()
            ));
        }

        command.arg(tsx_cli).arg(server);
    }

    command
        .current_dir(&sidecar_root)
        .stdin(Stdio::null())
        .stdout(sidecar_stdout)
        .stderr(sidecar_stderr)
        .env("AGENT_SIDECAR_PORT", "39871")
        .env("NODE_COMPILE_CACHE", sidecar_root.join(".node-compile-cache"));

    inject_sidecar_dotenv_key_if_present(&mut command, &sidecar_root, "TAVILY_API_KEY");
    inject_user_env_if_present(&mut command, "TAVILY_API_KEY");
    inject_uvx_path(&mut command);

    crate::commands::configure_std_command_for_background(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("AGENT_SIDECAR_UNAVAILABLE: 启动 Node sidecar 失败：{error}"))
}

fn resolve_sidecar_root() -> Result<PathBuf, String> {
    if let Some(path) = env_or_user_env(SIDECAR_ROOT_ENV).map(PathBuf::from) {
        if path.is_dir() {
            return Ok(path);
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let Some(workspace_root) = manifest_dir.parent() else {
        return Err("AGENT_SIDECAR_UNAVAILABLE: 无法定位仓库根目录。".to_string());
    };
    let sidecar_root = workspace_root.join("agent-sidecar");

    if sidecar_root.is_dir() {
        return Ok(sidecar_root);
    }

    Err(format!(
        "AGENT_SIDECAR_UNAVAILABLE: 未找到 agent-sidecar 目录：{}",
        sidecar_root.display()
    ))
}

fn resolve_node_executable() -> Result<PathBuf, String> {
    if let Some(path) = env_or_user_env(NODE_EXE_ENV).map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }

    for candidate in node_executable_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    find_executable_in_path("node.exe")
        .or_else(|| find_executable_in_path("node"))
        .ok_or_else(|| {
            "AGENT_SIDECAR_UNAVAILABLE: 未找到 node.exe，请设置 XIAOJIANC_NODE_EXE。".to_string()
        })
}

fn node_executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(program_files) = env_or_user_env("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
    }
    if let Some(program_files_x86) = env_or_user_env("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("nodejs")
                .join("node.exe"),
        );
    }
    candidates
}

fn find_executable_in_path(file_name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path_value| {
        env::split_paths(&path_value)
            .map(|directory| directory.join(file_name))
            .find(|candidate| candidate.is_file())
    })
}

fn inject_uvx_path(command: &mut Command) {
    if let Some(path) = resolve_windows_uvx_path() {
        command.env(MCP_UVX_PATH_ENV, path);
    }
}

fn resolve_windows_uvx_path() -> Option<PathBuf> {
    if let Some(path) = env_or_user_env(MCP_UVX_PATH_ENV).map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    windows_uvx_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn windows_uvx_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(user_profile) = env_or_user_env("USERPROFILE") {
        let user_profile = PathBuf::from(user_profile);
        candidates.push(user_profile.join(".local").join("bin").join("uvx.exe"));
        candidates.push(user_profile.join(".cargo").join("bin").join("uvx.exe"));
    }
    if let Some(local_app_data) = env_or_user_env("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        candidates.push(local_app_data.join("Programs").join("uv").join("uvx.exe"));
        candidates.push(local_app_data.join("uv").join("uvx.exe"));
    }
    if let Some(program_files) = env_or_user_env("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("uv").join("uvx.exe"));
    }
    if let Some(program_files_x86) = env_or_user_env("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(program_files_x86).join("uv").join("uvx.exe"));
    }
    candidates
}

fn inject_user_env_if_present(command: &mut Command, key: &str) {
    if let Some(value) = env_or_user_env(key) {
        command.env(key, value);
    }
}

fn inject_sidecar_dotenv_key_if_present(command: &mut Command, sidecar_root: &Path, key: &str) {
    if env_or_user_env(key).is_some() {
        return;
    }

    let Ok(content) = fs::read_to_string(sidecar_root.join(".env")) else {
        return;
    };

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((name, raw_value)) = trimmed.split_once('=') else {
            continue;
        };

        if name.trim() != key {
            continue;
        }

        let value = raw_value.trim().trim_matches(['"', '\'']);
        if !value.is_empty() {
            command.env(key, value);
        }
        return;
    }
}

fn model_provider_id(model_id: &str) -> Result<&str, String> {
    let provider_id = model_id
        .split_once('/')
        .map(|(provider_id, _)| provider_id.trim())
        .filter(|provider_id| !provider_id.is_empty())
        .ok_or_else(|| "AI 模型 ID 缺少厂商前缀，请使用“厂商/模型”格式。".to_string())?;

    Ok(provider_id)
}

fn current_sidecar_model_config() -> Result<AgentSidecarModelConfigPayload, String> {
    let config = crate::ai::gateway::get_config();
    let model_id = config
        .selected_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AI 模型未配置：请先在 AI 设置中选择模型并保存。".to_string())?;
    let api_key = CredentialStore::get(model_provider_id(model_id)?)?;
    let base_url = config
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string());

    Ok(AgentSidecarModelConfigPayload {
        model_id: model_id.to_string(),
        api_key: api_key.into(),
        base_url,
    })
}

fn narrator_sidecar_model_config() -> Result<AgentSidecarModelConfigPayload, String> {
    let config = crate::ai::gateway::get_config();
    let model_id = config
        .narrator
        .selected_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Narrator 模型未配置：请先在 AI 设置中选择 Narrator 模型并保存。".to_string()
        })?;
    let api_key = CredentialStore::get(model_provider_id(model_id)?)?;
    let base_url = config
        .narrator
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string());

    Ok(AgentSidecarModelConfigPayload {
        model_id: model_id.to_string(),
        api_key: api_key.into(),
        base_url,
    })
}

fn env_or_user_env(key: &str) -> Option<String> {
    let process_value = env::var(key).ok().and_then(non_empty_string);
    if process_value.is_some() {
        return process_value;
    }

    read_user_environment_value(key).and_then(non_empty_string)
}

fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(windows)]
fn read_user_environment_value(key: &str) -> Option<String> {
    let output = Command::new("reg.exe")
        .args(["query", "HKCU\\Environment", "/v", key])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_reg_query_value(&stdout, key)
}

#[cfg(not(windows))]
fn read_user_environment_value(_key: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn parse_reg_query_value(output: &str, key: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with(key) {
            return None;
        }

        let mut parts = trimmed.split_whitespace();
        let name = parts.next()?;
        let _kind = parts.next()?;
        let value = parts.collect::<Vec<_>>().join(" ");

        (name == key).then_some(value).and_then(non_empty_string)
    })
}

pub async fn health() -> Result<AgentSidecarHealthPayload, String> {
    get_json("/health").await
}

pub async fn warmup() -> Result<AgentSidecarWarmupPayload, String> {
    post_json(
        "/agent/warmup",
        &AgentSidecarWarmupRequest {
            model_config: Some(current_sidecar_model_config()?),
        },
    )
    .await
}

pub async fn chat(
    app: AppHandle,
    mut payload: AgentSidecarChatRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    let session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-chat");
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json_streaming_events(
        &app,
        "/agent/chat",
        "/agent/chat/stream",
        &payload,
        &session_id,
    )
    .await
}

pub async fn plan(
    app: AppHandle,
    mut payload: AgentSidecarPlanRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    let session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-plan");
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json_streaming_events(
        &app,
        "/agent/plan",
        "/agent/plan/stream",
        &payload,
        &session_id,
    )
    .await
}

pub async fn approve_plan(
    payload: AgentSidecarPlanApproveRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    post_json("/agent/plan/approve", &payload).await
}

pub async fn query_plan(
    payload: AgentSidecarPlanQueryRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    post_json("/agent/plan/query", &payload).await
}

pub async fn reject_plan(
    payload: AgentSidecarPlanRejectRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    post_json("/agent/plan/reject", &payload).await
}

pub async fn finish_plan(
    payload: AgentSidecarPlanFinishRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    post_json("/agent/plan/finish", &payload).await
}

pub async fn validate_plan(
    mut payload: AgentSidecarPlanValidateRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json("/agent/plan/validate", &payload).await
}

pub async fn replan_plan(
    mut payload: AgentSidecarPlanReplanRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json("/agent/plan/replan", &payload).await
}

pub async fn execute(
    app: AppHandle,
    mut payload: AgentSidecarExecuteRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    let session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-agent");
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json_streaming_events(
        &app,
        "/agent/execute",
        "/agent/execute/stream",
        &payload,
        &session_id,
    )
    .await
}

pub async fn resolve_approval(
    app: AppHandle,
    mut payload: AgentSidecarApprovalResolveRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    let session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-approval");
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json_streaming_events(
        &app,
        "/approval/resolve",
        "/approval/resolve/stream",
        &payload,
        &session_id,
    )
    .await
}

pub async fn restore_checkpoint(
    app: AppHandle,
    mut payload: AgentSidecarCheckpointRestoreRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    let session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-rollback");
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json_streaming_events(
        &app,
        "/rollback/restore",
        "/rollback/restore/stream",
        &payload,
        &session_id,
    )
    .await
}

/// 流式聊天：在读取 sidecar NDJSON 事件流的同时，把每个 UI 事件交给
/// `on_event` 回调（聊天网关据此把 `message_delta` 增量实时下发到
/// `ai:chat-stream`），最终返回完整响应。除回调外，行为与既有流式路径一致。
pub async fn model_chat_streaming<F>(
    app: AppHandle,
    mut payload: AgentSidecarChatRequest,
    mut on_event: F,
) -> Result<AgentSidecarResponsePayload, String>
where
    F: FnMut(&serde_json::Value),
{
    let session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-model-chat");
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json_streaming_events_with_handler(
        &app,
        "/model/chat",
        "/model/chat/stream",
        &payload,
        &session_id,
        &mut on_event,
    )
    .await
}

pub async fn model_chat_once(
    mut payload: AgentSidecarChatRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    let _session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-model-chat");
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_json("/model/chat", &payload).await
}

pub async fn narrator_model_chat_once(
    mut payload: AgentSidecarChatRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    let _session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-narrator-chat");
    if payload.model_config.is_none() {
        payload.model_config = Some(narrator_sidecar_model_config()?);
    }
    post_json_with_narrator_retry("/model/chat", &payload).await
}

pub async fn web_search(payload: AiWebSearchInput) -> Result<AiWebSearchPayload, String> {
    post_json("/web/search", &payload).await
}

pub async fn web_fetch(payload: AiWebFetchInput) -> Result<AiWebFetchPayload, String> {
    post_json("/web/fetch", &payload).await
}

#[cfg(test)]
mod tests {
    use super::{
        answer_delta_text, build_sidecar_url, canonicalize_local_base_url,
        clamp_startup_timeout_seconds, classify_sidecar_health,
        drain_complete_sidecar_stream_lines, has_non_whitespace_bytes,
        inject_sidecar_dotenv_key_if_present, is_default_local_sidecar_url,
        is_retryable_narrator_sidecar_error, model_provider_id, normalize_base_url,
        parse_netstat_listening_pids, SidecarHealthProbePayload, SidecarHealthStatus,
        DEFAULT_SIDECAR_URL, SIDECAR_STARTUP_TIMEOUT_DEFAULT_SECONDS,
        SIDECAR_STARTUP_TIMEOUT_MAX_SECONDS, SIDECAR_STARTUP_TIMEOUT_MIN_SECONDS,
    };
    use std::fs;
    use std::process::Command;

    #[test]
    fn normalize_base_url_uses_default_when_env_is_empty() {
        assert_eq!(normalize_base_url(None), DEFAULT_SIDECAR_URL);
        assert_eq!(normalize_base_url(Some("   ")), DEFAULT_SIDECAR_URL);
    }

    #[test]
    fn normalize_base_url_strips_trailing_slash() {
        assert_eq!(
            normalize_base_url(Some("http://127.0.0.1:39871///")),
            "http://127.0.0.1:39871"
        );
    }

    #[test]
    fn build_sidecar_url_joins_endpoint_without_double_slash() {
        assert_eq!(
            build_sidecar_url("http://127.0.0.1:39871/", "/agent/chat"),
            "http://127.0.0.1:39871/agent/chat"
        );
    }

    #[test]
    fn only_default_local_sidecar_url_is_auto_started() {
        assert!(is_default_local_sidecar_url("http://127.0.0.1:39871"));
        assert!(is_default_local_sidecar_url("http://localhost:39871/"));
        assert!(!is_default_local_sidecar_url("http://127.0.0.1:49999"));
        assert!(!is_default_local_sidecar_url("https://agent.example.com"));
    }

    #[test]
    fn canonicalizes_localhost_and_ipv6_to_loopback_ipv4() {
        assert_eq!(
            canonicalize_local_base_url("http://localhost:39871".to_string()),
            DEFAULT_SIDECAR_URL
        );
        assert_eq!(
            canonicalize_local_base_url("http://[::1]:39871".to_string()),
            DEFAULT_SIDECAR_URL
        );
        assert_eq!(
            canonicalize_local_base_url("http://127.0.0.1:39871".to_string()),
            DEFAULT_SIDECAR_URL
        );
        assert_eq!(
            canonicalize_local_base_url("https://agent.example.com".to_string()),
            "https://agent.example.com"
        );
    }

    #[test]
    fn clamp_startup_timeout_uses_default_and_bounds() {
        assert_eq!(
            clamp_startup_timeout_seconds(None),
            SIDECAR_STARTUP_TIMEOUT_DEFAULT_SECONDS
        );
        assert_eq!(
            clamp_startup_timeout_seconds(Some("   ")),
            SIDECAR_STARTUP_TIMEOUT_DEFAULT_SECONDS
        );
        assert_eq!(
            clamp_startup_timeout_seconds(Some("not-a-number")),
            SIDECAR_STARTUP_TIMEOUT_DEFAULT_SECONDS
        );
        assert_eq!(
            clamp_startup_timeout_seconds(Some("1")),
            SIDECAR_STARTUP_TIMEOUT_MIN_SECONDS
        );
        assert_eq!(
            clamp_startup_timeout_seconds(Some("99999")),
            SIDECAR_STARTUP_TIMEOUT_MAX_SECONDS
        );
        assert_eq!(clamp_startup_timeout_seconds(Some("30")), 30);
    }

    #[test]
    fn startup_not_ready_error_is_retryable() {
        let error = "AGENT_SIDECAR_UNAVAILABLE: Node sidecar 已尝试启动，但未在 20 秒内就绪。";
        assert!(is_retryable_narrator_sidecar_error(error));
        assert!(!is_retryable_narrator_sidecar_error(
            "AGENT_SIDECAR_CONTRACT_ERROR: sidecar 响应无法解析"
        ));
    }

    #[test]
    fn answer_delta_text_extracts_only_final_phase_message_deltas() {
        let implicit_final = serde_json::json!({ "type": "message_delta", "text": "你好" });
        assert_eq!(answer_delta_text(&implicit_final).as_deref(), Some("你好"));

        let explicit_final =
            serde_json::json!({ "type": "message_delta", "text": "世界", "phase": "final" });
        assert_eq!(answer_delta_text(&explicit_final).as_deref(), Some("世界"));

        let stage_event =
            serde_json::json!({ "type": "message_delta", "text": "思考中", "phase": "stage" });
        assert_eq!(answer_delta_text(&stage_event), None);

        let empty_event = serde_json::json!({ "type": "message_delta", "text": "" });
        assert_eq!(answer_delta_text(&empty_event), None);

        let other_event =
            serde_json::json!({ "type": "tool_start", "toolName": "x", "input": {} });
        assert_eq!(answer_delta_text(&other_event), None);
    }

    #[test]
    fn parses_sidecar_listener_pid_from_netstat_output() {
        let output = r#"
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:39871        0.0.0.0:0              LISTENING       1234
  TCP    [::1]:39871            [::]:0                 LISTENING       1234
  TCP    127.0.0.1:39872        0.0.0.0:0              LISTENING       5678
"#;

        assert_eq!(parse_netstat_listening_pids(output, 39871), vec![1234]);
    }

    #[test]
    fn sidecar_stream_line_buffer_waits_for_complete_utf8_line() {
        let line =
            "{\"type\":\"event\",\"event\":{\"type\":\"message_delta\",\"text\":\"你好🙂\"}}\n";
        let split_at = line.find('你').expect("line should contain chinese") + 2;
        let bytes = line.as_bytes();
        let mut buffer = Vec::new();

        buffer.extend_from_slice(&bytes[..split_at]);
        let lines = drain_complete_sidecar_stream_lines(&mut buffer, "/agent/chat/stream")
            .expect("partial chunk should not decode incomplete utf8");
        assert!(lines.is_empty());

        buffer.extend_from_slice(&bytes[split_at..]);
        let lines = drain_complete_sidecar_stream_lines(&mut buffer, "/agent/chat/stream")
            .expect("complete line should decode");

        assert_eq!(lines, vec![line.trim_end_matches('\n').to_string()]);
        assert!(!lines[0].contains('\u{fffd}'));
        assert!(buffer.is_empty());
    }

    #[test]
    fn sidecar_stream_line_buffer_ignores_whitespace_tail() {
        assert!(!has_non_whitespace_bytes(b"\r\n\t "));
        assert!(has_non_whitespace_bytes(b"\n{}"));
    }

    #[test]
    fn injects_tavily_key_from_sidecar_dotenv_when_user_env_is_missing() {
        let sidecar_root =
            std::env::temp_dir().join(format!("xiaojianc-sidecar-env-test-{}", std::process::id()));

        fs::create_dir_all(&sidecar_root).expect("temp sidecar root should be created");
        fs::write(
            sidecar_root.join(".env"),
            "# comment\nXIAOJIANC_TEST_TAVILY_KEY=tvly-test-from-dotenv\n",
        )
        .expect("dotenv should be written");

        let mut command = Command::new("node");
        inject_sidecar_dotenv_key_if_present(
            &mut command,
            &sidecar_root,
            "XIAOJIANC_TEST_TAVILY_KEY",
        );

        let injected = command
            .get_envs()
            .find(|(key, _)| key.to_string_lossy() == "XIAOJIANC_TEST_TAVILY_KEY")
            .and_then(|(_, value)| value.map(|item| item.to_string_lossy().to_string()));

        assert_eq!(injected.as_deref(), Some("tvly-test-from-dotenv"));

        fs::remove_dir_all(sidecar_root).expect("temp sidecar root should be removed");
    }

    #[test]
    fn sidecar_health_is_runtime_name_agnostic() {
        let ready_payload = SidecarHealthProbePayload {
            ok: true,
            _engine: Some("mastra".to_string()),
            protocol_version: Some("7".to_string()),
            implementation_version: Some(
                "deepseek-reasoning-transport-v6-plan-history".to_string(),
            ),
        };
        let stale_payload = SidecarHealthProbePayload {
            ok: true,
            _engine: Some("custom-runtime".to_string()),
            protocol_version: Some("6".to_string()),
            implementation_version: None,
        };
        let unavailable_payload = SidecarHealthProbePayload {
            ok: false,
            _engine: Some("legacy-runtime".to_string()),
            protocol_version: Some("7".to_string()),
            implementation_version: Some(
                "deepseek-reasoning-transport-v6-plan-history".to_string(),
            ),
        };

        assert_eq!(
            classify_sidecar_health(&ready_payload),
            SidecarHealthStatus::Ready
        );
        assert_eq!(
            classify_sidecar_health(&stale_payload),
            SidecarHealthStatus::Stale
        );
        assert_eq!(
            classify_sidecar_health(&unavailable_payload),
            SidecarHealthStatus::Unavailable
        );
    }

    #[test]
    fn model_provider_id_uses_model_prefix() {
        assert_eq!(
            model_provider_id("deepseek/deepseek-v4-pro").unwrap(),
            "deepseek"
        );
        assert_eq!(model_provider_id(" openai/gpt-5.5 ").unwrap(), "openai");
        assert!(model_provider_id("gpt-5.5").is_err());
    }
}
