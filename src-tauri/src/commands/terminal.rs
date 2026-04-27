use super::{configure_std_command_for_background, find_command_path};
use chrono::Utc;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::terminal::{
    command_contracts::{
        CancelTerminalRunRequest, CloseTerminalSessionRequest, DispatchTerminalScriptPayload,
        DispatchTerminalScriptRequest, EnsureTerminalSessionRequest, TerminalInputRequest,
        TerminalResizeRequest, TerminalSessionPayload,
    },
    dispatch::{build_terminal_run_command, TerminalDispatchCommand},
    prompt::{build_terminal_prompt_fallback, resolve_wsl_home_directory},
    pty::normalize_pty_size,
    snapshot::{
        contains_alt_screen_switch, is_likely_interactive_resize_repaint_frame,
        resolve_alt_screen_state_after_data, trim_terminal_snapshot,
        TerminalInteractiveVisualState,
    },
    state_machine::StateMachine,
    tauri_events::{
        emit_terminal_data, emit_terminal_exit, emit_terminal_run_chunk,
        emit_terminal_run_completed, emit_terminal_run_started, emit_terminal_state_changed,
        TerminalDataEvent, TerminalDataSource, TerminalExitEvent, TerminalRunChunkEvent,
        TerminalRunCompletedEvent, TerminalRunStartedEvent, TerminalStateChangedEvent,
    },
    types::TerminalState,
    utf8_decoder::Utf8ChunkDecoder,
    visual::{
        build_terminal_ansi_reset, build_terminal_run_separator, current_visual_tracker,
        extract_prompt_from_terminal_snapshot, next_visual_run_seq,
        observe_visual_output_and_prefix, TerminalRunVisualObservation, TerminalRunVisualTracker,
    },
    wsl as terminal_wsl,
};

const TERMINAL_READ_BUFFER_SIZE: usize = 64 * 1024;
const TERMINAL_EVENT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const TERMINAL_EVENT_FLUSH_THRESHOLD: usize = 64 * 1024;
const TERMINAL_RESIZE_REPAINT_SUPPRESSION: Duration = Duration::from_millis(240);
static TERMINAL_DATA_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_RUN_CHUNK_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_RUN_VISUAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WSL_COMMAND_PATH_CACHE: Mutex<Option<PathBuf>> = Mutex::new(None);

struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    working_directory: String,
}

struct TerminalActiveRun {
    run_id: String,
    pty: Option<Arc<crate::terminal::run_supervisor::LiveRunPty>>,
}

enum ActiveRunInputTarget {
    None,
    Pending,
    Ready(Arc<crate::terminal::run_supervisor::LiveRunPty>),
}

struct TerminalActiveRunGuard {
    state: TerminalSessionState,
    run_id: String,
}

impl TerminalActiveRunGuard {
    fn new(state: TerminalSessionState, run_id: String) -> Self {
        Self { state, run_id }
    }
}

impl Drop for TerminalActiveRunGuard {
    fn drop(&mut self) {
        clear_active_terminal_run(&self.state, &self.run_id);
    }
}

enum TerminalEmitterMessage {
    VisibleOutput(String),
    Close,
}

#[derive(Clone, Default)]
pub struct TerminalSessionState {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    snapshots: Arc<Mutex<HashMap<String, String>>>,
    interactive_visual: Arc<Mutex<HashMap<String, TerminalInteractiveVisualState>>>,
    active_run: Arc<Mutex<Option<TerminalActiveRun>>>,
    creation_guard: Arc<Mutex<()>>,
}

#[tauri::command]
pub fn ensure_terminal_session(
    app: AppHandle,
    state: State<TerminalSessionState>,
    payload: EnsureTerminalSessionRequest,
) -> Result<TerminalSessionPayload, String> {
    let terminal_state = state.inner().clone();
    update_terminal_geometry(payload.cols, payload.rows);
    let (child, reader, terminal_cwd) = {
        let _creation_guard = terminal_state
            .creation_guard
            .lock()
            .map_err(|_| "终端会话创建锁已损坏。".to_string())?;

        if let Some(existing_session) = get_terminal_session(&terminal_state, &payload.session_id)?
        {
            if payload.cwd.is_none() && should_recreate_terminal_session(existing_session.as_ref())
            {
                remove_terminal_session(&terminal_state, &payload.session_id)?;
                remove_terminal_snapshot(&terminal_state, &payload.session_id)?;
                terminate_terminal_session(existing_session.as_ref())?;
            } else {
                resize_session_master(existing_session.as_ref(), payload.cols, payload.rows)?;
                resize_active_terminal_run_pty(&terminal_state, payload.cols, payload.rows)?;
                mark_terminal_resize_repaint_suppression(&terminal_state, &payload.session_id);
                let initial_output = get_terminal_snapshot(&terminal_state, &payload.session_id)?;
                mark_terminal_interactive_ready(&app);

                return Ok(TerminalSessionPayload {
                    session_id: payload.session_id,
                    cwd: existing_session.working_directory.clone(),
                    shell_label: "WSL2".into(),
                    created: false,
                    initial_output: (!initial_output.is_empty()).then_some(initial_output),
                });
            }
        }

        let wsl_command_path = resolve_wsl_command_path()?;
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

        set_terminal_snapshot(&terminal_state, &payload.session_id, String::new())?;
        remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;

        (child, reader, terminal_cwd)
    };

    spawn_terminal_reader(
        app.clone(),
        terminal_state.clone(),
        payload.session_id.clone(),
        reader,
    );
    spawn_terminal_waiter(
        app.clone(),
        terminal_state,
        payload.session_id.clone(),
        child,
    );
    mark_terminal_interactive_ready(&app);

    Ok(TerminalSessionPayload {
        session_id: payload.session_id,
        cwd: terminal_cwd,
        shell_label: "WSL2".into(),
        created: true,
        initial_output: None,
    })
}

