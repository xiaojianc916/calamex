use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use encoding_rs::{GB18030, UTF_16BE, UTF_16LE, UTF_8};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
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
use tokio::{process::Command, time::{sleep, timeout}};

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);
const SHELLCHECK_TIMEOUT: Duration = Duration::from_secs(12);
const SPLASH_WINDOW_WIDTH: f64 = 780.0;
const SPLASH_WINDOW_HEIGHT: f64 = 520.0;
const MAIN_WINDOW_WIDTH: f64 = 1500.0;
const MAIN_WINDOW_HEIGHT: f64 = 960.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 1220.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 760.0;
const WSL_TEMP_DIRECTORY: &str = "/tmp";
const TERMINAL_DISPATCH_RUNNER_PATH: &str = "/tmp/sh_run.sh";
const TERMINAL_RUN_MARKER_PREFIX: &str = "\u{001b}]SH_EDITOR:";
const TERMINAL_RUN_MARKER_SUFFIX: char = '\u{0007}';
const TERMINAL_RUN_MARKER_ESCAPED_PREFIX: &str = "\\033]SH_EDITOR:";
const TERMINAL_RUN_MARKER_ESCAPED_SUFFIX: &str = "\\007";
const TERMINAL_RUN_START_MARKER_PREFIX: &str = "SH_EDITOR_RUN_BEGIN:";
const TERMINAL_RUN_END_MARKER_PREFIX: &str = "SH_EDITOR_RUN_END:";

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetPayload {
    path: String,
    name: String,
    mime_type: String,
    data_url: String,
    byte_size: usize,
}

