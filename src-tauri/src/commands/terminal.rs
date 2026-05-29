use jiff::Timestamp;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::terminal::{
    command_contracts::{
        CancelTerminalRunRequest, CloseTerminalSessionRequest, DispatchTerminalScriptPayload,
        DispatchTerminalScriptRequest, EnsureTerminalSessionRequest, TerminalInputRequest,
        TerminalResizeRequest, TerminalSessionPayload,
    },
    dispatch::{build_terminal_run_command_for_wsl_link, TerminalDispatchCommand},
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
    visual::{
        build_terminal_ansi_reset, build_terminal_run_separator, current_visual_tracker,
        extract_prompt_from_terminal_snapshot, next_visual_run_seq,
        observe_visual_output_and_prefix, TerminalRunVisualObservation, TerminalRunVisualTracker,
    },
    wsl as terminal_wsl,
};
use crate::wsl_link::{
    agent_distribution::{start_installed_agent, WslLinkAgentDistributionPlan},
    grpc_transport::WslLinkGrpcTransportError,
    noise_material::{
        KeyringWslLinkNoiseMaterialStore, WslLinkDesktopNoiseMaterial, WslLinkNoiseMaterialStore,
    },
    primary_supervisor::WslLinkPrimarySupervisorError,
    terminal_client::{
        open_interactive_terminal_over_wsl_link, run_terminal_script_over_wsl_link,
        signal_terminal_process_over_wsl_link, write_terminal_run_input_over_wsl_link,
        WslLinkInteractiveTerminalHandle, WslLinkTerminalClientError,
    },
    terminal_exec::{
        WslLinkTerminalOpenInteractiveRequest, WslLinkTerminalRunInput,
        WslLinkTerminalRunScriptRequest, WslLinkTerminalServerPayload,
        WslLinkTerminalSignalProcess,
    },
};

const TERMINAL_RESIZE_REPAINT_SUPPRESSION: Duration = Duration::from_millis(240);
const DEFAULT_WSL_INTERACTIVE_CWD: &str = "~";
const WSL_LINK_NOISE_MATERIAL_MISSING_MESSAGE: &str =
    "WSL Link Noise 桌面密钥材料不存在，请先安装并启动 WSL Link agent。";
const MAX_PENDING_SWITCH_INPUT_BYTES: usize = 64 * 1024;

static TERMINAL_DATA_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_RUN_CHUNK_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_RUN_VISUAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

struct TerminalSession {
    handle: WslLinkInteractiveTerminalHandle,
    working_directory: String,
}

struct TerminalActiveRun {
    session_id: String,
    run_id: String,
    wsl_link_pid: Option<u32>,
}

