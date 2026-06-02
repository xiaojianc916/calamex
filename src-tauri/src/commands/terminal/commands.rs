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
        LocalWslTerminalOpenInteractiveRequest, LocalWslTerminalRunScriptRequest,
    },
    types::TerminalState,
    visual::{extract_prompt_from_terminal_snapshot, TerminalRunVisualTracker},
    wsl_pty::{open_interactive_terminal_local, run_terminal_script_local},
};

use super::events::{
    handle_local_run_event, handle_local_wsl_interactive_terminal_event,
    mark_terminal_interactive_ready, transition_terminal_state,
};
use super::state::{
    attach_active_terminal_run_handle, buffer_pending_switch_input, clear_active_terminal_run,
    get_active_terminal_run_handle, get_active_terminal_run_input_target, get_terminal_session,
    get_terminal_snapshot, lock_terminal_sessions, mark_terminal_resize_repaint_suppression,
    remove_pending_switch_input, remove_terminal_interactive_visual_state, remove_terminal_session,
    remove_terminal_snapshot, resolve_terminal_start_directory, set_terminal_snapshot,
    should_recreate_terminal_session, take_and_prepend_pending_switch_input,
    terminate_terminal_session, try_mark_active_terminal_run, update_terminal_geometry,
    ActiveRunInputTarget, TerminalSession, TerminalSessionState,
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

    // Phase 1: 创建锁保护下检查现有会话、准备 WSL 启动参数。
    // std::sync::MutexGuard 不能跨越 .await，必须在 await 前释放。
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
                    initial_output: (!initial_output.is_empty()).then_some(initial_output),
                });
            }
        }

        let working_directory = resolve_terminal_start_directory(payload.cwd.as_deref())?;
        let terminal_cwd = working_directory
            .as_ref()
            .map(|path| to_wsl_path(path.as_path()))
            .transpose()?
            .unwrap_or_else(|| DEFAULT_WSL_INTERACTIVE_CWD.to_string());

        // 释放 creation_guard 后再打开本地 PTY，保持与原异步路径一致的锁释放时机。
        drop(_creation_guard);

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

        // Phase 2: 重新获取 creation_guard 后原子插入，防止并发创建。
        {
            let _creation_guard = terminal_state
                .creation_guard
                .lock()
                .map_err(|_| "终端会话创建锁已损坏。".to_string())?;
            // 再次检查：打开期间可能有其他调用者抢先生成了同一会话。
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
            let mut sessions = lock_terminal_sessions(&terminal_state)?;
            sessions.insert(payload.session_id.clone(), Arc::clone(&session));
            set_terminal_snapshot(&terminal_state, &payload.session_id, String::new())?;
            remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;
        }

        (terminal_cwd, true)
    };

    mark_terminal_interactive_ready(&app);

    Ok(TerminalSessionPayload {
        session_id: payload.session_id,
        cwd: terminal_cwd,
        shell_label: "WSL2".into(),
        created,
        initial_output: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn write_terminal_input(
    state: State<'_, TerminalSessionState>,
    payload: TerminalInputRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();

    match get_active_terminal_run_input_target(&terminal_state, &payload.session_id)? {
        ActiveRunInputTarget::Pending => {
            // 切换态（SwitchingToRun / SwitchingToIdle）：run 的 stdin 尚未就绪。
            // 不再静默丢弃用户输入，而是按会话缓冲，待状态落定后随下一次写入按序补发。
            buffer_pending_switch_input(&terminal_state, &payload.session_id, &payload.data)?;
            return Ok(());
        }
        ActiveRunInputTarget::Run(run_id) => {
            let data = take_and_prepend_pending_switch_input(
                &terminal_state,
                &payload.session_id,
                payload.data,
            )?;
            let handle = get_active_terminal_run_handle(&terminal_state, &run_id)?
                .ok_or_else(|| "目标运行任务不存在或已结束。".to_string())?;
            return handle
                .write_input(data)
                .await
                .map_err(|error| error.to_string());
        }
        ActiveRunInputTarget::None => {}
    }

    let data =
        take_and_prepend_pending_switch_input(&terminal_state, &payload.session_id, payload.data)?;
    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;
    session
        .handle
        .write_input(data)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn resize_terminal_session(
    state: State<TerminalSessionState>,
    payload: TerminalResizeRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    update_terminal_geometry(payload.cols, payload.rows);

    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;
    session
        .handle
        .resize(payload.cols, payload.rows)
        .map_err(|error| error.to_string())?;
    mark_terminal_resize_repaint_suppression(&terminal_state, &payload.session_id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn close_terminal_session(
    state: State<TerminalSessionState>,
    payload: CloseTerminalSessionRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let removed_session = remove_terminal_session(&terminal_state, &payload.session_id)?;
    remove_terminal_snapshot(&terminal_state, &payload.session_id)?;
    remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;
    remove_pending_switch_input(&terminal_state, &payload.session_id);
    let Some(session) = removed_session else {
        return Ok(());
    };
    terminate_terminal_session(session.as_ref())
}

pub fn shutdown_all_terminal_sessions(state: &TerminalSessionState) -> Result<(), String> {
    let sessions = {
        let mut sessions_map = lock_terminal_sessions(state)?;
        sessions_map
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>()
    };
    for session in sessions {
        terminate_terminal_session(session.as_ref())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn dispatch_script_to_terminal(
    app: AppHandle,
    state: State<TerminalSessionState>,
    payload: DispatchTerminalScriptRequest,
) -> Result<DispatchTerminalScriptPayload, String> {
    let terminal_state = state.inner().clone();
    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在，请先打开集成终端。".to_string())?;
    let started_at_ts = Timestamp::now();
    let (command, script_content) =
        build_terminal_run_command_for_local_wsl(&payload, &session.working_directory)?;
    let command_line = command.display_command.clone();
    let used_temp_file = command.used_temp_file;
    let prompt_snapshot = get_terminal_snapshot(&terminal_state, &payload.session_id)?;
    let prompt = extract_prompt_from_terminal_snapshot(&prompt_snapshot);

    let geometry = crate::terminal::registry::registry()
        .geometry
        .read()
        .map(|geometry| *geometry)
        .unwrap_or_default();
    let request = LocalWslTerminalRunScriptRequest {
        run_id: payload.run_id.clone(),
        working_directory: command.working_directory.clone(),
        execution_path: command.execution_path.clone(),
        script_content,
        cleanup_paths: command.cleanup_paths.clone(),
        cols: geometry.cols,
        rows: geometry.rows,
    };

    try_mark_active_terminal_run(&terminal_state, &payload.session_id, &payload.run_id)?;
    if let Err(error) = transition_terminal_state(&app, TerminalState::SwitchingToRun) {
        clear_active_terminal_run(&terminal_state, &payload.run_id);
        return Err(error);
    }

    let started_at = Instant::now();
    let visual_tracker = Arc::new(Mutex::new(TerminalRunVisualTracker::default()));
    let event_app = app.clone();
    let event_state = terminal_state.clone();
    let event_session_id = payload.session_id.clone();
    let event_run_id = payload.run_id.clone();
    let event_prompt = prompt;

    let run_handle = match run_terminal_script_local(request, move |event| {
        handle_local_run_event(
            &event_app,
            &event_state,
            &event_session_id,
            &event_run_id,
            &visual_tracker,
            started_at,
            event_prompt.clone(),
            event,
        );
    }) {
        Ok(handle) => handle,
        Err(error) => {
            // 启动失败：回滚活动 run 与状态机，不泄露半起的运行态。
            clear_active_terminal_run(&terminal_state, &payload.run_id);
            let _ = transition_terminal_state(&app, TerminalState::IdleInteractive);
            return Err(error.to_string());
        }
    };

    // run 已开始：把句柄登记到活动 run，供 stdin / 取消使用。
    // 若脚本已极快结束并清空活动 run，attach 返回 Err，忽略即可。
    let _ = attach_active_terminal_run_handle(&terminal_state, &payload.run_id, run_handle);

    Ok(DispatchTerminalScriptPayload {
        session_id: payload.session_id,
        cwd: session.working_directory.clone(),
        command_line,
        used_temp_file,
        started_at: started_at_ts.to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_terminal_run(
    state: State<'_, TerminalSessionState>,
    payload: CancelTerminalRunRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let mode = payload.mode.as_deref().unwrap_or("graceful");

    let handle = get_active_terminal_run_handle(&terminal_state, &payload.run_id)?
        .ok_or_else(|| format!("未找到正在运行的脚本：{}", payload.run_id))?;
    handle.cancel(mode).map_err(|error| error.to_string())
}
