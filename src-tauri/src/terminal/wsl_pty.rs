// 终端域：本地 PTY（Windows 原生 ConPTY）直接驱动 wsl.exe 的交互式 WSL2 终端与脚本运行。
//
// 这是“自研 gRPC supervisor + WSL Link agent”链路的替代实现：不再依赖 vsock /
// gRPC / Noise / 旁路 agent，而是用 portable-pty 在桌面进程内直接拉起 wsl.exe，
// 与 VS Code、Windows Terminal 走同一套官方方案。
//
// 事件类型（LocalWslTerminalServerPayload）、运行/交互请求与 UTF-8 分块解码器定义在
// 同域的 terminal::local_wsl_protocol；命令层与本模块共用这一套类型，不再依赖原 wsl_link 模块。

use std::{
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use thiserror::Error;

use super::flow_control::{FlowController, utf16_len};
use super::local_wsl_protocol::{
    LocalWslTerminalInteractiveClosed, LocalWslTerminalInteractiveData,
    LocalWslTerminalInteractiveOpened, LocalWslTerminalOpenInteractiveRequest,
    LocalWslTerminalRunChunk, LocalWslTerminalRunCompleted, LocalWslTerminalRunScriptRequest,
    LocalWslTerminalRunStarted, LocalWslTerminalServerPayload, LocalWslUtf8ChunkDecoder,
    SIGNAL_MODE_KILL,
};
use super::wsl::bash_quote;

const TERMINAL_READ_BUFFER_BYTES: usize = 8192;

/// 持续高吞吐输出时，把多次 read 的解码结果攒批到该字节阈值再发一次事件，
/// 减少 Tauri IPC 事件数（前端已有 16ms 写入合批，这里在源头做合批）。
const TERMINAL_OUTPUT_COALESCE_BYTES: usize = 32 * 1024;

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

/// 本地 PTY 交互式终端句柄。
///
/// 对外方法签名与原 WslLinkInteractiveTerminalHandle 完全一致（session_id /
/// write_input / resize / close），因此命令层可无差别替换。
#[derive(Clone)]
pub struct LocalWslPtyHandle {
    session_id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    /// 该会话的输出流控器（P2 ack 背压）。close() 时取消，确保读线程不被暂停态卡住、能读到 EOF。
    flow: Option<FlowController>,
}

impl LocalWslPtyHandle {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub async fn write_input(&self, data: String) -> Result<(), LocalWslPtyError> {
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

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), LocalWslPtyError> {
        let master = self
            .master
            .lock()
            .map_err(|_| LocalWslPtyError::Resize("终端尺寸锁已损坏。".to_string()))?;
        master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| LocalWslPtyError::Resize(error.to_string()))
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

/// 本地 PTY 脚本运行句柄：提供运行期 stdin 写入与取消。
#[derive(Clone)]
pub struct LocalWslRunHandle {
    run_id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    /// 读线程在脚本进程结束（child.wait 返回）后置位。供上层在「完成事件未能清理
    /// active_runs」的异常路径下，确证该运行确已结束、可安全回收陈旧条目，
    /// 而不必依赖一定会送达的完成事件。
    finished: Arc<AtomicBool>,
    /// 该运行所属会话的输出流控器（P2 ack 背压）。cancel() 时取消，确保读线程能读到 EOF。
    flow: Option<FlowController>,
}

impl LocalWslRunHandle {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// 底层脚本进程是否已结束（读线程在 child.wait 返回后置位）。
    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    pub async fn write_input(&self, data: String) -> Result<(), LocalWslPtyError> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| LocalWslPtyError::Write("运行任务写入锁已损坏。".to_string()))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| LocalWslPtyError::Write(error.to_string()))?;
        writer
            .flush()
            .map_err(|error| LocalWslPtyError::Write(error.to_string()))
    }

    /// graceful：向 PTY 写入 Ctrl-C(ETX)，由 ConPTY 转成 SIGINT 投递给前台进程组；
    /// kill：直接终止子进程。
    pub fn cancel(&self, mode: &str) -> Result<(), LocalWslPtyError> {
        // 先取消流控：无论 graceful / kill，运行都将走向结束，需解除背压暂停以便读线程读到 EOF。
        if let Some(flow) = &self.flow {
            flow.cancel();
        }
        if mode.trim() == SIGNAL_MODE_KILL {
            let mut killer = self
                .killer
                .lock()
                .map_err(|_| LocalWslPtyError::Close("运行任务终止锁已损坏。".to_string()))?;
            return killer
                .kill()
                .map_err(|error| LocalWslPtyError::Close(error.to_string()));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| LocalWslPtyError::Write("运行任务写入锁已损坏。".to_string()))?;
        writer
            .write_all(b"\x03")
            .map_err(|error| LocalWslPtyError::Write(error.to_string()))?;
        writer
            .flush()
            .map_err(|error| LocalWslPtyError::Write(error.to_string()))
    }
}

