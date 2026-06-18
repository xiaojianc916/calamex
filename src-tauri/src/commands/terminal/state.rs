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
    flow_control::FlowController,
    snapshot::{
        TerminalInteractiveVisualState, is_likely_interactive_resize_repaint_frame,
        trim_terminal_snapshot,
    },
    state_machine::StateMachine,
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
    /// RunStarted 事件到达后填充：运行进程 pid 与启动时刻（ms）。供重载恢复时经
    /// ensure_terminal_session 回传给前端，复原「运行中」UI 的展示信息。
    pid: Option<u32>,
    started_at_ms: Option<i64>,
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
    session_states: Arc<Mutex<HashMap<String, TerminalState>>>,
    /// 每会话输出流控器（P2 ack 背压）。键为 session_id；交互读线程与该会话发起的运行读线程
    /// 共享同一控制器（都汇入前端同一个 xterm，由前端按会话回 ack）。会话创建时重置为全新实例，
    /// 关闭 / 退出时取消并移除，避免复用到已 cancel 的陈旧控制器而失去背压。
    flow_controllers: Arc<Mutex<HashMap<String, FlowController>>>,
    /// 每会话最近一次「前端心跳」时刻。每个挂载中的前端 TerminalSession 周期性上报，后端据此判定
    /// 哪些会话已无前端照管（页面重载 / 崩溃后前端 VM 销毁、心跳停止）。收割线程只回收「心跳超过
    /// 宽限期 + 无活动运行」的孤儿交互会话，绝不碰仍在心跳的健康会话（零误杀）。
    session_liveness: Arc<Mutex<HashMap<String, Instant>>>,
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

/// 每会话 geometry：作为「单一 SessionRegistry」绞杀式重构的第一步，让会话各自持有自己的
/// 列宽/行高。运行 PTY 不再统一从全局 `registry().geometry` 取尺寸，避免多开时会话 A 的运行
/// 被会话 B 最后一次 resize 的尺寸创建。全局 geometry 已删除，每会话 geometry 成为唯一来源
/// （绞杀式重构 BE-1）。
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

/// 取指定会话的 geometry；该会话尚无记录时回退到默认尺寸。每会话 geometry 已是唯一真相源，
/// 不再回退到全局 `registry().geometry`（全局几何已于 BE-1 删除）。
pub(super) fn get_session_geometry(state: &TerminalSessionState, session_id: &str) -> Geometry {
    if let Ok(geometries) = state.session_geometry.lock()
        && let Some(geometry) = geometries.get(session_id)
    {
        return *geometry;
    }
    Geometry::default()
}

pub(super) fn remove_session_geometry(state: &TerminalSessionState, session_id: &str) {
    if let Ok(mut geometries) = state.session_geometry.lock() {
        geometries.remove(session_id);
    }
}

/// 每会话状态机：作为「单一 SessionRegistry」绞杀式重构的第二块砖，让会话各自持有自己的
/// 运行/交互状态。输入路由不再读全局 `registry().state`，避免多开时会话 A 处于 Running 导致
/// 会话 B 的输入被误判为应进 run stdin（跨会话输入串台）。全局 state 已于 BE-2b 删除，状态完全
/// 按会话维护。
///
/// 对照 VSCode `src/vs/platform/terminal/node/ptyService.ts`：每个 `PersistentTerminalProcess`
/// 各自持有交互/生命周期态（`_interactionState`），`PtyService` 的 input/resize/shutdown 全按 id
/// 路由到对应进程，不存在跨会话共享的全局终端状态。
///
/// 每会话各自是一台从 `Booting` 起步的状态机：无记录时以 `Booting` 为基线做合法性判定，与全局
/// 态无关（全局可能因其它会话而处于 `Running`，不应阻断本会话的初始 Idle 化）。复用全局状态机
/// 的转移约束，保持与 registry 单源一致；非法/无变化的转移就地忽略（与全局
/// `transition_terminal_state` 出错即跳过的语义一致）。
///
/// 返回实际发生的转移 `Some((from, to))`，供上层发 `terminal:session-state-changed`；无变化、
/// 非法转移或锁中毒时返回 `None`（不发事件）。
///
/// P1：每个分支都打上 `[session-fsm]` 结构化日志，使每会话 FSM 的流转可从日志追踪：
/// 接受的转移 debug、无变化 trace、非法转移 warn（提示事件乱序 / 竞态）、锁中毒 warn。
pub(super) fn set_session_state(
    state: &TerminalSessionState,
    session_id: &str,
    to: TerminalState,
) -> Option<(TerminalState, TerminalState)> {
    let mut states = match state.session_states.lock() {
        Ok(states) => states,
        Err(_) => {
            // 锁中毒属不可恢复的内部错误：记录后丢弃本次转移，保持「尽力而为、不 panic」。
            log::warn!(
                "[session-fsm] 会话状态锁中毒，丢弃状态转移（session_id={session_id}, 目标={to:?}）。"
            );
            return None;
        }
    };
    let from = states
        .get(session_id)
        .copied()
        .unwrap_or(TerminalState::Booting);
    if from == to {
        // 无变化：常见且无害（如交互就绪重复置 IdleInteractive），仅 trace 备查，不发事件。
        log::trace!(
            "[session-fsm] 会话状态无变化，忽略（session_id={session_id}, 状态={to:?}）。"
        );
        return None;
    }
    if !StateMachine::can_transition(from, to) {
        // 非法转移通常意味着事件乱序 / 竞态：就地忽略并 warn，便于据日志定位异常时序。
        log::warn!(
            "[session-fsm] 忽略非法会话状态转移（session_id={session_id}, {from:?} -> {to:?}）。"
        );
        return None;
    }
    states.insert(session_id.to_string(), to);
    log::debug!("[session-fsm] 会话状态转移（session_id={session_id}, {from:?} -> {to:?}）。");
    Some((from, to))
}

