use chrono::Utc;
use encoding_rs::{GB18030, UTF_16BE, UTF_16LE, UTF_8};
use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    cmp::Ordering,
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Size, State};
use tokio::{process::Command, time::timeout};

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);
const SPLASH_WINDOW_WIDTH: f64 = 780.0;
const SPLASH_WINDOW_HEIGHT: f64 = 520.0;
const MAIN_WINDOW_WIDTH: f64 = 1500.0;
const MAIN_WINDOW_HEIGHT: f64 = 960.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 1220.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 760.0;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFilePayload {
    path: String,
    name: String,
    content: String,
    encoding: String,
    line_count: usize,
    char_count: usize,
}

#[derive(Debug, Deserialize)]
pub struct SaveScriptRequest {
    path: String,
    content: String,
    encoding: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptRequest {
    path: Option<String>,
    content: String,
    encoding: String,
    executor: String,
    is_dirty: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptResponse {
    success: bool,
    stdout: String,
    stderr: String,
    combined_output: String,
    exit_code: Option<i32>,
    executor: String,
    executor_label: String,
    duration_ms: u128,
    started_at: String,
    finished_at: String,
    command_line: String,
    log_path: Option<String>,
    used_temp_file: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOption {
    r#type: String,
    label: String,
    available: bool,
    description: String,
    command_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironment {
    recommended: String,
    has_any: bool,
    executors: Vec<ExecutionOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    path: String,
    name: String,
    kind: String,
    has_children: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryPayload {
    root_path: String,
    root_name: String,
    entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureTerminalSessionRequest {
    session_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionPayload {
    session_id: String,
    cwd: String,
    shell_label: String,
    created: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTerminalScriptRequest {
    session_id: String,
    path: Option<String>,
    content: String,
    is_dirty: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTerminalScriptPayload {
    session_id: String,
    cwd: String,
    command_line: String,
    used_temp_file: bool,
    started_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputRequest {
    session_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeRequest {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseTerminalSessionRequest {
    session_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalDataEvent {
    session_id: String,
    data: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    session_id: String,
    exit_code: Option<i32>,
}

struct ExecutorCandidate {
    kind: &'static str,
    label: &'static str,
    description: &'static str,
    path: Option<PathBuf>,
    available: bool,
}

struct PreparedScript {
    execution_path: PathBuf,
    working_directory: PathBuf,
    used_temp_file: bool,
    cleanup_path: Option<PathBuf>,
}

struct TerminalDispatchCommand {
    raw_command: String,
    display_command: String,
    used_temp_file: bool,
}

struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    working_directory: String,
}

#[derive(Clone, Default)]
pub struct TerminalSessionState {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

#[tauri::command]
pub fn apply_window_stage(app: AppHandle, stage: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "未找到主窗口。".to_string())?;

    match stage.as_str() {
        "splash" => {
            let splash_size =
                Size::Logical(LogicalSize::new(SPLASH_WINDOW_WIDTH, SPLASH_WINDOW_HEIGHT));
            window
                .set_min_size(Some(splash_size))
                .map_err(|error| format!("设置欢迎窗最小尺寸失败：{error}"))?;
            window
                .set_size(splash_size)
                .map_err(|error| format!("设置欢迎窗尺寸失败：{error}"))?;
            window
                .set_resizable(false)
                .map_err(|error| format!("锁定欢迎窗尺寸失败：{error}"))?;
            window
                .center()
                .map_err(|error| format!("居中欢迎窗失败：{error}"))?;
        }
        "main" => {
            let main_size = Size::Logical(LogicalSize::new(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT));
            let main_min_size = Size::Logical(LogicalSize::new(
                MAIN_WINDOW_MIN_WIDTH,
                MAIN_WINDOW_MIN_HEIGHT,
            ));

            window
                .set_resizable(true)
                .map_err(|error| format!("恢复主窗口缩放失败：{error}"))?;
            window
                .set_size(main_size)
                .map_err(|error| format!("恢复主窗口尺寸失败：{error}"))?;
            window
                .set_min_size(Some(main_min_size))
                .map_err(|error| format!("设置主窗口最小尺寸失败：{error}"))?;
            window
                .center()
                .map_err(|error| format!("居中主窗口失败：{error}"))?;
            window
                .set_focus()
                .map_err(|error| format!("聚焦主窗口失败：{error}"))?;
        }
        _ => return Err(format!("不支持的窗口阶段：{stage}")),
    }

    Ok(())
}

#[tauri::command]
pub fn show_startup_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "未找到主窗口。".to_string())?;

    let splash_size = Size::Logical(LogicalSize::new(SPLASH_WINDOW_WIDTH, SPLASH_WINDOW_HEIGHT));
    window
        .set_min_size(Some(splash_size))
        .map_err(|error| format!("设置欢迎窗最小尺寸失败：{error}"))?;
    window
        .set_size(splash_size)
        .map_err(|error| format!("设置欢迎窗尺寸失败：{error}"))?;
    window
        .set_resizable(false)
        .map_err(|error| format!("锁定欢迎窗尺寸失败：{error}"))?;
    window
        .center()
        .map_err(|error| format!("居中欢迎窗失败：{error}"))?;
    window
        .show()
        .map_err(|error| format!("显示欢迎窗失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦欢迎窗失败：{error}"))?;

    Ok(())
}

#[tauri::command]
pub fn ensure_terminal_session(
    app: AppHandle,
    state: State<TerminalSessionState>,
    payload: EnsureTerminalSessionRequest,
) -> Result<TerminalSessionPayload, String> {
    let terminal_state = state.inner().clone();

    if let Some(existing_session) = get_terminal_session(&terminal_state, &payload.session_id)? {
        if payload.cwd.is_none() && should_recreate_terminal_session(existing_session.as_ref()) {
            remove_terminal_session(&terminal_state, &payload.session_id)?;
            terminate_terminal_session(existing_session.as_ref())?;
        } else {
            resize_session_master(existing_session.as_ref(), payload.cols, payload.rows)?;

            return Ok(TerminalSessionPayload {
                session_id: payload.session_id,
                cwd: existing_session.working_directory.clone(),
                shell_label: "WSL2".into(),
                created: false,
            });
        }
    }

    let wsl_command_path = find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"])
        .ok_or_else(|| "当前系统未发现可用的 wsl.exe，请先安装或启用 WSL2。".to_string())?;
    let working_directory = resolve_terminal_start_directory(payload.cwd.as_deref())?;
    let terminal_cwd = working_directory
        .as_ref()
        .map(|path| to_wsl_path(path.as_path()))
        .transpose()?
        .or_else(|| resolve_wsl_home_directory(&wsl_command_path))
        .unwrap_or_else(|| "~".to_string());
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(normalize_pty_size(payload.cols, payload.rows))
        .map_err(|error| format!("创建终端会话失败：{error}"))?;

    let mut command = CommandBuilder::new(wsl_command_path.to_string_lossy().as_ref());
    let startup_command = "exec \"${SHELL:-/bin/bash}\" -il".to_string();

    command.arg("--cd");
    command.arg(&terminal_cwd);
    command.arg("--");
    command.arg("bash");
    command.arg("-lc");
    command.arg(&startup_command);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动 WSL2 终端失败：{error}"))?;
    let killer = child.clone_killer();
    drop(pty_pair.slave);

    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("初始化终端读通道失败：{error}"))?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|error| format!("初始化终端写通道失败：{error}"))?;

    let session = Arc::new(TerminalSession {
        master: Mutex::new(pty_pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        working_directory: terminal_cwd.clone(),
    });

    {
        let mut sessions = lock_terminal_sessions(&terminal_state)?;
        sessions.insert(payload.session_id.clone(), Arc::clone(&session));
    }

    spawn_terminal_reader(app.clone(), payload.session_id.clone(), reader);
    spawn_terminal_waiter(app, terminal_state, payload.session_id.clone(), child);

    Ok(TerminalSessionPayload {
        session_id: payload.session_id,
        cwd: terminal_cwd,
        shell_label: "WSL2".into(),
        created: true,
    })
}

#[tauri::command]
pub fn write_terminal_input(
    state: State<TerminalSessionState>,
    payload: TerminalInputRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "终端写入通道已损坏。".to_string())?;

    writer
        .write_all(payload.data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写入终端输入失败：{error}"))
}

#[tauri::command]
pub fn resize_terminal_session(
    state: State<TerminalSessionState>,
    payload: TerminalResizeRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;

    resize_session_master(session.as_ref(), payload.cols, payload.rows)
}

#[tauri::command]
pub fn close_terminal_session(
    state: State<TerminalSessionState>,
    payload: CloseTerminalSessionRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let removed_session = remove_terminal_session(&terminal_state, &payload.session_id)?;

    let Some(session) = removed_session else {
        return Ok(());
    };

    terminate_terminal_session(session.as_ref())
}

#[tauri::command]
pub fn load_script(path: String) -> Result<ScriptFilePayload, String> {
    let file_path = PathBuf::from(&path);
    let bytes = fs::read(&file_path).map_err(|error| format!("读取脚本失败：{error}"))?;
    let (content, encoding) = decode_script_bytes(&bytes)?;
    Ok(build_script_payload(file_path, content, encoding))
}

#[tauri::command]
pub fn save_script(payload: SaveScriptRequest) -> Result<ScriptFilePayload, String> {
    let file_path = PathBuf::from(&payload.path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }

    let bytes = encode_script_content(&payload.content, &payload.encoding)?;
    fs::write(&file_path, bytes).map_err(|error| format!("保存脚本失败：{error}"))?;
    Ok(build_script_payload(
        file_path,
        payload.content,
        payload.encoding,
    ))
}

#[tauri::command]
pub async fn detect_execution_environment() -> Result<ExecutionEnvironment, String> {
    let executors = collect_executor_candidates().await;
    Ok(build_execution_environment(&executors))
}

#[tauri::command]
pub fn list_workspace_entries(
    path: Option<String>,
    root_path: Option<String>,
) -> Result<WorkspaceDirectoryPayload, String> {
    let workspace_root = resolve_workspace_root(root_path)?;
    let target_path = path
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.clone())
        .canonicalize()
        .map_err(|error| format!("读取资源目录失败：{error}"))?;

    if !target_path.starts_with(&workspace_root) {
        return Err("仅允许浏览当前资源根目录。".into());
    }

    if !target_path.is_dir() {
        return Err("目标路径不是有效目录。".into());
    }

    Ok(WorkspaceDirectoryPayload {
        root_path: workspace_root.to_string_lossy().to_string(),
        root_name: workspace_name(&workspace_root),
        entries: read_workspace_entries(&target_path)?,
    })
}

#[tauri::command]
pub async fn run_script(payload: RunScriptRequest) -> Result<RunScriptResponse, String> {
    let executors = collect_executor_candidates().await;
    let executor = resolve_executor(&payload.executor, &executors)?;
    let prepared = prepare_script(&payload)?;
    let started_at = Utc::now();
    let start_time = Instant::now();
    let (mut command, command_line) = build_run_command(executor, &prepared)?;
    let output = execute_command(&mut command, EXEC_TIMEOUT).await?;
    let duration_ms = start_time.elapsed().as_millis();
    let finished_at = Utc::now();

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined_output = merge_output(&stdout, &stderr);
    let success = output.status.success();
    let log_path = write_run_log(
        &started_at.to_rfc3339(),
        &finished_at.to_rfc3339(),
        &command_line,
        &stdout,
        &stderr,
        output.status.code(),
    )?;

    if let Some(path) = prepared.cleanup_path {
        let _ = fs::remove_file(path);
    }

    Ok(RunScriptResponse {
        success,
        stdout,
        stderr,
        combined_output,
        exit_code: output.status.code(),
        executor: executor.kind.to_string(),
        executor_label: executor.label.to_string(),
        duration_ms,
        started_at: started_at.to_rfc3339(),
        finished_at: finished_at.to_rfc3339(),
        command_line,
        log_path: Some(log_path.to_string_lossy().to_string()),
        used_temp_file: prepared.used_temp_file,
    })
}

#[tauri::command]
pub fn dispatch_script_to_terminal(
    state: State<TerminalSessionState>,
    payload: DispatchTerminalScriptRequest,
) -> Result<DispatchTerminalScriptPayload, String> {
    let terminal_state = state.inner().clone();
    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在，请先打开集成终端。".to_string())?;
    let started_at = Utc::now();
    let command = build_terminal_run_command(&payload)?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "终端写入通道已损坏。".to_string())?;

    writer
        .write_all(command.raw_command.as_bytes())
        .and_then(|_| writer.write_all(b"\r"))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("发送脚本到终端失败：{error}"))?;

    Ok(DispatchTerminalScriptPayload {
        session_id: payload.session_id,
        cwd: session.working_directory.clone(),
        command_line: command.display_command,
        used_temp_file: command.used_temp_file,
        started_at: started_at.to_rfc3339(),
    })
}

fn lock_terminal_sessions(
    state: &TerminalSessionState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, Arc<TerminalSession>>>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态已损坏。".to_string())
}

fn get_terminal_session(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<Option<Arc<TerminalSession>>, String> {
    let sessions = lock_terminal_sessions(state)?;
    Ok(sessions.get(session_id).cloned())
}

fn remove_terminal_session(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<Option<Arc<TerminalSession>>, String> {
    let mut sessions = lock_terminal_sessions(state)?;
    Ok(sessions.remove(session_id))
}

fn normalize_pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(2),
        rows: rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn resize_session_master(session: &TerminalSession, cols: u16, rows: u16) -> Result<(), String> {
    let master = session
        .master
        .lock()
        .map_err(|_| "终端尺寸通道已损坏。".to_string())?;

    master
        .resize(normalize_pty_size(cols, rows))
        .map_err(|error| format!("同步终端尺寸失败：{error}"))
}

fn should_recreate_terminal_session(session: &TerminalSession) -> bool {
    let cwd = session.working_directory.trim();
    cwd.is_empty()
        || cwd.contains('\\')
        || cwd.contains(':')
        || (!cwd.starts_with('/') && cwd != "~")
}

fn terminate_terminal_session(session: &TerminalSession) -> Result<(), String> {
    let mut killer = session
        .killer
        .lock()
        .map_err(|_| "终端结束通道已损坏。".to_string())?;
    match killer.kill() {
        Ok(()) => Ok(()),
        Err(error) => {
            let message = error.to_string();
            if message.contains("os error 0") {
                Ok(())
            } else {
                Err(format!("关闭 WSL2 终端失败：{error}"))
            }
        }
    }
}

fn resolve_terminal_start_directory(path: Option<&str>) -> Result<Option<PathBuf>, String> {
    if let Some(path) = path {
        let directory = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("读取终端工作目录失败：{error}"))?;

        if !directory.is_dir() {
            return Err("终端工作目录不是有效目录。".into());
        }

        return Ok(Some(directory));
    }

    Ok(None)
}

fn resolve_wsl_home_directory(wsl_command_path: &Path) -> Option<String> {
    let output = StdCommand::new(wsl_command_path)
        .args(["--cd", "~", "--", "pwd"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn emit_terminal_data(app: &AppHandle, payload: TerminalDataEvent) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("terminal:data", payload);
    }
}

fn emit_terminal_exit(app: &AppHandle, payload: TerminalExitEvent) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("terminal:exit", payload);
    }
}

fn spawn_terminal_reader(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    emit_terminal_data(
                        &app,
                        TerminalDataEvent {
                            session_id: session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_terminal_waiter(
    app: AppHandle,
    state: TerminalSessionState,
    session_id: String,
    mut child: Box<dyn Child + Send + Sync>,
) {
    thread::spawn(move || {
        let exit_code = child
            .wait()
            .ok()
            .and_then(|status| i32::try_from(status.exit_code()).ok());

        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&session_id);
        }

        emit_terminal_exit(
            &app,
            TerminalExitEvent {
                session_id,
                exit_code,
            },
        );
    });
}

fn build_script_payload(path: PathBuf, content: String, encoding: String) -> ScriptFilePayload {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("untitled.sh")
        .to_string();

    ScriptFilePayload {
        path: path.to_string_lossy().to_string(),
        name,
        line_count: line_count(&content),
        char_count: content.chars().count(),
        content,
        encoding,
    }
}

fn resolve_workspace_root(selected_root: Option<String>) -> Result<PathBuf, String> {
    if let Some(root) = selected_root {
        let root_path = PathBuf::from(root)
            .canonicalize()
            .map_err(|error| format!("读取资源根目录失败：{error}"))?;

        if !root_path.is_dir() {
            return Err("资源根路径不是有效目录。".into());
        }

        return Ok(root_path);
    }

    if let Ok(current_dir) = env::current_dir() {
        if current_dir.join("package.json").exists()
            || current_dir.join("src").exists()
            || current_dir.join("resources").exists()
        {
            return current_dir
                .canonicalize()
                .map_err(|error| format!("读取工作区目录失败：{error}"));
        }

        if current_dir
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("src-tauri"))
        {
            if let Some(parent) = current_dir.parent() {
                return parent
                    .to_path_buf()
                    .canonicalize()
                    .map_err(|error| format!("读取工作区目录失败：{error}"));
            }
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fallback_root = manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir);
    fallback_root
        .canonicalize()
        .map_err(|error| format!("读取工作区目录失败：{error}"))
}

fn workspace_name(root_path: &Path) -> String {
    root_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace")
        .to_string()
}

fn read_workspace_entries(directory: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    let read_dir = fs::read_dir(directory).map_err(|error| format!("读取资源目录失败：{error}"))?;
    let mut entries = Vec::new();

    for item in read_dir {
        let Ok(entry) = item else {
            continue;
        };

        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let is_directory = metadata.is_dir();

        entries.push(WorkspaceEntry {
            path: path.to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            kind: if is_directory {
                "directory".into()
            } else {
                "file".into()
            },
            has_children: is_directory && directory_has_entries(&path),
        });
    }

    entries.sort_by(compare_workspace_entries);
    Ok(entries)
}

fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut iterator| iterator.any(|item| item.is_ok()))
        .unwrap_or(false)
}

fn compare_workspace_entries(a: &WorkspaceEntry, b: &WorkspaceEntry) -> Ordering {
    match (a.kind.as_str(), b.kind.as_str()) {
        ("directory", "file") => Ordering::Less,
        ("file", "directory") => Ordering::Greater,
        _ => a
            .name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name)),
    }
}

fn line_count(content: &str) -> usize {
    if content.is_empty() {
        1
    } else {
        content.split('\n').count()
    }
}

fn decode_script_bytes(bytes: &[u8]) -> Result<(String, String), String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let content = String::from_utf8(bytes[3..].to_vec()).map_err(|error| error.to_string())?;
        return Ok((content, "utf-8-bom".into()));
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_with_encoding(&bytes[2..], UTF_16LE, "utf-16le");
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_with_encoding(&bytes[2..], UTF_16BE, "utf-16be");
    }

    if bytes.contains(&0) {
        return Err("当前文件疑似二进制内容，暂不支持在编辑器中打开。".into());
    }

    let (utf8, _, utf8_errors) = UTF_8.decode(bytes);
    if !utf8_errors {
        return Ok((utf8.into_owned(), "utf-8".into()));
    }

    let (gb18030, _, gb_errors) = GB18030.decode(bytes);
    if !gb_errors {
        return Ok((gb18030.into_owned(), "gb18030".into()));
    }

    Err("无法识别文件编码，请确认脚本是否为常见 UTF-8 / GB 编码。".into())
}

fn decode_with_encoding(
    bytes: &[u8],
    encoding: &'static encoding_rs::Encoding,
    encoding_name: &str,
) -> Result<(String, String), String> {
    let (content, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(format!("使用 {encoding_name} 解码脚本失败。"));
    }

    Ok((content.into_owned(), encoding_name.to_string()))
}

fn encode_script_content(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "utf-8" => Ok(content.as_bytes().to_vec()),
        "utf-8-bom" => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(content.as_bytes());
            Ok(bytes)
        }
        "utf-16le" => encode_with_encoding(content, UTF_16LE, "utf-16le", true),
        "utf-16be" => encode_with_encoding(content, UTF_16BE, "utf-16be", true),
        "gbk" => encode_with_encoding_name(content, "gbk"),
        "gb18030" => encode_with_encoding_name(content, "gb18030"),
        _ => Err(format!("暂不支持编码：{encoding}")),
    }
}