#[derive(Debug, Deserialize)]
pub struct SaveScriptRequest {
    path: String,
    content: String,
    encoding: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeScriptRequest {
    path: Option<String>,
    name: Option<String>,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDiagnosticPayload {
    line: usize,
    end_line: usize,
    column: usize,
    end_column: usize,
    level: String,
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeScriptPayload {
    available: bool,
    message: Option<String>,
    dialect: String,
    diagnostics: Vec<ScriptDiagnosticPayload>,
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
    run_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTerminalScriptPayload {
    session_id: String,
    cwd: String,
    command_line: String,
    used_temp_file: bool,
    started_at: String,
    status_path: String,
    output_path: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitTerminalRunRequest {
    status_path: String,
    output_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitTerminalRunPayload {
    exit_code: Option<i32>,
    finished_at: String,
    output: String,
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalRunCompleteEvent {
    session_id: String,
    run_id: String,
    exit_code: Option<i32>,
    output: String,
    finished_at: String,
}

struct ExecutorCandidate {
    kind: &'static str,
    label: &'static str,
    description: &'static str,
    path: Option<PathBuf>,
    available: bool,
}

struct ShellCheckCandidate {
    executable: PathBuf,
    use_wsl: bool,
}

struct PreparedScript {
    execution_path: PathBuf,
    working_directory: PathBuf,
    used_temp_file: bool,
    cleanup_path: Option<PathBuf>,
}

struct TerminalPreparedScript {
    execution_path: String,
    used_temp_file: bool,
    cleanup_path: Option<String>,
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

#[derive(Default)]
struct TerminalRunStreamParser {
    buffer: String,
    active_run_id: Option<String>,
    captured_output: String,
}

struct TerminalMarkerChunk<'a> {
    before: &'a str,
    marker_token: Option<&'a str>,
    remainder: &'a str,
}

#[derive(Clone, Default)]
pub struct TerminalSessionState {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    creation_guard: Arc<Mutex<()>>,
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
    let (child, reader, terminal_cwd) = {
        let _creation_guard = terminal_state
            .creation_guard
            .lock()
            .map_err(|_| "终端会话创建锁已损坏。".to_string())?;

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
        command.arg("--cd");
        command.arg(&terminal_cwd);
        command.arg("--");
        command.arg("/bin/bash");
        command.arg("-il");
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

        (child, reader, terminal_cwd)
    };

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
pub fn load_image_asset(path: String) -> Result<ImageAssetPayload, String> {
    let file_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("读取图片资源失败：{error}"))?;

    if !file_path.is_file() {
        return Err("目标图片不存在或不是有效文件。".into());
    }

    let bytes = fs::read(&file_path).map_err(|error| format!("读取图片资源失败：{error}"))?;
    build_image_asset_payload(file_path, bytes)
}

#[derive(Debug, Deserialize)]
struct ShellCheckJsonPayload {
    comments: Vec<ShellCheckComment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellCheckComment {
    line: usize,
    end_line: usize,
    column: usize,
    end_column: usize,
    level: String,
    code: u64,
    message: String,
}

#[tauri::command]
pub async fn analyze_script(payload: AnalyzeScriptRequest) -> Result<AnalyzeScriptPayload, String> {
    let normalized_content = normalize_shellcheck_content(&payload.content);
    let dialect = detect_shellcheck_dialect(
        payload.path.as_deref(),
        payload.name.as_deref(),
        &normalized_content,
    )
    .to_string();

    if normalized_content.trim().is_empty() {
        return Ok(AnalyzeScriptPayload {
            available: true,
            message: None,
            dialect,
            diagnostics: Vec::new(),
        });
    }

    let Some(shellcheck) = resolve_shellcheck_candidate() else {
        return Ok(AnalyzeScriptPayload {
            available: false,
            message: Some("未检测到可用的 ShellCheck，本地实时诊断暂不可用。".into()),
            dialect,
            diagnostics: Vec::new(),
        });
    };

    let script_name = resolve_analysis_script_name(payload.path.as_deref(), payload.name.as_deref());
    let temporary_root = env::temp_dir().join("sh-editor-shellcheck");
    let temporary_script = create_temp_script(&temporary_root, &script_name, &normalized_content, "utf-8")?;
    let output = run_shellcheck(&shellcheck, &temporary_script, &dialect).await;
    let _ = fs::remove_file(&temporary_script);

    let output = output?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let diagnostics = parse_shellcheck_diagnostics(&stdout)?;

    Ok(AnalyzeScriptPayload {
        available: true,
        message: None,
        dialect,
        diagnostics,
    })
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
    let status_path = env::temp_dir().join(format!(
        "sh-editor-terminal-run-{}.status",
        payload.run_id
    ));
    let output_path = env::temp_dir().join(format!(
        "sh-editor-terminal-run-{}.output",
        payload.run_id
    ));
    let _ = fs::remove_file(&status_path);
    let _ = fs::remove_file(&output_path);
    let status_path_wsl = to_wsl_path(&status_path)?;
    let output_path_wsl = to_wsl_path(&output_path)?;
    let command = build_terminal_run_command(&payload, &status_path_wsl, &output_path_wsl)?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "终端写入通道已损坏。".to_string())?;

    writer
        .write_all(command.raw_command.as_bytes())
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("发送脚本到终端失败：{error}"))?;

    Ok(DispatchTerminalScriptPayload {
        session_id: payload.session_id,
        cwd: session.working_directory.clone(),
        command_line: command.display_command,
        used_temp_file: command.used_temp_file,
        started_at: started_at.to_rfc3339(),
        status_path: status_path.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn wait_for_terminal_run(
    payload: WaitTerminalRunRequest,
) -> Result<WaitTerminalRunPayload, String> {
    const WAIT_TIMEOUT: Duration = Duration::from_secs(60 * 60 * 12);
    const POLL_INTERVAL: Duration = Duration::from_millis(120);

    let status_path = PathBuf::from(&payload.status_path);
    let output_path = PathBuf::from(&payload.output_path);
    let started_at = Instant::now();

    loop {
        if let Ok(raw) = fs::read_to_string(&status_path) {
            let exit_code = raw.trim().parse::<i32>().ok();
            let _ = fs::remove_file(&status_path);
            let output = fs::read_to_string(&output_path).unwrap_or_default();
            let _ = fs::remove_file(&output_path);
            return Ok(WaitTerminalRunPayload {
                exit_code,
                finished_at: Utc::now().to_rfc3339(),
                output,
            });
        }

        if started_at.elapsed() >= WAIT_TIMEOUT {
            return Err("等待终端执行结果超时。".into());
        }

        sleep(POLL_INTERVAL).await;
    }
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

fn resolve_wsl_command_path() -> Result<PathBuf, String> {
    find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"])
        .ok_or_else(|| "当前系统未发现可用的 wsl.exe，请先安装或启用 WSL2。".to_string())
}

fn write_wsl_file(path: &str, content: &[u8]) -> Result<(), String> {
    let wsl_command_path = resolve_wsl_command_path()?;
    let shell_command = format!(
        "umask 077 && cat > {} && chmod 600 {}",
        bash_quote(path),
        bash_quote(path),
    );
    let mut command = StdCommand::new(wsl_command_path);
    command
        .args(["--", "sh", "-lc", &shell_command])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("写入 WSL 临时文件失败：{error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "WSL 写入通道不可用。".to_string())?;
    stdin
        .write_all(content)
        .map_err(|error| format!("写入 WSL 临时文件失败：{error}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 WSL 临时文件写入完成失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err("写入 WSL 临时文件失败。".into())
    } else {
        Err(format!("写入 WSL 临时文件失败：{stderr}"))
    }
}

fn build_terminal_run_temp_output_path(run_id: &str) -> String {
    format!("{WSL_TEMP_DIRECTORY}/sh-editor-terminal-run-{run_id}.output")
}

fn build_terminal_run_temp_status_path(run_id: &str) -> String {
    format!("{WSL_TEMP_DIRECTORY}/sh-editor-terminal-run-{run_id}.status")
}

fn build_terminal_dispatch_runner_path() -> String {
    TERMINAL_DISPATCH_RUNNER_PATH.to_string()
}

fn build_terminal_temp_script_path(original_name: &str) -> Result<String, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let stem = Path::new(original_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("untitled");

    Ok(format!("{WSL_TEMP_DIRECTORY}/{stem}-{stamp}.tmp.sh"))
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

fn emit_terminal_run_complete(app: &AppHandle, payload: TerminalRunCompleteEvent) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("terminal:run-complete", payload);
    }
}

fn spawn_terminal_reader(app: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut parser = TerminalRunStreamParser::default();

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let raw_data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    emit_terminal_data(
                        &app,
                        TerminalDataEvent {
                            session_id: session_id.clone(),
                            data: raw_data.clone(),
                        },
                    );

                    for item in parser.push_chunk(&session_id, &raw_data) {
                        emit_terminal_run_complete(&app, item);
                    }
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

fn resolve_terminal_marker_remainder_start(value: &str) -> usize {
    let max_tail_length = TERMINAL_RUN_MARKER_PREFIX.len().saturating_sub(1);

    for (index, _) in value.char_indices().rev() {
        if value.len().saturating_sub(index) > max_tail_length {
            break;
        }

        if TERMINAL_RUN_MARKER_PREFIX.starts_with(&value[index..]) {
            return index;
        }
    }

    value.len()
}

fn split_terminal_marker_chunk(value: &str) -> TerminalMarkerChunk<'_> {
    let Some(marker_start_index) = value.find(TERMINAL_RUN_MARKER_PREFIX) else {
        let remainder_start_index = resolve_terminal_marker_remainder_start(value);
        return TerminalMarkerChunk {
            before: &value[..remainder_start_index],
            marker_token: None,
            remainder: &value[remainder_start_index..],
        };
    };

    let marker_content_start_index = marker_start_index + TERMINAL_RUN_MARKER_PREFIX.len();
    let Some(marker_end_offset) = value[marker_content_start_index..].find(TERMINAL_RUN_MARKER_SUFFIX)
    else {
        return TerminalMarkerChunk {
            before: &value[..marker_start_index],
            marker_token: None,
            remainder: &value[marker_start_index..],
        };
    };

    let marker_end_index = marker_content_start_index + marker_end_offset;
    TerminalMarkerChunk {
        before: &value[..marker_start_index],
        marker_token: Some(&value[marker_content_start_index..marker_end_index]),
        remainder: &value[marker_end_index + TERMINAL_RUN_MARKER_SUFFIX.len_utf8()..],
    }
}

impl TerminalRunStreamParser {
    fn push_chunk(
        &mut self,
        session_id: &str,
        chunk: &str,
    ) -> Vec<TerminalRunCompleteEvent> {
        self.buffer.push_str(chunk);
        let mut completed_runs = Vec::new();

        loop {
            if let Some(run_id) = self.active_run_id.clone() {
                let marker_chunk = split_terminal_marker_chunk(&self.buffer);
                if !marker_chunk.before.is_empty() {
                    self.captured_output.push_str(marker_chunk.before);
                }

                let marker_token = marker_chunk.marker_token.map(str::to_owned);
                self.buffer = marker_chunk.remainder.to_string();
                let Some(marker_token) = marker_token else {
                    break;
                };

                let end_marker_prefix = format!("{TERMINAL_RUN_END_MARKER_PREFIX}{run_id}:");
                if marker_token.starts_with(&end_marker_prefix) {
                    let exit_code = marker_token[end_marker_prefix.len()..]
                        .parse::<i32>()
                        .ok();
                    completed_runs.push(TerminalRunCompleteEvent {
                        session_id: session_id.to_string(),
                        run_id,
                        exit_code,
                        output: std::mem::take(&mut self.captured_output),
                        finished_at: Utc::now().to_rfc3339(),
                    });
                    self.active_run_id = None;
                }

                continue;
            }

            let marker_chunk = split_terminal_marker_chunk(&self.buffer);
            let marker_token = marker_chunk.marker_token.map(str::to_owned);
            self.buffer = marker_chunk.remainder.to_string();
            let Some(marker_token) = marker_token else {
                break;
            };

            if let Some(run_id) = marker_token.strip_prefix(TERMINAL_RUN_START_MARKER_PREFIX) {
                self.active_run_id = Some(run_id.to_string());
                self.captured_output.clear();
            }
        }

        completed_runs
    }
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

fn parse_shellcheck_diagnostics(output: &str) -> Result<Vec<ScriptDiagnosticPayload>, String> {
    if output.trim().is_empty() {
        return Ok(Vec::new());
    }

    let payload: ShellCheckJsonPayload =
        serde_json::from_str(output).map_err(|error| format!("解析 ShellCheck 结果失败：{error}"))?;

    Ok(payload
        .comments
        .into_iter()
        .map(|item| ScriptDiagnosticPayload {
            line: item.line.max(1),
            end_line: item.end_line.max(item.line).max(1),
            column: item.column.max(1),
            end_column: item.end_column.max(item.column).max(1),
            level: item.level,
            code: format!("SC{}", item.code),
            message: item.message,
        })
        .collect())
}

fn resolve_analysis_script_name(path: Option<&str>, name: Option<&str>) -> String {
    if let Some(file_name) = path
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
    {
        return file_name.to_string();
    }

    name.filter(|value| !value.is_empty())
        .unwrap_or("untitled.sh")
        .to_string()
}

fn normalize_shellcheck_content(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn detect_shellcheck_dialect(path: Option<&str>, name: Option<&str>, content: &str) -> &'static str {
    let first_line = content.lines().next().unwrap_or_default().to_ascii_lowercase();
    if first_line.starts_with("#!") {
        if first_line.contains("bash") {
            return "bash";
        }
        if first_line.contains("dash") {
            return "dash";
        }
        if first_line.contains("ksh") {
            return "ksh";
        }
        if first_line.contains("sh") {
            return "sh";
        }
    }

    let inferred_name = path
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        .or(name)
        .unwrap_or_default()
        .to_ascii_lowercase();

    if inferred_name.ends_with(".dash") {
        return "dash";
    }
    if inferred_name.ends_with(".ksh") {
        return "ksh";
    }
    if inferred_name.ends_with(".sh") || inferred_name.ends_with(".bash") {
        return "bash";
    }

    "bash"
}

fn resolve_shellcheck_candidate() -> Option<ShellCheckCandidate> {
    if let Some(configured_path) = env::var_os("SHELLCHECK_BIN") {
        let configured_path = PathBuf::from(configured_path);
        if configured_path.exists() {
            return Some(ShellCheckCandidate {
                executable: configured_path,
                use_wsl: false,
            });
        }
    }

    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf);
    let local_binary_name = if cfg!(windows) { "shellcheck.exe" } else { "shellcheck" };
    if let Some(repo_root) = repo_root {
        let local_binary = repo_root
            .join("node_modules")
            .join("shellcheck")
            .join("bin")
            .join(local_binary_name);
        if local_binary.exists() {
            return Some(ShellCheckCandidate {
                executable: local_binary,
                use_wsl: false,
            });
        }
    }

    let shellcheck_command = if cfg!(windows) { "shellcheck.exe" } else { "shellcheck" };
    if let Some(system_binary) = find_command_path(shellcheck_command, &[]) {
        return Some(ShellCheckCandidate {
            executable: system_binary,
            use_wsl: false,
        });
    }

    let wsl_path = find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"])?;
    if StdCommand::new(&wsl_path)
        .args(["--", "shellcheck", "--version"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .is_some_and(|status| status.success())
    {
        return Some(ShellCheckCandidate {
            executable: wsl_path,
            use_wsl: true,
        });
    }

    None
}

async fn run_shellcheck(
    candidate: &ShellCheckCandidate,
    script_path: &Path,
    dialect: &str,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(&candidate.executable);

    if candidate.use_wsl {
        let wsl_script_path = to_wsl_path(script_path)?;
        command.args([
            "--",
            "shellcheck",
            "--format=json1",
            "--shell",
            dialect,
            &wsl_script_path,
        ]);
    } else {
        command
            .args(["--format=json1", "--shell", dialect])
            .arg(script_path);
    }

    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = match timeout(SHELLCHECK_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("运行 ShellCheck 失败：{error}")),
        Err(_) => {
            return Err(format!(
                "ShellCheck 分析超时（超过 {} 秒）。",
                SHELLCHECK_TIMEOUT.as_secs()
            ))
        }
    };

    if matches!(output.status.code(), Some(0 | 1)) {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err("ShellCheck 执行失败。".into());
    }

    Err(format!("ShellCheck 执行失败：{stderr}"))
}

fn build_image_asset_payload(path: PathBuf, bytes: Vec<u8>) -> Result<ImageAssetPayload, String> {
    let mime_type = resolve_image_mime_type(&path)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();
    let byte_size = bytes.len();
    let data_url = format!("data:{mime_type};base64,{}", STANDARD.encode(&bytes));

    Ok(ImageAssetPayload {
        path: path.to_string_lossy().to_string(),
        name,
        mime_type: mime_type.to_string(),
        data_url,
        byte_size,
    })
}

fn resolve_image_mime_type(path: &Path) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "无法识别图片格式。".to_string())?;

    match extension.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "bmp" => Ok("image/bmp"),
        "svg" => Ok("image/svg+xml"),
        "ico" => Ok("image/x-icon"),
        _ => Err(format!("暂不支持预览该图片格式：{extension}")),
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
    let mut executors = vec![ExecutorCandidate {
        kind: "wsl",
        label: "WSL2",
        description: "唯一执行环境，所有脚本统一通过 WSL2 Linux 子系统运行。",
        path: find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"]),
        available: false,
    }];

    for item in executors.iter_mut() {
        item.available = probe_executor(item).await;
    }

    executors
}

fn find_preferred_available_executor(
    executors: &[ExecutorCandidate],
) -> Option<&ExecutorCandidate> {
    executors.iter().find(|item| item.kind == "wsl" && item.available)
}

fn build_execution_environment(executors: &[ExecutorCandidate]) -> ExecutionEnvironment {
    let has_any = executors.iter().any(|item| item.available);

    ExecutionEnvironment {
        recommended: "wsl".to_string(),
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

    if candidate.kind != "wsl" {
        return false;
    }

    let mut command = Command::new(path);
    command.args(["--list", "--quiet"]);
    command.stdout(Stdio::piped()).stderr(Stdio::null());

    matches!(
        timeout(PROBE_TIMEOUT, command.output()).await,
        Ok(Ok(output))
            if output.status.success()
                && output
                    .stdout
                    .iter()
                    .any(|byte| !matches!(*byte, 0 | b' ' | b'\n' | b'\r' | b'\t'))
    )
}

fn resolve_executor<'a>(
    requested: &str,
    executors: &'a [ExecutorCandidate],
) -> Result<&'a ExecutorCandidate, String> {
    if requested != "wsl" {
        return Err("当前版本仅支持 WSL2 执行环境。".into());
    }

    find_preferred_available_executor(executors)
        .ok_or_else(|| "当前系统未检测到可用的 WSL2 运行环境。".into())
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

fn prepare_terminal_dispatch_script(
    payload: &DispatchTerminalScriptRequest,
) -> Result<TerminalPreparedScript, String> {
    let preferred_path = payload.path.as_ref().map(PathBuf::from);

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
        let temp_path = build_terminal_temp_script_path(file_name)?;
        write_wsl_file(&temp_path, payload.content.as_bytes())?;
        return Ok(TerminalPreparedScript {
            execution_path: temp_path.clone(),
            used_temp_file: true,
            cleanup_path: Some(temp_path),
        });
    }

    let execution_path = preferred_path.ok_or_else(|| "脚本路径无效。".to_string())?;
    Ok(TerminalPreparedScript {
        execution_path: to_wsl_path(&execution_path)?,
        used_temp_file: false,
        cleanup_path: None,
    })
}

fn build_terminal_run_command(
    payload: &DispatchTerminalScriptRequest,
    status_path_wsl: &str,
    output_path_wsl: &str,
) -> Result<TerminalDispatchCommand, String> {
    let prepared = prepare_terminal_dispatch_script(payload)?;
    create_terminal_dispatch_runner(
        payload,
        &prepared,
        status_path_wsl,
        output_path_wsl,
    )?;

    Ok(TerminalDispatchCommand {
        raw_command: format!("/bin/bash {TERMINAL_DISPATCH_RUNNER_PATH}"),
        display_command: format!("/bin/bash {TERMINAL_DISPATCH_RUNNER_PATH}"),
        used_temp_file: prepared.used_temp_file,
    })
}

fn create_terminal_dispatch_runner(
    payload: &DispatchTerminalScriptRequest,
    prepared: &TerminalPreparedScript,
    status_path_wsl: &str,
    output_path_wsl: &str,
) -> Result<String, String> {
    let runner_path = build_terminal_dispatch_runner_path();
    let temp_status_path = build_terminal_run_temp_status_path(&payload.run_id);
    let temp_output_path = build_terminal_run_temp_output_path(&payload.run_id);
    let cleanup_command = if prepared.cleanup_path.is_some() {
        "rm -f \"$t\"\n"
    } else {
        ""
    };
    let runner_content = format!(
        "#!/usr/bin/env bash\n\
set +x\n\
trap 'rm -f \"$0\"' EXIT INT TERM HUP\n\
i={}\n\
o={}\n\
s={}\n\
ho={}\n\
hs={}\n\
t={}\n\
printf '%b%s%s%b' {} {} \"$i\" {}\n\
:>\"$o\"\n\
bash \"$t\" 2>&1 | tee \"$o\"\n\
e=${{PIPESTATUS[0]}}\n\
{}printf %s \"$e\" >\"$s\"\n\
cat \"$o\" >\"$ho\"\n\
printf %s \"$e\" >\"$hs\"\n\
rm -f \"$o\" \"$s\"\n\
printf '%b%s%s:%s%b' {} {} \"$i\" \"$e\" {}\n\
",
        bash_quote(&payload.run_id),
        bash_quote(&temp_output_path),
        bash_quote(&temp_status_path),
        bash_quote(output_path_wsl),
        bash_quote(status_path_wsl),
        bash_quote(&prepared.execution_path),
        bash_quote(TERMINAL_RUN_MARKER_ESCAPED_PREFIX),
        bash_quote(TERMINAL_RUN_START_MARKER_PREFIX),
        bash_quote(TERMINAL_RUN_MARKER_ESCAPED_SUFFIX),
        cleanup_command,
        bash_quote(TERMINAL_RUN_MARKER_ESCAPED_PREFIX),
        bash_quote(TERMINAL_RUN_END_MARKER_PREFIX),
        bash_quote(TERMINAL_RUN_MARKER_ESCAPED_SUFFIX),
    );

    write_wsl_file(&runner_path, runner_content.as_bytes())
        .map_err(|error| format!("写入终端调度脚本失败：{error}"))?;

    Ok(runner_path)
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
    if executor.kind != "wsl" {
        return Err(format!("不支持的执行器：{}", executor.kind));
    }

    let shell_path = executor
        .path
        .as_ref()
        .ok_or_else(|| "未找到 WSL2 可执行文件。".to_string())?;
    let script_path = to_wsl_path(&prepared.execution_path)?;
    let working_directory = to_wsl_path(&prepared.working_directory)?;
    let bash_script = format!(
        "cd {} && bash {}",
        bash_quote(&working_directory),
        bash_quote(&script_path)
    );
    let mut command = Command::new(shell_path);
    command.args(["--", "bash", "-lc", &bash_script]);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    Ok((
        command,
        format!(
            "{} -- bash -lc {}",
            shell_path.to_string_lossy(),
            bash_quote(&bash_script)
        ),
    ))
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
