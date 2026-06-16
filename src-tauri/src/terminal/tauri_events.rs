use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::types::TerminalState;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TerminalDataSource {
    Interactive,
    Run,
    InjectedReset,
    InjectedSeparator,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalDataEvent {
    pub(crate) session_id: String,
    pub(crate) data: String,
    pub(crate) source: TerminalDataSource,
    pub(crate) seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) run_seq: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalRunChunkEvent {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) data: String,
    pub(crate) seq: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalExitEvent {
    pub(crate) session_id: String,
    pub(crate) exit_code: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalRunCompletedEvent {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) exit_code: Option<i32>,
    pub(crate) finished_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalRunStartedEvent {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) started_at_ms: i64,
    pub(crate) pid: u32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalStateChangedEvent {
    pub(crate) from: TerminalState,
    pub(crate) to: TerminalState,
    pub(crate) at_ms: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSessionStateChangedEvent {
    pub(crate) session_id: String,
    pub(crate) from: TerminalState,
    pub(crate) to: TerminalState,
    pub(crate) at_ms: i64,
}

pub(crate) fn emit_terminal_data(app: &AppHandle, payload: TerminalDataEvent) {
    emit_to_main(app, "terminal:data", payload);
}

pub(crate) fn emit_terminal_run_chunk(app: &AppHandle, payload: TerminalRunChunkEvent) {
    emit_to_main(app, "terminal:run-chunk", payload);
}

pub(crate) fn emit_terminal_exit(app: &AppHandle, payload: TerminalExitEvent) {
    emit_to_main(app, "terminal:interactive-exited", payload);
}

pub(crate) fn emit_terminal_run_completed(app: &AppHandle, payload: TerminalRunCompletedEvent) {
    emit_to_main(app, "terminal:run-completed", payload);
}

pub(crate) fn emit_terminal_run_started(app: &AppHandle, payload: TerminalRunStartedEvent) {
    emit_to_main(app, "terminal:run-started", payload);
}

pub(crate) fn emit_terminal_state_changed(app: &AppHandle, payload: TerminalStateChangedEvent) {
    emit_to_main(app, "terminal:state-changed", payload);
}

pub(crate) fn emit_terminal_session_state_changed(
    app: &AppHandle,
    payload: TerminalSessionStateChangedEvent,
) {
    emit_to_main(app, "terminal:session-state-changed", payload);
}

fn emit_to_main<T>(app: &AppHandle, event: &str, payload: T)
where
    T: Serialize + Clone,
{
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(event, payload);
    }
}