/// 取指定会话的状态；该会话尚无记录时回退到 `Booting`——每会话各自是一台从 `Booting` 起步的
/// 状态机，与全局态无关。此前回退到全局 `current_state()` 是迁移期权宜：在「已有活动运行但尚未
/// 置位会话态」的极小窗口里，若另一会话正处于 `Running`，全局回退会把本会话输入误判为应进
/// run stdin（跨会话串台）；改回 `Booting` 后该窗口一律按交互处理，更正确，且与
/// `set_session_state` 的 `Booting` 基线一致。
///
/// 对照 VSCode `ptyService.ts`：每个 `PersistentTerminalProcess` 依据自身 `_interactionState`
/// 判定，不存在跨会话共享的全局态。
pub(super) fn get_session_state(state: &TerminalSessionState, session_id: &str) -> TerminalState {
    if let Ok(states) = state.session_states.lock()
        && let Some(current) = states.get(session_id)
    {
        return *current;
    }
    TerminalState::Booting
}

pub(super) fn remove_session_state(state: &TerminalSessionState, session_id: &str) {
    if let Ok(mut states) = state.session_states.lock()
        && states.remove(session_id).is_some()
    {
        // P1：会话 FSM 生命终结，记一条 debug 以便日志中能完整追踪一个会话的起灭。
        log::debug!("[session-fsm] 会话状态机回收（session_id={session_id}）。");
    }
}

/// 会话创建时重置该会话的输出流控器为全新实例（覆盖任何陈旧 / 已取消的旧控制器），返回其克隆。
/// P2：交互读线程在创建时拿到它；该会话发起的运行读线程随后经 get_flow_controller 复用同一个。
/// 之所以「重置」而非「取或建」：旧会话关闭时会 cancel 控制器（永久解除暂停），若复用到这个已
/// cancel 的实例，新会话的读线程将永不背压——必须换上全新实例。
pub(super) fn reset_flow_controller(
    state: &TerminalSessionState,
    session_id: &str,
) -> Option<FlowController> {
    let mut controllers = state.flow_controllers.lock().ok()?;
    let controller = FlowController::new();
    controllers.insert(session_id.to_string(), controller.clone());
    Some(controller)
}

/// 取该会话已存在的输出流控器：供该会话的运行读线程复用、以及前端 ack 命令查找。
pub(super) fn get_flow_controller(
    state: &TerminalSessionState,
    session_id: &str,
) -> Option<FlowController> {
    let controllers = state.flow_controllers.lock().ok()?;
    controllers.get(session_id).cloned()
}

/// 取消并移除该会话的输出流控器：cancel 释放任何处于背压暂停态的读线程（使其能继续读到 EOF），
/// 移除则保证下次创建同名会话时得到全新实例。锁中毒时尽力而为忽略。
pub(super) fn remove_flow_controller(state: &TerminalSessionState, session_id: &str) {
    let Ok(mut controllers) = state.flow_controllers.lock() else {
        return;
    };
    if let Some(controller) = controllers.remove(session_id) {
        controller.cancel();
    }
}

/// 记录 / 刷新某会话的前端心跳时刻。会话连接（ensure）与每次前端心跳时调用。
pub(super) fn touch_session_liveness(state: &TerminalSessionState, session_id: &str) {
    let Ok(mut liveness) = state.session_liveness.lock() else {
        return;
    };
    liveness.insert(session_id.to_string(), Instant::now());
}

/// 移除某会话的心跳记录（会话拆解 / 关闭时），避免心跳表泄漏已消亡会话的陈旧条目。
pub(super) fn remove_session_liveness(state: &TerminalSessionState, session_id: &str) {
    if let Ok(mut liveness) = state.session_liveness.lock() {
        liveness.remove(session_id);
    }
}

