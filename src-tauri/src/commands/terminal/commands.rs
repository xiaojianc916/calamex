//! 集成终端命令入口：对前端暴露的 Tauri 命令。
//!
//! 本模块只负责命令编排，状态存取下沉到 `state`，事件发射下沉到 `events`。

use jiff::Timestamp;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tauri::{AppHandle, State};

use crate::terminal::{
    command_contracts::{
        CancelTerminalRunRequest, CloseTerminalSessionRequest, DispatchTerminalScriptPayload,
        DispatchTerminalScriptRequest, EnsureTerminalSessionRequest, TerminalActiveRunSnapshot,
        TerminalInputRequest, TerminalResizeRequest, TerminalSessionPayload,
    },
    dispatch::build_terminal_run_command_for_local_wsl,
    local_wsl_protocol::{
        LocalWslTerminalOpenInteractiveRequest, LocalWslTerminalRunScriptRequest, SIGNAL_MODE_KILL,
    },
    tauri_events::{
        TerminalExitEvent, TerminalRunCompletedEvent, emit_terminal_exit,
        emit_terminal_run_completed,
    },
    types::TerminalState,
    visual::{TerminalRunVisualTracker, extract_prompt_from_terminal_snapshot},
    wsl_pty::{
        LocalWslPtyHandle, LocalWslRunHandle, open_interactive_terminal_local_with_flow,
        run_terminal_script_local_with_flow,
    },
};

use super::events::{
    complete_session_run_state_and_emit, handle_local_run_event,
    handle_local_wsl_interactive_terminal_event, mark_terminal_interactive_ready,
    set_session_state_and_emit,
};
use super::state::{
    ActiveRunInputTarget, TerminalSession, TerminalSessionState, attach_active_terminal_run_handle,
    buffer_pending_switch_input, clear_active_terminal_run, drain_active_terminal_runs,
    get_active_terminal_run_handle, get_active_terminal_run_input_target,
    get_active_run_snapshot_for_session, get_active_terminal_run_session, get_flow_controller,
    get_session_geometry, get_session_state, get_terminal_session, get_terminal_snapshot,
    lock_terminal_sessions,
    mark_terminal_resize_repaint_suppression, remove_flow_controller,
    remove_interactive_terminal_after_exit, remove_pending_switch_input, remove_session_geometry,
    remove_terminal_interactive_visual_state, remove_terminal_session, remove_terminal_snapshot,
    reset_flow_controller, resolve_terminal_start_directory, set_session_geometry,
    set_terminal_snapshot, should_recreate_terminal_session, take_active_terminal_run_for_session,
    take_and_prepend_pending_switch_input, terminate_terminal_session, try_mark_active_terminal_run,
};
use super::to_wsl_path;

const DEFAULT_WSL_INTERACTIVE_CWD: &str = "~";

/// 关闭看门狗——宽限期：发出 kill 后等待读线程正常收尾（EOF → InteractiveClosed）的时长。
/// 超过未收尾则升级重发 kill。
const INTERACTIVE_TEARDOWN_GRACE: Duration = Duration::from_secs(3);
/// 关闭看门狗——硬超时：升级 kill 后再等这么久；仍未收尾则判定 wsl.exe 卡死，合成退出事件。
const INTERACTIVE_TEARDOWN_HARD_DEADLINE: Duration = Duration::from_secs(5);
/// 取消看门狗——宽限期：kill 模式取消运行后等待运行读线程正常收尾（child.wait 返回 →
/// RunCompleted）的时长。超过未收尾则升级重发 kill。
const RUN_CANCEL_TEARDOWN_GRACE: Duration = Duration::from_secs(3);
/// 取消看门狗——硬超时：升级重发 kill 后再等这么久；仍未收尾则判定 wsl.exe 卡死，合成完成事件。
const RUN_CANCEL_TEARDOWN_HARD_DEADLINE: Duration = Duration::from_secs(5);
/// 收尾看门狗——轮询间隔：周期性复检读线程是否已收尾，避免忙等。关闭 / 取消两条看门狗共用。
const TEARDOWN_WATCH_POLL: Duration = Duration::from_millis(250);

