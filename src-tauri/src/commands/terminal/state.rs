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
        TerminalInteractiveVisualState, is_likely_interactive_resize_repaint_frame,
        trim_terminal_snapshot,
    },
    types::{Geometry, TerminalState},
    vte_detect::scan_ansi_csi_events,
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
    active_runs: Arc<Mutex<HashMap<String, TerminalActiveRun>>>,
    pending_switch_input: Arc<Mutex<HashMap<String, String>>>,
    session_geometry: Arc<Mutex<HashMap<String, Geometry>>>,
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

/// 每会话 geometry：作为「单一 SessionRegistry」绞杀式重构的第一步，让会话各自持有自己的
/// 列宽/行高。运行 PTY 不再统一从全局 `registry().geometry` 取尺寸，避免多开时会话 A 的运行
/// 被会话 B 最后一次 resize 的尺寸创建。迁移期全局 geometry 暂保留（双写），待所有读取方
/// 迁移完毕后再于绞杀收尾统一删除。
///
/// 对照 VSCode `src/vs/platform/terminal/node/ptyService.ts`：每个 `PersistentTerminalProcess`
/// 各自持有 cols/rows（经其 `XtermSerializer`），`PtyService.resize(id, cols, rows)` 仅作用于
/// 指定 id 的进程，不存在跨会话共享的全局尺寸。
pub(super) fn set_session_geometry(
    state: &TerminalSessionState,
    session_id: &str,
    cols: u16,
    rows: u16,
) {
    let Ok(mut geometries) = state.session_geometry.lock() else {
        return;
    };
    let geometry = geometries.entry(session_id.to_string()).or_default();
    geometry.cols = cols.max(2);
    geometry.rows = rows.max(1);
}

/// 取指定会话的 geometry；该会话尚无记录时回退到全局 geometry（再回退到默认），保证迁移期
/// 行为与改动前一致。
pub(super) fn get_session_geometry(state: &TerminalSessionState, session_id: &str) -> Geometry {
    if let Ok(geometries) = state.session_geometry.lock()
        && let Some(geometry) = geometries.get(session_id)
    {
        return *geometry;
    }
    crate::terminal::registry::registry()
        .geometry
        .read()
        .map(|geometry| *geometry)
        .unwrap_or_default()
}

pub(super) fn remove_session_geometry(state: &TerminalSessionState, session_id: &str) {
    if let Ok(mut geometries) = state.session_geometry.lock() {
        geometries.remove(session_id);
    }
}

fn lock_active_terminal_runs(
    state: &TerminalSessionState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, TerminalActiveRun>>, String> {
    state
        .active_runs
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())
}

pub(super) fn active_terminal_run_count(state: &TerminalSessionState) -> usize {
    state
        .active_runs
        .lock()
        .map(|active_runs| active_runs.len())
        .unwrap_or(0)
}

pub(super) fn try_mark_active_terminal_run(
    state: &TerminalSessionState,
    session_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let mut active_runs = lock_active_terminal_runs(state)?;
    if active_runs.contains_key(run_id) {
        return Err(format!("运行任务已存在：{run_id}"));
    }
    // 兜底：若该会话既有的活动运行其底层进程实际已结束（读线程已在 child.wait 返回后
    // 置位 is_finished），但因完成事件丢失 / 读线程异常等原因未能清理 active_runs，则
    // 视为陈旧条目就地回收，避免该会话被永久卡在「已有脚本正在运行」而再也无法发起新
    // 运行。仅在确证已结束时回收，绝不误清仍在运行的脚本；句柄尚未绑定（刚 mark、未
    // attach）时一律按「仍在进行」处理。
    let existing_run = active_runs
        .values()
        .find(|active_run| active_run.session_id == session_id)
        .map(|active_run| {
            let finished = active_run
                .run_handle
                .as_ref()
                .map(|handle| handle.is_finished())
                .unwrap_or(false);
            (active_run.run_id.clone(), finished)
        });
    if let Some((existing_run_id, finished)) = existing_run {
        if finished {
            active_runs.remove(&existing_run_id);
        } else {
            return Err(format!("当前终端已有脚本正在运行：{existing_run_id}"));
        }
    }
    active_runs.insert(
        run_id.to_string(),
        TerminalActiveRun {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            run_handle: None,
        },
    );
    Ok(())
}

