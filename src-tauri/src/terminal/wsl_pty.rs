// 终端域：本地 PTY（Windows 原生 ConPTY）直接驱动 wsl.exe 的交互式 WSL2 终端与脚本运行。
//
// 这是“自研 gRPC supervisor + WSL Link agent”链路的替代实现：不再依赖 vsock /
// gRPC / Noise / 旁路 agent，而是用 portable-pty 在桌面进程内直接拉起 wsl.exe，
// 与 VS Code、Windows Terminal 走同一套官方方案。
//
// 事件类型（LocalWslTerminalServerPayload）、运行/交互请求与 UTF-8 分块解码器定义在
// 同域的 terminal::local_wsl_protocol；命令层与本模块共用这一套类型。

use std::{
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    time::Duration,
};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use thiserror::Error;
use wait_timeout::ChildExt;

use super::flow_control::{FlowController, utf16_len};
use super::local_wsl_protocol::{
    LocalWslTerminalInteractiveClosed, LocalWslTerminalInteractiveData,
    LocalWslTerminalInteractiveMark, LocalWslTerminalOpenInteractiveRequest,
    LocalWslTerminalServerPayload, LocalWslUtf8ChunkDecoder,
};
use super::wsl::bash_quote;

const TERMINAL_READ_BUFFER_BYTES: usize = 8192;

/// 持续高吞吐输出时，把多次 read 的解码结果攒批到该字节阈值再发一次事件，
/// 减少 Tauri IPC 事件数（前端已有 16ms 写入合批，这里在源头做合批）。
const TERMINAL_OUTPUT_COALESCE_BYTES: usize = 32 * 1024;

/// resize 合批静默窗口：窗口拖拽期间会高频触发 resize，逐次直接驱动 ConPTY 既浪费又可能在
/// Windows 上引发抖动 / 竞争。对照 VSCode src/vs/platform/terminal/node/terminalProcess.ts 的
/// DelayedResizer：合并一串快速 resize，仅在尺寸“安定”后把最后一次应用到底层 PTY。
const TERMINAL_RESIZE_DEBOUNCE: Duration = Duration::from_millis(50);

/// 同步驱动 wsl.exe 写脚本 / 清理临时文件时的硬超时。
/// 某些 Windows 环境下 wsl.exe 可能长时间挂起（参见 script_run.rs 对健康探测的刻意规避），
// 这里给同步子进程加超时兜底，避免命令线程被永久阻塞、反复触发后耗尽线程池导致 UI 冻结。
const WSL_SYNC_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Error)]
pub enum LocalWslPtyError {
    #[error("打开本地 WSL 终端失败：{0}")]
    Open(String),
    #[error("WSL 终端写入失败：{0}")]
    Write(String),
    #[error("WSL 终端调整尺寸失败：{0}")]
    Resize(String),
    #[error("WSL 终端关闭失败：{0}")]
    Close(String),
}

/// 本地 PTY 交互式终端句柄：对外提供 write_input / resize / close，
/// 以及关闭看门狗所需的 is_finished / force_kill。
#[derive(Clone)]
pub struct LocalWslPtyHandle {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// resize 合批通道发送端：所有 resize 经此投递给该会话独占的合批线程串行应用（见 spawn_resize_worker）。
    resize_tx: Sender<(u16, u16)>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    /// 读线程在交互 shell 结束（child.wait 返回）后置位。供关闭看门狗确证「读线程确已收尾」：
    /// 若 kill 后 wsl.exe 仍卡死、child.wait() 永久阻塞，则该标志持续为 false，看门狗据此升级
    /// 回收并合成退出事件通知前端，避免 UI 永久卡在僵尸会话上。
    finished: Arc<AtomicBool>,
    /// 该会话的输出流控器（P2 ack 背压）。close() 时取消，确保读线程不被暂停态卡住、能读到 EOF。
    flow: Option<FlowController>,
}

