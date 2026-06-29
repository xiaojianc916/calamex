//! 集成终端共享状态：会话、快照、交互视觉态、活动运行与切换态输入缓冲。
//!
//! 本模块只负责状态容器与其存取，不发射事件、不驱动状态机。
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32},
    },
    time::{Duration, Instant},
};

use crate::terminal::{
    flow_control::FlowController,
    snapshot::{
        TerminalInteractiveVisualState,
        is_likely_interactive_resize_repaint_frame,
        trim_terminal_snapshot,
    },
    state_machine::StateMachine,
    types::{Geometry, TerminalState},
    vte_detect::scan_ansi_csi_events,
    wsl_pty::LocalWslPtyHandle,
};

const TERMINAL_RESIZE_REPAINT_SUPPRESSION: Duration = Duration::from_millis(240);
const MAX_PENDING_SWITCH_INPUT_BYTES: usize = 64 * 1024;

pub(super) struct TerminalSession {
    pub(super) handle: LocalWslPtyHandle,
    pub(super) working_directory: String,
    /// 交互 shell 自身 PID（经 OSC 633;P;ShellPid 上报），0 表示尚未上报。
    /// 供带外取消时读 `/proc/<shell_pid>/stat` 定位前台进程组。
    pub(super) shell_pid: AtomicU32,
}

pub(super) struct TerminalActiveRun {
    session_id: String,
    run_id: String,
    /// RunStarted 事件到达后填充：运行进程 pid 与启动时刻（ms）。供重载恢复时经
    /// ensure_terminal_session 回传给前端，复原「运行中」UI 的展示信息。
    pid: Option<u32>,
    started_at_ms: Option<i64>,
    /// 该运行落在 WSL `/tmp` 下、需在运行结束后回收的临时脚本路径（行内/未保存脚本才有；
    /// 直接运行已存在的文件时为空）。运行经 clear_active_terminal_run 收尾时返回给上层清理。
    cleanup_paths: Vec<String>,
}

pub(super) enum ActiveRunInputTarget {
    None,
    Pending,
    Run(String),
}

/// 单个会话「按 session_id 归集」的全部叶子状态。
///
/// 历史上这些字段分散在 7 个独立的 `Arc<Mutex<HashMap<String, _>>>` 里，导致
/// `remove_interactive_terminal_after_exit` 等拆解路径要串行获取多把锁，锁的数量本身也
/// 增加心智负担与潜在加锁顺序风险。现合并为单一 `per_session` 表，按 session_id 一把锁取用。
///
/// 注意：`sessions`（PTY 句柄）与 `active_runs`（按 run_id 归集）刻意**不并入**本结构——
/// 见 `TerminalSessionState` 各字段注释中的加锁顺序约束。
///
/// 所有字段都「可空 / 可空串」，从而：
/// - 用 `None` / 空串表达「该会话尚无此项记录」，与原先「map 中无该 key」语义一致；
/// - `is_empty()` 为真时整条目可被剪除，避免合并表随会话起灭而泄漏空条目。
#[derive(Default)]
struct PerSessionState {
    /// 终端输出快照（裁剪后的回放缓冲）。空串表示无快照。
    snapshot: String,
    /// 切换态（Idle<->Run）期间缓冲的前端输入。空串表示无缓冲。
    pending_switch_input: String,
    /// 该会话的列宽/行高。`None` 表示尚无记录，取用时回退默认尺寸。
    geometry: Option<Geometry>,
    /// 该会话状态机的当前状态。`None` 表示尚无记录，以 `Booting` 为基线。
    state: Option<TerminalState>,
    /// 交互视觉态（alt-screen / resize 重绘抑制）。`None` 表示尚无记录。
    interactive_visual: Option<TerminalInteractiveVisualState>,
    /// 该会话的输出流控器（P2 ack 背压）。`None` 表示尚未重置过。
    flow_controller: Option<FlowController>,
    /// 该会话最近一次前端心跳时刻。`None` 表示无心跳记录。
    liveness: Option<Instant>,
}