#[tauri::command]
pub fn write_terminal_input(
    state: State<TerminalSessionState>,
    payload: TerminalInputRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    match get_active_terminal_run_input_target(&terminal_state)? {
        ActiveRunInputTarget::Ready(active_pty) => {
            return active_pty.write_input(payload.data.as_bytes());
        }
        ActiveRunInputTarget::Pending => {
            return Ok(());
        }
        ActiveRunInputTarget::None => {}
    }

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
    update_terminal_geometry(payload.cols, payload.rows);
    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;

    resize_session_master(session.as_ref(), payload.cols, payload.rows)?;
    resize_active_terminal_run_pty(&terminal_state, payload.cols, payload.rows)?;
    mark_terminal_resize_repaint_suppression(&terminal_state, &payload.session_id);
    Ok(())
}

#[tauri::command]
pub fn close_terminal_session(
    state: State<TerminalSessionState>,
    payload: CloseTerminalSessionRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let removed_session = remove_terminal_session(&terminal_state, &payload.session_id)?;
    remove_terminal_snapshot(&terminal_state, &payload.session_id)?;
    remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;

    let Some(session) = removed_session else {
        return Ok(());
    };

    terminate_terminal_session(session.as_ref())
}

pub fn shutdown_all_terminal_sessions(state: &TerminalSessionState) -> Result<(), String> {
    let sessions = {
        let mut sessions_map = lock_terminal_sessions(state)?;
        sessions_map
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>()
    };

    for session in sessions {
        terminate_terminal_session(session.as_ref())?;
    }

    Ok(())
}

#[tauri::command]
pub fn dispatch_script_to_terminal(
    app: AppHandle,
    state: State<TerminalSessionState>,
    payload: DispatchTerminalScriptRequest,
) -> Result<DispatchTerminalScriptPayload, String> {
    let terminal_state = state.inner().clone();
    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在，请先打开集成终端。".to_string())?;
    let started_at = Utc::now();
    let command = build_terminal_run_command(&payload, &session.working_directory, write_wsl_file)?;
    let command_line = command.display_command.clone();
    let used_temp_file = command.used_temp_file;
    let prompt_snapshot = get_terminal_snapshot(&terminal_state, &payload.session_id)?;
    let prompt = extract_prompt_from_terminal_snapshot(&prompt_snapshot).or_else(|| {
        resolve_wsl_command_path()
            .ok()
            .and_then(|path| build_terminal_prompt_fallback(&path, &session.working_directory))
    });
    try_mark_active_terminal_run(&terminal_state, &payload.run_id)?;
    if let Err(error) = transition_terminal_state(&app, TerminalState::SwitchingToRun) {
        clear_active_terminal_run(&terminal_state, &payload.run_id);
        return Err(error);
    }
    spawn_terminal_run(
        app,
        terminal_state,
        payload.session_id.clone(),
        payload.run_id.clone(),
        command,
        prompt,
    );

    Ok(DispatchTerminalScriptPayload {
        session_id: payload.session_id,
        cwd: session.working_directory.clone(),
        command_line,
        used_temp_file,
        started_at: started_at.to_rfc3339(),
    })
}