impl LocalWslPtyHandle {
    /// 底层交互 shell 是否已结束（读线程在 child.wait 返回后置位）。关闭看门狗据此判断
    /// kill 后读线程是否已正常收尾。
    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    /// 升级回收：再次向子进程发 kill（不重复取消流控，close() 已取消）。用于关闭看门狗在
    /// 宽限期内未观察到读线程收尾时，强制重试终止可能仍卡死的 wsl.exe。锁中毒 / kill 失败
    /// 时返回错误，调用方按尽力而为处理。
    pub fn force_kill(&self) -> Result<(), LocalWslPtyError> {
        let mut killer = self
            .killer
            .lock()
            .map_err(|_| LocalWslPtyError::Close("终端终止锁已损坏。".to_string()))?;
        killer
            .kill()
            .map_err(|error| LocalWslPtyError::Close(error.to_string()))
    }

    /// 同步写入交互 stdin：供命令派发等非 async 路径直接调用（写入即返回，无 await）。
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
    }

    /// 提交一次尺寸调整。不直接驱动 ConPTY，而是投递到该会话独占的 resize 合批线程：窗口拖拽
    /// 等高频 resize 会被合并，仅在尺寸安定后把最后一次应用到底层 PTY（见 spawn_resize_worker）。
    /// 通道断开（会话已销毁）时返回错误，由命令层按尽力而为处理。
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), LocalWslPtyError> {
        self.resize_tx
            .send((cols, rows))
            .map_err(|_| LocalWslPtyError::Resize("终端尺寸合批通道已关闭。".to_string()))
    }

    pub fn close(&self) -> Result<(), LocalWslPtyError> {
        // 先取消流控：若读线程正处于背压暂停态，需解除以便其读到 EOF 并完成收尾。
        if let Some(flow) = &self.flow {
            flow.cancel();
        }
        let mut killer = self
            .killer
            .lock()
            .map_err(|_| LocalWslPtyError::Close("终端终止锁已损坏。".to_string()))?;
        killer
            .kill()
            .map_err(|error| LocalWslPtyError::Close(error.to_string()))
    }
}