impl PerSessionState {
    /// 所有叶子状态均为空：可安全从 `per_session` 表中剪除该会话条目。
    fn is_empty(&self) -> bool {
        self.snapshot.is_empty()
            && self.pending_switch_input.is_empty()
            && self.geometry.is_none()
            && self.state.is_none()
            && self.interactive_visual.is_none()
            && self.flow_controller.is_none()
            && self.liveness.is_none()
    }
}

#[derive(Clone, Default)]
pub struct TerminalSessionState {
    /// 会话 PTY 句柄。**独立保留**：`ensure_terminal_session` 创建分支会在持有本表锁期间，
    /// 调用 `set_terminal_snapshot` / `remove_terminal_interactive_visual_state`（二者现取
    /// `per_session` 锁）。若把 `sessions` 并入 `per_session`，将在同一线程重入同一把锁导致自
    /// 死锁（std `Mutex` 不可重入）。故 `sessions` 必须是独立的一把锁。
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    /// 活动运行。**独立保留**：键为 `run_id`（非 `session_id`），与 `per_session` 键空间不同；
    /// 且 `get_active_terminal_run_input_target` 刻意先取本锁拿到 run_id 后立即释放，再取
    /// `per_session`（会话状态）锁，维持单一加锁顺序。并入会破坏该顺序约束。
    active_runs: Arc<Mutex<HashMap<String, TerminalActiveRun>>>,
    /// 其余「按 session_id 归集」的叶子状态（快照 / 交互视觉态 / 切换态输入 / geometry /
    /// 状态机 / 流控器 / 心跳）合并到单一表，按 session_id 一把锁取用。相比原先 7 张独立 map，
    /// 显著降低 `remove_interactive_terminal_after_exit` 等路径的取锁次数（7 把锁 -> 1 把）。
    per_session: Arc<Mutex<HashMap<String, PerSessionState>>>,
    /// 优雅关闭信号：设为 true 时孤儿收割线程退出循环。
    pub(super) shutdown: Arc<AtomicBool>,
    pub(super) creation_guard: Arc<Mutex<()>>,
}

/// 锁定合并后的 per-session 表；中毒时返回带上下文的错误串（沿用各原始辅助的提示文案）。
fn lock_per_session<'a>(
    state: &'a TerminalSessionState,
    poisoned_message: &str,
) -> Result<std::sync::MutexGuard<'a, HashMap<String, PerSessionState>>, String> {
    state
        .per_session
        .lock()
        .map_err(|_| poisoned_message.to_string())
}

