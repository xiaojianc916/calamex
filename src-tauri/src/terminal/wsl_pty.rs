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
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use thiserror::Error;

use super::local_wsl_protocol::{
    LocalWslTerminalInteractiveClosed, LocalWslTerminalInteractiveData,
    LocalWslTerminalInteractiveOpened, LocalWslTerminalOpenInteractiveRequest,
    LocalWslTerminalRunChunk, LocalWslTerminalRunCompleted, LocalWslTerminalRunScriptRequest,
    LocalWslTerminalRunStarted, LocalWslTerminalServerPayload, LocalWslUtf8ChunkDecoder,
    SIGNAL_MODE_KILL,
};
use super::wsl::bash_quote;

const TERMINAL_READ_BUFFER_BYTES: usize = 8192;

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
/// on_event 在独立读线程中被调用，事件序列与 WSL Link 路径一致：
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

            let mut decoder = LocalWslUtf8ChunkDecoder::default();
            let mut buffer = [0u8; TERMINAL_READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let mut decoded = String::new();
                        decoder.decode_into(&buffer[..read], &mut decoded, false);
                        if !decoded.is_empty() {
                            on_event(LocalWslTerminalServerPayload::InteractiveData(
                                LocalWslTerminalInteractiveData {
                                    session_id: session_id.clone(),
                                    data: decoded,
                                },
                            ));
                        }
                    }
                    Err(error) => {
                        log::warn!("WSL 交互终端读线程异常退出（session_id={session_id}）：{error}");
                        break;
                    }
                }
            }

            let mut tail = String::new();
            decoder.decode_into(&[], &mut tail, true);
            if !tail.is_empty() {
                on_event(LocalWslTerminalServerPayload::InteractiveData(
                    LocalWslTerminalInteractiveData {
                        session_id: session_id.clone(),
                        data: tail,
                    },
                ));
            }

            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
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

fn spawn_run_reader<F>(
    run_id: String,
    pid: u32,
    cleanup_paths: Vec<String>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
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

            let mut decoder = LocalWslUtf8ChunkDecoder::default();
            let mut buffer = [0u8; TERMINAL_READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let mut decoded = String::new();
                        decoder.decode_into(&buffer[..read], &mut decoded, false);
                        if !decoded.is_empty() {
                            on_event(LocalWslTerminalServerPayload::RunChunk(
                                LocalWslTerminalRunChunk {
                                    run_id: run_id.clone(),
                                    data: decoded,
                                },
                            ));
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
                on_event(LocalWslTerminalServerPayload::RunChunk(
                    LocalWslTerminalRunChunk {
                        run_id: run_id.clone(),
                        data: tail,
                    },
                ));
            }

            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            cleanup_wsl_paths(&cleanup_paths);
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
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(content.as_bytes()) {
            // 写 stdin 失败时主动终止子进程，避免遗留挂起的 wsl.exe。
            let _ = child.kill();
            return Err(LocalWslPtyError::Open(format!("写入临时脚本失败：{error}")));
        }
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
}
