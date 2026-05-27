//! LSP (Language Server Protocol) 集成
//!
//! 管理 bash-language-server 进程，通过 JSON-RPC over stdio 通信。
//! 诊断通过 Tauri 事件 `lsp-diagnostics` 推送到前端；
//! 补全 / 悬停采用同步 request/response，由 oneshot channel 关联 id。
//!
//! 设计要点:
//! - LSP 位置使用 UTF-16 code units (LSP 3.x 默认)。前端列号需按 UTF-16 计算。
//! - 子进程由独立 watcher 任务 own；进程崩溃会把 state 置回 Stopped 并 emit `lsp-crashed`。
//! - 启动流程被 `startup` 互斥锁串行化，避免 TOCTOU 双实例。
//! - 反向 request (server → client) 对常见方法返回合规响应，对未知方法返回 MethodNotFound。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex},
    time::timeout,
};

// ============================================================================
// 数据结构
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub severity: u32, // 1=Error, 2=Warning, 3=Info, 4=Hint
    pub message: String,
    pub code: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionItem {
    pub label: String,
    pub insert_text: Option<String>,
    pub kind: Option<u32>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspHoverResult {
    pub contents: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LspState {
    Stopped,
    Running,
}

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>;

struct LspSession {
    state: LspState,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    next_id: i64,
    open_files: HashMap<String, String>, // path → uri
    workspace_root: Option<String>,
    /// 单调递增，每次 start +1。watcher 比对此值，避免在新一代实例上写状态。
    generation: u64,
    /// drop 即向 watcher 发出"主动停止"信号，使其不要再 emit `lsp-crashed`。
    kill_tx: Option<oneshot::Sender<()>>,
}

impl LspSession {
    fn new() -> Self {
        Self {
            state: LspState::Stopped,
            stdin: None,
            next_id: 1,
            open_files: HashMap::new(),
            workspace_root: None,
            generation: 0,
            kill_tx: None,
        }
    }
}

pub struct LspManager {
    session: Arc<Mutex<LspSession>>,
    pending: PendingMap,
    /// 串行化 `lsp_start` 的整条路径，防止两次启动并发产生双实例。
    startup: Mutex<()>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(LspSession::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            startup: Mutex::new(()),
        }
    }
}

// ============================================================================
// JSON-RPC 工具
// ============================================================================

fn jsonrpc_request(id: i64, method: &str, params: Value) -> String {
    serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string()
}

fn jsonrpc_notify(method: &str, params: Value) -> String {
    serde_json::json!({"jsonrpc":"2.0","method":method,"params":params}).to_string()
}

fn jsonrpc_ok_response(id: &Value, result: Value) -> String {
    serde_json::json!({"jsonrpc":"2.0","id":id,"result":result}).to_string()
}

fn jsonrpc_error_response(id: &Value, code: i64, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
    .to_string()
}

fn frame_message(content: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", content.len(), content).into_bytes()
}

// --- 极简 percent-encoding（纯 Rust，零依赖）-------------------------------

/// 对 file path 做 percent-encoding。保留 `unreserved` 字符 + `/` + `:`。
/// 其它字节 (空格、`#`、中文 UTF-8 字节等) 编码成 `%XX`。
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => out.push(b as char),
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{:02X}", b);
            }
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = (bytes[i + 1] as char).to_digit(16);
            let l = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn path_to_uri(path: &str) -> Result<String, String> {
    let normalized = path.replace('\\', "/");
    // 去掉 Windows 扩展路径前缀(\\?\ 或 //?/),避免打断后续 trim 逻辑
    let cleaned = if cfg!(windows) {
        if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
            format!("//{}", rest)
        } else if let Some(rest) = normalized.strip_prefix("//?/") {
            rest.to_string()
        } else if let Some(rest) = normalized.strip_prefix("//./") {
            rest.to_string()
        } else {
            normalized
        }
    } else {
        normalized
    };

    if cfg!(windows) {
        let trimmed = cleaned.trim_start_matches('/');
        Ok(format!("file:///{}", percent_encode_path(trimmed)))
    } else {
        let with_slash = if cleaned.starts_with('/') {
            cleaned
        } else {
            format!("/{}", cleaned)
        };
        Ok(format!("file://{}", percent_encode_path(&with_slash)))
    }
}