fn encode_with_encoding(
    content: &str,
    encoding: &'static encoding_rs::Encoding,
    label: &str,
    with_bom: bool,
) -> Result<Vec<u8>, String> {
    let (bytes, _, had_errors) = encoding.encode(content);
    if had_errors {
        return Err(format!("将内容编码为 {label} 失败。"));
    }

    let mut result = Vec::new();
    if with_bom {
        if label == "utf-16le" {
            result.extend_from_slice(&[0xFF, 0xFE]);
        } else if label == "utf-16be" {
            result.extend_from_slice(&[0xFE, 0xFF]);
        }
    }
    result.extend_from_slice(bytes.as_ref());
    Ok(result)
}

fn encode_with_encoding_name(content: &str, label: &str) -> Result<Vec<u8>, String> {
    let (bytes, _, had_errors): (Cow<[u8]>, _, bool) = match label {
        "gbk" => encoding_rs::GBK.encode(content),
        "gb18030" => GB18030.encode(content),
        _ => return Err(format!("暂不支持编码：{label}")),
    };
    if had_errors {
        return Err(format!("将内容编码为 {label} 失败。"));
    }
    Ok(bytes.into_owned())
}

async fn collect_executor_candidates() -> Vec<ExecutorCandidate> {
    let mut executors = vec![
        ExecutorCandidate {
            kind: "wsl",
            label: "WSL2",
            description: "优先使用 WSL2 Linux 子系统执行脚本，兼容性最高。",
            path: find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"]),
            available: false,
        },
        ExecutorCandidate {
            kind: "git-bash",
            label: "Git Bash / sh",
            description: "适合作为 WSL2 之外的备用 shell 环境。",
            path: find_command_path(
                "sh.exe",
                &[
                    "C:\\Program Files\\Git\\bin\\sh.exe",
                    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
                ],
            ),
            available: false,
        },
        ExecutorCandidate {
            kind: "bash",
            label: "Windows Bash",
            description: "兼容旧版 bash.exe / WSL Legacy 环境，仅建议用于兼容场景。",
            path: find_command_path("bash.exe", &["C:\\Windows\\System32\\bash.exe"]),
            available: false,
        },
    ];

    for item in executors.iter_mut() {
        item.available = probe_executor(item).await;
    }

    executors
}

