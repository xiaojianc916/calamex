//! LSP (Language Server Protocol) 集成
//!
//! 管理 bash-language-server 进程，通过 JSON-RPC over stdio 通信。
//! 诊断通过 Tauri 事件 `lsp-diagnostics` 推送到前端；
//! 补全 / 悬停采用同步 request/response，由 oneshot channel 关联 id。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
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
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    next_id: i64,
    open_files: HashMap<String, String>, // path → uri
    workspace_root: Option<String>,
}

impl LspSession {
    fn new() -> Self {
        Self {
            state: LspState::Stopped,
            child: None,
            stdin: None,
            next_id: 1,
            open_files: HashMap::new(),
            workspace_root: None,
        }
    }
}

pub struct LspManager {
    session: Mutex<LspSession>,
    pending: PendingMap,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(LspSession::new()),
            pending: Arc::new(Mutex::new(HashMap::new())),
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

fn jsonrpc_error_response(id: &Value, code: i64, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }).to_string()
}

fn frame_message(content: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", content.len(), content).into_bytes()
}

fn path_to_uri(path: &str) -> Result<String, String> {
    // NOTE: 未做 percent-encoding；含空格 / 非 ASCII 路径可能不合规。
    // 生产建议引入 `url` 或 `percent-encoding`。
    let normalized = path.replace('\\', "/");
    if cfg!(windows) {
        Ok(format!("file:///{}", normalized.trim_start_matches('/')))
    } else {
        let with_slash = if normalized.starts_with('/') {
            normalized
        } else {
            format!("/{}", normalized)
        };
        Ok(format!("file://{}", with_slash))
    }
}

fn uri_to_path(uri: &str) -> String {
    let s = uri.strip_prefix("file://").unwrap_or(uri);
    if cfg!(windows) && s.starts_with('/') {
        s[1..].to_string()
    } else {
        s.to_string()
    }
}

// ============================================================================
// 内部 I/O
// ============================================================================

