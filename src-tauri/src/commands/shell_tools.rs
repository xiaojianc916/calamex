use super::{
    FormatScriptPayload, FormatScriptRequest, configure_std_command_for_background,
    configure_tokio_command_for_background, count_to_u32,
};
use std::{
    env,
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

const SHFMT_TIMEOUT: Duration = Duration::from_secs(12);

struct ShfmtCandidate {
    executable: PathBuf,
    use_wsl: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn format_script(payload: FormatScriptRequest) -> Result<FormatScriptPayload, String> {
    // resolve_shfmt_candidate 在 WSL 兜底分支会同步执行 `wsl.exe -- shfmt --version`，
    // 阻塞调用线程（WSL 冷启动可能数秒）。放进 spawn_blocking 避免阻塞 tokio worker。
    let shfmt = tokio::task::spawn_blocking(resolve_shfmt_candidate)
        .await
        .map_err(|error| format!("探测 shfmt 失败：{error}"))?;
    let Some(shfmt) = shfmt else {
        return Err(
            "未检测到可用的 shfmt，请先在 Windows 或 WSL 中安装 shfmt，或配置 SHFMT_BIN。".into(),
        );
    };

    if payload.content.trim().is_empty() {
        return Ok(FormatScriptPayload {
            line_count: count_to_u32(super::line_count(&payload.content), "脚本行数")?,
            char_count: count_to_u32(payload.content.chars().count(), "脚本字符数")?,
            content: payload.content,
            encoding: payload.encoding,
        });
    }

    let formatted = run_shfmt(&shfmt, &payload.content, payload.path.as_deref()).await?;

    Ok(FormatScriptPayload {
        line_count: count_to_u32(super::line_count(&formatted), "脚本行数")?,
        char_count: count_to_u32(formatted.chars().count(), "脚本字符数")?,
        content: formatted,
        encoding: payload.encoding,
    })
}

/// 候选「随包资源」根目录：打包后用于定位安装目录内自带的运行时 / 二进制。
/// 解析策略统一为「随包优先 → 系统兜底」。开发模式 (`tauri dev`) 下这些目录
/// 通常不存在，候选会被 is_file() 过滤掉，因此对开发流程无副作用。
///
/// 同时供 builtin_agent 复用以定位随包的 builtin-agent 与 Node 运行时，
/// 确保打包侧 (prepare-bundle-resources.ts) 与运行时侧的产物布局契约一致。
pub(crate) fn bundled_resource_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = env::current_exe()
        && let Some(dir) = exe.parent()
    {
        roots.push(dir.join("resources-bundle"));
        roots.push(dir.join("resources").join("resources-bundle"));
        roots.push(dir.to_path_buf());
    }
    roots
}

fn resolve_shfmt_candidate() -> Option<ShfmtCandidate> {
    if let Some(configured_path) = env::var_os("SHFMT_BIN") {
        let executable = PathBuf::from(configured_path);
        if executable.exists() {
            return Some(ShfmtCandidate {
                executable,
                use_wsl: false,
            });
        }
    }

    let shfmt_command = if cfg!(windows) { "shfmt.exe" } else { "shfmt" };

    // 打包优先：安装目录内自带的 shfmt。
    for root in bundled_resource_roots() {
        let bundled = root.join(shfmt_command);
        if bundled.is_file() {
            return Some(ShfmtCandidate {
                executable: bundled,
                use_wsl: false,
            });
        }
    }

    if let Some(system_binary) = super::find_command_path(shfmt_command, &[]) {
        return Some(ShfmtCandidate {
            executable: system_binary,
            use_wsl: false,
        });
    }

    let wsl_path = super::find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"])?;
    let mut command = StdCommand::new(&wsl_path);
    configure_std_command_for_background(&mut command);
    if command
        .args(["--", "shfmt", "--version"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .is_some_and(|status| status.success())
    {
        return Some(ShfmtCandidate {
            executable: wsl_path,
            use_wsl: true,
        });
    }

    None
}

async fn run_shfmt(
    candidate: &ShfmtCandidate,
    content: &str,
    _path: Option<&str>,
) -> Result<String, String> {
    let mut command = Command::new(&candidate.executable);
    configure_tokio_command_for_background(&mut command);
    // 超时分支会 drop 掉 wait_with_output() 的 future，从而 drop 掉 child。
    // tokio 默认不会在 drop 时终止子进程，这里显式开启 kill_on_drop，
    // 避免 shfmt 超时后残留孤儿进程。
    command.kill_on_drop(true);

    if candidate.use_wsl {
        command.args(["--", "shfmt", "-i", "2"]);
    } else {
        command.args(["-i", "2"]);
    }

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 shfmt 失败：{error}"))?;

    // 独立读取 stderr：超时时 wait_with_output 的 future 被 drop，
    // 已缓冲的 stderr 诊断信息会丢失。提前 take stderr 管道由独立任务持续读取，
    // 超时后仍能获得部分诊断输出（如语法错误位置）。
    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    // 使用 std::sync::Mutex 而非 tokio::sync::Mutex：锁仅用于 stderr 缓冲的瞬时读写，
    // 不跨 await 点，持锁时间 < 1µs（extend_from_slice 是同步操作）。
    // tokio::sync::Mutex 会引入不必要的 async 开销和潜在的 await 中断。
    // SAFETY: stderr_reader 线程中的 lock() → extend_from_slice → unlock 是
    // 同步完成的，主线程的 lock() 也是同步的（take + lock 不跨 await）。
    let partial_stderr: Arc<std::sync::Mutex<Vec<u8>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let partial_stderr_clone = partial_stderr.clone();
    let stderr_reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 4096];
        loop {
            match stderr_pipe.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => partial_stderr_clone
                    .lock()
                    .unwrap()
                    .extend_from_slice(&buf[..n]),
            }
        }
    });

    // 并发写 stdin：与排空 stdout 同时进行，避免大脚本触发 stdin/stdout 双向管道死锁。
    let stdin = child.stdin.take();
    let input = content.as_bytes().to_vec();
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            stdin.write_all(&input).await?;
            stdin.shutdown().await?;
        }
        Ok::<(), std::io::Error>(())
    });

    let output = match timeout(SHFMT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(mut output)) => {
            // wait 返回后合并 stderr_reader 已捕获的完整 stderr。
            let _ = stderr_reader.await;
            output.stderr = std::mem::take(&mut *partial_stderr.lock().unwrap());
            output
        }
        Ok(Err(error)) => return Err(format!("运行 shfmt 失败：{error}")),
        Err(_) => {
            // 超时：从 partial_stderr 获取已缓冲的 stderr 内容。
            let stderr_text = String::from_utf8_lossy(&partial_stderr.lock().unwrap())
                .trim()
                .to_string();
            let base = format!("shfmt 格式化超时（超过 {} 秒）。", SHFMT_TIMEOUT.as_secs());
            return Err(if stderr_text.is_empty() {
                base
            } else {
                format!("{base} 部分诊断输出：{stderr_text}")
            });
        }
    };

    // 回收写入任务：stdin 写入失败通常是 shfmt 提前退出（解析错误时会关闭 stdin）
    // 的副作用，其 stderr / 退出码才是权威信号；故仅在子进程成功时才追究写入错误。
    match writer.await {
        Ok(Ok(())) => {}
        Ok(Err(write_error)) if output.status.success() => {
            return Err(format!("写入 shfmt 输入失败：{write_error}"));
        }
        Ok(Err(_)) => {}
        Err(join_error) => return Err(format!("shfmt 输入任务异常退出：{join_error}")),
    }

    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map_err(|error| format!("解析 shfmt 输出失败：{error}"));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err("shfmt 执行失败。".into());
    }

    Err(format!("shfmt 执行失败：{stderr}"))
}
