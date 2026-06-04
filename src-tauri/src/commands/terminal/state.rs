//! 集成终端共享状态：会话、快照、交互视觉态、活动运行与切换态输入缓冲。
//!
//! 本模块只负责状态容器与其存取，不发射事件、不驱动状态机。

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::terminal::{
    snapshot::{
        TerminalInteractiveVisualState, contains_alt_screen_switch,
        is_likely_interactive_resize_repaint_frame, resolve_alt_screen_state_after_data,
        trim_terminal_snapshot,
    },
    types::TerminalState,
    wsl_pty::{LocalWslPtyHandle, LocalWslRunHandle},
};

const TERMINAL_RESIZE_REPAINT_SUPPRESSION: Duration = Duration::from_millis(240);
const MAX_PENDING_SWITCH_INPUT_BYTES: usize = 64 * 1024;

pub(super) struct TerminalSession {
    pub(super) handle: LocalWslPtyHandle,
    pub(super) working_directory: String,
}

pub(super) struct TerminalActiveRun {
    session_id: String,
    run_id: String,
    run_handle: Option<LocalWslRunHandle>,
}

pub(super) enum ActiveRunInputTarget {
    None,
    Pending,
    Run(String),
}

#[derive(Clone, Default)]
pub struct TerminalSessionState {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    snapshots: Arc<Mutex<HashMap<String, String>>>,
    interactive_visual: Arc<Mutex<HashMap<String, TerminalInteractiveVisualState>>>,
    pub(super) active_run: Arc<Mutex<Option<TerminalActiveRun>>>,
    pending_switch_input: Arc<Mutex<HashMap<String, String>>>,
    pub(super) creation_guard: Arc<Mutex<()>>,
}

pub(super) fn lock_terminal_sessions(
    state: &TerminalSessionState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, Arc<TerminalSession>>>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态已损坏。".to_string())
}

pub(super) fn get_terminal_session(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<Option<Arc<TerminalSession>>, String> {
    let sessions = lock_terminal_sessions(state)?;
    Ok(sessions.get(session_id).cloned())
}

pub(super) fn remove_terminal_session(
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

pub(super) fn get_terminal_snapshot(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<String, String> {
    let snapshots = lock_terminal_snapshots(state)?;
    Ok(snapshots.get(session_id).cloned().unwrap_or_default())
}

pub(super) fn set_terminal_snapshot(
    state: &TerminalSessionState,
    session_id: &str,
    value: String,
) -> Result<(), String> {
    let mut snapshots = lock_terminal_snapshots(state)?;
    snapshots.insert(session_id.to_string(), value);
    Ok(())
}

pub(super) fn remove_terminal_snapshot(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<(), String> {
    let mut snapshots = lock_terminal_snapshots(state)?;
    snapshots.remove(session_id);
    Ok(())
}

pub(super) fn append_terminal_snapshot(
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

pub(super) fn remove_terminal_interactive_visual_state(
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

pub(super) fn mark_terminal_resize_repaint_suppression(
    state: &TerminalSessionState,
    session_id: &str,
) {
    let Ok(mut visual_states) = state.interactive_visual.lock() else {
        return;
    };
    let visual_state = visual_states.entry(session_id.to_string()).or_default();
    visual_state.resize_repaint_suppress_until =
        Some(Instant::now() + TERMINAL_RESIZE_REPAINT_SUPPRESSION);
}

pub(super) fn update_terminal_geometry(cols: u16, rows: u16) {
    let Ok(mut geometry) = crate::terminal::registry::registry().geometry.write() else {
        return;
    };
    geometry.cols = cols.max(2);
    geometry.rows = rows.max(1);
}

pub(super) fn try_mark_active_terminal_run(
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
        run_handle: None,
    });
    Ok(())
}

pub(super) fn attach_active_terminal_run_handle(
    state: &TerminalSessionState,
    run_id: &str,
    handle: LocalWslRunHandle,
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
    active_run.run_handle = Some(handle);
    Ok(())
}

pub(super) fn clear_active_terminal_run(state: &TerminalSessionState, run_id: &str) {
    let Ok(mut active_run) = state.active_run.lock() else {
        return;
    };
    if active_run.as_ref().map(|run| run.run_id.as_str()) == Some(run_id) {
        *active_run = None;
    }
}

/// 会话作用域地接管活动运行：仅当当前活动运行归属指定会话时，才取出其句柄并清空活动
/// 运行，返回被取出的句柄供调用方 kill，避免脚本进程沦为无人管理的孤儿。多开场景下，
/// 若活动运行属于其它会话，则原样保留并返回 None，绝不误清其它会话仍在进行的脚本。
pub(super) fn take_active_terminal_run_for_session(
    state: &TerminalSessionState,
    session_id: &str,
) -> Option<LocalWslRunHandle> {
    let mut active_run = state.active_run.lock().ok()?;
    if active_run.as_ref().map(|run| run.session_id.as_str()) != Some(session_id) {
        return None;
    }
    active_run.take().and_then(|run| run.run_handle)
}

pub(super) fn get_active_terminal_run_handle(
    state: &TerminalSessionState,
    run_id: &str,
) -> Result<Option<LocalWslRunHandle>, String> {
    let active_run = state
        .active_run
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;
    Ok(active_run
        .as_ref()
        .filter(|run| run.run_id == run_id)
        .and_then(|run| run.run_handle.clone()))
}

pub(super) fn get_active_terminal_run_input_target(
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

pub(super) fn buffer_pending_switch_input(
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

pub(super) fn take_and_prepend_pending_switch_input(
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

pub(super) fn remove_pending_switch_input(state: &TerminalSessionState, session_id: &str) {
    if let Ok(mut pending) = state.pending_switch_input.lock() {
        pending.remove(session_id);
    }
}

pub(super) fn should_skip_snapshot_for_interactive_resize_repaint(
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

pub(super) fn should_recreate_terminal_session(session: &TerminalSession) -> bool {
    let cwd = session.working_directory.trim();
    cwd.is_empty()
        || cwd.contains('\\')
        || cwd.contains(':')
        || (!cwd.starts_with('/') && cwd != "~")
}

pub(super) fn terminate_terminal_session(session: &TerminalSession) -> Result<(), String> {
    session.handle.close().map_err(|error| error.to_string())
}

pub(super) fn resolve_terminal_start_directory(
    path: Option<&str>,
) -> Result<Option<PathBuf>, String> {
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

pub(super) fn remove_interactive_terminal_after_exit(
    state: &TerminalSessionState,
    session_id: &str,
) {
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