/// 打开一个本地 PTY 交互式 WSL2 终端。
///
/// on_event 在独立读线程中被调用，事件序列与 WSL Link 路径一致：
/// InteractiveOpened → 若干 InteractiveData → InteractiveClosed。
pub fn open_interactive_terminal_local<F>(
    request: LocalWslTerminalOpenInteractiveRequest,
    on_event: F,
) -> Result<LocalWslPtyHandle, LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    open_interactive_terminal_local_with_flow(request, None, on_event)
}

/// 同 open_interactive_terminal_local，但接入每会话输出流控器（P2 ack 背压）。
/// flow 为 None 时行为与原函数完全一致（无背压）。
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

    let mut command = CommandBuilder::new("wsl.exe");
    command.arg("--cd");
    command.arg(&working_directory);
    command.arg("--");
    command.arg("bash");
    command.arg("-il");
    // 让 wsl.exe 自身的诊断信息以 UTF-8 输出，根治 UTF-16LE 造成的终端乱码。
    command.env("WSL_UTF8", "1");

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

    spawn_interactive_reader(
        session_id.clone(),
        working_directory,
        pid,
        reader,
        child,
        flow.clone(),
        on_event,
    )
    .inspect_err(|_error| {
        // 读线程创建失败时，child 不会被任何线程接管，主动终止以免遗留孤儿 wsl.exe。
        let _ = cleanup_killer.kill();
    })?;

    Ok(LocalWslPtyHandle {
        session_id,
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
        killer: Arc::new(Mutex::new(killer)),
        flow,
    })
}

/// 在本地 PTY 中运行一个脚本。
///
/// on_event 在独立读线程中被调用，事件序列与 WSL Link 路径一致：
/// RunStarted → 若干 RunChunk → RunCompleted。
pub fn run_terminal_script_local<F>(
    request: LocalWslTerminalRunScriptRequest,
    on_event: F,
) -> Result<LocalWslRunHandle, LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    run_terminal_script_local_with_flow(request, None, on_event)
}