enum ActiveRunInputTarget {
    None,
    Pending,
    Run(String),
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

#[derive(Clone, Default)]
pub struct TerminalSessionState {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    snapshots: Arc<Mutex<HashMap<String, String>>>,
    interactive_visual: Arc<Mutex<HashMap<String, TerminalInteractiveVisualState>>>,
    active_run: Arc<Mutex<Option<TerminalActiveRun>>>,
    pending_switch_input: Arc<Mutex<HashMap<String, String>>>,
    creation_guard: Arc<Mutex<()>>,
}

#[tauri::command]
pub async fn ensure_terminal_session(
    app: AppHandle,
    state: State<'_, TerminalSessionState>,
    payload: EnsureTerminalSessionRequest,
) -> Result<TerminalSessionPayload, String> {
    let terminal_state = state.inner().clone();
    update_terminal_geometry(payload.cols, payload.rows);

    // Phase 1: 创建锁保护下检查现有会话、准备 WSL 连接参数。
    // std::sync::MutexGuard 不能跨越 .await，必须在 await 前释放。
    let (terminal_cwd, created) = {
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
                existing_session
                    .handle
                    .resize(payload.cols, payload.rows)
                    .map_err(|error| error.to_string())?;
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

        let working_directory = resolve_terminal_start_directory(payload.cwd.as_deref())?;
        let terminal_cwd = working_directory
            .as_ref()
            .map(|path| to_wsl_path(path.as_path()))
            .transpose()?
            .unwrap_or_else(|| DEFAULT_WSL_INTERACTIVE_CWD.to_string());
        let desktop_material = load_required_desktop_noise_material()?;

        // 释放 creation_guard 后再做异步 WSL 连接，避免 MutexGuard 跨越 .await
        drop(_creation_guard);

        let handle = open_interactive_terminal_with_agent_retry(
            app.clone(),
            terminal_state.clone(),
            payload.session_id.clone(),
            &desktop_material,
            WslLinkTerminalOpenInteractiveRequest {
                session_id: payload.session_id.clone(),
                working_directory: terminal_cwd.clone(),
                cols: payload.cols,
                rows: payload.rows,
            },
        )
        .await
        .map_err(|error| error.to_string())?;

        // Phase 2: 重新获取 creation_guard 后原子插入，防止并发创建
        {
            let _creation_guard = terminal_state
                .creation_guard
                .lock()
                .map_err(|_| "终端会话创建锁已损坏。".to_string())?;
            // 再次检查：await 期间可能有其他调用者抢先生成了同一会话
            if get_terminal_session(&terminal_state, &payload.session_id)?.is_some() {
                // 已有会话，终止刚创建的连接
                let _ = handle.close();
                return Ok(TerminalSessionPayload {
                    session_id: payload.session_id,
                    cwd: terminal_cwd.clone(),
                    shell_label: "WSL2".into(),
                    created: false,
                    initial_output: None,
                });
            }

            let session = Arc::new(TerminalSession {
                handle,
                working_directory: terminal_cwd.clone(),
            });
            let mut sessions = lock_terminal_sessions(&terminal_state)?;
            sessions.insert(payload.session_id.clone(), Arc::clone(&session));
            set_terminal_snapshot(&terminal_state, &payload.session_id, String::new())?;
            remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;
        }

        (terminal_cwd, true)
    };

    mark_terminal_interactive_ready(&app);

    Ok(TerminalSessionPayload {
        session_id: payload.session_id,
        cwd: terminal_cwd,
        shell_label: "WSL2".into(),
        created,
        initial_output: None,
    })
}

#[tauri::command]
pub async fn write_terminal_input(
    state: State<'_, TerminalSessionState>,
    payload: TerminalInputRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();

    match get_active_terminal_run_input_target(&terminal_state, &payload.session_id)? {
        ActiveRunInputTarget::Pending => {
            // 切换态（SwitchingToRun / SwitchingToIdle）：run 的 stdin 尚未就绪。
            // 不再静默丢弃用户输入，而是按会话缓冲，待状态落定后随下一次写入按序补发。
            buffer_pending_switch_input(&terminal_state, &payload.session_id, &payload.data)?;
            return Ok(());
        }
        ActiveRunInputTarget::Run(run_id) => {
            let data = take_and_prepend_pending_switch_input(
                &terminal_state,
                &payload.session_id,
                payload.data,
            )?;
            let desktop_material = load_required_desktop_noise_material()?;
            return write_terminal_run_input_over_wsl_link(
                &desktop_material,
                WslLinkTerminalRunInput { run_id, data },
            )
            .await
            .map_err(|error| error.to_string());
        }
        ActiveRunInputTarget::None => {}
    }

    let data =
        take_and_prepend_pending_switch_input(&terminal_state, &payload.session_id, payload.data)?;
    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;
    session
        .handle
        .write_input(data)
        .await
        .map_err(|error| error.to_string())
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
    session
        .handle
        .resize(payload.cols, payload.rows)
        .map_err(|error| error.to_string())?;
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
    remove_pending_switch_input(&terminal_state, &payload.session_id);
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

async fn open_interactive_terminal_with_agent_retry(
    app: AppHandle,
    terminal_state: TerminalSessionState,
    session_id: String,
    desktop_material: &WslLinkDesktopNoiseMaterial,
    request: WslLinkTerminalOpenInteractiveRequest,
) -> Result<WslLinkInteractiveTerminalHandle, String> {
    match open_interactive_terminal_attempt(
        app.clone(),
        terminal_state.clone(),
        session_id.clone(),
        desktop_material,
        request.clone(),
    )
    .await
    {
        Ok(handle) => Ok(handle),
        Err(first_error) if should_retry_terminal_after_agent_start(&first_error) => {
            start_installed_agent(&WslLinkAgentDistributionPlan::user_default())
                .await
                .map_err(|start_error| {
                    format!(
                        "WSL Link agent 自动启动失败：{start_error}；首次连接错误：{first_error}"
                    )
                })?;
            open_interactive_terminal_attempt(
                app,
                terminal_state,
                session_id,
                desktop_material,
                request,
            )
            .await
            .map_err(|retry_error| {
                format!(
                    "WSL Link agent 已自动启动，但终端连接仍失败：{retry_error}；首次连接错误：{first_error}"
                )
            })
        }
        Err(error) => Err(error.to_string()),
    }
}

async fn open_interactive_terminal_attempt(
    app: AppHandle,
    terminal_state: TerminalSessionState,
    session_id: String,
    desktop_material: &WslLinkDesktopNoiseMaterial,
    request: WslLinkTerminalOpenInteractiveRequest,
) -> Result<WslLinkInteractiveTerminalHandle, WslLinkTerminalClientError> {
    open_interactive_terminal_over_wsl_link(desktop_material, request, move |event| {
        handle_wsl_link_interactive_terminal_event(&app, &terminal_state, &session_id, event);
    })
    .await
}

fn should_retry_terminal_after_agent_start(error: &WslLinkTerminalClientError) -> bool {
    match error {
        WslLinkTerminalClientError::Grpc(error) => is_wsl_link_connection_error(error),
        WslLinkTerminalClientError::Supervisor(WslLinkPrimarySupervisorError::Grpc(error)) => {
            is_wsl_link_connection_error(error)
        }
        WslLinkTerminalClientError::Status(_)
        | WslLinkTerminalClientError::Payload(_)
        | WslLinkTerminalClientError::SessionMismatch
        | WslLinkTerminalClientError::CommandChannelClosed => false,
    }
}

fn is_wsl_link_connection_error(error: &WslLinkGrpcTransportError) -> bool {
    matches!(
        error,
        WslLinkGrpcTransportError::Transport(_) | WslLinkGrpcTransportError::Connector(_)
    )
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
    let started_at = Timestamp::now();
    let desktop_material = load_required_desktop_noise_material()?;
    let (command, wsl_link_script_content) =
        build_terminal_run_command_for_wsl_link(&payload, &session.working_directory)?;
    let command_line = command.display_command.clone();
    let used_temp_file = command.used_temp_file;
    let prompt_snapshot = get_terminal_snapshot(&terminal_state, &payload.session_id)?;
    let prompt = extract_prompt_from_terminal_snapshot(&prompt_snapshot);

    try_mark_active_terminal_run(&terminal_state, &payload.session_id, &payload.run_id)?;
    if let Err(error) = transition_terminal_state(&app, TerminalState::SwitchingToRun) {
        clear_active_terminal_run(&terminal_state, &payload.run_id);
        return Err(error);
    }

    spawn_wsl_link_terminal_run(
        app,
        terminal_state,
        payload.session_id.clone(),
        payload.run_id.clone(),
        command,
        wsl_link_script_content,
        prompt,
        desktop_material,
    );

    Ok(DispatchTerminalScriptPayload {
        session_id: payload.session_id,
        cwd: session.working_directory.clone(),
        command_line,
        used_temp_file,
        started_at: started_at.to_string(),
    })
}

#[tauri::command]
pub async fn cancel_terminal_run(
    state: State<'_, TerminalSessionState>,
    payload: CancelTerminalRunRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let mode = payload.mode.as_deref().unwrap_or("graceful");

    if let Some(pid) = get_active_terminal_run_wsl_link_pid(&terminal_state, &payload.run_id)? {
        let desktop_material = load_required_desktop_noise_material()?;
        return signal_terminal_process_over_wsl_link(
            &desktop_material,
            WslLinkTerminalSignalProcess {
                pid,
                mode: mode.to_string(),
            },
        )
        .await
        .map_err(|error| error.to_string());
    }

    Err(format!("未找到正在运行的脚本：{}", payload.run_id))
}

fn load_required_desktop_noise_material() -> Result<WslLinkDesktopNoiseMaterial, String> {
    KeyringWslLinkNoiseMaterialStore
        .load_desktop_material()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| WSL_LINK_NOISE_MATERIAL_MISSING_MESSAGE.to_string())
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

fn try_mark_active_terminal_run(
    state: &TerminalSessionState,
    session_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let mut active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    if let Some(active_run) = active_run.as_ref() {
        return Err(format!("已有脚本正在运行：{}", active_run.run_id));
    }
    *active_run = Some(TerminalActiveRun {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        wsl_link_pid: None,
    });
    Ok(())
}

fn attach_active_terminal_run_wsl_link_pid(
    state: &TerminalSessionState,
    run_id: &str,
    pid: u32,
) -> Result<(), String> {
    let mut active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    let Some(active_run) = active_run.as_mut() else {
        return Err("当前没有可绑定的 WSL Link 运行任务。".to_string());
    };
    if active_run.run_id != run_id {
        return Err(format!(
            "运行任务不匹配：active={} incoming={run_id}",
            active_run.run_id
        ));
    }
    active_run.wsl_link_pid = Some(pid);
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

fn get_active_terminal_run_wsl_link_pid(
    state: &TerminalSessionState,
    run_id: &str,
) -> Result<Option<u32>, String> {
    let active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    Ok(active_run
        .as_ref()
        .filter(|run| run.run_id == run_id)
        .and_then(|run| run.wsl_link_pid))
}

fn get_active_terminal_run_input_target(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<ActiveRunInputTarget, String> {
    let active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    let Some(active_run) = active_run.as_ref() else {
        return Ok(ActiveRunInputTarget::None);
    };
    // 活动 run 全局串行，但输入必须按会话路由：只有发起该 run 的会话才把输入送进
    // run 的 stdin；其它会话的输入应进入各自的交互 shell，避免跨会话输入串台。
    if active_run.session_id != session_id {
        return Ok(ActiveRunInputTarget::None);
    }
    match crate::terminal::registry::registry().current_state() {
        TerminalState::Running => Ok(ActiveRunInputTarget::Run(active_run.run_id.clone())),
        TerminalState::SwitchingToRun | TerminalState::SwitchingToIdle => {
            Ok(ActiveRunInputTarget::Pending)
        }
        _ => Ok(ActiveRunInputTarget::None),
    }
}

fn buffer_pending_switch_input(
    state: &TerminalSessionState,
    session_id: &str,
    data: &str,
) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let mut pending = state
        .pending_switch_input
        .lock()
        .map_err(|_| "终端切换态输入缓冲已损坏。".to_string())?;
    let buffer = pending.entry(session_id.to_string()).or_default();
    // 防御：切换窗口异常拉长时避免缓冲无限增长。超限则整体清空再写入，
    // 既保留最新输入，也保证不会在 UTF-8 字符边界中间截断。
    if buffer.len() + data.len() > MAX_PENDING_SWITCH_INPUT_BYTES {
        buffer.clear();
    }
    buffer.push_str(data);
    Ok(())
}

fn take_and_prepend_pending_switch_input(
    state: &TerminalSessionState,
    session_id: &str,
    data: String,
) -> Result<String, String> {
    let mut pending = state
        .pending_switch_input
        .lock()
        .map_err(|_| "终端切换态输入缓冲已损坏。".to_string())?;
    match pending.remove(session_id) {
        Some(buffered) if !buffered.is_empty() => Ok(format!("{buffered}{data}")),
        _ => Ok(data),
    }
}

fn remove_pending_switch_input(state: &TerminalSessionState, session_id: &str) {
    if let Ok(mut pending) = state.pending_switch_input.lock() {
        pending.remove(session_id);
    }
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

fn should_recreate_terminal_session(session: &TerminalSession) -> bool {
    let cwd = session.working_directory.trim();
    cwd.is_empty()
        || cwd.contains('\\')
        || cwd.contains(':')
        || (!cwd.starts_with('/') && cwd != "~")
}

fn terminate_terminal_session(session: &TerminalSession) -> Result<(), String> {
    session.handle.close().map_err(|error| error.to_string())
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

fn mark_terminal_interactive_exited(
    app: &AppHandle,
    state: &TerminalSessionState,
    payload: TerminalExitEvent,
) {
    if let Ok(mut active_run) = state.active_run.lock() {
        *active_run = None;
    }
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

fn emit_terminal_interactive_output(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    chunk: String,
) {
    if chunk.is_empty() {
        return;
    }
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

fn handle_wsl_link_interactive_terminal_event(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    event: WslLinkTerminalServerPayload,
) {
    match event {
        WslLinkTerminalServerPayload::InteractiveOpened(_) => {
            mark_terminal_interactive_ready(app);
        }
        WslLinkTerminalServerPayload::InteractiveData(payload) => {
            emit_terminal_interactive_output(app, state, session_id, payload.data);
        }
        WslLinkTerminalServerPayload::InteractiveClosed(payload) => {
            remove_interactive_terminal_after_exit(state, session_id);
            mark_terminal_interactive_exited(
                app,
                state,
                TerminalExitEvent {
                    session_id: session_id.to_string(),
                    exit_code: payload.exit_code,
                },
            );
        }
        WslLinkTerminalServerPayload::InteractiveError(payload) => {
            if let Some(message_session_id) = payload.session_id.as_ref() {
                if message_session_id == &session_id {
                    emit_terminal_interactive_output(
                        app,
                        state,
                        session_id,
                        format!("{}\n", payload.message),
                    );
                }
            }
            remove_interactive_terminal_after_exit(state, session_id);
            mark_terminal_interactive_exited(
                app,
                state,
                TerminalExitEvent {
                    session_id: session_id.to_string(),
                    exit_code: payload.exit_code,
                },
            );
        }
        WslLinkTerminalServerPayload::InteractiveAck(_) => {}
        WslLinkTerminalServerPayload::RunStarted(_)
        | WslLinkTerminalServerPayload::RunChunk(_)
        | WslLinkTerminalServerPayload::RunCompleted(_)
        | WslLinkTerminalServerPayload::RunError(_) => {}
    }
}

fn remove_interactive_terminal_after_exit(state: &TerminalSessionState, session_id: &str) {
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(session_id);
    }
    if let Ok(mut snapshots) = state.snapshots.lock() {
        snapshots.remove(session_id);
    }
    if let Ok(mut visual_states) = state.interactive_visual.lock() {
        visual_states.remove(session_id);
    }
    if let Ok(mut pending) = state.pending_switch_input.lock() {
        pending.remove(session_id);
    }
}

fn spawn_wsl_link_terminal_run(
    app: AppHandle,
    state: TerminalSessionState,
    session_id: String,
    run_id: String,
    command: TerminalDispatchCommand,
    script_content: Option<String>,
    prompt: Option<String>,
    desktop_material: WslLinkDesktopNoiseMaterial,
) {
    tauri::async_runtime::spawn(async move {
        let started_at = Instant::now();
        let visual_tracker = Arc::new(Mutex::new(TerminalRunVisualTracker::default()));
        let _active_run_guard = TerminalActiveRunGuard::new(state.clone(), run_id.clone());

        let geometry = crate::terminal::registry::registry()
            .geometry
            .read()
            .map(|geometry| *geometry)
            .unwrap_or_default();
        let request = WslLinkTerminalRunScriptRequest {
            run_id: run_id.clone(),
            working_directory: command.working_directory.clone(),
            execution_path: command.execution_path.clone(),
            script_content,
            cleanup_paths: command.cleanup_paths.clone(),
            cols: geometry.cols,
            rows: geometry.rows,
        };

        let mut exit_code = None;
        let mut completed = false;
        let result =
            run_terminal_script_over_wsl_link(&desktop_material, request, |event| match event {
                WslLinkTerminalServerPayload::RunStarted(payload) => {
                    let _ = attach_active_terminal_run_wsl_link_pid(&state, &run_id, payload.pid);
                    emit_terminal_run_started_state(
                        &app,
                        &session_id,
                        &run_id,
                        payload.pid,
                        started_at,
                    );
                }
                WslLinkTerminalServerPayload::RunChunk(payload) => {
                    let visual = observe_visual_output_and_prefix(&visual_tracker, &payload.data);
                    emit_terminal_run_chunk_with_visual_prefix(
                        &app,
                        &state,
                        &session_id,
                        &run_id,
                        payload.data,
                        visual,
                    );
                }
                WslLinkTerminalServerPayload::RunCompleted(payload) => {
                    exit_code = payload.exit_code;
                    completed = true;
                }
                WslLinkTerminalServerPayload::RunError(payload) => {
                    let output = format!("{}\n", payload.message);
                    let visual = observe_visual_output_and_prefix(&visual_tracker, &output);
                    emit_terminal_run_chunk_with_visual_prefix(
                        &app,
                        &state,
                        &session_id,
                        &run_id,
                        output,
                        visual,
                    );
                    exit_code = payload.exit_code.or(Some(127));
                    completed = true;
                }
                WslLinkTerminalServerPayload::InteractiveOpened(_)
                | WslLinkTerminalServerPayload::InteractiveData(_)
                | WslLinkTerminalServerPayload::InteractiveClosed(_)
                | WslLinkTerminalServerPayload::InteractiveAck(_)
                | WslLinkTerminalServerPayload::InteractiveError(_) => {}
            })
            .await;

        if let Err(error) = result {
            let output = format!("WSL Link 脚本执行失败：{error}\n");
            let visual = observe_visual_output_and_prefix(&visual_tracker, &output);
            emit_terminal_run_chunk_with_visual_prefix(
                &app,
                &state,
                &session_id,
                &run_id,
                output,
                visual,
            );
            exit_code = Some(127);
            completed = true;
        }
        if !completed {
            exit_code = Some(127);
        }

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
                finished_at: Timestamp::now().to_string(),
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
    use std::{fs, time::Duration};

    fn set_test_terminal_state(state: TerminalState) {
        let mut machine_state = crate::terminal::registry::registry()
            .state
            .write()
            .expect("terminal state lock should be healthy");
        *machine_state = state;
    }

    #[test]
    fn terminal_agent_retry_is_limited_to_connection_errors() {
        let connector_error = WslLinkTerminalClientError::Grpc(
            WslLinkGrpcTransportError::Connector("WSL Link agent 未监听。".to_string()),
        );
        let payload_error = WslLinkTerminalClientError::Payload(
            crate::wsl_link::terminal_exec::WslLinkTerminalExecError::Payload(
                "session_id 不能为空。".to_string(),
            ),
        );
        assert!(should_retry_terminal_after_agent_start(&connector_error));
        assert!(!should_retry_terminal_after_agent_start(&payload_error));
    }

    #[test]
    fn wsl_link_active_run_is_serialized() {
        let state = TerminalSessionState::default();
        set_test_terminal_state(TerminalState::IdleInteractive);
        assert!(try_mark_active_terminal_run(&state, "session-1", "run-1").is_ok());
        assert!(try_mark_active_terminal_run(&state, "session-1", "run-2").is_err());
        assert!(matches!(
            get_active_terminal_run_input_target(&state, "session-1"),
            Ok(ActiveRunInputTarget::None)
        ));
        clear_active_terminal_run(&state, "run-1");
        assert!(matches!(
            get_active_terminal_run_input_target(&state, "session-1"),
            Ok(ActiveRunInputTarget::None)
        ));
        assert!(try_mark_active_terminal_run(&state, "session-1", "run-2").is_ok());
    }

    #[test]
    fn active_run_does_not_block_input_outside_switching_states() {
        let state = TerminalSessionState::default();
        try_mark_active_terminal_run(&state, "session-1", "run-1").expect("active run should mark");

        set_test_terminal_state(TerminalState::IdleInteractive);
        assert!(matches!(
            get_active_terminal_run_input_target(&state, "session-1"),
            Ok(ActiveRunInputTarget::None)
        ));

        set_test_terminal_state(TerminalState::SwitchingToRun);
        assert!(matches!(
            get_active_terminal_run_input_target(&state, "session-1"),
            Ok(ActiveRunInputTarget::Pending)
        ));

        set_test_terminal_state(TerminalState::Running);
        assert!(matches!(
            get_active_terminal_run_input_target(&state, "session-1"),
            Ok(ActiveRunInputTarget::Run(run_id)) if run_id == "run-1"
        ));

        set_test_terminal_state(TerminalState::IdleInteractive);
    }

    #[test]
    fn active_run_input_routes_only_to_owning_session() {
        let state = TerminalSessionState::default();
        try_mark_active_terminal_run(&state, "session-A", "run-A").expect("active run should mark");
        set_test_terminal_state(TerminalState::Running);

        // 拥有该 run 的会话 → 输入路由到 run 的 stdin
        assert!(matches!(
            get_active_terminal_run_input_target(&state, "session-A"),
            Ok(ActiveRunInputTarget::Run(run_id)) if run_id == "run-A"
        ));

        // 其它会话 → 输入进入各自交互 shell，而不是串进别人的 run
        assert!(matches!(
            get_active_terminal_run_input_target(&state, "session-B"),
            Ok(ActiveRunInputTarget::None)
        ));

        set_test_terminal_state(TerminalState::IdleInteractive);
    }

    #[test]
    fn pending_switch_input_is_buffered_and_prepended_not_dropped() {
        let state = TerminalSessionState::default();
        buffer_pending_switch_input(&state, "session-1", "ab").expect("buffer ok");
        buffer_pending_switch_input(&state, "session-1", "cd").expect("buffer ok");

        // 切换态缓冲的输入会在状态落定后按序补发，且原始输入排在新输入之前。
        let combined =
            take_and_prepend_pending_switch_input(&state, "session-1", "EF".to_string())
                .expect("take ok");
        assert_eq!(combined, "abcdEF");

        // 取出后缓冲被清空，不会重复补发。
        let again = take_and_prepend_pending_switch_input(&state, "session-1", "X".to_string())
            .expect("take ok");
        assert_eq!(again, "X");
    }

    #[test]
    fn wsl_link_active_run_records_pid_for_cancel() {
        let state = TerminalSessionState::default();
        try_mark_active_terminal_run(&state, "session-1", "run-wsl-link")
            .expect("active run should mark");
        attach_active_terminal_run_wsl_link_pid(&state, "run-wsl-link", 1234)
            .expect("pid should attach");
        assert_eq!(
            get_active_terminal_run_wsl_link_pid(&state, "run-wsl-link").expect("pid should read"),
            Some(1234)
        );
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
    fn terminal_run_visual_separator_does_not_add_blank_line_after_newline_output() {
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
    fn terminal_run_visual_separator_starts_newline_for_no_newline_output() {
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
    fn terminal_run_extracts_last_prompt_from_interactive_snapshot() {
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
        let (command, script_content) = build_terminal_run_command_for_wsl_link(&payload, "/tmp")
            .expect("dispatch command should build");
        assert_eq!(
            command.working_directory,
            to_wsl_path(&temp_root).expect("workspace root should convert to WSL path")
        );
        assert!(script_content.is_none());
        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn dirty_script_dispatch_keeps_inline_content_for_wsl_link() {
        let payload = DispatchTerminalScriptRequest {
            session_id: "dispatch-inline-session".to_string(),
            path: None,
            workspace_root_path: None,
            content: "echo __WSL_LINK_INLINE__\n".to_string(),
            is_dirty: true,
            run_id: "dispatch-inline-run".to_string(),
        };
        let (command, script_content) = build_terminal_run_command_for_wsl_link(&payload, "/tmp")
            .expect("dispatch command should build");
        assert_eq!(script_content.as_deref(), Some(payload.content.as_str()));
        assert!(command.used_temp_file);
        assert_eq!(command.cleanup_paths, vec![command.execution_path.clone()]);
    }
}