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
        mpsc::{self, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use thiserror::Error;

use super::local_wsl_protocol::{
    LocalWslTerminalInteractiveClosed, LocalWslTerminalInteractiveData,
    LocalWslTerminalInteractiveOpened, LocalWslTerminalOpenInteractiveRequest,
    LocalWslTerminalRunChunk, LocalWslTerminalRunCompleted, LocalWslTerminalRunScriptRequest,
    LocalWslTerminalRunStarted, LocalWslTerminalServerPayload, LocalWslUtf8ChunkDecoder,
    SIGNAL_MODE_KILL,
};
use super::wsl::bash_quote;

// 读缓冲：单次 read 的字节上限。配合下游输出合并，调大可减少高吞吐时的 read 次数。
const TERMINAL_READ_BUFFER_BYTES: usize = 65536;

/// 输出合并时间窗：读线程产生的高频小块输出在该时间窗内聚合为一条事件再发往前端，
/// 显著降低跨 WebView 的 IPC 序列化 / 事件回调次数。8ms 远小于一帧（16ms），交互回显无可感延迟。
const TERMINAL_OUTPUT_COALESCE_WINDOW: Duration = Duration::from_millis(8);

/// 合并缓冲的字节上限：达到即立即冲洗，避免高吞吐（如 `cat 大文件`）时单条事件无限膨胀。
const TERMINAL_OUTPUT_COALESCE_MAX_BYTES: usize = 256 * 1024;

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
}

impl LocalWslRunHandle {
    pub fn run_id(&self) -> &str {
        &self.run_id
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

/// 合并线程的入站消息：数据块会被聚合，生命周期等非数据事件原样透传并保持顺序。
enum CoalescerMessage {
    Data(String),
    Passthrough(LocalWslTerminalServerPayload),
}

/// 启动一个输出合并线程，返回向其投递消息的发送端。
///
/// 读线程只负责 `read + 解码 + 投递`，真正的 `on_event`（含 Tauri 事件发射）在合并线程内执行：
/// 把同一时间窗内的多次小块输出聚合成一条，从根上减少跨 WebView 的 IPC 事件数量。
fn spawn_output_coalescer<F, W>(
    thread_name: String,
    on_event: F,
    wrap_data: W,
) -> Result<Sender<CoalescerMessage>, LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
    W: Fn(String) -> LocalWslTerminalServerPayload + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<CoalescerMessage>();
    std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || run_output_coalescer(rx, on_event, wrap_data))
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))?;
    Ok(tx)
}

/// 合并主循环：阻塞等待首条消息（空闲时不轮询），随后在一个时间窗内尽量聚合相邻数据块；
/// 遇到非数据事件先冲洗已聚合数据再原样发射，严格保持事件顺序。
fn run_output_coalescer<F, W>(rx: mpsc::Receiver<CoalescerMessage>, mut on_event: F, wrap_data: W)
where
    F: FnMut(LocalWslTerminalServerPayload),
    W: Fn(String) -> LocalWslTerminalServerPayload,
{
    'outer: loop {
        let mut pending = match rx.recv() {
            Ok(CoalescerMessage::Data(text)) => text,
            Ok(CoalescerMessage::Passthrough(payload)) => {
                on_event(payload);
                continue 'outer;
            }
            // 发送端（读线程）已结束，正常退出。
            Err(_) => return,
        };

        let deadline = Instant::now() + TERMINAL_OUTPUT_COALESCE_WINDOW;
        loop {
            if pending.len() >= TERMINAL_OUTPUT_COALESCE_MAX_BYTES {
                break;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            match rx.recv_timeout(remaining) {
                Ok(CoalescerMessage::Data(text)) => pending.push_str(&text),
                Ok(CoalescerMessage::Passthrough(payload)) => {
                    if !pending.is_empty() {
                        on_event(wrap_data(std::mem::take(&mut pending)));
                    }
                    on_event(payload);
                    continue 'outer;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    if !pending.is_empty() {
                        on_event(wrap_data(pending));
                    }
                    return;
                }
            }
        }

        if !pending.is_empty() {
            on_event(wrap_data(pending));
        }
    }
}

/// 打开一个本地 PTY 交互式 WSL2 终端。
///
/// on_event 在独立合并线程中被调用，事件序列与 WSL Link 路径一致：
/// InteractiveOpened → 若干 InteractiveData → InteractiveClosed。
pub fn open_interactive_terminal_local<F>(
    request: LocalWslTerminalOpenInteractiveRequest,
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
    })
}