/// 同 run_terminal_script_local，但接入每会话输出流控器（P2 ack 背压）。
/// flow 为 None 时行为与原函数完全一致（无背压）。
pub fn run_terminal_script_local_with_flow<F>(
    request: LocalWslTerminalRunScriptRequest,
    flow: Option<FlowController>,
    on_event: F,
) -> Result<LocalWslRunHandle, LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    request
        .validate()
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))?;

    let run_id = request.run_id.clone();
    let working_directory = normalize_interactive_cwd(&request.working_directory);
    let execution_path = request.execution_path.clone();
    let cleanup_paths = request.cleanup_paths.clone();

    // 行内未保存脚本：先把内容落到 WSL 临时文件，再以 bash <path> 运行。
    if let Some(content) = request.script_content.as_ref() {
        materialize_wsl_script(&execution_path, content)?;
    }

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: request.rows.max(1),
        cols: request.cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => {
            cleanup_wsl_paths(&cleanup_paths);
            return Err(LocalWslPtyError::Open(error.to_string()));
        }
    };

    let mut command = CommandBuilder::new("wsl.exe");
    command.arg("--cd");
    command.arg(&working_directory);
    command.arg("--");
    command.arg("bash");
    command.arg(&execution_path);
    command.env("WSL_UTF8", "1");

    let child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            cleanup_wsl_paths(&cleanup_paths);
            return Err(LocalWslPtyError::Open(error.to_string()));
        }
    };
    drop(pair.slave);

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let mut killer = child.clone_killer();
            let _ = killer.kill();
            cleanup_wsl_paths(&cleanup_paths);
            return Err(LocalWslPtyError::Open(error.to_string()));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let mut killer = child.clone_killer();
            let _ = killer.kill();
            cleanup_wsl_paths(&cleanup_paths);
            return Err(LocalWslPtyError::Open(error.to_string()));
        }
    };
    let killer = child.clone_killer();
    let mut cleanup_killer = child.clone_killer();
    let pid = child.process_id().unwrap_or_default();
    let finished = Arc::new(AtomicBool::new(false));

    spawn_run_reader(
        run_id.clone(),
        pid,
        cleanup_paths.clone(),
        reader,
        child,
        pair.master,
        Arc::clone(&finished),
        flow.clone(),
        on_event,
    )
    .inspect_err(|_error| {
        // 读线程创建失败时，child 不会被任何线程接管，主动终止以免遗留孤儿 wsl.exe。
        let _ = cleanup_killer.kill();
        cleanup_wsl_paths(&cleanup_paths);
    })?;

    Ok(LocalWslRunHandle {
        run_id,
        writer: Arc::new(Mutex::new(writer)),
        killer: Arc::new(Mutex::new(killer)),
        finished,
        flow,
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_interactive_reader<F>(
    session_id: String,
    working_directory: String,
    pid: u32,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    flow: Option<FlowController>,
    mut on_event: F,
) -> Result<(), LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    std::thread::Builder::new()
        .name(format!("wsl-pty-{session_id}"))
        .spawn(move || {
            on_event(LocalWslTerminalServerPayload::InteractiveOpened(
                LocalWslTerminalInteractiveOpened {
                    session_id: session_id.clone(),
                    cwd: working_directory,
                    pid,
                    opened_at_unix_ms: now_unix_ms(),
                },
            ));
            log::debug!("WSL 交互终端读线程已启动（session_id={session_id}, pid={pid}）。");

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
                            // 记录已发往前端的字符数（UTF-16 码元，与前端 ack 同尺）。
                            if let Some(flow) = &flow {
                                flow.record_produced(utf16_len(&chunk));
                            }
                            on_event(LocalWslTerminalServerPayload::InteractiveData(
                                LocalWslTerminalInteractiveData {
                                    session_id: session_id.clone(),
                                    data: chunk,
                                },
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
            if !pending_out.is_empty() {
                let chunk = std::mem::take(&mut pending_out);
                if let Some(flow) = &flow {
                    flow.record_produced(utf16_len(&chunk));
                }
                on_event(LocalWslTerminalServerPayload::InteractiveData(
                    LocalWslTerminalInteractiveData {
                        session_id: session_id.clone(),
                        data: chunk,
                    },
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
            log::debug!(
                "WSL 交互终端读线程退出（session_id={session_id}, 原因={exit_reason}, exit_code={exit_code:?}）。"
            );
            on_event(LocalWslTerminalServerPayload::InteractiveClosed(
                LocalWslTerminalInteractiveClosed {
                    session_id,
                    exit_code,
                    finished_at_unix_ms: now_unix_ms(),
                },
            ));
        })
        .map(|_| ())
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))
}

#[allow(clippy::too_many_arguments)]
fn spawn_run_reader<F>(
    run_id: String,
    pid: u32,
    cleanup_paths: Vec<String>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    finished: Arc<AtomicBool>,
    flow: Option<FlowController>,
    mut on_event: F,
) -> Result<(), LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    std::thread::Builder::new()
        .name(format!("wsl-run-{run_id}"))
        .spawn(move || {
            // master 在本线程内保活，确保运行期间 stdin/输出通道有效；运行结束后随线程释放。
            let _master = master;
            on_event(LocalWslTerminalServerPayload::RunStarted(
                LocalWslTerminalRunStarted {
                    run_id: run_id.clone(),
                    pid,
                    started_at_unix_ms: now_unix_ms(),
                },
            ));
            log::debug!("WSL 运行任务读线程已启动（run_id={run_id}, pid={pid}）。");

            let mut decoder = LocalWslUtf8ChunkDecoder::default();
            let mut buffer = [0u8; TERMINAL_READ_BUFFER_BYTES];
            // 攒批缓冲：多次 read 的解码结果先累加在这里，按启发式决定何时发事件。
            let mut pending_out = String::new();
            // 同交互读线程：记录读取错误退出，以便在 wait 前先 kill。
            let mut read_error: Option<std::io::Error> = None;
            loop {
                // P2 背压：同交互读线程，读下一批前先等待「可写」。flow 为 None 时为空操作。
                if let Some(flow) = &flow {
                    flow.wait_until_writable();
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        decoder.decode_into(&buffer[..read], &mut pending_out, false);
                        if should_flush_terminal_output(pending_out.len(), read, buffer.len()) {
                            let chunk = std::mem::take(&mut pending_out);
                            if let Some(flow) = &flow {
                                flow.record_produced(utf16_len(&chunk));
                            }
                            on_event(LocalWslTerminalServerPayload::RunChunk(
                                LocalWslTerminalRunChunk {
                                    run_id: run_id.clone(),
                                    data: chunk,
                                },
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
            if !pending_out.is_empty() {
                let chunk = std::mem::take(&mut pending_out);
                if let Some(flow) = &flow {
                    flow.record_produced(utf16_len(&chunk));
                }
                on_event(LocalWslTerminalServerPayload::RunChunk(
                    LocalWslTerminalRunChunk {
                        run_id: run_id.clone(),
                        data: chunk,
                    },
                ));
            }

            // 读取错误退出：先终止可能仍存活的子进程，保证 child.wait() 有界返回、不留孤儿 wsl.exe。
            let exit_reason = if read_error.is_some() { "读取错误" } else { "EOF" };
            if let Some(error) = read_error {
                log::warn!(
                    "WSL 运行任务读线程因读取错误退出（run_id={run_id}）：{error}；强制终止子进程以避免阻塞与孤儿。"
                );
                let _ = child.clone_killer().kill();
            }
            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            cleanup_wsl_paths(&cleanup_paths);
            // 标记运行已结束：即便随后的 RunCompleted 完成事件未能让上层清理 active_runs，
            // 上层仍可据此（is_finished）确证该运行确已结束、安全回收陈旧条目。
            finished.store(true, Ordering::SeqCst);
            log::debug!(
                "WSL 运行任务读线程退出（run_id={run_id}, 原因={exit_reason}, exit_code={exit_code:?}）。"
            );
            on_event(LocalWslTerminalServerPayload::RunCompleted(
                LocalWslTerminalRunCompleted {
                    run_id,
                    exit_code,
                    finished_at_unix_ms: now_unix_ms(),
                },
            ));
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

/// 在 `timeout` 内轮询等待子进程结束：
/// 正常结束返回 `Ok(Some(status))`；超时返回 `Ok(None)`（并已 kill + 回收子进程）；
/// 轮询自身出错返回 `Err`。用于给同步 wsl.exe 调用加超时兜底，防止 WSL 挂起时永久阻塞。
fn wait_child_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            // 超时：终止挂起的子进程并回收句柄，避免遗留僵尸 / 孤儿。
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// 把脚本内容写入 WSL 侧的 execution_path（通过 `bash -c 'cat > <path>'` + stdin）。
fn materialize_wsl_script(execution_path: &str, content: &str) -> Result<(), LocalWslPtyError> {
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

/// 运行结束后清理临时文件（失败忽略，不影响运行结果）。
fn cleanup_wsl_paths(paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    let joined = paths
        .iter()
        .map(|path| bash_quote(path))
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = std::process::Command::new("wsl.exe");
    command
        .arg("--")
        .arg("bash")
        .arg("-c")
        .arg(format!("rm -f {joined}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("WSL_UTF8", "1");
    crate::commands::configure_std_command_for_background(&mut command);
    // 加超时兜底：清理用的 wsl.exe 若挂起，不应阻塞调用线程（读线程结束路径）。
    match command.spawn() {
        Ok(mut child) => {
            if let Ok(None) = wait_child_with_timeout(&mut child, WSL_SYNC_COMMAND_TIMEOUT) {
                log::warn!(
                    "清理 WSL 临时文件超时（{} 秒），已终止挂起的 wsl.exe。",
                    WSL_SYNC_COMMAND_TIMEOUT.as_secs()
                );
            }
        }
        Err(error) => {
            log::warn!("清理 WSL 临时文件失败：{error}");
        }
    }
}

fn normalize_interactive_cwd(working_directory: &str) -> String {
    let trimmed = working_directory.trim();
    if trimmed.is_empty() {
        "~".to_string()
    } else {
        trimmed.to_string()
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn now_unix_ms_is_positive() {
        assert!(now_unix_ms() > 0);
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