/// 清空某字段后，若该会话条目已无任何状态则剪除整条目，避免空条目在合并表里泄漏。
fn prune_session_entry_if_empty(
    per_session: &mut HashMap<String, PerSessionState>,
    session_id: &str,
) {
    if per_session
        .get(session_id)
        .is_some_and(PerSessionState::is_empty)
    {
        per_session.remove(session_id);
    }
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

pub(super) fn get_terminal_snapshot(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<String, String> {
    let per_session = lock_per_session(state, "终端快照状态已损坏。")?;
    Ok(per_session
        .get(session_id)
        .map(|entry| entry.snapshot.clone())
        .unwrap_or_default())
}

pub(super) fn set_terminal_snapshot(
    state: &TerminalSessionState,
    session_id: &str,
    value: String,
) -> Result<(), String> {
    let mut per_session = lock_per_session(state, "终端快照状态已损坏。")?;
    per_session
        .entry(session_id.to_string())
        .or_default()
        .snapshot = value;
    Ok(())
}

pub(super) fn remove_terminal_snapshot(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<(), String> {
    let mut per_session = lock_per_session(state, "终端快照状态已损坏。")?;
    if let Some(entry) = per_session.get_mut(session_id) {
        entry.snapshot.clear();
    }
    prune_session_entry_if_empty(&mut per_session, session_id);
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
    let mut per_session = lock_per_session(state, "终端快照状态已损坏。")?;
    let snapshot = &mut per_session
        .entry(session_id.to_string())
        .or_default()
        .snapshot;
    snapshot.push_str(chunk);
    trim_terminal_snapshot(snapshot);
    Ok(())
}

pub(super) fn remove_terminal_interactive_visual_state(
    state: &TerminalSessionState,
    session_id: &str,
) -> Result<(), String> {
    let mut per_session = lock_per_session(state, "终端交互视觉状态已损坏。")?;
    if let Some(entry) = per_session.get_mut(session_id) {
        entry.interactive_visual = None;
    }
    prune_session_entry_if_empty(&mut per_session, session_id);
    Ok(())
}

pub(super) fn mark_terminal_resize_repaint_suppression(
    state: &TerminalSessionState,
    session_id: &str,
) {
    let Ok(mut per_session) = state.per_session.lock() else {
        return;
    };
    let visual_state = per_session
        .entry(session_id.to_string())
        .or_default()
        .interactive_visual
        .get_or_insert_with(TerminalInteractiveVisualState::default);
    visual_state.resize_repaint_suppress_until = Some(Instant::now() + TERMINAL_RESIZE_REPAINT_SUPPRESSION);
}

/// 每会话 geometry：作为「单一 SessionRegistry」绞杀式重构的第一步，让会话各自持有自己的
/// 列宽/行高。运行 PTY 不再统一从全局 `registry().geometry` 取尺寸，避免多开时会话 A 的运行
/// 被会话 B 最后一次 resize 的尺寸创建。全局 geometry 已删除，每会话 geometry 成为唯一来源
/// （绞杀式重构 BE-1）。
///
/// 对照 VSCode `src/vs/platform/terminal/node/ptyService.ts`：每个 `PersistentTerminalProcess`
/// 各自持有 cols/rows（尤其 `XtermSerializer`），`PtyService.resize(id, cols, rows)` 仅作用于
/// 指定 id 的进程，不存在跨会话共享的全局尺寸。
pub(super) fn set_session_geometry(
    state: &TerminalSessionState,
    session_id: &str,
    cols: u16,
    rows: u16,
) {
    let Ok(mut per_session) = state.per_session.lock() else {
        return;
    };
    let geometry = per_session
        .entry(session_id.to_string())
        .or_default()
        .geometry
        .get_or_insert_with(Geometry::default);
    geometry.cols = cols.max(2);
    geometry.rows = rows.max(1);
}

pub(super) fn remove_session_geometry(state: &TerminalSessionState, session_id: &str) {
    let Ok(mut per_session) = state.per_session.lock() else {
        return;
    };
    if let Some(entry) = per_session.get_mut(session_id) {
        entry.geometry = None;
    }
    prune_session_entry_if_empty(&mut per_session, session_id);
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
    let mut per_session = match state.per_session.lock() {
        Ok(per_session) => per_session,
        Err(_) => {
            // 锁中毒属不可恢复的内部错误：记录后丢弃本次转移，保持「尽力而为、不 panic」。
            log::warn!(
                "[session-fsm] 会话状态锁中毒，丢弃状态转移（session_id={session_id}, 目标={to:?}）。"
            );
            return None;
        }
    };

    let from = per_session
        .get(session_id)
        .and_then(|entry| entry.state)
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

    per_session.entry(session_id.to_string()).or_default().state = Some(to);
    log::debug!(
        "[session-fsm] 会话状态转移（session_id={session_id}, {from:?} -> {to:?}）。"
    );
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
    if let Ok(per_session) = state.per_session.lock() && let Some(entry) = per_session.get(session_id) && let Some(current) = entry.state {
        return current;
    }
    TerminalState::Booting
}

/// 会话创建时重置该会话的输出流控器为全新实例（覆盖任何陈旧 / 已取消的旧控制器），返回其克隆。
/// P2：交互读线程在创建时拿到它；该会话发起的运行读线程随后经 get_flow_controller 复用同一个。
/// 之所以「重置」而非「取或建」：旧会话关闭时会 cancel 控制器（永久解除暂停），若复用到这个已
/// cancel 的实例，新会话的读线程将永不背压——必须换上全新实例。
pub(super) fn reset_flow_controller(
    state: &TerminalSessionState,
    session_id: &str,
) -> Option<FlowController> {
    let mut per_session = state.per_session.lock().ok()?;
    let controller = FlowController::new();
    per_session
        .entry(session_id.to_string())
        .or_default()
        .flow_controller = Some(controller.clone());
    Some(controller)
}

/// 取该会话已存在的输出流控器：供该会话的运行读线程复用、以及前端 ack 命令查找。
pub(super) fn get_flow_controller(
    state: &TerminalSessionState,
    session_id: &str,
) -> Option<FlowController> {
    let per_session = state.per_session.lock().ok()?;
    per_session
        .get(session_id)
        .and_then(|entry| entry.flow_controller.clone())
}

/// 取消并移除该会话的输出流控器：cancel 释放任何处于背压暂停态的读线程（使其能继续读到 EOF），
/// 移除则保证下次创建同名会话时得到全新实例。锁中毒时尽力而为忽略。
pub(super) fn remove_flow_controller(state: &TerminalSessionState, session_id: &str) {
    // 先在锁内取出控制器并剪除空条目，再于锁外 cancel：cancel 释放被背压暂停的读线程，
    // 无需也不应持有 per_session 锁，避免无谓扩大锁临界区。
    let controller = {
        let Ok(mut per_session) = state.per_session.lock() else {
            return;
        };
        let controller = per_session
            .get_mut(session_id)
            .and_then(|entry| entry.flow_controller.take());
        prune_session_entry_if_empty(&mut per_session, session_id);
        controller
    };
    if let Some(controller) = controller {
        controller.cancel();
    }
}

/// 记录 / 刷新某会话的前端心跳时刻。会话连接（ensure）与每次前端心跳时调用。
pub(super) fn touch_session_liveness(state: &TerminalSessionState, session_id: &str) {
    let Ok(mut per_session) = state.per_session.lock() else {
        return;
    };
    per_session
        .entry(session_id.to_string())
        .or_default()
        .liveness = Some(Instant::now());
}

/// 移除某会话的心跳记录（会话拆解 / 关闭时），避免心跳表泄漏已消亡会话的陈旧条目。
pub(super) fn remove_session_liveness(state: &TerminalSessionState, session_id: &str) {
    let Ok(mut per_session) = state.per_session.lock() else {
        return;
    };
    if let Some(entry) = per_session.get_mut(session_id) {
        entry.liveness = None;
    }
    prune_session_entry_if_empty(&mut per_session, session_id);
}

/// 收集「已超过宽限期未收到前端心跳、且当前无活动运行」的孤儿交互会话 id。
/// 仅返回仍存在于 sessions 表中的会话；带活动运行的会话一律跳过（绝不经收割线程终止仍在运行的
/// 脚本，那类清理交由应用退出时的 shutdown_all 处理），最大化零误杀。先在锁内仅取候选 id 即释放
/// per_session 锁，再做 sessions / active_runs 复核，避免跨锁持有。
pub(super) fn collect_idle_orphan_session_ids(
    state: &TerminalSessionState,
    grace: Duration,
) -> Vec<String> {
    let candidates: Vec<String> = {
        let Ok(per_session) = state.per_session.lock() else {
            return Vec::new();
        };
        let now = Instant::now();
        per_session
            .iter()
            .filter_map(|(session_id, entry)| {
                entry
                    .liveness
                    .filter(|last_seen| now.duration_since(*last_seen) > grace)
                    .map(|_| session_id.clone())
            })
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
    cleanup_paths: Vec<String>,
) -> Result<(), String> {
    let mut active_runs = lock_active_terminal_runs(state)?;
    if active_runs.contains_key(run_id) {
        return Err(format!("运行任务已存在：{run_id}"));
    }
    // Shell Integration 单命令/会话模型：同一会话同一时刻只跑一条命令。该会话已有活动运行时
    // 直接拒绝；运行的结束由交互流中的 OSC 133 D 标记驱动清理（clear_active_terminal_run）。
    if let Some(existing_run) = active_runs
        .values()
        .find(|active_run| active_run.session_id == session_id)
    {
        return Err(format!(
            "当前终端已有脚本正在运行：{}",
            existing_run.run_id
        ));
    }

    active_runs.insert(
        run_id.to_string(),
        TerminalActiveRun {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            pid: None,
            started_at_ms: None,
            cleanup_paths,
        },
    );
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

/// 移除指定活动运行，并返回该运行登记的、需在 WSL 侧回收的临时脚本路径（无则空）。运行完成 /
/// 派发失败回滚的调用方据此 spawn_wsl_script_cleanup 删除临时脚本，根治其在 /tmp 泄漏。锁中毒时
/// 尽力而为返回空列表。
pub(super) fn clear_active_terminal_run(state: &TerminalSessionState, run_id: &str) -> Vec<String> {
    let Ok(mut active_runs) = state.active_runs.lock() else {
        return Vec::new();
    };
    active_runs
        .remove(run_id)
        .map(|run| run.cleanup_paths)
        .unwrap_or_default()
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
    // per_session（会话状态）锁叠加持有（保持单一加锁顺序，杜绝潜在死锁）。
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
    let mut per_session = lock_per_session(state, "终端切换态输入缓冲已损坏。")?;
    let buffer = &mut per_session
        .entry(session_id.to_string())
        .or_default()
        .pending_switch_input;
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
    let mut per_session = lock_per_session(state, "终端切换态输入缓冲已损坏。")?;
    let buffered = per_session
        .get_mut(session_id)
        .map(|entry| std::mem::take(&mut entry.pending_switch_input))
        .unwrap_or_default();
    prune_session_entry_if_empty(&mut per_session, session_id);
    if buffered.is_empty() {
        Ok(data)
    } else {
        Ok(format!("{buffered}{data}"))
    }
}

pub(super) fn remove_pending_switch_input(state: &TerminalSessionState, session_id: &str) {
    let Ok(mut per_session) = state.per_session.lock() else {
        return;
    };
    if let Some(entry) = per_session.get_mut(session_id) {
        entry.pending_switch_input.clear();
    }
    prune_session_entry_if_empty(&mut per_session, session_id);
}

pub(super) fn should_skip_snapshot_for_interactive_resize_repaint(
    state: &TerminalSessionState,
    session_id: &str,
    chunk: &str,
) -> bool {
    if chunk.is_empty() {
        return false;
    }
    let Ok(mut per_session) = state.per_session.lock() else {
        return false;
    };
    let visual_state = per_session
        .entry(session_id.to_string())
        .or_default()
        .interactive_visual
        .get_or_insert_with(TerminalInteractiveVisualState::default);
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
        || looks_like_windows_drive_path(cwd)
        || (!cwd.starts_with('/') && cwd != "~")
}

/// 检测 Windows 驱动器号路径（如 `C:\` 或 `C:/`），避免误判含 `:` 的 Linux 路径。
fn looks_like_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
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
    // sessions 表独立：单独移除其 PTY 句柄。
    let _ = remove_terminal_session(state, session_id);

    // 其余按会话归集的状态都在 per_session 合并表里：一次取锁整体移除该会话条目
    // （原先逐项串行获取 7 把锁，现合并为 1 把）。同时取出流控器，于锁外 cancel
    // 以释放任何处于背压暂停态的读线程。锁中毒时尽力而为忽略。
    let flow_controller = {
        let Ok(mut per_session) = state.per_session.lock() else {
            return;
        };
        per_session
            .remove(session_id)
            .and_then(|entry| entry.flow_controller)
    };
    if let Some(controller) = flow_controller {
        controller.cancel();
    }
}