/// 收集「已超过宽限期未收到前端心跳、且当前无活动运行」的孤儿交互会话 id。
/// 仅返回仍存在于 sessions 表中的会话；带活动运行的会话一律跳过（绝不经收割线程终止仍在运行的
/// 脚本，那类清理交由应用退出时的 shutdown_all 处理），最大化零误杀。先在锁内仅取候选 id 即释放
/// 心跳锁，再做 sessions / active_runs 复核，避免跨锁持有。
pub(super) fn collect_idle_orphan_session_ids(
    state: &TerminalSessionState,
    grace: Duration,
) -> Vec<String> {
    let candidates: Vec<String> = {
        let Ok(liveness) = state.session_liveness.lock() else {
            return Vec::new();
        };
        let now = Instant::now();
        liveness
            .iter()
            .filter(|(_, last_seen)| now.duration_since(**last_seen) > grace)
            .map(|(session_id, _)| session_id.clone())
            .collect()
    };
    candidates
        .into_iter()
        .filter(|session_id| {
            get_terminal_session(state, session_id)
                .ok()
                .flatten()
                .is_some()
                && get_active_run_snapshot_for_session(state, session_id).is_none()
        })
        .collect()
}

/// 运行完成时回收该会话的状态：与全局 `begin/finish_terminal_run_completion` 同构，但只作用于
/// 该会话、不受其它会话是否仍在运行影响（全局计数门控仅用于全局态）。`Running` 经
/// `SwitchingToIdle` 回到 `IdleInteractive`；若运行在真正启动前就结束（仍处 `SwitchingToRun`），
/// 直接回 `IdleInteractive`。
///
/// 按发生顺序返回实际转移序列，供上层逐步发 `terminal:session-state-changed`。
pub(super) fn complete_session_run_state(
    state: &TerminalSessionState,
    session_id: &str,
) -> Vec<(TerminalState, TerminalState)> {
    let mut transitions = Vec::new();
    match get_session_state(state, session_id) {
        TerminalState::Running => {
            transitions.extend(set_session_state(
                state,
                session_id,
                TerminalState::SwitchingToIdle,
            ));
            transitions.extend(set_session_state(
                state,
                session_id,
                TerminalState::IdleInteractive,
            ));
        }
        TerminalState::SwitchingToRun => {
            transitions.extend(set_session_state(
                state,
                session_id,
                TerminalState::IdleInteractive,
            ));
        }
        _ => {}
    }
    transitions
}

fn lock_active_terminal_runs(
    state: &TerminalSessionState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, TerminalActiveRun>>, String> {
    state
        .active_runs
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())
}

#[cfg(test)]
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
            pid: None,
            started_at_ms: None,
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

/// RunStarted 事件到达后回填该运行的 pid 与启动时刻（ms）。运行已被清理（如极快完成）
/// 时静默忽略。供重载恢复经 ensure_terminal_session 回传给前端。
pub(super) fn set_active_terminal_run_started_meta(
    state: &TerminalSessionState,
    run_id: &str,
    pid: u32,
    started_at_ms: i64,
) {
    let Ok(mut active_runs) = state.active_runs.lock() else {
        return;
    };
    if let Some(active_run) = active_runs.get_mut(run_id) {
        active_run.pid = Some(pid);
        active_run.started_at_ms = Some(started_at_ms);
    }
}

/// 取该会话当前活动运行的快照 (run_id, pid, started_at_ms)，供 ensure_terminal_session
/// 复用分支在前端重载后复原运行态 UI。无活动运行或锁中毒时返回 None。
pub(super) fn get_active_run_snapshot_for_session(
    state: &TerminalSessionState,
    session_id: &str,
) -> Option<(String, Option<u32>, Option<i64>)> {
    let active_runs = state.active_runs.lock().ok()?;
    active_runs
        .values()
        .find(|run| run.session_id == session_id)
        .map(|run| (run.run_id.clone(), run.pid, run.started_at_ms))
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

/// 取指定运行所属的会话 id：供取消看门狗在「读线程卡死、完成事件不会送达」的异常路径下，
/// 合成运行完成事件并回收该会话的运行态时定位会话。运行不存在时返回 None。锁中毒时返回 None
/// （尽力而为）。
pub(super) fn get_active_terminal_run_session(
    state: &TerminalSessionState,
    run_id: &str,
) -> Option<String> {
    let active_runs = state.active_runs.lock().ok()?;
    active_runs.get(run_id).map(|run| run.session_id.clone())
}

pub(super) fn get_active_terminal_run_input_target(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<ActiveRunInputTarget, String> {
    // 先确定该会话是否有活动运行；有则取出 run_id 后立即释放 active_runs 锁，避免与
    // session_states 锁叠加持有（保持单一加锁顺序，杜绝潜在死锁）。
    let run_id = {
        let active_runs = lock_active_terminal_runs(state)?;
        match active_runs
            .values()
            .find(|active_run| active_run.session_id == session_id)
        {
            Some(active_run) => active_run.run_id.clone(),
            None => return Ok(ActiveRunInputTarget::None),
        }
    };
    // 输入必须按会话路由：依据「该会话自身」的状态判定去向，不再读全局 registry().state，
    // 避免其它会话的运行态把本会话输入误导进 run stdin（跨会话输入串台）。
    match get_session_state(state, session_id) {
        TerminalState::Running => Ok(ActiveRunInputTarget::Run(run_id)),
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
    remove_session_state(state, session_id);
    remove_flow_controller(state, session_id);
    remove_session_liveness(state, session_id);
}