fn uri_to_path(uri: &str) -> String {
    let s = uri.strip_prefix("file://").unwrap_or(uri);
    let decoded = percent_decode(s);
    if cfg!(windows) && decoded.starts_with('/') {
        decoded[1..].to_string()
    } else {
        decoded
    }
}

// ============================================================================
// 内部 I/O
// ============================================================================

/// 把数据写入 LSP stdin。**不要在持有 session 锁时调用**——先取 stdin 句柄再 drop 锁。
async fn write_framed(stdin: &Arc<Mutex<ChildStdin>>, data: &[u8]) -> Result<(), String> {
    let mut s = stdin.lock().await;
    s.write_all(data).await.map_err(|e| format!("写入 LSP 失败: {e}"))?;
    s.flush().await.map_err(|e| format!("flush 失败: {e}"))?;
    Ok(())
}

async fn read_lsp_stdout(
    app: AppHandle,
    stdout: ChildStdout,
    pending: PendingMap,
    stdin: Arc<Mutex<ChildStdin>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut header_line = String::new();
    loop {
        // 1) 读 header
        let mut content_length: Option<usize> = None;
        loop {
            header_line.clear();
            match reader.read_line(&mut header_line).await {
                Ok(0) => return, // EOF
                Ok(_) => {
                    let line = header_line.trim_end_matches(&['\r', '\n'][..]);
                    if line.is_empty() {
                        break;
                    }
                    if let Some(val) =
                        line.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        content_length = val.trim().parse().ok();
                    }
                }
                Err(e) => {
                    log::warn!("LSP stdout header 读取失败: {e}");
                    return;
                }
            }
        }
        let len = match content_length {
            Some(l) if l > 0 && l < 10_000_000 => l,
            Some(l) => {
                // body 长度异常,无法继续保持流同步,直接退出 reader。
                log::error!("LSP body 长度异常 ({l}),断开 reader");
                return;
            }
            None => continue,
        };

        // 2) 读 body
        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            log::warn!("LSP stdout body 读取失败: {e}");
            return;
        }
        let msg: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                log::error!(
                    "LSP body JSON 解析失败: {e}; body={}",
                    String::from_utf8_lossy(&body)
                );
                continue;
            }
        };

        // 3) 分派
        dispatch_message(&app, &pending, &stdin, msg).await;
    }
}

