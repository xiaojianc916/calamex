// apply-shellint-batch2.mjs
// Batch 2（Shell Integration）：把脚本运行改道到交互 shell 的 stdin，运行生命周期由
// 交互流中的 OSC 133 标记（C→RunStarted、D→RunCompleted）合成；不再派生独立运行 PTY、
// 不再抓取/合成提示符。旧运行路径与其单测留待 Batch 3 删除（本批仅产生 warning，可编过）。
//
// 在仓库根目录运行：node apply-shellint-batch2.mjs
import { readFileSync, writeFileSync } from "node:fs";

const R = String.raw;

/** 每个文件：marker（幂等跳过）+ 若干 {find, replace} 精确单匹配替换。 */
const FILES = [
  // ───────────────────────────────────────────────────────────── protocol
  {
    path: "src-tauri/src/terminal/local_wsl_protocol.rs",
    marker: "LocalWslTerminalInteractiveMark",
    edits: [
      {
        find: R`#[derive(Debug, Clone)]
pub enum LocalWslTerminalServerPayload {`,
        replace: R`/// 交互 shell 经 OSC 133/633 上报的生命周期标记（Shell Integration）。由交互读线程从输出流中
/// 剥离后上抛，events 层据此合成运行的 RunStarted/RunCompleted，取代旧的抓取/合成提示符方案。
#[derive(Debug, Clone)]
pub struct LocalWslTerminalInteractiveMark {
    pub session_id: String,
    pub mark: super::shell_integration::ShellIntegrationMark,
}

#[derive(Debug, Clone)]
pub enum LocalWslTerminalServerPayload {`,
      },
      {
        find: R`    InteractiveAck(LocalWslTerminalInteractiveAck),
    InteractiveError(LocalWslTerminalInteractiveError),
}`,
        replace: R`    InteractiveAck(LocalWslTerminalInteractiveAck),
    InteractiveError(LocalWslTerminalInteractiveError),
    InteractiveMark(LocalWslTerminalInteractiveMark),
}`,
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── wsl_pty
  {
    path: "src-tauri/src/terminal/wsl_pty.rs",
    marker: "write_input_sync",
    edits: [
      {
        find: R`use super::local_wsl_protocol::{
    LocalWslTerminalInteractiveClosed, LocalWslTerminalInteractiveData,
    LocalWslTerminalInteractiveOpened, LocalWslTerminalOpenInteractiveRequest,
    LocalWslTerminalRunChunk, LocalWslTerminalRunCompleted, LocalWslTerminalRunScriptRequest,
    LocalWslTerminalRunStarted, LocalWslTerminalServerPayload, LocalWslUtf8ChunkDecoder,
    SIGNAL_MODE_KILL,
};`,
        replace: R`use super::local_wsl_protocol::{
    LocalWslTerminalInteractiveClosed, LocalWslTerminalInteractiveData,
    LocalWslTerminalInteractiveMark, LocalWslTerminalInteractiveOpened,
    LocalWslTerminalOpenInteractiveRequest, LocalWslTerminalRunChunk, LocalWslTerminalRunCompleted,
    LocalWslTerminalRunScriptRequest, LocalWslTerminalRunStarted, LocalWslTerminalServerPayload,
    LocalWslUtf8ChunkDecoder, SIGNAL_MODE_KILL,
};`,
      },
      {
        // LocalWslPtyHandle::write_input —— 拆出同步写入，async 版委托之。
        find: R`    pub async fn write_input(&self, data: String) -> Result<(), LocalWslPtyError> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| LocalWslPtyError::Write("终端写入锁已损坏。".to_string()))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| LocalWslPtyError::Write(error.to_string()))?;
        writer
            .flush()
            .map_err(|error| LocalWslPtyError::Write(error.to_string()))
    }`,
        replace: R`    /// 同步写入交互 stdin：供命令派发等非 async 路径直接调用（写入即返回，无 await）。
    pub fn write_input_sync(&self, data: &str) -> Result<(), LocalWslPtyError> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| LocalWslPtyError::Write("终端写入锁已损坏。".to_string()))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| LocalWslPtyError::Write(error.to_string()))?;
        writer
            .flush()
            .map_err(|error| LocalWslPtyError::Write(error.to_string()))
    }

    pub async fn write_input(&self, data: String) -> Result<(), LocalWslPtyError> {
        self.write_input_sync(&data)
    }`,
      },
      {
        // 命令派发需要把行内脚本落盘 —— 提升可见性到 pub(crate)。
        find: R`fn materialize_wsl_script(execution_path: &str, content: &str) -> Result<(), LocalWslPtyError> {`,
        replace: R`pub(crate) fn materialize_wsl_script(
    execution_path: &str,
    content: &str,
) -> Result<(), LocalWslPtyError> {`,
      },
      {
        // 交互读线程主循环：上抛 OSC 133/633 标记（即便 clean 为空也不能丢标记）。
        find: R`                        if should_flush_terminal_output(pending_out.len(), read, buffer.len()) {
                            let chunk = std::mem::take(&mut pending_out);
                            let (clean, _marks) = shell_filter.filter(&chunk);
                            if clean.is_empty() {
                                continue;
                            }`,
        replace: R`                        if should_flush_terminal_output(pending_out.len(), read, buffer.len()) {
                            let chunk = std::mem::take(&mut pending_out);
                            let (clean, marks) = shell_filter.filter(&chunk);
                            // 先把本批解析出的 OSC 133/633 标记上抛（clean 为空时标记也不能丢）。
                            for mark in marks {
                                on_event(LocalWslTerminalServerPayload::InteractiveMark(
                                    LocalWslTerminalInteractiveMark {
                                        session_id: session_id.clone(),
                                        mark,
                                    },
                                ));
                            }
                            if clean.is_empty() {
                                continue;
                            }`,
      },
      {
        // 交互读线程收尾：EOF 残尾里的标记同样上抛。
        find: R`            let mut tail = shell_filter.filter(&std::mem::take(&mut pending_out)).0;
            tail.push_str(&shell_filter.flush_remaining());`,
        replace: R`            let (mut tail, tail_marks) = shell_filter.filter(&std::mem::take(&mut pending_out));
            for mark in tail_marks {
                on_event(LocalWslTerminalServerPayload::InteractiveMark(
                    LocalWslTerminalInteractiveMark {
                        session_id: session_id.clone(),
                        mark,
                    },
                ));
            }
            tail.push_str(&shell_filter.flush_remaining());`,
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── events
  {
    path: "src-tauri/src/commands/terminal/events.rs",
    marker: "handle_interactive_shell_mark",
    edits: [
      {
        find: R`use crate::terminal::{
    local_wsl_protocol::{LocalWslTerminalServerPayload, SIGNAL_MODE_KILL},
    tauri_events::{`,
        replace: R`use crate::terminal::{
    local_wsl_protocol::{LocalWslTerminalServerPayload, SIGNAL_MODE_KILL},
    shell_integration::ShellIntegrationMark,
    tauri_events::{`,
      },
      {
        find: R`use super::state::{
    TerminalSessionState, append_terminal_snapshot, clear_active_terminal_run,
    complete_session_run_state, remove_interactive_terminal_after_exit,
    set_active_terminal_run_started_meta, set_session_state,
    should_skip_snapshot_for_interactive_resize_repaint, take_active_terminal_run_for_session,
};`,
        replace: R`use super::state::{
    TerminalSessionState, append_terminal_snapshot, clear_active_terminal_run,
    complete_session_run_state, get_active_run_snapshot_for_session, get_session_state,
    remove_interactive_terminal_after_exit, set_active_terminal_run_started_meta,
    set_session_state, should_skip_snapshot_for_interactive_resize_repaint,
    take_active_terminal_run_for_session,
};`,
      },
      {
        // 交互事件分发：新增 InteractiveMark 分支（枚举新增变体后必须穷尽）。
        find: R`        LocalWslTerminalServerPayload::InteractiveAck(_) => {}
        LocalWslTerminalServerPayload::RunStarted(_)
        | LocalWslTerminalServerPayload::RunChunk(_)
        | LocalWslTerminalServerPayload::RunCompleted(_)
        | LocalWslTerminalServerPayload::RunError(_) => {}
    }
}`,
        replace: R`        LocalWslTerminalServerPayload::InteractiveAck(_) => {}
        LocalWslTerminalServerPayload::InteractiveMark(payload) => {
            handle_interactive_shell_mark(app, state, session_id, payload.mark);
        }
        LocalWslTerminalServerPayload::RunStarted(_)
        | LocalWslTerminalServerPayload::RunChunk(_)
        | LocalWslTerminalServerPayload::RunCompleted(_)
        | LocalWslTerminalServerPayload::RunError(_) => {}
    }
}`,
      },
      {
        // 旧 run-PTY 分发（待 Batch 3 删除）：补齐 InteractiveMark 分支以保持穷尽。
        find: R`        LocalWslTerminalServerPayload::InteractiveOpened(_)
        | LocalWslTerminalServerPayload::InteractiveData(_)
        | LocalWslTerminalServerPayload::InteractiveClosed(_)
        | LocalWslTerminalServerPayload::InteractiveAck(_)
        | LocalWslTerminalServerPayload::InteractiveError(_) => {}
    }
}`,
        replace: R`        LocalWslTerminalServerPayload::InteractiveOpened(_)
        | LocalWslTerminalServerPayload::InteractiveData(_)
        | LocalWslTerminalServerPayload::InteractiveClosed(_)
        | LocalWslTerminalServerPayload::InteractiveAck(_)
        | LocalWslTerminalServerPayload::InteractiveError(_)
        | LocalWslTerminalServerPayload::InteractiveMark(_) => {}
    }
}`,
      },
      {
        // 新增：消费 OSC 133 标记，合成运行生命周期。插在 handle_local_run_event 之前。
        find: R`#[allow(clippy::too_many_arguments)]
pub(super) fn handle_local_run_event(`,
        replace: R`/// 消费交互 shell 上报的 OSC 133 生命周期标记，合成运行的 RunStarted/RunCompleted：
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
pub(super) fn handle_local_run_event(`,
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── commands
  {
    path: "src-tauri/src/commands/terminal/commands.rs",
    marker: "write_input_sync",
    edits: [
      {
        find: R`    wsl_pty::{
        LocalWslPtyHandle, LocalWslRunHandle, open_interactive_terminal_local_with_flow,
        run_terminal_script_local_with_flow,
    },`,
        replace: R`    wsl_pty::{
        LocalWslPtyHandle, LocalWslRunHandle, materialize_wsl_script,
        open_interactive_terminal_local_with_flow, run_terminal_script_local_with_flow,
    },`,
      },
      {
        // write_terminal_input：运行期输入直接写交互 stdin（运行就是交互 shell 的前台命令）。
        find: R`        ActiveRunInputTarget::Run(run_id) => {
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
        }`,
        replace: R`        ActiveRunInputTarget::Run(_run_id) => {
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
        }`,
      },
      {
        // dispatch_script_to_terminal：改道到交互 shell 的 stdin。
        find: R`    let prompt_snapshot = get_terminal_snapshot(&terminal_state, &payload.session_id)?;
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
}`,
        replace: R`    // Shell Integration：命令直接写入交互 shell 的 stdin，由真实 shell 执行并绘制其自身提示符，
    // 不再派生独立运行 PTY、不再抓取/合成提示符。运行生命周期由交互流中的 OSC 133 标记在
    // events 层合成（C=输出开始 → RunStarted/Running，D[;exit]=完成 → RunCompleted/回收）。
    // 并发以多开会话实现：同一会话同一时刻只跑一条命令（try_mark 串行化）。
    if let Some(content) = script_content.as_ref() {
        // 行内/未保存脚本：先把内容落到 WSL 临时文件，再以 bash <path> 运行。
        materialize_wsl_script(&command.execution_path, content)
            .map_err(|error| error.to_string())?;
    }

    try_mark_active_terminal_run(&terminal_state, &payload.session_id, &payload.run_id)?;
    // 紧跟 try_mark 置位 SwitchingToRun：切换窗口内的输入缓冲为 Pending；待交互流的 C 标记
    // 到达后再由 events 层切到 Running（届时合成 RunStarted）。
    set_session_state_and_emit(
        &app,
        &terminal_state,
        &payload.session_id,
        TerminalState::SwitchingToRun,
    );

    // 写入命令行 + 换行触发交互 shell 执行；失败则回收本会话运行态。
    if let Err(error) = session.handle.write_input_sync(&format!("{command_line}\n")) {
        clear_active_terminal_run(&terminal_state, &payload.run_id);
        complete_session_run_state_and_emit(&app, &terminal_state, &payload.session_id);
        return Err(error.to_string());
    }

    Ok(DispatchTerminalScriptPayload {
        session_id: payload.session_id,
        cwd: session.working_directory.clone(),
        command_line,
        used_temp_file,
        started_at: started_at_ts.to_string(),
    })
}`,
      },
      {
        // cancel_terminal_run：向交互 stdin 写 Ctrl-C；结束仍由 OSC 133 D 标记驱动。
        find: R`    let terminal_state = state.inner().clone();
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
}`,
        replace: R`    let terminal_state = state.inner().clone();
    // Shell Integration：运行即交互 shell 的前台命令。取消 = 向交互 stdin 写入 Ctrl-C(ETX)，
    // 由 ConPTY 转成 SIGINT 投递给前台进程组；运行结束仍由交互流中的 OSC 133 D 标记驱动收尾。
    // 单命令/会话模型下不再有独立运行 PTY 与 kill 看门狗（graceful / kill 同样发 Ctrl-C）。
    let session_id = get_active_terminal_run_session(&terminal_state, &payload.run_id)
        .ok_or_else(|| format!("未找到正在运行的脚本：{}", payload.run_id))?;
    let session = get_terminal_session(&terminal_state, &session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;
    session
        .handle
        .write_input("\u{0003}".to_string())
        .await
        .map_err(|error| error.to_string())
}`,
      },
    ],
  },
];

function detectEol(raw) {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

let changed = 0,
  skipped = 0;
for (const file of FILES) {
  let raw;
  try {
    raw = readFileSync(file.path, "utf8");
  } catch (e) {
    console.error(`[fail] 读取失败：${file.path} —— ${e.message}`);
    process.exit(1);
  }
  if (file.marker && raw.includes(file.marker)) {
    console.log(`[skip] 已含标记「${file.marker}」，跳过：${file.path}`);
    skipped++;
    continue;
  }
  const eol = detectEol(raw);
  let lf = raw.split("\r\n").join("\n");

  // 先校验每个 find 恰好命中 1 处，再整体写入（all-or-nothing）。
  for (const { find } of file.edits) {
    const n = lf.split(find).length - 1;
    if (n !== 1) {
      console.error(
        `[fail] 期望恰好 1 处匹配，实际 ${n} 处。未改动 ${file.path}\n----- 锚点片段 -----\n${find.slice(0, 160)}…`,
      );
      process.exit(1);
    }
  }
  for (const { find, replace } of file.edits) {
    lf = lf.replace(find, () => replace);
  }

  const out = eol === "\r\n" ? lf.split("\n").join("\r\n") : lf;
  writeFileSync(file.path, out, "utf8");
  console.log(`[ok]   已更新（${file.edits.length} 处）：${file.path}`);
  changed++;
}
console.log(`\n完成：更新 ${changed} 个文件，跳过 ${skipped} 个。`);