/// 在本地 PTY 中运行一个脚本。
///
/// on_event 在独立合并线程中被调用，事件序列与 WSL Link 路径一致：
/// RunStarted → 若干 RunChunk → RunCompleted。
pub fn run_terminal_script_local<F>(
    request: LocalWslTerminalRunScriptRequest,
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

    spawn_run_reader(
        run_id.clone(),
        pid,
        cleanup_paths.clone(),
        reader,
        child,
        pair.master,
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
    })
}

fn spawn_interactive_reader<F>(
    session_id: String,
    working_directory: String,
    pid: u32,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    on_event: F,
) -> Result<(), LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    let wrap_session_id = session_id.clone();
    let tx = spawn_output_coalescer(
        format!("wsl-pty-coalesce-{session_id}"),
        on_event,
        move |data| {
            LocalWslTerminalServerPayload::InteractiveData(LocalWslTerminalInteractiveData {
                session_id: wrap_session_id.clone(),
                data,
            })
        },
    )?;

    std::thread::Builder::new()
        .name(format!("wsl-pty-{session_id}"))
        .spawn(move || {
            let _ = tx.send(CoalescerMessage::Passthrough(
                LocalWslTerminalServerPayload::InteractiveOpened(
                    LocalWslTerminalInteractiveOpened {
                        session_id: session_id.clone(),
                        cwd: working_directory,
                        pid,
                        opened_at_unix_ms: now_unix_ms(),
                    },
                ),
            ));

            let mut decoder = LocalWslUtf8ChunkDecoder::default();
            let mut buffer = [0u8; TERMINAL_READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let mut decoded = String::new();
                        decoder.decode_into(&buffer[..read], &mut decoded, false);
                        if !decoded.is_empty()
                            && tx.send(CoalescerMessage::Data(decoded)).is_err()
                        {
                            // 合并线程已退出，无人消费，提前结束读循环。
                            break;
                        }
                    }
                    Err(error) => {
                        log::warn!(
                            "WSL 交互终端读线程异常退出（session_id={session_id}）：{error}"
                        );
                        break;
                    }
                }
            }

            let mut tail = String::new();
            decoder.decode_into(&[], &mut tail, true);
            if !tail.is_empty() {
                let _ = tx.send(CoalescerMessage::Data(tail));
            }

            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            let _ = tx.send(CoalescerMessage::Passthrough(
                LocalWslTerminalServerPayload::InteractiveClosed(
                    LocalWslTerminalInteractiveClosed {
                        session_id,
                        exit_code,
                        finished_at_unix_ms: now_unix_ms(),
                    },
                ),
            ));
            // tx 在此随线程结束被 drop，合并线程收到 Disconnected 后冲洗剩余数据并退出。
        })
        .map(|_| ())
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))
}