async fn dispatch_message(
    app: &AppHandle,
    pending: &PendingMap,
    stdin: &Arc<Mutex<ChildStdin>>,
    msg: Value,
) {
    let has_id = msg.get("id").is_some();
    let has_method = msg.get("method").is_some();

    match (has_id, has_method) {
        // 响应:有 id、无 method
        (true, false) => {
            if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
                let tx = pending.lock().await.remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(msg);
                }
            }
        }
        // server → client request:有 id、有 method
        (true, true) => {
            handle_reverse_request(stdin, &msg).await;
        }
        // notification:无 id、有 method
        (false, true) => {
            let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
            match method {
                "textDocument/publishDiagnostics" => {
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("");
                    let empty: Vec<Value> = Vec::new();
                    let diags = params
                        .get("diagnostics")
                        .and_then(|v| v.as_array())
                        .unwrap_or(&empty);
                    handle_diagnostics(app, uri, diags);
                }
                "window/logMessage" | "window/showMessage" => {
                    if let Some(text) = msg.pointer("/params/message").and_then(|v| v.as_str()) {
                        log::debug!("[bash-ls] {method}: {text}");
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

/// 对常见的 server → client request 返回合规响应,其它一律 MethodNotFound。
async fn handle_reverse_request(stdin: &Arc<Mutex<ChildStdin>>, msg: &Value) {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");

    let result: Option<Value> = match method {
        // 我们没有动态配置,对每个 item 返回 null。
        "workspace/configuration" => {
            let count = msg
                .pointer("/params/items")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            Some(Value::Array(vec![Value::Null; count]))
        }
        // 我们没有 workspaceFolders 能力,但礼貌回空数组。
        "workspace/workspaceFolders" => Some(Value::Array(vec![])),
        // 动态注册/反注册:接受但不实际处理。
        "client/registerCapability" | "client/unregisterCapability" => Some(Value::Null),
        // 进度创建:同意。
        "window/workDoneProgress/create" => Some(Value::Null),
        _ => None,
    };

    let payload = match result {
        Some(r) => jsonrpc_ok_response(&id, r),
        None => jsonrpc_error_response(&id, -32601, "Method not found"),
    };
    if let Err(e) = write_framed(stdin, &frame_message(&payload)).await {
        log::warn!("回复 server-request ({method}) 失败: {e}");
    }
}

// ============================================================================
// ShellCheck 中文本地化(来自 Messages_zh.json)
// ============================================================================
const SHELLCHECK_ZH_JSON: &str = include_str!("../../../resources/Messages_zh.json");
static ZH_MESSAGES: std::sync::OnceLock<std::collections::HashMap<String, String>> =
    std::sync::OnceLock::new();

fn zh_message(code: &str) -> Option<&'static str> {
    let map = ZH_MESSAGES.get_or_init(|| {
        match serde_json::from_str::<HashMap<String, String>>(
            SHELLCHECK_ZH_JSON.trim_start_matches('\u{FEFF}'),
        ) {
            Ok(m) => m,
            Err(e) => {
                log::error!("加载 ShellCheck 中文化失败: {e}");
                HashMap::new()
            }
        }
    });
    map.get(code).map(|s| s.as_str())
}

/// 从 diagnostic JSON 中抽取 code (string / number / { value })。
fn extract_diag_code(d: &Value) -> Option<String> {
    let c = &d["code"];
    if let Some(s) = c.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = c.as_i64() {
        return Some(n.to_string());
    }
    if let Some(v) = c.get("value") {
        if let Some(s) = v.as_str() {
            return Some(s.to_string());
        }
        if let Some(n) = v.as_i64() {
            return Some(n.to_string());
        }
    }
    None
}

fn handle_diagnostics(app: &AppHandle, uri: &str, diags: &[Value]) {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    static PENDING: std::sync::LazyLock<Mutex<HashMap<String, Vec<Value>>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    static FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);

    {
        let mut guard = PENDING.lock().unwrap();
        guard.insert(uri.to_string(), diags.to_vec());
    }

    if !FLUSH_SCHEDULED.swap(true, Ordering::AcqRel) {
        let app = app.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            // 关键：先清标志再 take，防止 take→emit→清标志之间插入的诊断被 stranded
            let batch = {
                let mut guard = PENDING.lock().unwrap();
                FLUSH_SCHEDULED.store(false, Ordering::Release);
                std::mem::take(&mut *guard)
            };
            for (file_uri, file_diags) in batch {
                let file_path = uri_to_path(&file_uri);
                let lsp_diagnostics: Vec<LspDiagnostic> = file_diags
                    .iter()
                    .map(|d| {
                        let range = &d["range"];
                        let raw = d["message"].as_str().unwrap_or("");
                        let code = extract_diag_code(d);
                        let message = match code.as_deref().and_then(zh_message) {
                            Some(zh) => format!("{raw} · {zh}"),
                            None => raw.to_string(),
                        };
                        LspDiagnostic {
                            file_path: file_path.clone(),
                            line: range["start"]["line"].as_u64().unwrap_or(0) as u32,
                            column: range["start"]["character"].as_u64().unwrap_or(0) as u32,
                            end_line: range["end"]["line"].as_u64().unwrap_or(0) as u32,
                            end_column: range["end"]["character"].as_u64().unwrap_or(0) as u32,
                            severity: d["severity"].as_u64().unwrap_or(1) as u32,
                            message,
                            code,
                            source: d["source"].as_str().map(String::from),
                        }
                    })
                    .collect();
                let payload = serde_json::json!({
                    "filePath": file_path,
                    "diagnostics": lsp_diagnostics,
                });
                if let Err(e) = app.emit("lsp-diagnostics", &payload) {
                    log::warn!("发送 LSP 诊断失败: {e}");
                }
            }
        });
    }
}