/// 打开一个本地 PTY 交互式 WSL2 终端，并接入每会话输出流控器（P2 ack 背压）。
///
/// on_event 在独立读线程中被调用：Opened → 若干 Data → Closed。
/// flow 为 None 时不施加背压。
pub fn open_interactive_terminal_local_with_flow<F>(
    request: LocalWslTerminalOpenInteractiveRequest,
    flow: Option<FlowController>,
    on_event: F,
) -> Result<LocalWslPtyHandle, LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    request
        .validate()
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))?;

    let session_id = request.session_id.clone();
    let working_directory = normalize_interactive_cwd(&request.working_directory);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows.max(1),
            cols: request.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))?;

    // Shell Integration（对照 VSCode shellIntegration-bash.sh）：把集成脚本落到 WSL 临时文件，
    // 再以 bash --init-file <path> -i 注入。--init-file 不支持 -l，故脚本内部自行 source 登录
    // 启动文件（/etc/profile + 首个 profile），等价于原 bash -il 的环境，随后装载 OSC 133/633 标记。
    let integration_script_path = shell_integration_script_path(&session_id);
    materialize_wsl_script(
        &integration_script_path,
        &super::shell_integration::build_bash_integration_script(),
    )?;

    let mut command = CommandBuilder::new("wsl.exe");
    command.arg("--cd");
    command.arg(&working_directory);
    command.arg("--");
    command.arg("bash");
    command.arg("--init-file");
    command.arg(&integration_script_path);
    command.arg("-i");
    // 让 wsl.exe 自身的诊断信息以 UTF-8 输出，根治 UTF-16LE 造成的终端乱码。
    command.env("WSL_UTF8", "1");
    // 标记集成脚本系由宿主注入（而非手动 source），脚本据此 source 登录启动文件。
    command.env("CALAMEX_SHELL_INTEGRATION_INJECTION", "1");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))?;
    // 拿到 child 后立即释放 slave，否则读端不会在子进程退出时收到 EOF。
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))?;
    let killer = child.clone_killer();
    let mut cleanup_killer = child.clone_killer();
    let pid = child.process_id().unwrap_or_default();
    let finished = Arc::new(AtomicBool::new(false));

    spawn_interactive_reader(
        session_id.clone(),
        pid,
        reader,
        child,
        Arc::clone(&finished),
        flow.clone(),
        on_event,
    )
    .inspect_err(|_error| {
        // 读线程创建失败时，child 不会被任何线程接管，主动终止以免遗留孤儿 wsl.exe。
        let _ = cleanup_killer.kill();
    })?;

    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>();
    // 为该会话挂一条独占的 resize 合批线程，移交 MasterPty 所有权并串行化全部尺寸调整。
    spawn_resize_worker(session_id.clone(), pair.master, resize_rx);

    Ok(LocalWslPtyHandle {
        writer: Arc::new(Mutex::new(writer)),
        resize_tx,
        killer: Arc::new(Mutex::new(killer)),
        finished,
        flow,
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_interactive_reader<F>(
    session_id: String,
    pid: u32,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    finished: Arc<AtomicBool>,
    flow: Option<FlowController>,
    mut on_event: F,
) -> Result<(), LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    std::thread::Builder::new()
        .name(format!("wsl-pty-{session_id}"))
        .spawn(move || {
            on_event(LocalWslTerminalServerPayload::Opened);
            log::debug!("WSL 交互终端读线程已启动（session_id={session_id}, pid={pid}）。");

            // Shell Integration 过滤器：从交互输出流中剥离注入的 OSC 133/633 标记（Batch 1 丢弃
            // 标记，保持现有可视输出不变）。跨多次 read 维护状态，正确处理被切分的转义序列。
            let mut shell_filter = super::shell_integration::ShellIntegrationFilter::new();
            let mut decoder = LocalWslUtf8ChunkDecoder::default();
            let mut buffer = [0u8; TERMINAL_READ_BUFFER_BYTES];
            // 攒批缓冲：多次 read 的解码结果先累加在这里，按启发式决定何时发事件。
            let mut pending_out = String::new();
            // 读线程因读取错误（而非正常 EOF）退出时记于此：底层 wsl.exe 可能仍存活，
            // 需在 wait 前主动 kill，避免 child.wait() 永久阻塞、拖死关闭事件并遗留孤儿。
            let mut read_error: Option<std::io::Error> = None;
            loop {
                // P2 背压：读下一批前先等待「可写」（未确认字符超高水位时在此阻塞）；
                // 不读即使 OS 管道缓冲填满，ConPTY 随之对 WSL 侧自然回压。flow 为 None 时为空操作。
                if let Some(flow) = &flow {
                    flow.wait_until_writable();
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        decoder.decode_into(&buffer[..read], &mut pending_out, false);
                        if should_flush_terminal_output(pending_out.len(), read, buffer.len()) {
                            let chunk = std::mem::take(&mut pending_out);
                            let (clean, marks) = shell_filter.filter(&chunk);
                            // 先把本批解析出的 OSC 133/633 标记上抛（clean 为空时标记也不能丢）。
                            for mark in marks {
                                on_event(LocalWslTerminalServerPayload::Mark(
                                    LocalWslTerminalInteractiveMark { mark },
                                ));
                            }
                            if clean.is_empty() {
                                continue;
                            }
                            // 记录已发往前端的字符数（UTF-16 码元，与前端 ack 同尺）。
                            if let Some(flow) = &flow {
                                flow.record_produced(utf16_len(&clean));
                            }
                            on_event(LocalWslTerminalServerPayload::Data(
                                LocalWslTerminalInteractiveData { data: clean },
                            ));
                        }
                    }
                    Err(error) => {
                        read_error = Some(error);
                        break;
                    }
                }
            }

            // 收尾：补全解码器残尾，并把最后攒批的输出一次性发出。
            decoder.decode_into(&[], &mut pending_out, true);
            let (mut tail, tail_marks) = shell_filter.filter(&std::mem::take(&mut pending_out));
            for mark in tail_marks {
                on_event(LocalWslTerminalServerPayload::Mark(
                    LocalWslTerminalInteractiveMark { mark },
                ));
            }
            tail.push_str(&shell_filter.flush_remaining());
            if !tail.is_empty() {
                if let Some(flow) = &flow {
                    flow.record_produced(utf16_len(&tail));
                }
                on_event(LocalWslTerminalServerPayload::Data(
                    LocalWslTerminalInteractiveData { data: tail },
                ));
            }

            // 读取错误退出：先终止可能仍存活的子进程，保证 child.wait() 有界返回、不留孤儿 wsl.exe。
            let exit_reason = if read_error.is_some() { "读取错误" } else { "EOF" };
            if let Some(error) = read_error {
                log::warn!(
                    "WSL 交互终端读线程因读取错误退出（session_id={session_id}）：{error}；强制终止子进程以避免阻塞与孤儿。"
                );
                let _ = child.clone_killer().kill();
            }
            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            // 标记交互 shell 已收尾：关闭看门狗据此（is_finished）确证读线程已正常退出；
            // 若上方 child.wait() 因 wsl.exe 卡死而永久阻塞，则此标志不会置位，看门狗将升级回收。
            finished.store(true, Ordering::SeqCst);
            log::debug!(
                "WSL 交互终端读线程退出（session_id={session_id}, 原因={exit_reason}, exit_code={exit_code:?}）。"
            );
            // 在 session_id 被移入关闭事件前算出集成脚本路径，供事件发出后清理（不阻塞关闭通知）。
            let integration_script_path = shell_integration_script_path(&session_id);
            on_event(LocalWslTerminalServerPayload::Closed(
                LocalWslTerminalInteractiveClosed { exit_code },
            ));
            // 关闭事件已发出后再清理遗留的集成脚本；覆盖正常退出 / kill / 看门狗各路径。
            if let Err(error) = cleanup_wsl_script(&integration_script_path) {
                log::warn!("清理 WSL Shell Integration 集成脚本失败：{error}");
            }
        })
        .map(|_| ())
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))
}

