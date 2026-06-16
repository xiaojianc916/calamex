//! 集成终端命令入口：对前端暴露的 Tauri 命令。
//!
//! 本模块只负责命令编排，状态存取下沉到 `state`，事件发射下沉到 `events`。

use jiff::Timestamp;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use tauri::{AppHandle, State};

use crate::terminal::{
    command_contracts::{
        CancelTerminalRunRequest, CloseTerminalSessionRequest, DispatchTerminalScriptPayload,
        DispatchTerminalScriptRequest, EnsureTerminalSessionRequest, TerminalInputRequest,
        TerminalResizeRequest, TerminalSessionPayload,
    },
    dispatch::build_terminal_run_command_for_local_wsl,
    local_wsl_protocol::{
        LocalWslTerminalOpenInteractiveRequest, LocalWslTerminalRunScriptRequest, SIGNAL_MODE_KILL,
    },
    types::TerminalState,
    visual::{TerminalRunVisualTracker, extract_prompt_from_terminal_snapshot},
    wsl_pty::{open_interactive_terminal_local, run_terminal_script_local},
};

use super::events::{
    complete_session_run_state_and_emit, handle_local_run_event,
    handle_local_wsl_interactive_terminal_event, mark_terminal_interactive_ready,
    set_session_state_and_emit, transition_terminal_state,
};
use super::state::{
    ActiveRunInputTarget, TerminalSession, TerminalSessionState, active_terminal_run_count,
    attach_active_terminal_run_handle, buffer_pending_switch_input, clear_active_terminal_run,
    drain_active_terminal_runs, get_active_terminal_run_handle,
    get_active_terminal_run_input_target, get_session_geometry, get_terminal_session,
    get_terminal_snapshot, lock_terminal_sessions, mark_terminal_resize_repaint_suppression,
    remove_pending_switch_input, remove_session_geometry, remove_terminal_interactive_visual_state,
    remove_terminal_session, remove_terminal_snapshot, resolve_terminal_start_directory,
    set_session_geometry, set_terminal_snapshot, should_recreate_terminal_session,
    take_active_terminal_run_for_session, take_and_prepend_pending_switch_input,
    terminate_terminal_session, try_mark_active_terminal_run, update_terminal_geometry,
};
use super::to_wsl_path;

const DEFAULT_WSL_INTERACTIVE_CWD: &str = "~";

#[tauri::command]
#[specta::specta]
pub async fn ensure_terminal_session(
    app: AppHandle,
    state: State<'_, TerminalSessionState>,
    payload: EnsureTerminalSessionRequest,
) -> Result<TerminalSessionPayload, String> {
    let terminal_state = state.inner().clone();
    update_terminal_geometry(payload.cols, payload.rows);
    set_session_geometry(&terminal_state, &payload.session_id, payload.cols, payload.rows);

    // 在持有创建保护锁之前完成工作目录规整：canonicalize 会触达文件系统，慢盘 / 网络盘上
    // 可能阻塞。把它挪到锁外可缩短临界区，避免无谓拉长 close / shutdown 等需与创建串行的
    // 路径的等待。这里只“预解析”、不在锁外提前返回错误：复用既有会话的分支（尤其 cwd
    // 为 Some 时）原本就不读取工作目录，必须保持其语义不变；解析错误只在真正进入创建分支
    // 时才通过 `?` 暴露，与改动前完全一致。
    let pre_resolved_terminal_cwd: Result<String, String> =
        resolve_terminal_start_directory(payload.cwd.as_deref()).and_then(|directory| {
            Ok(directory
                .as_ref()
                .map(|path| to_wsl_path(path.as_path()))
                .transpose()?
                .unwrap_or_else(|| DEFAULT_WSL_INTERACTIVE_CWD.to_string()))
        });

    let (terminal_cwd, created) = {
        // Serialize the full create path with close/shutdown. This mirrors VS Code's
        // process lifecycle guard: a close issued while a pty is still being created must
        // not observe "no session" and return before the new process is inserted.
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
                    initial_output: (!initial_output.is_empty()).then_some(initial_output),
                });
            }
        }

        // 进入创建分支后才暴露工作目录解析错误（与改动前的 `?` 时机一致）。
        let terminal_cwd = pre_resolved_terminal_cwd?;

        let event_app = app.clone();
        let event_state = terminal_state.clone();
        let event_session_id = payload.session_id.clone();
        let handle = open_interactive_terminal_local(
            LocalWslTerminalOpenInteractiveRequest {
                session_id: payload.session_id.clone(),
                working_directory: terminal_cwd.clone(),
                cols: payload.cols,
                rows: payload.rows,
            },
            move |event| {
                handle_local_wsl_interactive_terminal_event(
                    &event_app,
                    &event_state,
                    &event_session_id,
                    event,
                );
            },
        )
        .map_err(|error| error.to_string())?;

        if get_terminal_session(&terminal_state, &payload.session_id)?.is_some() {
            let _ = handle.close();
            return Ok(TerminalSessionPayload {
                session_id: payload.session_id,
                cwd: terminal_cwd.clone(),
                shell_label: "WSL2".into(),
                created: false,
                initial_output: None,
            });
        }

        let session = Arc::new(TerminalSession {
            handle,
            working_directory: terminal_cwd.clone(),
        });
        let mut sessions = match lock_terminal_sessions(&terminal_state) {
            Ok(sessions) => sessions,
            Err(error) => {
                let _ = terminate_terminal_session(session.as_ref());
                return Err(error);
            }
        };
        sessions.insert(payload.session_id.clone(), Arc::clone(&session));