//! 集成终端事件：向前端发射交互/运行/会话状态事件。
//!
//! 本模块不持有状态容器，只通过 state 模块的接口读写快照与活动运行。
//! 全局终端状态机已于 BE-2b 移除，状态完全按会话维度（session-state-changed）维护。

use jiff::Timestamp;
use std::{
    sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::terminal::{
    local_wsl_protocol::LocalWslTerminalServerPayload,
    shell_integration::ShellIntegrationMark,
    tauri_events::{
        TerminalDataEvent, TerminalDataSource, TerminalExitEvent, TerminalRunCompletedEvent,
        TerminalRunStartedEvent, TerminalSessionStateChangedEvent, emit_terminal_data,
        emit_terminal_exit, emit_terminal_run_completed, emit_terminal_run_started,
        emit_terminal_session_state_changed,
    },
    types::TerminalState,
};

use super::state::{
    TerminalSessionState, append_terminal_snapshot, clear_active_terminal_run,
    complete_session_run_state, get_active_run_snapshot_for_session, get_session_state,
    remove_interactive_terminal_after_exit, set_active_terminal_run_started_meta,
    set_session_state, should_skip_snapshot_for_interactive_resize_repaint,
};

static TERMINAL_DATA_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn terminal_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn emit_session_state_transitions(
    app: &AppHandle,
    session_id: &str,
    transitions: impl IntoIterator<Item = (TerminalState, TerminalState)>,
) {
    let at_ms = terminal_now_ms();
    for (from, to) in transitions {
        emit_terminal_session_state_changed(
            app,
            TerminalSessionStateChangedEvent {
                session_id: session_id.to_string(),
                from,
                to,
                at_ms,
            },
        );
    }
}

/// 改写会话状态的同时向前端发 `terminal:session-state-changed`，让 UI 能按会话维度观察
/// 状态流转。全局状态机已移除（BE-2b），状态完全按会话维护。无实际转移（无变化 / 非法 /
/// 锁中毒）时不发事件。
pub(super) fn set_session_state_and_emit(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    to: TerminalState,
) {
    emit_session_state_transitions(app, session_id, set_session_state(state, session_id, to));
}

/// 回收该会话的运行态并逐步发事件：`Running -> SwitchingToIdle -> IdleInteractive` 两步都会
/// 作为独立的 session-state-changed 发出。
pub(super) fn complete_session_run_state_and_emit(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
) {
    emit_session_state_transitions(
        app,
        session_id,
        complete_session_run_state(state, session_id),
    );
}

pub(super) fn mark_terminal_interactive_ready(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("terminal:interactive-ready", ());
    }
}

fn mark_terminal_interactive_exited(
    app: &AppHandle,
    _state: &TerminalSessionState,
    payload: TerminalExitEvent,
) {
    // Shell Integration 单命令/会话模型下运行就是交互 shell 的前台命令：交互 shell 退出即运行
    // 终止，无需再单独接管/终止运行句柄。活动运行条目的清理由 OSC 133 D 标记或会话拆解负责。
    emit_terminal_exit(app, payload);
}

fn emit_terminal_run_started_state(
    app: &AppHandle,
    session_id: &str,
    run_id: &str,
    pid: u32,
    started_at_ms: i64,
) {
    emit_terminal_run_started(
        app,
        TerminalRunStartedEvent {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            started_at_ms,
            pid,
        },
    );
}

pub(super) fn next_terminal_data_seq() -> u64 {
    TERMINAL_DATA_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
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

pub(super) fn handle_local_wsl_interactive_terminal_event(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    event: LocalWslTerminalServerPayload,
) {
    match event {
        LocalWslTerminalServerPayload::InteractiveOpened(_) => {
            mark_terminal_interactive_ready(app);
            // 每会话态：交互 shell 就绪即把「这个会话」置为 IdleInteractive（每会话各自从
            // Booting 起步），作为后续 dispatch -> SwitchingToRun 的合法起点。
            set_session_state_and_emit(app, state, session_id, TerminalState::IdleInteractive);
        }
        LocalWslTerminalServerPayload::InteractiveData(payload) => {
            emit_terminal_interactive_output(app, state, session_id, payload.data);
        }
        LocalWslTerminalServerPayload::InteractiveClosed(payload) => {
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
        LocalWslTerminalServerPayload::InteractiveError(payload) => {
            if let Some(message_session_id) = payload.session_id.as_ref()
                && message_session_id == session_id
            {
                emit_terminal_interactive_output(
                    app,
                    state,
                    session_id,
                    format!("{}\n", payload.message),
                );
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
        LocalWslTerminalServerPayload::InteractiveAck(_) => {}
        LocalWslTerminalServerPayload::InteractiveMark(payload) => {
            handle_interactive_shell_mark(app, state, session_id, payload.mark);
        }
    }
}

/// 消费交互 shell 上报的 OSC 133 生命周期标记，合成运行的 RunStarted/RunCompleted：
/// - C（命令开始执行）：该会话若有处于 SwitchingToRun 的活动运行 → 进入 Running 并发 RunStarted。
/// - D[;exit]（命令完成）：该会话若有处于 Running 的活动运行 → 回收会话态并发 RunCompleted。
/// 无活动运行（用户在终端里手动敲的命令）一律忽略，不为手输命令合成 run 事件。
/// 单命令/会话模型下 pid 不再有独立含义，取 0。
fn handle_interactive_shell_mark(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    mark: ShellIntegrationMark,
) {
    match mark {
        ShellIntegrationMark::CommandExecuted => {
            let Some((run_id, _, _)) = get_active_run_snapshot_for_session(state, session_id)
            else {
                return;
            };
            if get_session_state(state, session_id) != TerminalState::SwitchingToRun {
                return;
            }
            let started_at_ms = terminal_now_ms();
            set_active_terminal_run_started_meta(state, &run_id, 0, started_at_ms);
            emit_terminal_run_started_state(app, session_id, &run_id, 0, started_at_ms);
            set_session_state_and_emit(app, state, session_id, TerminalState::Running);
        }
        ShellIntegrationMark::CommandFinished { exit_code } => {
            let Some((run_id, _, _)) = get_active_run_snapshot_for_session(state, session_id)
            else {
                return;
            };
            if get_session_state(state, session_id) != TerminalState::Running {
                return;
            }
            clear_active_terminal_run(state, &run_id);
            complete_session_run_state_and_emit(app, state, session_id);
            emit_terminal_run_completed(
                app,
                TerminalRunCompletedEvent {
                    session_id: session_id.to_string(),
                    run_id,
                    exit_code,
                    finished_at: Timestamp::now().to_string(),
                },
            );
        }
        ShellIntegrationMark::PromptStart
        | ShellIntegrationMark::CommandStart
        | ShellIntegrationMark::Cwd(_) => {}
    }
}