/// 发送一个 request 并等待响应。
async fn send_request(
    pending: &PendingMap,
    stdin: &Arc<Mutex<ChildStdin>>,
    id: i64,
    method: &str,
    params: Value,
    wait: Duration,
) -> Result<Value, String> {
    let (tx, rx) = oneshot::channel();
    pending.lock().await.insert(id, tx);

    let msg = frame_message(&jsonrpc_request(id, method, params));
    if let Err(e) = write_framed(stdin, &msg).await {
        pending.lock().await.remove(&id);
        return Err(e);
    }

    match timeout(wait, rx).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) => {
            pending.lock().await.remove(&id);
            Err("LSP 响应通道已关闭".into())
        }
        Err(_) => {
            pending.lock().await.remove(&id);
            Err(format!("LSP 请求 {method} 超时"))
        }
    }
}

// ============================================================================
// 二进制路径解析
// ============================================================================

/// 解析 bash-language-server 的启动参数:(node 可执行文件, CLI 入口 JS)。
fn resolve_lsp_command() -> Result<(PathBuf, PathBuf), String> {
    let node = resolve_node_executable()?;
    let cli_js = resolve_lsp_cli_js()?;
    Ok((node, cli_js))
}

fn resolve_node_executable() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("XIAOJIANC_NODE_EXE") {
        let p = PathBuf::from(&path);
        if p.is_file() {
            return Ok(p);
        }
    }

    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(&pf).join("nodejs").join(exe_name));
        }
        if let Ok(pfx86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(&pfx86).join("nodejs").join(exe_name));
        }
    } else {
        candidates.push(PathBuf::from("/usr/local/bin").join(exe_name));
        candidates.push(PathBuf::from("/usr/bin").join(exe_name));
        // nvm: ~/.nvm/versions/node/<version>/bin/node — 取按名字最大的那个版本
        if let Ok(home) = std::env::var("HOME") {
            let nvm_root = PathBuf::from(&home).join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm_root) {
                let mut versions: Vec<PathBuf> =
                    entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                versions.sort();
                for v in versions.iter().rev() {
                    let candidate = v.join("bin").join(exe_name);
                    if candidate.is_file() {
                        candidates.push(candidate);
                        break;
                    }
                }
            }
        }
    }

    for c in &candidates {
        if c.is_file() {
            log::info!("找到 node: {}", c.display());
            return Ok(c.clone());
        }
    }

    if let Some(p) = find_in_path(exe_name) {
        log::info!("PATH 中找到 node: {}", p.display());
        return Ok(p);
    }

    Err("未找到 node 可执行文件。请安装 Node.js 或设置 XIAOJIANC_NODE_EXE 环境变量。".into())
}