/// 判断是否应把已攒批的输出立即作为一个事件发出。
///
/// 启发式：当本次 read 读满了整个缓冲（`last_read == buffer_len`）时，说明管道仍处于
/// 饱和突发中，继续攒批以减少 IPC 次数；一旦某次 read 未读满（突发已排空，常见于交互
/// 单字符回显），立即 flush 以保证低延迟。攒批超过阈值也会强制 flush，避免无界增长。
fn should_flush_terminal_output(pending_len: usize, last_read: usize, buffer_len: usize) -> bool {
    if pending_len == 0 {
        return false;
    }
    let saturated = last_read == buffer_len;
    !saturated || pending_len >= TERMINAL_OUTPUT_COALESCE_BYTES
}

/// 在 `timeout` 内等待子进程结束（基于 wait-timeout，内核事件驱动，无忙等轮询）：
/// 正常结束返回 `Ok(Some(status))`；超时返回 `Ok(None)`（并已 kill + 回收子进程）；
/// 等待自身出错返回 `Err`。用于给同步 wsl.exe 调用加超时兜底，防止 WSL 挂起时永久阻塞。
fn wait_child_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    match child.wait_timeout(timeout)? {
        Some(status) => Ok(Some(status)),
        None => {
            // 超时：终止挂起的子进程并回收句柄，避免遗留僵尸 / 孤儿。
            let _ = child.kill();
            let _ = child.wait();
            Ok(None)
        }
    }
}

/// 把脚本内容写入 WSL 侧的 execution_path（通过 `bash -c 'cat > <path>'` + stdin）。
pub(crate) fn materialize_wsl_script(
    execution_path: &str,
    content: &str,
) -> Result<(), LocalWslPtyError> {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .arg("--")
        .arg("bash")
        .arg("-c")
        .arg(format!("cat > {}", bash_quote(execution_path)))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .env("WSL_UTF8", "1");
    crate::commands::configure_std_command_for_background(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| LocalWslPtyError::Open(format!("写入临时脚本失败：{error}")))?;
    if let Some(mut stdin) = child.stdin.take()
        && let Err(error) = stdin.write_all(content.as_bytes())
    {
        // 写 stdin 失败时主动终止子进程，避免遗留挂起的 wsl.exe。
        let _ = child.kill();
        let _ = child.wait();
        return Err(LocalWslPtyError::Open(format!("写入临时脚本失败：{error}")));
    }

    // 加超时兜底：stdin 已关闭，cat 应迅速结束；若 wsl.exe 挂起则不应永久阻塞命令线程。
    let status = match wait_child_with_timeout(&mut child, WSL_SYNC_COMMAND_TIMEOUT) {
        Ok(Some(status)) => status,
        Ok(None) => {
            return Err(LocalWslPtyError::Open(format!(
                "写入临时脚本超时（{} 秒），已终止挂起的 wsl.exe。",
                WSL_SYNC_COMMAND_TIMEOUT.as_secs()
            )));
        }
        Err(error) => {
            return Err(LocalWslPtyError::Open(format!("写入临时脚本失败：{error}")));
        }
    };
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut handle) = child.stderr.take() {
            let _ = handle.read_to_string(&mut stderr);
        }
        return Err(LocalWslPtyError::Open(format!(
            "写入临时脚本失败：{}",
            stderr.trim()
        )));
    }
    Ok(())
}

