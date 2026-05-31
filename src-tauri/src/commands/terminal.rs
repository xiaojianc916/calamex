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
    dispatch::build_terminal_run_command_for_wsl_link,
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
    wsl_pty::{
        open_interactive_terminal_local, run_terminal_script_local, LocalWslPtyHandle,
        LocalWslRunHandle,
    },
};
use crate::wsl_link::terminal_exec::{
    WslLinkTerminalOpenInteractiveRequest, WslLinkTerminalRunScriptRequest,
    WslLinkTerminalServerPayload,
};

const TERMINAL_RESIZE_REPAINT_SUPPRESSION: Duration = Duration::from_millis(240);
const DEFAULT_WSL_INTERACTIVE_CWD: &str = "~";
const MAX_PENDING_SWITCH_INPUT_BYTES: usize = 64 * 1024;

static TERMINAL_DATA_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_RUN_CHUNK_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_RUN_VISUAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

struct TerminalSession {
    handle: LocalWslPtyHandle,
    working_directory: String,
}

struct TerminalActiveRun {
    session_id: String,
    run_id: String,
    run_handle: Option<LocalWslRunHandle>,
}

enum ActiveRunInputTarget {
    None,
    Pending,
    Run(String),
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

    // Phase 1: 创建锁保护下检查现有会话、准备 WSL 启动参数。
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
                    initial_output: (!initial_output.is_empty()).then_some