fn spawn_run_reader<F>(
    run_id: String,
    pid: u32,
    cleanup_paths: Vec<String>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    on_event: F,
) -> Result<(), LocalWslPtyError>
where
    F: FnMut(LocalWslTerminalServerPayload) + Send + 'static,
{
    let wrap_run_id = run_id.clone();
    let tx = spawn_output_coalescer(
        format!("wsl-run-coalesce-{run_id}"),
        on_event,
        move |data| {
            LocalWslTerminalServerPayload::RunChunk(LocalWslTerminalRunChunk {
                run_id: wrap_run_id.clone(),
                data,
            })
        },
    )?;

    std::thread::Builder::new()
        .name(format!("wsl-run-{run_id}"))
        .spawn(move || {
            // master 在本线程内保活，确保运行期间 stdin/输出通道有效；运行结束后随线程释放。
            let _master = master;
            let _ = tx.send(CoalescerMessage::Passthrough(
                LocalWslTerminalServerPayload::RunStarted(LocalWslTerminalRunStarted {
                    run_id: run_id.clone(),
                    pid,
                    started_at_unix_ms: now_unix_ms(),
                }),
            ));

            let mut decoder = LocalWslUtf8ChunkDecoder::default();
            let mut buffer = [0u8; TERMINAL_READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let mut decoded = String::new();
                        decoder.decode_into(&buffer[..read], &mut decoded, false);
                        if !decoded.is_empty()
                            && tx.send(CoalescerMessage::Data(decoded)).is_err()
                        {
                            // 合并线程已退出，无人消费，提前结束读循环。
                            break;
                        }
                    }
                    Err(error) => {
                        log::warn!("WSL 运行任务读线程异常退出（run_id={run_id}）：{error}");
                        break;
                    }
                }
            }

            let mut tail = String::new();
            decoder.decode_into(&[], &mut tail, true);
            if !tail.is_empty() {
                let _ = tx.send(CoalescerMessage::Data(tail));
            }

            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            cleanup_wsl_paths(&cleanup_paths);
            let _ = tx.send(CoalescerMessage::Passthrough(
                LocalWslTerminalServerPayload::RunCompleted(LocalWslTerminalRunCompleted {
                    run_id,
                    exit_code,
                    finished_at_unix_ms: now_unix_ms(),
                }),
            ));
            // tx 在此随线程结束被 drop，合并线程收到 Disconnected 后冲洗剩余数据并退出。
        })
        .map(|_| ())
        .map_err(|error| LocalWslPtyError::Open(error.to_string()))
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
        return Err(LocalWslPtyError::Open(format!("写入临时脚本失败：{error}")));
    }
    let output = child
        .wait_with_output()
        .map_err(|error| LocalWslPtyError::Open(format!("写入临时脚本失败：{error}")))?;
    if !output.status.success() {
        return Err(LocalWslPtyError::Open(format!(
            "写入临时脚本失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
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
    let _ = command.status();
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
    use std::sync::mpsc::channel;

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

    // 合并器：相邻数据块合并为一条；生命周期事件原样透传并保序；其后的数据块独立成条。
    #[test]
    fn coalescer_merges_adjacent_data_and_preserves_event_order() {
        let (tx, rx) = channel::<CoalescerMessage>();
        tx.send(CoalescerMessage::Data("foo".to_string())).unwrap();
        tx.send(CoalescerMessage::Data("bar".to_string())).unwrap();
        tx.send(CoalescerMessage::Passthrough(
            LocalWslTerminalServerPayload::InteractiveClosed(LocalWslTerminalInteractiveClosed {
                session_id: "s1".to_string(),
                exit_code: Some(0),
                finished_at_unix_ms: 1,
            }),
        ))
        .unwrap();
        tx.send(CoalescerMessage::Data("baz".to_string())).unwrap();
        drop(tx);

        let events = Arc::new(Mutex::new(Vec::<LocalWslTerminalServerPayload>::new()));
        let sink = Arc::clone(&events);
        run_output_coalescer(
            rx,
            move |payload| sink.lock().unwrap().push(payload),
            |data| {
                LocalWslTerminalServerPayload::InteractiveData(LocalWslTerminalInteractiveData {
                    session_id: "s1".to_string(),
                    data,
                })
            },
        );

        let collected = events.lock().unwrap();
        assert_eq!(collected.len(), 3);
        match &collected[0] {
            LocalWslTerminalServerPayload::InteractiveData(data) => {
                assert_eq!(data.data, "foobar");
            }
            _ => panic!("第一条应为合并后的交互数据"),
        }
        assert!(matches!(
            collected[1],
            LocalWslTerminalServerPayload::InteractiveClosed(_)
        ));
        match &collected[2] {
            LocalWslTerminalServerPayload::InteractiveData(data) => {
                assert_eq!(data.data, "baz");
            }
            _ => panic!("第三条应为透传事件后的新数据块"),
        }
    }

    // 合并器：发送端断开前，缓冲中的剩余数据必须被冲洗出去。
    #[test]
    fn coalescer_flushes_pending_data_before_disconnect() {
        let (tx, rx) = channel::<CoalescerMessage>();
        tx.send(CoalescerMessage::Data("only".to_string())).unwrap();
        drop(tx);

        let events = Arc::new(Mutex::new(Vec::<LocalWslTerminalServerPayload>::new()));
        let sink = Arc::clone(&events);
        run_output_coalescer(
            rx,
            move |payload| sink.lock().unwrap().push(payload),
            |data| {
                LocalWslTerminalServerPayload::RunChunk(LocalWslTerminalRunChunk {
                    run_id: "r1".to_string(),
                    data,
                })
            },
        );

        let collected = events.lock().unwrap();
        assert_eq!(collected.len(), 1);
        match &collected[0] {
            LocalWslTerminalServerPayload::RunChunk(chunk) => assert_eq!(chunk.data, "only"),
            _ => panic!("应冲洗出唯一的运行数据块"),
        }
    }
}
