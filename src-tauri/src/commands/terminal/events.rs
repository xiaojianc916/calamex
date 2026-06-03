//! 集成终端事件与状态机：驱动状态转移、向前端发射交互/运行事件。
//!
//! 本模块不持有状态容器，只通过 state 模块的接口读写快照与活动运行。

use jiff::Timestamp;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::terminal::{
    local_wsl_protocol::LocalWslTerminalServerPayload,
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
        next_visual_run_seq, observe_visual_output_and_prefix, TerminalRunVisualObservation,
        TerminalRunVisualTracker,
    },
};

use super::state::{
    append_terminal_snapshot, clear_active_terminal_run, remove_interactive_terminal_after_exit,
    should_skip_snapshot_for_interactive_resize_repaint, TerminalSessionState,
};

static TERMINAL_DATA_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_RUN_CHUNK_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_RUN_VISUAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn terminal_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub(super) fn transition_terminal_state(app: &AppHandle, to: TerminalState) -> Result<(), String> {
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

pub(super) fn mark_terminal_interactive_ready(app: &AppHandle) {
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

pub(super) fn next_terminal_data_seq() -> u64 {
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

pub(super) fn next_terminal_run_chunk_seq() -> u64 {
    TERMINAL_RUN_CHUNK_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
}

/// `emit_terminal_run_visual_completion` 的入参集合：把一次 run 结束时注入
/// reset / 分隔符视觉块所需的上下文收拢成结构体，避免过长参数列表。
struct RunVisualCompletion<'a> {
    app: &'a AppHandle,
    state: &'a TerminalSessionState,
    session_id: &'a str,
    run_id: &'a str,
    exit_code: Option<i32>,
    started_at: Instant,
    tracker: &'a Arc<Mutex<TerminalRunVisualTracker>>,
    prompt: Option<String>,
}

fn emit_terminal_run_visual_completion(ctx: RunVisualCompletion<'_>) {
    let RunVisualCompletion {
        app,
        state,
        session_id,
        run_id,
        exit_code,
        started_at,
        tracker,
        prompt,
    } = ctx;
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

pub(super) fn handle_local_wsl_interactive_terminal_event(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    event: LocalWslTerminalServerPayload,
) {
    match event {
        LocalWslTerminalServerPayload::InteractiveOpened(_) => {
            mark_terminal_interactive_ready(app);
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
            if let Some(message_session_id) = payload.session_id.as_ref() {
                if message_session_id == session_id {
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
        LocalWslTerminalServerPayload::InteractiveAck(_) => {}
        LocalWslTerminalServerPayload::RunStarted(_)
        | LocalWslTerminalServerPayload::RunChunk(_)
        | LocalWslTerminalServerPayload::RunCompleted(_)
        | LocalWslTerminalServerPayload::RunError(_) => {}
    }
}

// 本地 run 读线程事件回调：与原 WSL Link run 路径的事件/状态转移保持等价。
#[allow(clippy::too_many_arguments)]
pub(super) fn handle_local_run_event(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    run_id: &str,
    visual_tracker: &Arc<Mutex<TerminalRunVisualTracker>>,
    started_at: Instant,
    prompt: Option<String>,
    event: LocalWslTerminalServerPayload,
) {
    match event {
        LocalWslTerminalServerPayload::RunStarted(payload) => {
            emit_terminal_run_started_state(app, session_id, run_id, payload.pid, started_at);
        }
        LocalWslTerminalServerPayload::RunChunk(payload) => {
            let visual = observe_visual_output_and_prefix(visual_tracker, &payload.data);
            emit_terminal_run_chunk_with_visual_prefix(
                app, state, session_id, run_id, payload.data, visual,
            );
        }
        LocalWslTerminalServerPayload::RunCompleted(payload) => {
            finalize_local_run(
                app,
                state,
                session_id,
                run_id,
                payload.exit_code,
                started_at,
                visual_tracker,
                prompt,
            );
        }
        LocalWslTerminalServerPayload::RunError(payload) => {
            let output = format!("{}\n", payload.message);
            let visual = observe_visual_output_and_prefix(visual_tracker, &output);
            emit_terminal_run_chunk_with_visual_prefix(
                app, state, session_id, run_id, output, visual,
            );
            finalize_local_run(
                app,
                state,
                session_id,
                run_id,
                payload.exit_code.or(Some(127)),
                started_at,
                visual_tracker,
                prompt,
            );
        }
        LocalWslTerminalServerPayload::InteractiveOpened(_)
        | LocalWslTerminalServerPayload::InteractiveData(_)
        | LocalWslTerminalServerPayload::InteractiveClosed(_)
        | LocalWslTerminalServerPayload::InteractiveAck(_)
        | LocalWslTerminalServerPayload::InteractiveError(_) => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn finalize_local_run(
    app: &AppHandle,
    state: &TerminalSessionState,
    session_id: &str,
    run_id: &str,
    exit_code: Option<i32>,
    started_at: Instant,
    visual_tracker: &Arc<Mutex<TerminalRunVisualTracker>>,
    prompt: Option<String>,
) {
    emit_terminal_run_visual_completion(RunVisualCompletion {
    app,
    state,
    session_id,
    run_id,
    exit_code,
    started_at,
    tracker: visual_tracker,
    prompt,
});
    emit_terminal_run_completed_with_state(
        app,
        TerminalRunCompletedEvent {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            exit_code,
            finished_at: Timestamp::now().to_string(),
        },
    );
    clear_active_terminal_run(state, run_id);
}
