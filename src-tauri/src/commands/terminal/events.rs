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

/// 运行输出预清洗：消除“独立运行 PTY 冷启动”带来的视觉噪声。
///
/// 现象根因：每次运行文件都会新开一个 `wsl.exe` ConPTY，它在脚本真正输出前会发出
/// 整屏清屏 + 光标归位（`CSI 2J` / `CSI H` / `CSI n;mH` 等），并重复打印 wsl.exe
/// 自身的诊断横幅（`wsl: ...`）。这些字节被灌进“滚动型” xterm 后会顶出大片空白行，
/// 并把运行结束后的提示符挤到视口之外，造成“结束后一片空白、看不到新的
/// [test@Predator]$”。
///
/// 处理策略（仅作用于运行输出，绝不触碰交互输出）：
/// - 任意位置：丢弃以 `wsl:` 开头的整行诊断横幅（用户脚本极少以此开头，安全）。
/// - 仅首段输出（`!has_prior_output`）且确以屏幕初始化控制序列开头时：剥掉开头连续的
///   清屏 / 光标定位 / 光标显隐序列及其夹带的换行；若不以控制序列开头则原样返回，避免
///   误删脚本自身的前导换行或空格。
pub(super) fn sanitize_terminal_run_chunk(data: &str, has_prior_output: bool) -> String {
    let without_banner = strip_wsl_diagnostic_lines(data);
    if has_prior_output {
        return without_banner;
    }
    strip_leading_screen_init(&without_banner)
}

/// 丢弃以 `wsl:`（允许前导空白）开头的整行——这些是 wsl.exe 自身的诊断横幅，
/// 而非用户脚本输出。保留其余所有内容与行结构。
fn strip_wsl_diagnostic_lines(input: &str) -> String {
    if !input.contains("wsl:") {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    for segment in input.split_inclusive('\n') {
        let trimmed = segment.trim_start_matches(|c: char| matches!(c, '\r' | ' ' | '\t'));
        if trimmed.starts_with("wsl:") {
            continue;
        }
        out.push_str(segment);
    }
    out
}

/// 仅当字符串确以“屏幕初始化”控制序列开头时，剥掉开头连续的此类序列及其夹带的换行。
fn strip_leading_screen_init(data: &str) -> String {
    if match_screen_init_token(data).is_none() {
        // 不以屏幕初始化控制序列开头：原样返回，避免误删脚本前导内容。
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

/// 匹配单个“屏幕初始化”控制序列，命中则返回其后剩余串：
/// - `CSI ?25l` / `CSI ?25h`（光标显隐）
/// - `CSI [0-9;]* {H,J,f}`（光标定位 / 清屏 / 行列定位）
///
/// 有意不匹配 alt-screen（`?1049h` 等）与 SGR（`m`），以免破坏 TUI 程序与颜色。
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
            // 运行输出预清洗：剥除“独立运行 PTY 冷启动”首段的整屏清屏/光标定位以及
            // 重复的 wsl.exe 诊断横幅，避免大片空白行与提示符被挤出视口。
            let has_prior_output = current_visual_tracker(visual_tracker).has_output;
            let cleaned = sanitize_terminal_run_chunk(&payload.data, has_prior_output);
            if cleaned.is_empty() {
                // 整段都是冷启动噪声：直接跳过，且不分配 run_seq，保持前端重排序列连续。
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
