//! 集成终端命令入口：对前端暴露的 Tauri 命令。
//!
//! 本模块只负责命令编排，状态存取下沉到 `state`，事件发射下沉到 `events`。

use jiff::Timestamp;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use tauri::{AppHandle, State};

use crate::terminal::{
    command_contracts::{
        CancelTerminalRunRequest, CloseTerminalSessionRequest, DispatchTerminalScriptPayload,
        DispatchTerminalScriptRequest, EnsureTerminalSessionRequest,
        HeartbeatTerminalSessionRequest, TerminalActiveRunSnapshot, TerminalInputRequest,
        TerminalResizeRequest, TerminalSessionPayload,
    },
    dispatch::build_terminal_run_command_for_local_wsl,
    local_wsl_protocol::LocalWslTerminalOpenInteractiveRequest,
    tauri_events::{TerminalExitEvent, emit_terminal_exit},
    types::TerminalState,
    wsl_pty::{
        LocalWslPtyHandle, materialize_wsl_script, open_interactive_terminal_local_with_flow,
        spawn_wsl_script_cleanup,
    },
};

use super::events::{
    complete_session_run_state_and_emit, handle_local_wsl_interactive_terminal_event,
    mark_terminal_interactive_ready, set_session_state_and_emit,
};
use super::state::{
    ActiveRunInputTarget, TerminalSession, TerminalSessionState, buffer_pending_switch_input,
    clear_active_terminal_run, collect_idle_orphan_session_ids,
    get_active_run_snapshot_for_session, get_active_terminal_run_input_target,
    get_active_terminal_run_session, get_flow_controller, get_session_state, get_terminal_session,
    get_terminal_snapshot, lock_terminal_sessions, mark_terminal_resize_repaint_suppression,
    remove_flow_controller, remove_interactive_terminal_after_exit, remove_pending_switch_input,
    remove_session_geometry, remove_session_liveness, remove_terminal_interactive_visual_state,
    remove_terminal_session, remove_terminal_snapshot, reset_flow_controller,
    resolve_terminal_start_directory, set_session_geometry, set_terminal_snapshot,
    should_recreate_terminal_session, take_and_prepend_pending_switch_input,
    terminate_terminal_session, touch_session_liveness, try_mark_active_terminal_run,
};
use super::to_wsl_path;

const DEFAULT_WSL_INTERACTIVE_CWD: &str = "~";

/// 关闭看门狗——宽限期：发出 kill 后等待读线程正常收尾（EOF → InteractiveClosed）的时长。
/// 超过未收尾则升级重发 kill。
const INTERACTIVE_TEARDOWN_GRACE: Duration = Duration::from_secs(3);
/// 关闭看门狗——硬超时：升级 kill 后再等这么久；仍未收尾则判定 wsl.exe 卡死，合成退出事件。
const INTERACTIVE_TEARDOWN_HARD_DEADLINE: Duration = Duration::from_secs(5);
/// 收尾看门狗——轮询间隔：周期性复检读线程是否已收尾，避免忙等。
const TEARDOWN_WATCH_POLL: Duration = Duration::from_millis(250);

/// 取消升级阶梯——SIGINT 宽限期：发出 Ctrl-C(SIGINT) 后等待运行经 OSC 133 D 收尾的时长；
/// 超时仍在运行则升级。首发 SIGINT 与补发 SIGINT 各用一个该宽限期。
const CANCEL_SIGINT_GRACE: Duration = Duration::from_secs(2);
/// 取消升级阶梯——SIGQUIT 宽限期：补发 Ctrl-C 仍无效后改发 Ctrl-\(SIGQUIT)，再等这么久；
/// 仍未收尾则进入最后手段（强拆该会话 PTY）。
const CANCEL_SIGQUIT_GRACE: Duration = Duration::from_secs(2);
/// 取消升级阶梯——轮询间隔：周期性复检活动运行是否已被 OSC 133 D 清理，避免忙等。
const CANCEL_ESCALATION_POLL: Duration = Duration::from_millis(100);

/// 孤儿会话收割——心跳宽限期：前端每个挂载中的会话周期性上报心跳（前端侧约 10s/次）。连续多次
/// 未上报（超过此宽限期，约 3 个心跳周期）即判定该后端会话已无前端照管（页面重载 / 崩溃后前端
/// VM 销毁、心跳停止），可作孤儿回收。宽限期为心跳间隔的约 3 倍，健康会话偶发抖动绝不会被误杀。
const ORPHAN_SESSION_REAP_GRACE: Duration = Duration::from_secs(30);
/// 孤儿会话收割——巡检间隔：收割线程每隔这么久扫描一次心跳表。
const ORPHAN_SESSION_REAP_POLL: Duration = Duration::from_secs(10);

#[tauri::command]
#[specta::specta]
pub async fn ensure_terminal_session(
    app: AppHandle,
    state: State<'_, TerminalSessionState>,
    payload: EnsureTerminalSessionRequest,
) -> Result<TerminalSessionPayload, String> {
    let terminal_state = state.inner().clone();
    set_session_geometry(
        &terminal_state,
        &payload.session_id,
        payload.cols,
        payload.rows,
    );
    // 刷新该会话的前端存活心跳：连接 / 重连即视为「有前端照管」，孤儿收割线程据此放行该会话。
    touch_session_liveness(&terminal_state, &payload.session_id);

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
                let active_run =
                    get_active_run_snapshot_for_session(&terminal_state, &payload.session_id).map(
                        |(run_id, pid, started_at_ms)| TerminalActiveRunSnapshot {
                            run_id,
                            pid,
                            started_at_ms: started_at_ms.map(|value| value as f64),
                        },
                    );
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
            shell_pid: std::sync::atomic::AtomicU32::new(0),
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
        ActiveRunInputTarget::Run(_run_id) => {
            // Shell Integration：运行就是交互 shell 的前台命令，运行期输入（含切换窗口缓冲的
            // Pending 输入）直接写入交互 stdin，不再经由独立运行 PTY。
            let data = take_and_prepend_pending_switch_input(
                &terminal_state,
                &payload.session_id,
                payload.data,
            )?;
            let session = get_terminal_session(&terminal_state, &payload.session_id)?
                .ok_or_else(|| "目标终端会话不存在。".to_string())?;
            return session
                .handle
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
    set_session_geometry(
        &terminal_state,
        &payload.session_id,
        payload.cols,
        payload.rows,
    );

    let session = get_terminal_session(&terminal_state, &payload.session_id)?
        .ok_or_else(|| "目标终端会话不存在。