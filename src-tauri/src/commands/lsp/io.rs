//! LSP stdin/stdout I/O：写帧、读取分派、请求-响应。

use std::{sync::Arc, time::Duration};

use serde_json::Value;
use tauri::AppHandle;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::{Mutex, oneshot},
    time::timeout,
};

use super::diagnostics::handle_diagnostics;
use super::protocol::{
    frame_message, jsonrpc_error_response, jsonrpc_ok_response, jsonrpc_request,
};
use super::types::PendingMap;

/// 把数据写入 LSP stdin。**不要在持有 session 锁时调用**——先取 stdin 句柄再 drop 锁。
pub(crate) async fn write_framed(
    stdin: &Arc<Mutex<ChildStdin>>,
    data: &[u8],
) -> Result<(), String> {
    let mut s = stdin.lock().await;
    s.write_all(data)
        .await
        .map_err(|e| format!("写入 LSP 失败: {e}"))?;
    s.flush().await.map_err(|e| format!("flush 失败: {e}"))?;
    Ok(())
}

pub(crate) async fn read_lsp_stdout(
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

/// 发送一个 request 并等待响应。
pub(crate) async fn send_request(
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