fn find_preferred_available_executor(executors: &[ExecutorCandidate]) -> Option<&ExecutorCandidate> {
    executors
        .iter()
        .find(|item| item.kind == "wsl" && item.available)
        .or_else(|| executors.iter().find(|item| item.available))
}

fn build_execution_environment(executors: &[ExecutorCandidate]) -> ExecutionEnvironment {
    let has_any = executors.iter().any(|item| item.available);
    let recommended = find_preferred_available_executor(executors)
        .map(|item| item.kind.to_string())
        .unwrap_or_else(|| "wsl".to_string());

    ExecutionEnvironment {
        recommended,
        has_any,
        executors: executors
            .iter()
            .map(|item| ExecutionOption {
                r#type: item.kind.to_string(),
                label: item.label.to_string(),
                available: item.available,
                description: item.description.to_string(),
                command_path: item
                    .path
                    .as_ref()
                    .map(|value| value.to_string_lossy().to_string()),
            })
            .collect(),
    }
}

fn find_command_path(file_name: &str, extra_candidates: &[&str]) -> Option<PathBuf> {
    if let Some(path_var) = env::var_os("PATH") {
        for directory in env::split_paths(&path_var) {
            let candidate = directory.join(file_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    extra_candidates
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.exists())
}

async fn probe_executor(candidate: &ExecutorCandidate) -> bool {
    let Some(path) = candidate.path.as_ref() else {
        return false;
    };

    let mut command = Command::new(path);
    match candidate.kind {
        "wsl" => {
            command.args(["--", "bash", "-lc", "printf ready"]);
        }
        _ => {
            command.args(["-lc", "printf ready"]);
        }
    }
    command.stdout(Stdio::null()).stderr(Stdio::null());

    matches!(
        timeout(PROBE_TIMEOUT, command.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

fn resolve_executor<'a>(
    requested: &str,
    executors: &'a [ExecutorCandidate],
) -> Result<&'a ExecutorCandidate, String> {
    if requested != "auto" {
        return executors
            .iter()
            .find(|item| item.kind == requested && item.available)
            .ok_or_else(|| format!("当前系统不可用执行器：{requested}"));
    }

    find_preferred_available_executor(executors)
        .ok_or_else(|| "当前系统未检测到可用的 WSL2 或其他 shell 运行环境。".into())
}

fn prepare_script(payload: &RunScriptRequest) -> Result<PreparedScript, String> {
    let preferred_path = payload.path.as_ref().map(PathBuf::from);
    let working_directory = preferred_path
        .as_ref()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(env::temp_dir);

    let should_use_temp = payload.is_dirty
        || preferred_path
            .as_ref()
            .map(|path| !path.exists())
            .unwrap_or(true);

    if should_use_temp {
        let file_name = preferred_path
            .as_ref()
            .and_then(|path| path.file_name().and_then(|value| value.to_str()))
            .unwrap_or("untitled.sh");
        let temp_path = create_temp_script(
            &working_directory,
            file_name,
            &payload.content,
            &payload.encoding,
        )?;
        return Ok(PreparedScript {
            execution_path: temp_path.clone(),
            working_directory,
            used_temp_file: true,
            cleanup_path: Some(temp_path),
        });
    }

    let execution_path = preferred_path.ok_or_else(|| "脚本路径无效。".to_string())?;
    Ok(PreparedScript {
        execution_path,
        working_directory,
        used_temp_file: false,
        cleanup_path: None,
    })
}

fn build_terminal_run_command(
    payload: &DispatchTerminalScriptRequest,
) -> Result<TerminalDispatchCommand, String> {
    let preferred_path = payload.path.as_ref().map(PathBuf::from);
    let should_use_inline_temp = payload.is_dirty
        || preferred_path
            .as_ref()
            .map(|path| !path.exists())
            .unwrap_or(true);

    if should_use_inline_temp {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis();
        let stem = preferred_path
            .as_ref()
            .and_then(|path| path.file_stem().and_then(|value| value.to_str()))
            .filter(|value| !value.is_empty())
            .unwrap_or("untitled");
        let temp_file_name = format!(".sh-editor-{stem}-{stamp}.tmp.sh");
        let delimiter = format!("__SH_EDITOR_EOF_{stamp}__");
        let normalized_content = payload.content.replace("\r\n", "\n").replace('\r', "\n");
        let raw_command = format!(
            "printf '\\n\\033[90m[sh-editor] Running current script...\\033[0m\\n'; cat <<'{}' > {}\n{}\n{}\nbash {}; __sh_editor_status=$?; rm -f {}; printf '\\033[90m[sh-editor] Exit code: %s\\033[0m\\n' \"$__sh_editor_status\"; unset __sh_editor_status",
            delimiter,
            bash_quote(&temp_file_name),
            normalized_content,
            delimiter,
            bash_quote(&temp_file_name),
            bash_quote(&temp_file_name),
        );

        return Ok(TerminalDispatchCommand {
            raw_command,
            display_command: format!("bash ./{}", temp_file_name),
            used_temp_file: true,
        });
    }

    let execution_path = preferred_path.ok_or_else(|| "脚本路径无效。".to_string())?;
    let execution_path_wsl = to_wsl_path(&execution_path)?;
    let command = format!(
        "printf '\\n\\033[90m[sh-editor] Running current script...\\033[0m\\n'; bash {}; __sh_editor_status=$?; printf '\\033[90m[sh-editor] Exit code: %s\\033[0m\\n' \"$__sh_editor_status\"; unset __sh_editor_status",
        bash_quote(&execution_path_wsl),
    );

    Ok(TerminalDispatchCommand {
        raw_command: command,
        display_command: format!("bash {}", bash_quote(&execution_path_wsl)),
        used_temp_file: false,
    })
}

fn create_temp_script(
    preferred_directory: &Path,
    original_name: &str,
    content: &str,
    encoding: &str,
) -> Result<PathBuf, String> {
    let directory = if preferred_directory.exists() {
        preferred_directory.to_path_buf()
    } else {
        env::temp_dir()
    };
    fs::create_dir_all(&directory).map_err(|error| format!("创建临时目录失败：{error}"))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let stem = Path::new(original_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("untitled");
    let temp_path = directory.join(format!("{stem}-{stamp}.tmp.sh"));
    let bytes = encode_script_content(content, encoding)?;
    fs::write(&temp_path, bytes).map_err(|error| format!("写入临时脚本失败：{error}"))?;
    Ok(temp_path)
}

fn build_run_command(
    executor: &ExecutorCandidate,
    prepared: &PreparedScript,
) -> Result<(Command, String), String> {
    match executor.kind {
        "git-bash" => {
            let mut command = Command::new(
                executor
                    .path
                    .as_ref()
                    .ok_or_else(|| "未找到 Git Bash / sh 可执行文件。".to_string())?,
            );
            let file_name = prepared
                .execution_path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "脚本文件名无效。".to_string())?;
            command.current_dir(&prepared.working_directory);
            command.args(["-lc", "sh \"$1\"", "_", &format!("./{file_name}")]);
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
            Ok((
                command,
                format!(
                    "{} -lc \"sh \\\"$1\\\"\" _ ./{}",
                    executor
                        .path
                        .as_ref()
                        .map(|value| value.to_string_lossy())
                        .unwrap_or_default(),
                    file_name
                ),
            ))
        }
        "wsl" | "bash" => {
            let shell_path = executor
                .path
                .as_ref()
                .ok_or_else(|| "未找到 WSL2 / Bash 可执行文件。".to_string())?;
            let script_path = to_wsl_path(&prepared.execution_path)?;
            let working_directory = to_wsl_path(&prepared.working_directory)?;
            let mut command = Command::new(shell_path);

            if executor.kind == "wsl" {
                let bash_script = format!(
                    "cd {} && bash {}",
                    bash_quote(&working_directory),
                    bash_quote(&script_path)
                );
                command.args(["--", "bash", "-lc", &bash_script]);
            } else {
                let bash_script = format!(
                    "cd {} && bash {}",
                    bash_quote(&working_directory),
                    bash_quote(&script_path)
                );
                command.args(["-lc", &bash_script]);
            }
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
            Ok((
                command,
                format!(
                    "{} {}",
                    shell_path.to_string_lossy(),
                    if executor.kind == "wsl" {
                        let bash_script = format!(
                            "cd {} && bash {}",
                            bash_quote(&working_directory),
                            bash_quote(&script_path)
                        );
                        format!("-- bash -lc {}", bash_quote(&bash_script))
                    } else {
                        let bash_script = format!(
                            "cd {} && bash {}",
                            bash_quote(&working_directory),
                            bash_quote(&script_path)
                        );
                        format!("-lc {}", bash_quote(&bash_script))
                    }
                ),
            ))
        }
        _ => Err(format!("不支持的执行器：{}", executor.kind)),
    }
}

fn to_wsl_path(path: &Path) -> Result<String, String> {
    let normalized = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();

    let normalized = normalize_windows_path_for_wsl(&normalized)?;

    let drive_letter = normalized
        .chars()
        .next()
        .ok_or_else(|| "无法识别 Windows 路径。".to_string())?;

    if !drive_letter.is_ascii_alphabetic() || !normalized.contains(':') {
        return Err("仅支持 Windows 本地磁盘路径转换为 WSL 路径。".into());
    }

    let rest = normalized
        .get(2..)
        .ok_or_else(|| "Windows 路径格式无效。".to_string())?;

    Ok(format!(
        "/mnt/{}/{}",
        drive_letter.to_ascii_lowercase(),
        rest.replace('\\', "/").trim_start_matches('/')
    ))
}

fn normalize_windows_path_for_wsl(value: &str) -> Result<String, String> {
    if let Some(network_path) = value.strip_prefix(r"\\?\UNC\") {
        return Err(format!(
            "暂不支持将网络共享路径转换为 WSL 路径：\\\\{}",
            network_path
        ));
    }

    if let Some(extended_path) = value.strip_prefix(r"\\?\") {
        return Ok(extended_path.to_string());
    }

    Ok(value.to_string())
}

fn bash_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

async fn execute_command(
    command: &mut Command,
    timeout_duration: Duration,
) -> Result<std::process::Output, String> {
    match timeout(timeout_duration, command.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(format!("执行脚本失败：{error}")),
        Err(_) => Err(format!(
            "脚本执行超时（超过 {} 秒），请检查脚本是否阻塞。",
            timeout_duration.as_secs()
        )),
    }
}

fn merge_output(stdout: &str, stderr: &str) -> String {
    match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (false, false) => format!("# stdout\n{stdout}\n\n# stderr\n{stderr}"),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (true, true) => "# 脚本已执行，但未产生任何标准输出。".into(),
    }
}

fn write_run_log(
    started_at: &str,
    finished_at: &str,
    command_line: &str,
    stdout: &str,
    stderr: &str,
    exit_code: Option<i32>,
) -> Result<PathBuf, String> {
    let file_name = format!("sh-editor-run-{}.log", Utc::now().format("%Y%m%d_%H%M%S"));
    let log_path = env::temp_dir().join(file_name);
    let log_content = format!(
        "started_at={started_at}\nfinished_at={finished_at}\nexit_code={}\ncommand={command_line}\n\n[stdout]\n{stdout}\n\n[stderr]\n{stderr}\n",
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".into())
    );
    fs::write(&log_path, log_content).map_err(|error| format!("写入运行日志失败：{error}"))?;
    Ok(log_path)
}