#[tauri::command]
#[specta::specta]
pub async fn ensure_terminal_session(
    app: AppHandle,
    state: State<'_, TerminalSessionState>,
    payload: EnsureTerminalSessionRequest,
) -> Result<TerminalSessionPayload, String> {
    let terminal_state = state.inner().clone();
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
                log::debug!(
                    "既有 WSL 交互会话已不可复用，将重建（session_id={}）。",
                    payload.session_id
                );
                remove_terminal_session(&terminal_state, &payload.session_id)?;
                remove_terminal_snapshot(&terminal_state, &payload.session_id)?;
                terminate_terminal_session(existing_session.as_ref())?;
            } else {
                log::debug!(
                    "复用既有 WSL 交互会话并同步尺寸（session_id={}, cols={}, rows={}）。",
                    payload.session_id,
                    payload.cols,
                    payload.rows
                );
                existing_session
                    .handle
                    .resize(payload.cols, payload.rows)
                    .map_err(|error| error.to_string())?;
                mark_terminal_resize_repaint_suppression(&terminal_state, &payload.session_id);
                let initial_output = get_terminal_snapshot(&terminal_state, &payload.session_id)?;
                // 重载恢复：复用既有会话时带回该会话当前活动运行快照与会话态，让前端在
                // 页面重载、运行态镜像被重置后仍能复原「运行中 / 取消」UI。
                let active_run = get_active_run_snapshot_for_session(
                    &terminal_state,
                    &payload.session_id,
                )
                .map(|(run_id, pid, started_at_ms)| TerminalActiveRunSnapshot {
                    run_id,
                    pid,
                    started_at_ms,
                });
                let session_state = get_session_state(&terminal_state, &payload.session_id);
                mark_terminal_interactive_ready(&app);
                return Ok(TerminalSessionPayload {
                    session_id: payload.session_id,
                    cwd: existing_session.working_directory.clone(),
                    shell_label: "WSL2".into(),
                    created: false,
                    initial_output: (!initial_output.is_empty()).then_some(initial_output),
                    active_run,
                    session_state,
                });
            }
        }

        // 进入创建分支后才暴露工作目录解析错误（与改动前的 `?` 时机一致）。
        let terminal_cwd = pre_resolved_terminal_cwd?;
        log::debug!(
            "创建新的 WSL 交互会话（session_id={}, cwd={terminal_cwd}, cols={}, rows={}）。",
            payload.session_id,
            payload.cols,
            payload.rows
        );

        let event_app = app.clone();
        let event_state = terminal_state.clone();
        let event_session_id = payload.session_id.clone();
        // P2：会话创建时为其安装全新的输出流控器（覆盖任何陈旧 / 已 cancel 的旧实例），交给
        // 交互读线程；该会话发起的运行读线程随后经 get_flow_controller 复用同一个。前端按会话
        // 回 ack，未确认字符回落到低水位即恢复读取。
        let flow = reset_flow_controller(&terminal_state, &payload.session_id);
        let handle = open_interactive_terminal_local_with_flow(
            LocalWslTerminalOpenInteractiveRequest {
                session_id: payload.session_id.clone(),
                working_directory: terminal_cwd.clone(),
                cols: payload.cols,
                rows: payload.rows,
            },
            flow,
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
            // 让步给已存在的会话：撤销刚安装的流控器（handle.close() 已 cancel 它），避免
            // 在 map 中留下与本次失败创建相关的陈旧条目。
            remove_flow_controller(&terminal_state, &payload.session_id);
            let session_state = get_session_state(&terminal_state, &payload.session_id);
            return Ok(TerminalSessionPayload {
                session_id: payload.session_id,
                cwd: terminal_cwd.clone(),
                shell_label: "WSL2".into(),
                created: false,
                initial_output: None,
                active_run: None,
                session_state,
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
        set_terminal_snapshot(&terminal_state, &payload.session_id, String::new())?;
        remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;

        (terminal_cwd, true)
    };

    mark_terminal_interactive_ready(&app);
    log::trace!(
        "WSL 交互会话就绪事件已发出（session_id={}, created={created}）。",
        payload.session_id
    );

    let session_state = get_session_state(&terminal_state, &payload.session_id);
    Ok(TerminalSessionPayload {
        session_id: payload.session_id,
        cwd: terminal_cwd,
        shell_label: "WSL2".into(),
        created,
        initial_output: None,
        active_run: None,
        session_state,
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
    set_session_geometry(&terminal_state, &payload.session_id, payload.cols, payload.rows);

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
    app: AppHandle,
    state: State<TerminalSessionState>,
    payload: CloseTerminalSessionRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    // Pair close with ensure_terminal_session's create guard so close cannot miss a
    // session that is between process spawn and registry insertion.
    let _creation_guard = terminal_state
        .creation_guard
        .lock()
        .map_err(|_| "终端会话创建锁已损坏。".to_string())?;
    let removed_session = remove_terminal_session(&terminal_state, &payload.session_id)?;
    remove_terminal_snapshot(&terminal_state, &payload.session_id)?;
    remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;
    remove_pending_switch_input(&terminal_state, &payload.session_id);
    remove_session_geometry(&terminal_state, &payload.session_id);
    // P2：取消并移除该会话的输出流控器，释放任何处于背压暂停态的读线程（使其能读到 EOF）。
    remove_flow_controller(&terminal_state, &payload.session_id);
    if let Some(run_handle) =
        take_active_terminal_run_for_session(&terminal_state, &payload.session_id)
    {
        let _ = run_handle.cancel(SIGNAL_MODE_KILL);
    }
    let Some(session) = removed_session else {
        return Ok(());
    };
    // 句柄是 Arc<Mutex<...>> 克隆共享，克隆后交给看门狗线程，与 terminate 发出的 kill 共用同一
    // killer / finished 标志。
    let handle = session.handle.clone();
    let result = terminate_terminal_session(session.as_ref());
    // 关闭看门狗：已请求关闭后，若读线程在宽限期内未收尾（wsl.exe 卡死等），升级重发
    // kill；硬超时仍未收尾则合成退出事件通知前端、回收会话状态，避免 UI 永久卡在僵尸会话
    // 上。只在关闭路径介入，不触碰健康的空闲会话（零误杀）。
    // 传入克隆：本函数末尾仍持有 `_creation_guard`（借用 terminal_state.creation_guard），
    // 其 Drop 在返回时才运行，故不能把 terminal_state 整体 move 进看门狗线程；克隆共享同一
    // Arc 态、开销可忽略，且保持创建锁持有至函数结束的原语义不变。
    spawn_interactive_teardown_watch(app, terminal_state.clone(), payload.session_id, handle);
    result
}

/// 关闭看门狗：在交互会话关闭发出 kill 后挂一次性的监护线程。正常路径下读线程会迅速读到
/// EOF 并发出 InteractiveClosed，看门狗观察到 is_finished 即静静退出，不做任何多余动作。
/// 仅当底层 wsl.exe 在 OS 层卡死、kill 不生效、读线程阻在 read()/child.wait() 时，才会升级
/// 重发 kill 并最终合成退出事件。只在关闭路径介入，不会误杀正常发呆等输入的空闲会话。
fn spawn_interactive_teardown_watch(
    app: AppHandle,
    state: TerminalSessionState,
    session_id: String,
    handle: LocalWslPtyHandle,
) {
    let spawn_result = std::thread::Builder::new()
        .name(format!("wsl-teardown-watch-{session_id}"))
        .spawn(move || {
            // 宽限期内等待读线程正常收尾（读到 EOF 后已由读线程自行发出 InteractiveClosed）。
            if wait_until_finished(&handle, INTERACTIVE_TEARDOWN_GRACE) {
                return;
            }
            // 宽限期内未收尾：升级重发 kill，强制终止可能仍卡死的 wsl.exe。
            log::warn!(
                "WSL 交互终端关闭后 {:?} 内读线程仍未收尾（session_id={session_id}），升级重发 kill。",
                INTERACTIVE_TEARDOWN_GRACE
            );
            if let Err(error) = handle.force_kill() {
                log::warn!(
                    "WSL 交互终端关闭看门狗升级 kill 失败（session_id={session_id}）：{error}"
                );
            }
            // 升级后再硬等一段；仍未收尾则合成退出事件，避免 UI 永久卡在僵尸会话上。
            if wait_until_finished(&handle, INTERACTIVE_TEARDOWN_HARD_DEADLINE) {
                return;
            }
            log::error!(
                "WSL 交互终端关闭后读线程在硬超时内仍未收尾（session_id={session_id}），合成退出事件通知前端并回收会话状态。"
            );
            // 读线程已确认卡死、不会再发 InteractiveClosed，这里代为回收会话状态并合成退出事件。
            remove_interactive_terminal_after_exit(&state, &session_id);
            emit_terminal_exit(
                &app,
                TerminalExitEvent {
                    session_id,
                    exit_code: None,
                },
            );
        });
    if let Err(error) = spawn_result {
        // 看门狗线程创建失败是极罕见的资源耗尽场景；关闭本身已发出 kill，这里仅警告，
        // 不阻断关闭流程。
        log::warn!("WSL 交互终端关闭看门狗线程创建失败：{error}");
    }
}

/// 在 `budget` 内轮询等待交互句柄标记已收尾；收尾返回 true，超预算仍未收尾返回 false。
fn wait_until_finished(handle: &LocalWslPtyHandle, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if handle.is_finished() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(TEARDOWN_WATCH_POLL);
    }
}

pub fn shutdown_all_terminal_sessions(state: &TerminalSessionState) -> Result<(), String> {
    let _creation_guard = state
        .creation_guard
        .lock()
        .map_err(|_| "终端会话创建锁已损坏。".to_string())?;
    // 先 kill 所有仍在运行的脚本：脚本走独立的运行 PTY，与交互会话句柄无关，仅 drain
    // sessions 无法终止它们，会在应用退出后遗留无人管理的孤儿 wsl.exe。
    for run_handle in drain_active_terminal_runs(state) {
        let _ = run_handle.cancel(SIGNAL_MODE_KILL);
    }
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

    // 运行 PTY 按「发起该 run 的会话」自身尺寸创建，而非全局共享尺寸；多开时不会被其它
    // 会话最后一次 resize 串台。对照 VSCode ptyService.ts：每个 PersistentTerminalProcess
    // 持有各自的尺寸，resize 仅作用于指定 id。
    let geometry = get_session_geometry(&terminal_state, &payload.session_id);
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
    // 每会话态：紧跟 try_mark 之后置位，发起脚本的「这个会话」立即进入 SwitchingToRun，
    // 使其切换窗口内的输入被缓冲为 Pending。紧贴 try_mark 之后置位，避免与并发的
    // write_terminal_input 之间出现「有活动运行但无会话态记录」的窗口。全局 FSM 已移除
    // （BE-2b），不再有「首个活动运行」的全局门控；多开时 B 不依赖被 A 卡住的全局态。
    // 对照 VSCode：每个 PersistentTerminalProcess 各自维护其运行/交互态，互不影响。同时
    // 向前端发 per-session 状态事件。
    set_session_state_and_emit(
        &app,
        &terminal_state,
        &payload.session_id,
        TerminalState::SwitchingToRun,
    );

    let started_at = Instant::now();
    let visual_tracker = Arc::new(Mutex::new(TerminalRunVisualTracker::default()));
    let event_app = app.clone();
    let event_state = terminal_state.clone();
    let event_session_id = payload.session_id.clone();
    let event_run_id = payload.run_id.clone();
    let event_prompt = prompt;

    // P2：运行读线程复用「发起该 run 的会话」的输出流控器，与交互读线程共享同一计数，
    // 一并受前端 ack 背压（运行输出同样汇入该会话的 xterm）。
    let flow = get_flow_controller(&terminal_state, &payload.session_id);
    let run_handle = match run_terminal_script_local_with_flow(request, flow, move |event| {
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
            clear_active_terminal_run(&terminal_state, &payload.run_id);
            complete_session_run_state_and_emit(&app, &terminal_state, &payload.session_id);
            return Err(error.to_string());
        }
    };

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
    app: AppHandle,
    state: State<'_, TerminalSessionState>,
    payload: CancelTerminalRunRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    let mode = payload.mode.as_deref().unwrap_or("graceful");
    // 取消看门狗只在 kill 模式下武装：graceful（Ctrl-C / ETX）只是「请求」，目标进程可能合法地
    // 继续运行，自动升级 graceful→kill 会破坏 graceful 语义、违反零误杀原则，故 graceful 永不
    // 武装看门狗。kill 模式才需兜底卡死的 wsl.exe。
    let arm_kill_watchdog = mode.trim() == SIGNAL_MODE_KILL;

    let handle = get_active_terminal_run_handle(&terminal_state, &payload.run_id)?
        .ok_or_else(|| format!("未找到正在运行的脚本：{}", payload.run_id))?;
    // 在发出 cancel 之前解析归属会话（此刻 run 仍在 active_runs 中，cancel 后可能被读线程清走）；
    // 合成 run-completed 事件需要 session_id。
    let watchdog_session_id = if arm_kill_watchdog {
        get_active_terminal_run_session(&terminal_state, &payload.run_id)
    } else {
        None
    };
    handle.cancel(mode).map_err(|error| error.to_string())?;
    if let Some(session_id) = watchdog_session_id {
        // 句柄是 Clone 共享，移交看门狗线程后与本次 kill 共用同一 killer / finished 标志。
        spawn_run_cancel_teardown_watch(app, terminal_state, session_id, payload.run_id, handle);
    }
    Ok(())
}

/// 取消看门狗：在 kill 模式取消运行、发出 kill 后挂一次性的监护线程。正常路径下运行读线程会
/// 迅速在 child.wait() 返回后置位 finished 并发出 RunCompleted，看门狗观察到 is_finished 即静静
/// 退出，不做任何多余动作。仅当底层 wsl.exe 卡死、kill 不生效、读线程阻在 read()/child.wait()
/// 时，才升级重发 kill 并最终合成完成事件，避免 UI 永久卡在「运行中」的僵尸 run 上。只在 kill
/// 取消路径介入，graceful 取消永不到达这里（零误杀）。
fn spawn_run_cancel_teardown_watch(
    app: AppHandle,
    state: TerminalSessionState,
    session_id: String,
    run_id: String,
    handle: LocalWslRunHandle,
) {
    let spawn_result = std::thread::Builder::new()
        .name(format!("wsl-run-cancel-watch-{run_id}"))
        .spawn(move || {
            // 宽限期内等待运行读线程正常收尾（child.wait 返回后已由读线程自行发出 RunCompleted）。
            if wait_until_run_finished(&handle, RUN_CANCEL_TEARDOWN_GRACE) {
                return;
            }
            // 宽限期内未收尾：升级重发 kill，强制终止可能仍卡死的 wsl.exe。
            log::warn!(
                "WSL 运行任务 kill 取消后 {:?} 内读线程仍未收尾（run_id={run_id}），升级重发 kill。",
                RUN_CANCEL_TEARDOWN_GRACE
            );
            if let Err(error) = handle.cancel(SIGNAL_MODE_KILL) {
                log::warn!("WSL 运行任务取消看门狗升级 kill 失败（run_id={run_id}）：{error}");
            }
            // 升级后再硬等一段；仍未收尾则合成完成事件，避免 UI 永久卡在「运行中」。
            if wait_until_run_finished(&handle, RUN_CANCEL_TEARDOWN_HARD_DEADLINE) {
                return;
            }
            log::error!(
                "WSL 运行任务 kill 取消后读线程在硬超时内仍未收尾（run_id={run_id}），合成完成事件通知前端并回收运行状态。"
            );
            // 读线程已确认卡死、不会再发 RunCompleted，这里代为回收运行状态并合成完成事件。
            // 注意：此处跳过 finalize_local_run 的视觉重置 / 分隔符注入（那些需要 visual_tracker /
            // prompt / started_at，仅在 dispatch 闭包内可得），属降级但正确的 UI 释放；前端按
            // run_id 去重，重复的 run-completed 可被安全忽略。
            clear_active_terminal_run(&state, &run_id);
            complete_session_run_state_and_emit(&app, &state, &session_id);
            emit_terminal_run_completed(
                &app,
                TerminalRunCompletedEvent {
                    session_id,
                    run_id,
                    exit_code: None,
                    finished_at: Timestamp::now().to_string(),
                },
            );
        });
    if let Err(error) = spawn_result {
        // 看门狗线程创建失败是极罕见的资源耗尽场景；取消本身已发出 kill，这里仅警告，
        // 不阻断取消流程。
        log::warn!("WSL 运行任务取消看门狗线程创建失败：{error}");
    }
}

/// 在 `budget` 内轮询等待运行句柄标记已收尾；收尾返回 true，超预算仍未收尾返回 false。
fn wait_until_run_finished(handle: &LocalWslRunHandle, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if handle.is_finished() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(TEARDOWN_WATCH_POLL);
    }
}

/// P2 ack 背压：前端每消费约 `CHAR_COUNT_ACK_SIZE` 个字符回一次 ack，未确认字符数回落到
/// 低水位以下即解除暂停、唤醒被背压的读线程。会话已关闭 / 无流控器时为安全 no-op。
///
/// 对照 VSCode `src/vs/platform/terminal/common/terminalProcess.ts` 的 `acknowledgeDataEvent`：
/// 前端 xterm 写入后按累计字符数回 ack，pty 侧据此增减 `_unacknowledgedCharCount`。
#[tauri::command]
#[specta::specta]
pub fn acknowledge_terminal_data(
    state: State<TerminalSessionState>,
    session_id: String,
    char_count: u32,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    if let Some(flow) = get_flow_controller(&terminal_state, &session_id) {
        flow.acknowledge(char_count as usize);
    }
    Ok(())
}
