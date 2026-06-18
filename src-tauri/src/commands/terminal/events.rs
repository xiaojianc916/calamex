//! 集成终端事件：向前端发射交互/运行/会话状态事件。
//!
//! 本模块不持有状态容器，只通过 state 模块的接口读写快照与活动运行。
//! 全局终端状态机已于 BE-2b 移除，状态完全按会话维度（session-state-changed）维护。

use jiff::Timestamp;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering as AtomicOrdering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::terminal::{
    local_wsl_protocol::{LocalWslTerminalServerPayload, SIGNAL_MODE_KILL},
    shell_integration::ShellIntegrationMark,
    tauri_events::{
        TerminalDataEvent, TerminalDataSource, TerminalExitEvent, TerminalRunChunkEvent,
        TerminalRunCompletedEvent, TerminalRunStartedEvent, TerminalSessionStateChangedEvent,
        emit_terminal_data, emit_terminal_exit, emit_terminal_run_chunk,
        emit_terminal_run_completed, emit_terminal_run_started,
        emit_terminal_session_state_changed,
    },
    types::TerminalState,
    visual::{
        TerminalRunVisualObservation, TerminalRunVisualTracker, build_terminal_ansi_reset,
        build_terminal_run_separator, current_visual_tracker, next_visual_run_seq,
        observe_visual_output_and_prefix,
    },
};

use super::state::{
    TerminalSessionState, append_terminal_snapshot, clear_active_terminal_run,
    complete_session_run_state, get_active_run_snapshot_for_session, get_session_state,
    remove_interactive_terminal_after_exit, set_active_terminal_run_started_meta,
    set_session_state, should_skip_snapshot_for_interactive_resize_repaint,
    take_active_terminal_run_for_session,
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
    state: &TerminalSessionState,
    payload: TerminalExitEvent,
) {
    // 仅接管归属于正在退出的这个会话的活动运行：多开场景下，关闭/退出某个会话绝不能
    // 误清其它会话仍在进行的脚本。取出句柄后立即 kill，避免脚本进程沦为无人管理的孤儿
    // （既丢失取消/输入入口，又遗留挂起的 wsl.exe）。
    if let Some(run_handle) = take_active_terminal_run_for_session(state, &payload.session_id) {
        let _ = run_handle.cancel(SIGNAL_MODE_KILL);
    }
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

/// 运行输出预清洗：消除“独立运行 PTY 冷启动”带来的视觉噪声。
pub(super) fn sanitize_terminal_run_chunk(data: &str, has_prior_output: bool) -> String {
    // WSL 诊断行（"wsl: ..."）仅在冷启动时出现，已有输出时不再剥离，
    // 避免误删用户脚本中合法的 "wsl:" 前缀行。
    if has_prior_output {
        return data.to_string();
    }
    let without_banner = strip_wsl_diagnostic_lines(data);
    strip_leading_screen_init(&without_banner)
}

fn strip_wsl_diagnostic_lines(input: &str) -> String {
    if !input.contains("wsl:") {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    for segment in input.split_inclusive('\n') {
        let trimmed = segment.trim_start_matches(['\r', ' ', '\t']);
        if trimmed.starts_with("wsl:") {
            continue;
        }
        out.push_str(segment);
    }
    out
}

fn strip_leading_screen_init(data: &str) -> String {
    if match_screen_init_token(data).is_none() {
        return data.to_string();
    }
    let mut rest = data;
    loop {
        if let Some(next) = match_screen_init_token(rest) {
            rest = next;
            continue;
        }
        if let Some(next) = rest.strip_prefix('\r').or_else(|| rest.strip_prefix('\n')) {
            rest = next;
            continue;
        }
        break;
    }
    rest.to_string()
}

fn match_screen_init_token(s: &str) -> Option<&str> {
    if let Some(rest) = s.strip_prefix("\x1b[?25l") {
        return Some(rest);
    }
    if let Some(rest) = s.strip_prefix("\x1b[?25h") {
        return Some(rest);
    }
    let after = s.strip_prefix("\x1b[")?;
    let mut byte_pos = 0usize;
    for ch in after.chars() {
        if ch.is_ascii_digit() || ch == ';' {
            byte_pos += ch.len_utf8();
        } else if matches!(ch, 'H' | 'J' | 'f') {
            return Some(&after[byte_pos + ch.len_utf8()..]);
        } else {
            return None;
        }
    }
    None
}

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
        LocalWslTerminalServerPayload::RunStarted(_)
        | LocalWslTerminalServerPayload::RunChunk(_)
        | LocalWslTerminalServerPayload::RunCompleted(_)
        | LocalWslTerminalServerPayload::RunError(_) => {}
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
            // 先据 started_at 推回绝对启动时刻（ms），一次算出、同时用于持久化与发事件，
            // 避免回填与前端事件之间出现毫秒级漂移。
            let started_at_ms = terminal_now_ms()
                - i64::try_from(started_at.elapsed().as_millis()).unwrap_or(0);
            // 回填活动运行的 pid / 启动时刻：供页面重载后经 ensure_terminal_session 复原运行态 UI。
            set_active_terminal_run_started_meta(state, run_id, payload.pid, started_at_ms);
            emit_terminal_run_started_state(app, session_id, run_id, payload.pid, started_at_ms);
            // 每会话态：该会话由 SwitchingToRun 进入 Running，输入据此路由到本会话的 run。
            set_session_state_and_emit(app, state, session_id, TerminalState::Running);
        }
        LocalWslTerminalServerPayload::RunChunk(payload) => {
            let has_prior_output = current_visual_tracker(visual_tracker).has_output;
            let cleaned = sanitize_terminal_run_chunk(&payload.data, has_prior_output);
            if cleaned.is_empty() {
                return;
            }
            let visual = observe_visual_output_and_prefix(visual_tracker, &cleaned);
            emit_terminal_run_chunk_with_visual_prefix(
                app, state, session_id, run_id, cleaned, visual,
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
        | LocalWslTerminalServerPayload::InteractiveError(_)
        | LocalWslTerminalServerPayload::InteractiveMark(_) => {}
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
    clear_active_terminal_run(state, run_id);
    // 每会话态：该会话的运行结束后回收其状态（Running -> SwitchingToIdle -> IdleInteractive），
    // 不受其它会话是否仍在运行影响。全局状态机已于 BE-2b 移除，运行完成事件直接发出。
    complete_session_run_state_and_emit(app, state, session_id);
    emit_terminal_run_completed(
        app,
        TerminalRunCompletedEvent {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            exit_code,
            finished_at: Timestamp::now().to_string(),
        },
    );
}