fn resolve_lsp_cli_js() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir.parent().ok_or("无法定位项目根目录")?;

    let candidate = workspace_root
        .join("node_modules")
        .join("bash-language-server")
        .join("out")
        .join("cli.js");
    if candidate.is_file() {
        log::info!("找到 bash-language-server CLI: {}", candidate.display());
        return Ok(candidate);
    }

    if cfg!(windows) {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let pnpm_global = PathBuf::from(&local)
                .join("pnpm")
                .join("global")
                .join("5")
                .join("node_modules")
                .join("bash-language-server")
                .join("out")
                .join("cli.js");
            if pnpm_global.is_file() {
                return Ok(pnpm_global);
            }
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            let npm_global = PathBuf::from(&appdata)
                .join("npm")
                .join("node_modules")
                .join("bash-language-server")
                .join("out")
                .join("cli.js");
            if npm_global.is_file() {
                return Ok(npm_global);
            }
        }
    } else {
        if let Ok(home) = std::env::var("HOME") {
            for prefix in &[".npm-global", ".local/share/pnpm/global/5"] {
                let candidate = PathBuf::from(&home)
                    .join(prefix)
                    .join("node_modules")
                    .join("bash-language-server")
                    .join("out")
                    .join("cli.js");
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        for prefix in &["/usr/local/lib", "/usr/lib"] {
            let candidate = PathBuf::from(prefix)
                .join("node_modules")
                .join("bash-language-server")
                .join("out")
                .join("cli.js");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "未找到 bash-language-server CLI。请运行 pnpm install 或 npm i -g bash-language-server。\n查找路径: {}",
        candidate.display()
    ))
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path).find_map(|dir| {
            let candidate = dir.join(name);
            candidate.is_file().then_some(candidate)
        })
    })
}

// ============================================================================
// Tauri 命令
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn lsp_start(
    app: AppHandle,
    manager: tauri::State<'_, LspManager>,
    workspace_root: String,
) -> Result<(), String> {
    // 整条启动路径串行化,杜绝双实例。
    let _startup_guard = manager.startup.lock().await;

    // 先把已有实例彻底停掉(不再用 TOCTOU 模式)。
    stop_inner(&manager.session, &manager.pending).await;

    let (node, cli_js) =
        resolve_lsp_command().map_err(|e| format!("无法启动 bash-language-server: {e}"))?;
    let mut child = Command::new(&node)
        .arg(&cli_js)
        .arg("start")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!(
                "无法启动 bash-language-server (node={} cli={}): {e}。请确认已安装 Node.js。",
                node.display(),
                cli_js.display()
            )
        })?;

    let stdin = child.stdin.take().ok_or("无法获取 stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
    let stderr = child.stderr.take().ok_or("无法获取 stderr")?;
    let stdin_arc = Arc::new(Mutex::new(stdin));
    let pending = manager.pending.clone();

    // stdout reader
    {
        let app_reader = app.clone();
        let pending = pending.clone();
        let stdin_for_dispatch = stdin_arc.clone();
        tokio::spawn(async move {
            read_lsp_stdout(app_reader, stdout, pending, stdin_for_dispatch).await;
        });
    }

    // stderr reader
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("[bash-ls stderr] {line}");
        }
    });

    // initialize (阻塞等响应,符合协议)
    let root_uri = path_to_uri(&workspace_root)?;
    let init_params = serde_json::json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "rootPath": workspace_root,
        "capabilities": {
            "general": {
                "positionEncodings": ["utf-16"]
            },
            "textDocument": {
                "synchronization": { "didSave": true, "dynamicRegistration": false },
                "publishDiagnostics": { "relatedInformation": true },
                "completion": { "completionItem": { "snippetSupport": true } },
                "hover": { "contentFormat": ["markdown", "plaintext"] }
            },
            "workspace": { "workspaceFolders": false }
        },
        // 显式禁用 shellcheck,使用 bash-language-server 内置语法解析
        "initializationOptions": { "shellcheckPath": "" }
    });

    let _init_resp = send_request(
        &pending,
        &stdin_arc,
        0i64,
        "initialize",
        init_params,
        Duration::from_secs(10),
    )
    .await
    .map_err(|e| format!("initialize 失败: {e}"))?;

    // initialized 通知
    let initiated = frame_message(&jsonrpc_notify("initialized", serde_json::json!({})));
    write_framed(&stdin_arc, &initiated)
        .await
        .map_err(|e| format!("写入 initialized 失败: {e}"))?;

    // 写回 session,并启动 watcher
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let generation = {
        let mut session = manager.session.lock().await;
        session.stdin = Some(stdin_arc);
        session.workspace_root = Some(workspace_root.clone());
        session.next_id = 1;
        session.state = LspState::Running;
        session.generation = session.generation.wrapping_add(1);
        session.kill_tx = Some(kill_tx);
        session.generation
    };

    // child watcher:负责 wait() 收尸 + 崩溃时清理状态 / emit 事件
    {
        let session = manager.session.clone();
        let pending = manager.pending.clone();
        let app_for_event = app.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = kill_rx => {
                    // 主动 stop 路径:由 stop_inner 负责 kill 与状态清理,这里不再插手。
                    log::debug!("LSP watcher: 收到主动停止信号,退出");
                }
                status = child.wait() => {
                    log::warn!("bash-language-server 进程退出: {status:?}");
                    // 只在仍是同一代实例时才清理,避免覆盖新一轮启动的状态
                    let mut s = session.lock().await;
                    if s.generation == generation && s.state == LspState::Running {
                        s.state = LspState::Stopped;
                        s.stdin = None;
                        s.open_files.clear();
                        s.kill_tx = None;
                        drop(s);
                        pending.lock().await.clear();
                        if let Err(e) = app_for_event.emit("lsp-crashed", &serde_json::json!({
                            "exitStatus": format!("{status:?}"),
                        })) {
                            log::warn!("发送 lsp-crashed 事件失败: {e}");
                        }
                    }
                }
            }
        });
    }

    log::info!("bash-language-server 已启动,workspace: {workspace_root}");
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_stop(manager: tauri::State<'_, LspManager>) -> Result<(), String> {
    stop_inner(&manager.session, &manager.pending).await;
    Ok(())
}