/// 清理某会话遗留在 WSL 侧的 Shell Integration 集成脚本（在读线程收尾、交互 shell 结束后调用）。
/// 通过 wsl.exe 执行 bash 的 rm -f 删除；尽力而为，失败仅记录告警，不影响关闭流程。
fn cleanup_wsl_script(execution_path: &str) -> Result<(), LocalWslPtyError> {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .arg("--")
        .arg("bash")
        .arg("-c")
        .arg(format!("rm -f {}", bash_quote(execution_path)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("WSL_UTF8", "1");
    crate::commands::configure_std_command_for_background(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| LocalWslPtyError::Close(format!("清理集成脚本失败：{error}")))?;
    match wait_child_with_timeout(&mut child, WSL_SYNC_COMMAND_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(error) => Err(LocalWslPtyError::Close(format!(
            "清理集成脚本失败：{error}"
        ))),
    }
}

/// 在独立线程上回收一批 WSL `/tmp` 临时脚本（脚本运行结束 / 派发失败回滚时调用）。
///
/// 必须 fire-and-forget：清理走 wsl.exe，最坏受 WSL_SYNC_COMMAND_TIMEOUT 约束可达数秒，绝不能
/// 在交互读线程 / 事件回调线程上同步执行，否则会阻塞实时输出管道。空列表为安全 no-op。
pub(crate) fn spawn_wsl_script_cleanup(paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let spawn_result = std::thread::Builder::new()
        .name("wsl-script-cleanup".to_string())
        .spawn(move || {
            for path in paths {
                if let Err(error) = cleanup_wsl_script(&path) {
                    log::warn!("清理 WSL 临时运行脚本失败（path={path}）：{error}");
                }
            }
        });
    if let Err(error) = spawn_result {
        log::warn!("WSL 临时运行脚本清理线程创建失败：{error}");
    }
}

/// resize 合批工作线程：拥有该会话的 MasterPty，串行化所有 resize，并在静默窗口内合并一串快速
/// resize，仅把最后一次尺寸应用到 ConPTY。句柄及其所有克隆释放（发送端全部 drop、通道断开）后
/// 线程自动退出。对照 VSCode terminalProcess.ts 的 DelayedResizer 合并快速 resize 的思路。
fn spawn_resize_worker(
    session_id: String,
    master: Box<dyn MasterPty + Send>,
    resize_rx: Receiver<(u16, u16)>,
) {
    // 把 session_id 克隆给合批线程闭包持有；原值留给下方 spawn 失败时的告警日志，
    // 避免「move 进闭包后又借用」(E0382)。
    let worker_session_id = session_id.clone();
    let spawn_result = std::thread::Builder::new()
        .name(format!("wsl-pty-resize-{session_id}"))
        .spawn(move || {
            let session_id = worker_session_id;
            // 阻塞等待第一条 resize；所有发送端释放后通道断开，recv 返回 Err，线程退出。
            while let Ok(mut latest) = resize_rx.recv() {
                // 合批：静默窗口内持续吸收后续 resize，只保留最后一次；窗口内无新 resize 即安定。
                loop {
                    match resize_rx.recv_timeout(TERMINAL_RESIZE_DEBOUNCE) {
                        Ok(next) => latest = next,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            apply_pty_resize(&session_id, &*master, latest);
                            return;
                        }
                    }
                }
                apply_pty_resize(&session_id, &*master, latest);
            }
        });
    if let Err(error) = spawn_result {
        // 合批线程创建失败极罕见（资源耗尽）；此时通道无接收端，后续 resize 的 send 将返回错误，
        // 由命令层按尽力而为处理，不阻断会话创建。
        log::warn!("WSL 交互终端 resize 合批线程创建失败（session_id={session_id}）：{error}");
    }
}

/// 把一次尺寸应用到底层 ConPTY；失败仅记录告警（resize 为尽力而为，不应阻断交互）。
fn apply_pty_resize(session_id: &str, master: &(dyn MasterPty + Send), size: (u16, u16)) {
    let (cols, rows) = size;
    match master.resize(PtySize {
        rows: rows.max(1),
        cols: cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(()) => log::trace!(
            "WSL 交互终端尺寸已应用（session_id={session_id}, cols={cols}, rows={rows}）。"
        ),
        Err(error) => {
            log::warn!("WSL 交互终端调整尺寸失败（session_id={session_id}）：{error}")
        }
    }
}

/// 集成脚本在 WSL 侧的落地路径：每会话唯一，避免并发写入同一文件造成截断竞争。
/// （会话结束后由读线程收尾时调用 cleanup_wsl_script 主动清理；位于 /tmp，按系统惯例回收。）
fn shell_integration_script_path(session_id: &str) -> String {
    let sanitized: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("/tmp/calamex-shell-integration-{sanitized}.bash")
}

fn normalize_interactive_cwd(working_directory: &str) -> String {
    let trimmed = working_directory.trim();
    if trimmed.is_empty() {
        "~".to_string()
    } else {
        trimmed.to_string()
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn interactive_cwd_defaults_to_home_when_blank() {
        assert_eq!(normalize_interactive_cwd("   "), "~");
        assert_eq!(normalize_interactive_cwd(""), "~");
    }

    #[test]
    fn interactive_cwd_preserves_explicit_directory() {
        assert_eq!(
            normalize_interactive_cwd("/mnt/d/com.xiaojianc/my_desktop_app"),
            "/mnt/d/com.xiaojianc/my_desktop_app"
        );
    }


    #[test]
    fn coalesces_while_saturated_and_flushes_on_drain() {
        let buf = TERMINAL_READ_BUFFER_BYTES;
        // 攒批为空：不发。
        assert!(!should_flush_terminal_output(0, buf, buf));
        // 饱和（读满）且未达阈值：继续攒批。
        assert!(!should_flush_terminal_output(1024, buf, buf));
        // 饱和但已超过阈值：强制 flush。
        assert!(should_flush_terminal_output(
            TERMINAL_OUTPUT_COALESCE_BYTES,
            buf,
            buf
        ));
        assert!(should_flush_terminal_output(
            TERMINAL_OUTPUT_COALESCE_BYTES + 1,
            buf,
            buf
        ));
        // 未读满（突发排空）：立即 flush，保证交互低延迟。
        assert!(should_flush_terminal_output(1, buf - 1, buf));
        assert!(should_flush_terminal_output(50, 50, buf));
    }

    #[test]
    fn wait_child_with_timeout_returns_status_for_fast_process() {
        let mut command = fast_exit_command();
        let mut child = command.spawn().expect("应能启动快速退出的子进程");
        let status =
            wait_child_with_timeout(&mut child, Duration::from_secs(5)).expect("等待不应出错");
        assert!(matches!(status, Some(code) if code.success()));
    }

    #[test]
    fn wait_child_with_timeout_kills_overrunning_process() {
        let mut command = long_sleep_command();
        let mut child = command.spawn().expect("应能启动长时间运行的子进程");
        let started = Instant::now();
        let status =
            wait_child_with_timeout(&mut child, Duration::from_millis(200)).expect("等待不应出错");
        assert!(status.is_none(), "超时应返回 None 并已 kill 子进程");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "超时后应迅速返回，而不是等待子进程自然结束"
        );
    }

    #[cfg(windows)]
    fn fast_exit_command() -> std::process::Command {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "exit 0"]);
        command
    }

    #[cfg(not(windows))]
    fn fast_exit_command() -> std::process::Command {
        std::process::Command::new("true")
    }

    #[cfg(windows)]
    fn long_sleep_command() -> std::process::Command {
        let mut command = std::process::Command::new("cmd");
        // ping 作为可移植 sleep：-n 30 约 29 秒，足以触发 200ms 超时。
        command.args(["/C", "ping 127.0.0.1 -n 30 >nul"]);
        command
    }

    #[cfg(not(windows))]
    fn long_sleep_command() -> std::process::Command {
        let mut command = std::process::Command::new("sleep");
        command.arg("30");
        command
    }
}