/// 把数据写入 LSP stdin。**不要在持有 session 锁时调用**——先从 session 取出 stdin 句柄再 drop 锁。
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
                    if let Some(val) = line.to_ascii_lowercase().strip_prefix("content-length:") {
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
            _ => continue,
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
                log::warn!("LSP body JSON 解析失败: {e}; body={}",
                    String::from_utf8_lossy(&body));
                continue;
            }
        };

        // 3) 分派：response / notification / server-request
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
        // 响应：有 id、无 method
        (true, false) => {
            if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
                let tx = pending.lock().await.remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(msg);
                }
            }
        }
        // server → client request：有 id、有 method → 回 MethodNotFound
        (true, true) => {
            let id = msg.get("id").cloned().unwrap_or(Value::Null);
            let resp = frame_message(&jsonrpc_error_response(&id, -32601, "Method not found"));
            if let Err(e) = write_framed(stdin, &resp).await {
                log::warn!("回复 server-request 失败: {e}");
            }
        }
        // notification：无 id、有 method
        (false, true) => {
            let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
            match method {
                "textDocument/publishDiagnostics" => {
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("");
                    let empty: Vec<Value> = vec![];
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

fn handle_diagnostics(app: &AppHandle, uri: &str, diags: &[Value]) {
    let file_path = uri_to_path(uri);
    let lsp_diagnostics: Vec<LspDiagnostic> = diags
        .iter()
        .map(|d| {
            let range = &d["range"];
            LspDiagnostic {
                file_path: file_path.clone(),
                line: range["start"]["line"].as_u64().unwrap_or(0) as u32,
                column: range["start"]["character"].as_u64().unwrap_or(0) as u32,
                end_line: range["end"]["line"].as_u64().unwrap_or(0) as u32,
                end_column: range["end"]["character"].as_u64().unwrap_or(0) as u32,
                severity: d["severity"].as_u64().unwrap_or(2) as u32,
                message: d["message"].as_str().unwrap_or("").to_string(),
                code: d["code"]
                    .as_str()
                    .map(String::from)
                    .or_else(|| d["code"].get("value").and_then(|v| v.as_str()).map(String::from)),
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
// Tauri 命令
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn lsp_start(
    app: AppHandle,
    manager: tauri::State<'_, LspManager>,
    workspace_root: String,
) -> Result<(), String> {
    // 先确保旧实例关闭
    {
        let session = manager.session.lock().await;
        if session.state == LspState::Running {
            drop(session);
            lsp_stop_internal(&manager).await;
        }
    }

    let mut child = Command::new("bash-language-server")
        .arg("start")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!("无法启动 bash-language-server: {e}。请确认已安装：npm i -g bash-language-server@^5")
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

    // initialize（阻塞等响应，符合协议）
    let root_uri = path_to_uri(&workspace_root)?;
    let init_params = serde_json::json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "rootPath": workspace_root,
        "capabilities": {
            "textDocument": {
                "synchronization": { "didSave": true, "dynamicRegistration": false },
                "publishDiagnostics": { "relatedInformation": true },
                "completion": { "completionItem": { "snippetSupport": true } },
                "hover": { "contentFormat": ["markdown", "plaintext"] }
            },
            "workspace": { "workspaceFolders": false }
        },
        "initializationOptions": { "enableShellCheck": true }
    });

    let init_id = 0i64;
    let _init_resp = send_request(
        &pending,
        &stdin_arc,
        init_id,
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

    // 写回 session
    {
        let mut session = manager.session.lock().await;
        session.stdin = Some(stdin_arc);
        session.child = Some(child);
        session.workspace_root = Some(workspace_root.clone());
        session.next_id = 1;
        session.state = LspState::Running;
    }
    log::info!("bash-language-server 已启动，workspace: {workspace_root}");
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_stop(manager: tauri::State<'_, LspManager>) -> Result<(), String> {
    lsp_stop_internal(&manager).await;
    Ok(())
}

async fn lsp_stop_internal(manager: &LspManager) {
    let (child, stdin) = {
        let mut session = manager.session.lock().await;
        let child = session.child.take();
        let stdin = session.stdin.take();
        session.state = LspState::Stopped;
        session.open_files.clear();
        (child, stdin)
    };
    manager.pending.lock().await.clear();

    // 尝试优雅 shutdown
    if let Some(stdin) = stdin {
        let shutdown = frame_message(&jsonrpc_request(i64::MAX, "shutdown", Value::Null));
        let _ = write_framed(&stdin, &shutdown).await;
        let exit = frame_message(&jsonrpc_notify("exit", Value::Null));
        let _ = write_framed(&stdin, &exit).await;
    }

    if let Some(mut child) = child {
        // 给 200ms 自己退出，超时则强杀
        let wait = async { let _ = child.wait().await; };
        if timeout(Duration::from_millis(200), wait).await.is_err() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
    log::info!("bash-language-server 已停止");
}

/// 抽出"取出 stdin/uri 并 drop 锁"的辅助
async fn take_handles(
    manager: &LspManager,
) -> Result<Arc<Mutex<ChildStdin>>, String> {
    let session = manager.session.lock().await;
    if session.state != LspState::Running {
        return Err("LSP 未启动".into());
    }
    session.stdin.clone().ok_or_else(|| "stdin 不可用".into())
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
        session.stdin.clone().ok_or("stdin 不可用")?
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
    let (stdin, uri) = {
        let session = manager.session.lock().await;
        if session.state != LspState::Running {
            return Ok(());
        }
        let uri = session
            .open_files
            .get(&file_path)
            .ok_or_else(|| format!("文件未打开: {file_path}"))?
            .clone();
        (session.stdin.clone().ok_or("stdin 不可用")?, uri)
    };
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
        let uri = match session.open_files.remove(&file_path) {
            Some(u) => u,
            None => return Ok(()),
        };
        (session.stdin.clone().ok_or("stdin 不可用")?, uri)
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
    let (stdin, uri, id) = {
        let mut session = manager.session.lock().await;
        if session.state != LspState::Running {
            return Ok(vec![]);
        }
        let uri = session
            .open_files
            .get(&file_path)
            .ok_or_else(|| format!("文件未打开: {file_path}"))?
            .clone();
        let id = session.next_id;
        session.next_id += 1;
        (session.stdin.clone().ok_or("stdin 不可用")?, uri, id)
    };
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
    Ok(parse_completion(resp.get("result").cloned().unwrap_or(Value::Null)))
}

fn parse_completion(result: Value) -> Vec<LspCompletionItem> {
    // result 可能是 CompletionItem[] 或 { items: CompletionItem[] }
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
    let (stdin, uri, id) = {
        let mut session = manager.session.lock().await;
        if session.state != LspState::Running {
            return Ok(None);
        }
        let uri = session
            .open_files
            .get(&file_path)
            .ok_or_else(|| format!("文件未打开: {file_path}"))?
            .clone();
        let id = session.next_id;
        session.next_id += 1;
        (session.stdin.clone().ok_or("stdin 不可用")?, uri, id)
    };
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
    fn test_path_to_uri() {
        let uri = path_to_uri("/home/user/test.sh").unwrap();
        assert!(uri.starts_with("file://"));
        assert!(uri.ends_with("test.sh"));
    }

    #[test]
    fn test_uri_to_path() {
        assert_eq!(uri_to_path("file:///home/user/test.sh"), "/home/user/test.sh");
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
}