/// 主动停止当前实例。watcher 会感知 `kill_tx` 被 drop 而自行退出,不再 emit `lsp-crashed`。
async fn stop_inner(
    session: &Arc<Mutex<LspSession>>,
    pending: &PendingMap,
) {
    let (stdin, kill_tx, was_running) = {
        let mut s = session.lock().await;
        let was_running = s.state == LspState::Running;
        s.state = LspState::Stopped;
        s.open_files.clear();
        let stdin = s.stdin.take();
        let kill_tx = s.kill_tx.take();
        (stdin, kill_tx, was_running)
    };
    pending.lock().await.clear();
    if !was_running {
        return;
    }

    // 通知 watcher 进入"主动停止"分支
    if let Some(tx) = kill_tx {
        let _ = tx.send(());
    }

    // 尝试优雅 shutdown:发请求并尽量等响应,然后发 exit。
    if let Some(stdin) = stdin {
        let (resp_tx, resp_rx) = oneshot::channel::<Value>();
        let shutdown_id = i64::MAX;
        pending.lock().await.insert(shutdown_id, resp_tx);

        let shutdown =
            frame_message(&jsonrpc_request(shutdown_id, "shutdown", Value::Null));
        let _ = write_framed(&stdin, &shutdown).await;

        // 最多等 500ms
        let _ = timeout(Duration::from_millis(500), resp_rx).await;
        pending.lock().await.remove(&shutdown_id);

        let exit = frame_message(&jsonrpc_notify("exit", Value::Null));
        let _ = write_framed(&stdin, &exit).await;
    }

    // 子进程依赖 `kill_on_drop` 在 Child 被 drop 时强杀(watcher 持有 child)。
    // watcher 在 kill_rx 触发后即返回,Child 随之被 drop。
    log::info!("bash-language-server 已停止");
}