pub(super) fn attach_active_terminal_run_handle(
    state: &TerminalSessionState,
    run_id: &str,
    handle: LocalWslRunHandle,
) -> Result<(), String> {
    let mut active_runs = lock_active_terminal_runs(state)?;
    let Some(active_run) = active_runs.get_mut(run_id) else {
        return Err("当前没有可绑定的运行任务。".to_string());
    };
    active_run.run_handle = Some(handle);
    Ok(())
}

pub(super) fn clear_active_terminal_run(state: &TerminalSessionState, run_id: &str) {
    let Ok(mut active_runs) = state.active_runs.lock() else {
        return;
    };
    active_runs.remove(run_id);
}

/// 退出清理：取出并清空所有活动运行的句柄，供调用方逐个 kill。
/// 运行脚本走独立的运行 PTY，与交互会话句柄无关——仅关闭 / drain 交互会话不会终止
/// 它们，应用退出时若不显式接管，会遗留无人管理的孤儿 wsl.exe 进程。锁中毒时返回空表
/// （尽力而为，不阻断退出流程）。
pub(super) fn drain_active_terminal_runs(state: &TerminalSessionState) -> Vec<LocalWslRunHandle> {
    let Ok(mut active_runs) = state.active_runs.lock() else {
        return Vec::new();
    };
    active_runs
        .drain()
        .filter_map(|(_, run)| run.run_handle)
        .collect()
}

/// 会话作用域地接管活动运行：仅当当前活动运行归属指定会话时，才取出其句柄并清空活动
/// 运行，返回被取出的句柄供调用方 kill，避免脚本进程沦为无人管理的孤儿。多开场景下，
/// 若活动运行属于其它会话，则原样保留并返回 None，绝不误清其它会话仍在进行的脚本。
pub(super) fn take_active_terminal_run_for_session(
    state: &TerminalSessionState,
    session_id: &str,
) -> Option<LocalWslRunHandle> {
    let mut active_runs = state.active_runs.lock().ok()?;
    let run_id = active_runs
        .values()
        .find(|run| run.session_id == session_id)
        .map(|run| run.run_id.clone())?;
    active_runs.remove(&run_id).and_then(|run| run.run_handle)
}

pub(super) fn get_active_terminal_run_handle(
    state: &TerminalSessionState,
    run_id: &str,
) -> Result<Option<LocalWslRunHandle>, String> {
    let active_runs = lock_active_terminal_runs(state)?;
    Ok(active_runs
        .get(run_id)
        .and_then(|run| run.run_handle.clone()))
}

pub(super) fn get_active_terminal_run_input_target(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<ActiveRunInputTarget, String> {
    let active_runs = lock_active_terminal_runs(state)?;
    let Some(active_run) = active_runs
        .values()
        .find(|active_run| active_run.session_id == session_id)
    else {
        return Ok(ActiveRunInputTarget::None);
    };
    // 输入必须按会话路由：只有发起该 run 的会话才把输入送进 run 的 stdin；
    // 其它会话的输入应进入各自的交互 shell，避免跨会话输入串台。
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
    // 单次 vte 扫描同时得出「本段是否含 alt-screen 切换」与「应用后最终 alt-screen 状态」，
    // 避免对同一段数据解析两遍（原先分别调用 contains_alt_screen_switch 与
    // resolve_alt_screen_state_after_data，各做一次完整 vte 解析）。
    let ansi_events = scan_ansi_csi_events(chunk);
    let has_alt_screen_control = ansi_events.alt_screen_switched;
    if ansi_events.alt_screen_switched {
        visual_state.alt_screen_active = ansi_events.alt_screen_active;
    }
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
    // 尽力而为地清理该会话的全部状态，复用各自的 remove_* 辅助；
    // 锁中毒时这些辅助返回 Err，这里一律忽略（与原先 if let Ok 的语义一致）。
    let _ = remove_terminal_session(state, session_id);
    let _ = remove_terminal_snapshot(state, session_id);
    let _ = remove_terminal_interactive_visual_state(state, session_id);
    remove_pending_switch_input(state, session_id);
    remove_session_geometry(state, session_id);
}
