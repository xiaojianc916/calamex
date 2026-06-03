//! 对外 `#[tauri::command]` 入口与会话辅助。

use std::{sync::Arc, time::Duration};

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::timeout,
};

use super::discovery::{resolve_lsp_command, resolve_shellcheck_executable};
use super::io::{read_lsp_stdout, send_request, write_framed};
use super::protocol::{frame_message, jsonrpc_notify, jsonrpc_request, path_to_uri};
use super::types::{
    LspCompletionItem, LspHoverResult, LspManager, LspSession, LspState, PendingMap,
};

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

    // 解析 shellcheck 绝对路径。必须在 spawn 之前完成,因为要作为子进程环境变量传入。
    // 关键:bash-language-server 的 onInitialize 根本不读 initializationOptions,
    // 它在 onInitialized 时从环境变量 SHELLCHECK_PATH 或 workspace/configuration 读配置。
    // 我们未声明 configuration 能力,所以最稳妥的方式是用 SHELLCHECK_PATH 环境变量。
    // shellcheck 是诊断的唯一来源;找不到时退回裸名,至少保持旧行为。
    let shellcheck_path = resolve_shellcheck_executable()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "shellcheck".to_string());
    log::info!("bash-ls 将使用 SHELLCHECK_PATH={shellcheck_path}");

    let mut child = Command::new(&node)
        .arg(&cli_js)
        .arg("start")
        .env("SHELLCHECK_PATH", &shellcheck_path)
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
        // 注意:bash-language-server 的 onInitialize 会忽略 initializationOptions。
        // shellcheck 路径改为通过子进程环境变量 SHELLCHECK_PATH 传入(见上)。
        "initializationOptions": {}
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
async fn stop_inner(session: &Arc<Mutex<LspSession>>, pending: &PendingMap) {
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

    // 通知 watcher 进入\"主动停止\"分支
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

/// 统一的\"取 stdin + uri + 分配 id\"辅助。未启动时一律返回 Err。
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

#[cfg(test)]
mod tests {
    use super::*;

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