/// 统一的"取 stdin + uri + 分配 id"辅助。未启动时一律返回 Err。
async fn require_running_with_uri(
    manager: &LspManager,
    file_path: &str,
    bump_id: bool,
) -> Result<(Arc<Mutex<ChildStdin>>, String, i64), String> {
    let mut session = manager.session.lock().await;
    if session.state != LspState::Running {
        return Err("LSP 未启动".into());
    }
    let uri = session
        .open_files
        .get(file_path)
        .ok_or_else(|| format!("文件未打开: {file_path}"))?
        .clone();
    let stdin = session
        .stdin
        .clone()
        .ok_or_else(|| "stdin 不可用".to_string())?;
    let id = if bump_id {
        let id = session.next_id;
        session.next_id += 1;
        id
    } else {
        0
    };
    Ok((stdin, uri, id))
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_did_open(
    manager: tauri::State<'_, LspManager>,
    file_path: String,
    content: String,
    language_id: String,
) -> Result<(), String> {
    let uri = path_to_uri(&file_path)?;
    let stdin = {
        let mut session = manager.session.lock().await;
        if session.state != LspState::Running {
            return Err("LSP 未启动".into());
        }
        session.open_files.insert(file_path.clone(), uri.clone());
        session
            .stdin
            .clone()
            .ok_or_else(|| "stdin 不可用".to_string())?
    };
    let params = serde_json::json!({
        "textDocument": { "uri": uri, "languageId": language_id, "version": 1, "text": content }
    });
    let msg = frame_message(&jsonrpc_notify("textDocument/didOpen", params));
    write_framed(&stdin, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_did_change(
    manager: tauri::State<'_, LspManager>,
    file_path: String,
    content: String,
    version: i64,
) -> Result<(), String> {
    let (stdin, uri, _) = require_running_with_uri(&manager, &file_path, false).await?;
    let params = serde_json::json!({
        "textDocument": { "uri": uri, "version": version },
        "contentChanges": [{ "text": content }]
    });
    let msg = frame_message(&jsonrpc_notify("textDocument/didChange", params));
    write_framed(&stdin, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_did_close(
    manager: tauri::State<'_, LspManager>,
    file_path: String,
) -> Result<(), String> {
    let (stdin, uri) = {
        let mut session = manager.session.lock().await;
        if session.state != LspState::Running {
            return Err("LSP 未启动".into());
        }
        let uri = match session.open_files.remove(&file_path) {
            Some(u) => u,
            None => return Ok(()),
        };
        (
            session
                .stdin
                .clone()
                .ok_or_else(|| "stdin 不可用".to_string())?,
            uri,
        )
    };
    let params = serde_json::json!({ "textDocument": { "uri": uri } });
    let msg = frame_message(&jsonrpc_notify("textDocument/didClose", params));
    write_framed(&stdin, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_completion(
    manager: tauri::State<'_, LspManager>,
    file_path: String,
    line: u32,
    column: u32,
) -> Result<Vec<LspCompletionItem>, String> {
    let (stdin, uri, id) = require_running_with_uri(&manager, &file_path, true).await?;
    let params = serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": column }
    });
    let resp = send_request(
        &manager.pending,
        &stdin,
        id,
        "textDocument/completion",
        params,
        Duration::from_secs(2),
    )
    .await?;
    Ok(parse_completion(
        resp.get("result").cloned().unwrap_or(Value::Null),
    ))
}

fn parse_completion(result: Value) -> Vec<LspCompletionItem> {
    let items = if let Some(items) = result.get("items").and_then(|v| v.as_array()) {
        items.clone()
    } else if let Some(arr) = result.as_array() {
        arr.clone()
    } else {
        return vec![];
    };
    items
        .into_iter()
        .map(|it| LspCompletionItem {
            label: it["label"].as_str().unwrap_or("").to_string(),
            insert_text: it["insertText"].as_str().map(String::from),
            kind: it["kind"].as_u64().map(|n| n as u32),
            detail: it["detail"].as_str().map(String::from),
            documentation: it["documentation"]
                .as_str()
                .map(String::from)
                .or_else(|| {
                    it["documentation"]
                        .get("value")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                }),
        })
        .collect()
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_hover(
    manager: tauri::State<'_, LspManager>,
    file_path: String,
    line: u32,
    column: u32,
) -> Result<Option<LspHoverResult>, String> {
    let (stdin, uri, id) = require_running_with_uri(&manager, &file_path, true).await?;
    let params = serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": column }
    });
    let resp = send_request(
        &manager.pending,
        &stdin,
        id,
        "textDocument/hover",
        params,
        Duration::from_secs(1),
    )
    .await?;
    Ok(parse_hover(resp.get("result").cloned().unwrap_or(Value::Null)))
}

fn parse_hover(result: Value) -> Option<LspHoverResult> {
    if result.is_null() {
        return None;
    }
    let contents = result.get("contents")?;
    let text = match contents {
        Value::String(s) => s.clone(),
        Value::Object(o) => o
            .get("value")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Object(o) => o.get("value").and_then(|x| x.as_str()).map(String::from),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => return None,
    };
    if text.is_empty() {
        None
    } else {
        Some(LspHoverResult { contents: text })
    }
}

// ============================================================================
// 测试
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_to_uri_simple() {
        let uri = path_to_uri("/home/user/test.sh").unwrap();
        assert!(uri.starts_with("file://"));
        assert!(uri.ends_with("test.sh"));
    }

    #[test]
    fn test_path_to_uri_encodes_spaces_and_unicode() {
        let uri = path_to_uri("/home/user/My Scripts/测试.sh").unwrap();
        assert!(uri.contains("%20"));
        // 中文 UTF-8 字节会被 percent-encoded
        assert!(uri.contains("%E6%B5%8B")); // '测' = E6 B5 8B
    }

    #[test]
    fn test_uri_to_path_roundtrip() {
        let original = "/home/user/My Scripts/测试.sh";
        let uri = path_to_uri(original).unwrap();
        assert_eq!(uri_to_path(&uri), original);
    }

    #[test]
    fn test_uri_to_path_basic() {
        assert_eq!(
            uri_to_path("file:///home/user/test.sh"),
            "/home/user/test.sh"
        );
    }

    #[test]
    fn test_frame_message() {
        let msg = jsonrpc_request(1, "test", serde_json::json!({}));
        let framed = frame_message(&msg);
        let framed_str = String::from_utf8_lossy(&framed);
        assert!(framed_str.starts_with("Content-Length:"));
        assert!(framed_str.contains("\r\n\r\n"));
    }

    #[test]
    fn test_parse_hover_string() {
        let v = serde_json::json!({ "contents": "hello" });
        let r = parse_hover(v).unwrap();
        assert_eq!(r.contents, "hello");
    }

    #[test]
    fn test_parse_completion_array_and_obj() {
        let arr = serde_json::json!([{"label":"echo","kind":3}]);
        assert_eq!(parse_completion(arr).len(), 1);
        let obj = serde_json::json!({"items":[{"label":"ls"}]});
        assert_eq!(parse_completion(obj).len(), 1);
    }

    #[test]
    fn test_extract_diag_code_variants() {
        assert_eq!(
            extract_diag_code(&serde_json::json!({"code": "SC2086"})),
            Some("SC2086".into())
        );
        assert_eq!(
            extract_diag_code(&serde_json::json!({"code": 2086})),
            Some("2086".into())
        );
        assert_eq!(
            extract_diag_code(&serde_json::json!({"code": {"value": "SC2086"}})),
            Some("SC2086".into())
        );
        assert_eq!(
            extract_diag_code(&serde_json::json!({"code": {"value": 2086}})),
            Some("2086".into())
        );
        assert_eq!(extract_diag_code(&serde_json::json!({})), None);
    }

    #[test]
    fn test_severity_defaults_to_error() {
        // 缺省 severity 应当被当作 Error (1),不再当作 Warning。
        let app_test_diag = serde_json::json!({
            "range": {
                "start": {"line": 0, "character": 0},
                "end":   {"line": 0, "character": 1}
            },
            "message": "x"
        });
        let s = app_test_diag["severity"].as_u64().unwrap_or(1) as u32;
        assert_eq!(s, 1);
    }
}