#[tauri::command]
pub fn cancel_terminal_run(
    state: State<TerminalSessionState>,
    payload: CancelTerminalRunRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let Some(active_pty) = get_active_terminal_run_pty(&terminal_state, &payload.run_id)? else {
        return Err(format!("未找到正在运行的脚本：{}", payload.run_id));
    };
    let _mode = payload.mode.as_deref().unwrap_or("graceful");
    active_pty.kill()
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

fn lock_terminal_snapshots(
    state: &TerminalSessionState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, String>>, String> {
    state
        .snapshots
        .lock()
        .map_err(|_| "终端快照状态已损坏。".to_string())
}

fn get_terminal_snapshot(state: &TerminalSessionState, session_id: &str) -> Result<String, String> {
    let snapshots = lock_terminal_snapshots(state)?;
    Ok(snapshots.get(session_id).cloned().unwrap_or_default())
}

fn set_terminal_snapshot(
    state: &TerminalSessionState,
    session_id: &str,
    value: String,
) -> Result<(), String> {
    let mut snapshots = lock_terminal_snapshots(state)?;
    snapshots.insert(session_id.to_string(), value);
    Ok(())
}

fn remove_terminal_snapshot(state: &TerminalSessionState, session_id: &str) -> Result<(), String> {
    let mut snapshots = lock_terminal_snapshots(state)?;
    snapshots.remove(session_id);
    Ok(())
}

fn append_terminal_snapshot(
    state: &TerminalSessionState,
    session_id: &str,
    chunk: &str,
) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    let mut snapshots = lock_terminal_snapshots(state)?;
    let snapshot = snapshots.entry(session_id.to_string()).or_default();
    snapshot.push_str(chunk);
    trim_terminal_snapshot(snapshot);
    Ok(())
}

fn remove_terminal_interactive_visual_state(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<(), String> {
    let mut visual_states = state
        .interactive_visual
        .lock()
        .map_err(|_| "终端交互视觉状态已损坏。".to_string())?;
    visual_states.remove(session_id);
    Ok(())
}

fn mark_terminal_resize_repaint_suppression(state: &TerminalSessionState, session_id: &str) {
    let Ok(mut visual_states) = state.interactive_visual.lock() else {
        return;
    };
    let visual_state = visual_states.entry(session_id.to_string()).or_default();
    visual_state.resize_repaint_suppress_until =
        Some(Instant::now() + TERMINAL_RESIZE_REPAINT_SUPPRESSION);
}

fn update_terminal_geometry(cols: u16, rows: u16) {
    let Ok(mut geometry) = crate::terminal::registry::registry().geometry.write() else {
        return;
    };
    geometry.cols = cols.max(2);
    geometry.rows = rows.max(1);
}

fn try_mark_active_terminal_run(state: &TerminalSessionState, run_id: &str) -> Result<(), String> {
    let mut active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    if let Some(active_run) = active_run.as_ref() {
        return Err(format!("已有脚本正在运行：{}", active_run.run_id));
    }
    *active_run = Some(TerminalActiveRun {
        run_id: run_id.to_string(),
        pty: None,
    });
    Ok(())
}

fn attach_active_terminal_run_pty(
    state: &TerminalSessionState,
    run_id: &str,
    pty: Arc<crate::terminal::run_supervisor::LiveRunPty>,
) -> Result<(), String> {
    let mut active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    let Some(active_run) = active_run.as_mut() else {
        return Err("当前没有可绑定的运行任务。".to_string());
    };
    if active_run.run_id != run_id {
        return Err(format!(
            "运行任务不匹配：active={} incoming={run_id}",
            active_run.run_id
        ));
    }
    active_run.pty = Some(pty);
    Ok(())
}

fn clear_active_terminal_run(state: &TerminalSessionState, run_id: &str) {
    let Ok(mut active_run) = state.active_run.lock() else {
        return;
    };
    if active_run.as_ref().map(|run| run.run_id.as_str()) == Some(run_id) {
        *active_run = None;
    }
}

fn get_active_terminal_run_pty(
    state: &TerminalSessionState,
    run_id: &str,
) -> Result<Option<Arc<crate::terminal::run_supervisor::LiveRunPty>>, String> {
    let active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    Ok(active_run
        .as_ref()
        .filter(|run| run.run_id == run_id)
        .and_then(|run| run.pty.as_ref().cloned()))
}

fn resize_active_terminal_run_pty(
    state: &TerminalSessionState,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let active_pty = {
        let active_run = state
            .active_run
            .lock()
            .map_err(|_| "终端运行状态已损坏。".to_string())?;
        active_run
            .as_ref()
            .and_then(|run| run.pty.as_ref().cloned())
    };

    if let Some(active_pty) = active_pty {
        active_pty.resize(cols, rows)?;
    }

    Ok(())
}

fn get_active_terminal_run_input_target(
    state: &TerminalSessionState,
) -> Result<ActiveRunInputTarget, String> {
    let active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    let Some(active_run) = active_run.as_ref() else {
        return Ok(ActiveRunInputTarget::None);
    };
    Ok(active_run
        .pty
        .as_ref()
        .cloned()
        .map(ActiveRunInputTarget::Ready)
        .unwrap_or(ActiveRunInputTarget::Pending))
}

fn should_skip_snapshot_for_interactive_resize_repaint(
    state: &TerminalSessionState,
    session_id: &str,
    chunk: &str,
) -> bool {
    if chunk.is_empty() {
        return false;
    }

    let Ok(mut visual_states) = state.interactive_visual.lock() else {
        return false;
    };
    let visual_state = visual_states.entry(session_id.to_string()).or_default();
    let was_alt_screen_active = visual_state.alt_screen_active;
    let has_alt_screen_control = contains_alt_screen_switch(chunk);
    visual_state.alt_screen_active =
        resolve_alt_screen_state_after_data(visual_state.alt_screen_active, chunk);

    if was_alt_screen_active || visual_state.alt_screen_active || has_alt_screen_control {
        return false;
    }

    let Some(suppress_until) = visual_state.resize_repaint_suppress_until else {
        return false;
    };
    if Instant::now() > suppress_until {
        visual_state.resize_repaint_suppress_until = None;
        return false;
    }

    is_likely_interactive_resize_repaint_frame(chunk)
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

fn resolve_wsl_command_path() -> Result<PathBuf, String> {
    {
        let cached_path = WSL_COMMAND_PATH_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(path) = cached_path.as_ref().filter(|path| path.exists()) {
            return Ok(path.clone());
        }
    }

    let resolved_path = find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"])
        .ok_or_else(|| "当前系统未发现可用的 wsl.exe，请先安装或启用 WSL2。".to_string())?;
    let mut cached_path = WSL_COMMAND_PATH_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cached_path = Some(resolved_path.clone());
    Ok(resolved_path)
}

fn write_wsl_file(path: &str, content: &[u8]) -> Result<(), String> {
    terminal_wsl::write_wsl_file(resolve_wsl_command_path()?, path, content)
}

pub(crate) fn build_temp_file_suffix() -> Result<String, String> {
    terminal_wsl::build_temp_file_suffix()
}

fn terminal_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn transition_terminal_state(app: &AppHandle, to: TerminalState) -> Result<(), String> {
    let registry = crate::terminal::registry::registry();
    let mut state = registry
        .state
        .write()
        .map_err(|_| "终端状态机已损坏。".to_string())?;
    let from = *state;
    if from == to {
        return Ok(());
    }
    if !StateMachine::can_transition(from, to) {
        return Err(format!("非法终端状态转移：{from:?} -> {to:?}"));
    }
    *state = to;
    emit_terminal_state_changed(
        app,
        TerminalStateChangedEvent {
            from,
            to,
            at_ms: terminal_now_ms(),
        },
    );
    Ok(())
}

fn mark_terminal_interactive_ready(app: &AppHandle) {
    let _ = transition_terminal_state(app, TerminalState::IdleInteractive);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("terminal:interactive-ready", ());
    }
}

fn mark_terminal_interactive_exited(app: &AppHandle, payload: TerminalExitEvent) {
    if crate::terminal::registry::registry().current_state() == TerminalState::IdleInteractive {
        let _ = transition_terminal_state(app, TerminalState::Booting);
    }
    emit_terminal_exit(app, payload);
}

fn emit_terminal_run_started_state(
    app: &AppHandle,
    session_id: &str,
    run_id: &str,
    pid: u32,
    started_at: Instant,
) {
    emit_terminal_run_started(
        app,
        TerminalRunStartedEvent {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            started_at_ms: terminal_now_ms()
                - i64::try_from(started_at.elapsed().as_millis()).unwrap_or(0),
            pid,
        },
    );
    let _ = transition_terminal_state(app, TerminalState::Running);
}

fn begin_terminal_run_completion(app: &AppHandle) {
    let current = crate::terminal::registry::registry().current_state();
    match current {
        TerminalState::Running => {
            let _ = transition_terminal_state(app, TerminalState::SwitchingToIdle);
        }
        TerminalState::SwitchingToRun => {
            let _ = transition_terminal_state(app, TerminalState::IdleInteractive);
        }
        _ => {}
    }
}

fn finish_terminal_run_completion(app: &AppHandle) {
    let current = crate::terminal::registry::registry().current_state();
    if current == TerminalState::SwitchingToIdle {
        let _ = transition_terminal_state(app, TerminalState::IdleInteractive);
    }
}

fn emit_terminal_run_completed_with_state(app: &AppHandle, payload: TerminalRunCompletedEvent) {
    begin_terminal_run_completion(app);
    emit_terminal_run_completed(app, payload);
    finish_terminal_run_completion(app);
}

fn next_terminal_data_seq() -> u64 {
    TERMINAL_DATA_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
}

fn next_terminal_run_visual_seq() -> u64 {
    TERMINAL_RUN_VISUAL_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
}

fn emit_terminal_run_chunk_with_visual_prefix(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    run_id: &str,
    data: String,
    visual: TerminalRunVisualObservation,
) {
    if data.is_empty() {
        return;
    }

    if !visual.prefix.is_empty() {
        let _ = append_terminal_snapshot(state, session_id, visual.prefix);
    }
    let _ = append_terminal_snapshot(state, session_id, &data);
    emit_terminal_data(
        app,
        TerminalDataEvent {
            session_id: session_id.to_string(),
            data: format!("{}{}", visual.prefix, data),
            source: TerminalDataSource::Run,
            seq: next_terminal_data_seq(),
            run_id: Some(run_id.to_string()),
            run_seq: (visual.run_seq > 0).then_some(visual.run_seq),
        },
    );
    emit_terminal_run_chunk(
        app,
        TerminalRunChunkEvent {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            data,
            seq: next_terminal_run_chunk_seq(),
        },
    );
}

fn next_terminal_run_chunk_seq() -> u64 {
    TERMINAL_RUN_CHUNK_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
}

fn emit_terminal_run_visual_completion(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    run_id: &str,
    exit_code: Option<i32>,
    started_at: Instant,
    tracker: &Arc<Mutex<TerminalRunVisualTracker>>,
    prompt: Option<String>,
) {
    let tracker_snapshot = current_visual_tracker(tracker);
    let reset_run_seq = next_visual_run_seq(tracker);
    let separator_run_seq = next_visual_run_seq(tracker);
    let reset = build_terminal_ansi_reset(tracker_snapshot);
    let separator = build_terminal_run_separator(
        next_terminal_run_visual_seq(),
        exit_code,
        started_at.elapsed(),
        tracker_snapshot,
        prompt,
    );
    let _ = append_terminal_snapshot(state, session_id, &reset);
    let _ = append_terminal_snapshot(state, session_id, &separator);

    emit_terminal_data(
        app,
        TerminalDataEvent {
            session_id: session_id.to_string(),
            data: reset,
            source: TerminalDataSource::InjectedReset,
            seq: next_terminal_data_seq(),
            run_id: Some(run_id.to_string()),
            run_seq: Some(reset_run_seq),
        },
    );

    emit_terminal_data(
        app,
        TerminalDataEvent {
            session_id: session_id.to_string(),
            data: separator,
            source: TerminalDataSource::InjectedSeparator,
            seq: next_terminal_data_seq(),
            run_id: Some(run_id.to_string()),
            run_seq: Some(separator_run_seq),
        },
    );
}

fn flush_terminal_data_buffer(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    buffer: &mut String,
) {
    if buffer.is_empty() {
        return;
    }

    let chunk = std::mem::take(buffer);
    if !should_skip_snapshot_for_interactive_resize_repaint(state, session_id, &chunk) {
        let _ = append_terminal_snapshot(state, session_id, &chunk);
    }

    emit_terminal_data(
        app,
        TerminalDataEvent {
            session_id: session_id.to_string(),
            data: chunk,
            source: TerminalDataSource::Interactive,
            seq: next_terminal_data_seq(),
            run_id: None,
            run_seq: None,
        },
    );
}

fn spawn_terminal_event_emitter(
    app: AppHandle,
    state: TerminalSessionState,
    session_id: String,
    receiver: mpsc::Receiver<TerminalEmitterMessage>,
) {
    thread::spawn(move || {
        let mut visible_output_buffer = String::new();

        loop {
            match receiver.recv_timeout(TERMINAL_EVENT_FLUSH_INTERVAL) {
                Ok(TerminalEmitterMessage::VisibleOutput(chunk)) => {
                    visible_output_buffer.push_str(&chunk);
                    if visible_output_buffer.len() >= TERMINAL_EVENT_FLUSH_THRESHOLD {
                        flush_terminal_data_buffer(
                            &app,
                            &state,
                            &session_id,
                            &mut visible_output_buffer,
                        );
                    }
                }
                Ok(TerminalEmitterMessage::Close) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush_terminal_data_buffer(
                        &app,
                        &state,
                        &session_id,
                        &mut visible_output_buffer,
                    );
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        flush_terminal_data_buffer(&app, &state, &session_id, &mut visible_output_buffer);
    });
}

fn spawn_terminal_reader(
    app: AppHandle,
    state: TerminalSessionState,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    let (sender, receiver) = mpsc::channel::<TerminalEmitterMessage>();
    spawn_terminal_event_emitter(app, state, session_id, receiver);

    thread::spawn(move || {
        let mut buffer = [0_u8; TERMINAL_READ_BUFFER_SIZE];
        let mut decoded_chunk = String::new();
        let mut decoder = Utf8ChunkDecoder::default();

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    decoded_chunk.clear();
                    decoder.decode_into(&buffer[..size], &mut decoded_chunk, false);
                    if decoded_chunk.is_empty() {
                        continue;
                    }

                    let _ =
                        sender.send(TerminalEmitterMessage::VisibleOutput(decoded_chunk.clone()));
                }
                Err(_) => break,
            }
        }

        decoded_chunk.clear();
        decoder.decode_into(&[], &mut decoded_chunk, true);
        if !decoded_chunk.is_empty() {
            let _ = sender.send(TerminalEmitterMessage::VisibleOutput(decoded_chunk));
        }

        let _ = sender.send(TerminalEmitterMessage::Close);
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
        if let Ok(mut snapshots) = state.snapshots.lock() {
            snapshots.remove(&session_id);
        }
        if let Ok(mut visual_states) = state.interactive_visual.lock() {
            visual_states.remove(&session_id);
        }

        mark_terminal_interactive_exited(
            &app,
            TerminalExitEvent {
                session_id,
                exit_code,
            },
        );
    });
}

fn cleanup_terminal_child_run_files(paths: &[String]) {
    if paths.is_empty() {
        return;
    }

    let Ok(wsl_command_path) = resolve_wsl_command_path() else {
        return;
    };
    let cleanup_command = format!(
        "rm -f {}",
        paths
            .iter()
            .map(|path| terminal_wsl::bash_quote(path))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let mut command = StdCommand::new(wsl_command_path);
    configure_std_command_for_background(&mut command);
    let _ = command
        .args(["--", "sh", "-lc", &cleanup_command])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn spawn_terminal_run(
    app: AppHandle,
    state: TerminalSessionState,
    session_id: String,
    run_id: String,
    command: TerminalDispatchCommand,
    prompt: Option<String>,
) {
    thread::spawn(move || {
        let started_at = Instant::now();
        let visual_tracker = Arc::new(Mutex::new(TerminalRunVisualTracker::default()));
        let _active_run_guard = TerminalActiveRunGuard::new(state.clone(), run_id.clone());
        let wsl_command_path = match resolve_wsl_command_path() {
            Ok(path) => path,
            Err(error) => {
                let output = format!("启动 WSL2 失败：{error}\n");
                let visual = observe_visual_output_and_prefix(&visual_tracker, &output);
                emit_terminal_run_chunk_with_visual_prefix(
                    &app,
                    &state,
                    &session_id,
                    &run_id,
                    output,
                    visual,
                );
                emit_terminal_run_visual_completion(
                    &app,
                    &state,
                    &session_id,
                    &run_id,
                    Some(127),
                    started_at,
                    &visual_tracker,
                    prompt,
                );
                emit_terminal_run_completed_with_state(
                    &app,
                    TerminalRunCompletedEvent {
                        session_id,
                        run_id,
                        exit_code: Some(127),
                        finished_at: Utc::now().to_rfc3339(),
                    },
                );
                return;
            }
        };

        let output_app = app.clone();
        let output_state = state.clone();
        let output_session_id = session_id.clone();
        let output_run_id = run_id.clone();
        let output_visual_tracker = Arc::clone(&visual_tracker);
        let geometry = crate::terminal::registry::registry()
            .geometry
            .read()
            .map(|geometry| *geometry)
            .unwrap_or_default();
        let result = crate::terminal::run_supervisor::spawn_live_run_pty(
            crate::terminal::run_supervisor::RunPtySpec {
                wsl_command_path,
                working_directory: command.working_directory.clone(),
                execution_path: command.execution_path.clone(),
                cols: geometry.cols,
                rows: geometry.rows,
                timeout: None,
            },
            move |chunk| {
                let visual = observe_visual_output_and_prefix(&output_visual_tracker, &chunk);
                emit_terminal_run_chunk_with_visual_prefix(
                    &output_app,
                    &output_state,
                    &output_session_id,
                    &output_run_id,
                    chunk,
                    visual,
                );
            },
        );
        let exit_code = match result {
            Ok(live_run) => {
                let live_run = Arc::new(live_run);
                if let Err(error) =
                    attach_active_terminal_run_pty(&state, &run_id, Arc::clone(&live_run))
                {
                    let output = format!("{error}\n");
                    let visual = observe_visual_output_and_prefix(&visual_tracker, &output);
                    emit_terminal_run_chunk_with_visual_prefix(
                        &app,
                        &state,
                        &session_id,
                        &run_id,
                        output,
                        visual,
                    );
                    let _ = live_run.kill();
                    Some(127)
                } else {
                    emit_terminal_run_started_state(
                        &app,
                        &session_id,
                        &run_id,
                        live_run.pid.unwrap_or(0),
                        started_at,
                    );
                    live_run.wait_timeout(None).or(Some(1))
                }
            }
            Err(error) => {
                let output = format!("{error}\n");
                let visual = observe_visual_output_and_prefix(&visual_tracker, &output);
                emit_terminal_run_chunk_with_visual_prefix(
                    &app,
                    &state,
                    &session_id,
                    &run_id,
                    output,
                    visual,
                );
                Some(127)
            }
        };

        cleanup_terminal_child_run_files(&command.cleanup_paths);
        emit_terminal_run_visual_completion(
            &app,
            &state,
            &session_id,
            &run_id,
            exit_code,
            started_at,
            &visual_tracker,
            prompt,
        );
        emit_terminal_run_completed_with_state(
            &app,
            TerminalRunCompletedEvent {
                session_id,
                run_id,
                exit_code,
                finished_at: Utc::now().to_rfc3339(),
            },
        );
    });
}

pub(crate) fn to_wsl_path(path: &std::path::Path) -> Result<String, String> {
    terminal_wsl::to_wsl_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::visual::{
        TERMINAL_ANSI_EXIT_ALT_SCREEN, TERMINAL_ANSI_RESET_SCROLL_REGION_PRESERVE_CURSOR,
        TERMINAL_ANSI_SAFE_RESET,
    };
    use std::{
        fs,
        sync::{Arc, Mutex},
        time::Duration,
    };

    struct DispatchHarnessResult {
        output: String,
        exit_code: Option<i32>,
        seqs: Vec<u64>,
    }

    #[test]
    fn run_pty_active_run_is_serialized() {
        let state = TerminalSessionState::default();

        assert!(try_mark_active_terminal_run(&state, "run-1").is_ok());
        assert!(try_mark_active_terminal_run(&state, "run-2").is_err());
        assert!(matches!(
            get_active_terminal_run_input_target(&state),
            Ok(ActiveRunInputTarget::Pending)
        ));

        clear_active_terminal_run(&state, "run-1");
        assert!(matches!(
            get_active_terminal_run_input_target(&state),
            Ok(ActiveRunInputTarget::None)
        ));
        assert!(try_mark_active_terminal_run(&state, "run-2").is_ok());
    }

    #[test]
    fn terminal_run_chunk_seq_is_monotonic() {
        let first = next_terminal_run_chunk_seq();
        let second = next_terminal_run_chunk_seq();
        let third = next_terminal_run_chunk_seq();

        assert!(first < second);
        assert!(second < third);
    }

    #[test]
    fn terminal_data_seq_is_monotonic() {
        let first = next_terminal_data_seq();
        let second = next_terminal_data_seq();
        let third = next_terminal_data_seq();

        assert!(first < second);
        assert!(second < third);
    }

    #[test]
    fn run_pty_visual_separator_does_not_add_blank_line_after_newline_output() {
        let separator = build_terminal_run_separator(
            7,
            Some(0),
            Duration::from_millis(1200),
            TerminalRunVisualTracker {
                has_output: true,
                ended_at_line_start: true,
                ..TerminalRunVisualTracker::default()
            },
            Some("[test@Predator ~]$ ".to_string()),
        );

        assert!(separator.starts_with("──── run #7 · exit 0 · 1.2s ────\r\n"));
        assert!(separator.ends_with("[test@Predator ~]$ "));
        assert!(!separator.starts_with("\r\n\r\n"));
    }

    #[test]
    fn run_pty_visual_separator_starts_newline_for_no_newline_output() {
        let separator = build_terminal_run_separator(
            8,
            Some(42),
            Duration::from_millis(250),
            TerminalRunVisualTracker {
                has_output: true,
                ended_at_line_start: false,
                ..TerminalRunVisualTracker::default()
            },
            None,
        );

        assert!(separator.starts_with("\r\n──── run #8 · exit 42 · 0.2s ────\r\n"));
    }

    #[test]
    fn visual_reset_does_not_move_cursor_for_plain_output() {
        let mut tracker = TerminalRunVisualTracker::default();
        tracker.observe("Hello SH Editor\n");

        let reset = build_terminal_ansi_reset(tracker);

        assert!(!reset.contains("\x1b[?1049l"));
        assert!(!reset.contains("\x1b[r"));
        assert_eq!(reset, TERMINAL_ANSI_SAFE_RESET);
    }

    #[test]
    fn visual_reset_exits_alt_screen_only_when_run_entered_it() {
        let mut tracker = TerminalRunVisualTracker::default();
        tracker.observe("\x1b[?1049hinside alt screen");

        let reset = build_terminal_ansi_reset(tracker);

        assert!(reset.starts_with(TERMINAL_ANSI_EXIT_ALT_SCREEN));
    }

    #[test]
    fn visual_reset_preserves_cursor_when_resetting_scroll_region() {
        let mut tracker = TerminalRunVisualTracker::default();
        tracker.observe("\x1b[3;20rregion changed");

        let reset = build_terminal_ansi_reset(tracker);

        assert!(reset.contains(TERMINAL_ANSI_RESET_SCROLL_REGION_PRESERVE_CURSOR));
        assert!(!reset.contains("\x1b[m\x1b[r"));
    }

    #[test]
    fn interactive_resize_repaint_is_excluded_from_snapshot_window() {
        let state = TerminalSessionState::default();
        let session_id = "resize-repaint-session";
        mark_terminal_resize_repaint_suppression(&state, session_id);

        assert!(should_skip_snapshot_for_interactive_resize_repaint(
            &state,
            session_id,
            "\x1b[?25l\x1b[m\x1b[HTo run a command as administrator\x1b[K\r\n[test@Predator]$\x1b[K"
        ));
        assert!(!should_skip_snapshot_for_interactive_resize_repaint(
            &state,
            session_id,
            "normal output after resize\r\n"
        ));
    }

    #[test]
    fn interactive_resize_repaint_keeps_alt_screen_frames() {
        let state = TerminalSessionState::default();
        let session_id = "resize-alt-screen-session";

        mark_terminal_resize_repaint_suppression(&state, session_id);
        assert!(!should_skip_snapshot_for_interactive_resize_repaint(
            &state,
            session_id,
            "\x1b[?1049h"
        ));

        mark_terminal_resize_repaint_suppression(&state, session_id);
        assert!(!should_skip_snapshot_for_interactive_resize_repaint(
            &state,
            session_id,
            "\x1b[?25l\x1b[Hvim repaint\x1b[K"
        ));
    }

    #[test]
    fn terminal_prompt_fallback_builds_visible_prompt() {
        let _guard = crate::terminal::test_support::wsl_test_guard();
        let wsl_command_path = resolve_wsl_command_path().expect("wsl should resolve");
        let terminal_cwd =
            resolve_wsl_home_directory(&wsl_command_path).unwrap_or_else(|| "~".to_string());

        let prompt = build_terminal_prompt_fallback(&wsl_command_path, &terminal_cwd)
            .expect("prompt fallback should build");

        assert!(prompt.starts_with('['));
        assert!(prompt.ends_with("$ ") || prompt.ends_with("# "));
        assert!(prompt.contains('@'));
    }

    #[test]
    fn run_pty_extracts_last_prompt_from_interactive_snapshot() {
        let snapshot = "To run a command as administrator\n\x1b[4;1H\x1b[?25h\x1b[?2004h\x1b[32m\x1b[1m[test@Predator my_desktop_app]$\x1b[m ";
        let prompt = extract_prompt_from_terminal_snapshot(snapshot);

        assert_eq!(
            prompt.as_deref(),
            Some("\x1b[32m\x1b[1m[test@Predator my_desktop_app]$\x1b[m ")
        );
    }

    #[test]
    fn visual_completion_snapshot_keeps_prompt_after_run_chunk_with_dollar() {
        let state = TerminalSessionState::default();
        let session_id = "snapshot-prompt-session";
        let prompt = "\x1b[32m\x1b[1m[test@Predator my_desktop_app]$\x1b[m ";
        set_terminal_snapshot(&state, session_id, prompt.to_string()).expect("snapshot set");
        append_terminal_snapshot(&state, session_id, "price is $5\n").expect("run output append");

        let separator = build_terminal_run_separator(
            9,
            Some(0),
            Duration::from_millis(900),
            TerminalRunVisualTracker {
                has_output: true,
                ended_at_line_start: true,
                ..TerminalRunVisualTracker::default()
            },
            Some(prompt.to_string()),
        );
        append_terminal_snapshot(&state, session_id, &separator).expect("separator append");

        let snapshot = get_terminal_snapshot(&state, session_id).expect("snapshot get");
        let extracted = extract_prompt_from_terminal_snapshot(&snapshot);

        assert_eq!(extracted.as_deref(), Some(prompt));
    }

    #[test]
    fn dispatch_command_prefers_workspace_root_over_script_directory() {
        let temp_root = std::env::temp_dir().join(format!(
            "calamex-dispatch-workspace-{}",
            build_temp_file_suffix().expect("suffix should build")
        ));
        let script_dir = temp_root.join("scripts");
        fs::create_dir_all(&script_dir).expect("test workspace should be created");
        let script_path = script_dir.join("hello.sh");
        fs::write(&script_path, "pwd\n").expect("test script should be written");

        let payload = DispatchTerminalScriptRequest {
            session_id: "dispatch-cwd-session".to_string(),
            path: Some(script_path.to_string_lossy().to_string()),
            workspace_root_path: Some(temp_root.to_string_lossy().to_string()),
            content: String::new(),
            is_dirty: false,
            run_id: "dispatch-cwd-run".to_string(),
        };
        let command = build_terminal_run_command(&payload, "/tmp", |_, _| {
            Err("clean file dispatch should not materialize content".to_string())
        })
        .expect("dispatch command should build");

        assert_eq!(
            command.working_directory,
            to_wsl_path(&temp_root).expect("workspace root should convert to WSL path")
        );

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn run_pty_dispatch_harness_emits_output_and_complete() {
        let result =
            run_pty_dispatch_harness("echo __RUN_PTY_DISPATCH_OK__\nexit 0\n", "run-pty-ok");

        assert_eq!(result.exit_code, Some(0), "{}", result.output);
        assert!(result.output.contains("__RUN_PTY_DISPATCH_OK__"));
        assert!(!result.seqs.is_empty());
        assert!(result.seqs.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn run_pty_dispatch_harness_propagates_exit_code() {
        let result = run_pty_dispatch_harness("echo __RUN_PTY_EXIT_42__\nexit 42\n", "run-pty-42");

        assert_eq!(result.exit_code, Some(42), "{}", result.output);
        assert!(result.output.contains("__RUN_PTY_EXIT_42__"));
    }

    #[test]
    fn run_pty_dispatch_harness_is_default_path() {
        let result =
            run_pty_dispatch_harness("echo __RUN_PTY_DEFAULT_OK__\nexit 0\n", "run-default-ok");

        assert_eq!(result.exit_code, Some(0), "{}", result.output);
        assert!(result.output.contains("__RUN_PTY_DEFAULT_OK__"));
    }

    fn run_pty_dispatch_harness(content: &str, run_id: &str) -> DispatchHarnessResult {
        let _guard = crate::terminal::test_support::wsl_test_guard();
        let payload = DispatchTerminalScriptRequest {
            session_id: "dispatch-harness-session".to_string(),
            path: None,
            workspace_root_path: None,
            content: content.to_string(),
            is_dirty: true,
            run_id: run_id.to_string(),
        };
        let command = build_terminal_run_command(&payload, "/tmp", write_wsl_file)
            .expect("dispatch command should build");
        let output = Arc::new(Mutex::new(String::new()));
        let seqs = Arc::new(Mutex::new(Vec::<u64>::new()));
        let output_ref = Arc::clone(&output);
        let seqs_ref = Arc::clone(&seqs);
        let exit = crate::terminal::run_supervisor::run_pty_script(
            crate::terminal::run_supervisor::RunPtySpec {
                wsl_command_path: resolve_wsl_command_path().expect("wsl should resolve"),
                working_directory: command.working_directory.clone(),
                execution_path: command.execution_path.clone(),
                cols: 120,
                rows: 40,
                timeout: Some(Duration::from_secs(8)),
            },
            move |chunk| {
                output_ref.lock().expect("output mutex").push_str(&chunk);
                seqs_ref
                    .lock()
                    .expect("seq mutex")
                    .push(next_terminal_run_chunk_seq());
            },
        )
        .expect("run pty dispatch harness should run");
        cleanup_terminal_child_run_files(&command.cleanup_paths);
        let output = output.lock().expect("output mutex").clone();
        let seqs = seqs.lock().expect("seq mutex").clone();

        DispatchHarnessResult {
            output,
            exit_code: exit.exit_code,
            seqs,
        }
    }
}
