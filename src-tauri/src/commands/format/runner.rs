//! External formatter 子进程执行：stdin 进 / stdout 出，失败回传 stderr。
//!
//! 范式对齐 shell_tools::run_shfmt：tokio `Command` + `kill_on_drop`（超时分支
//! drop child 时一并终止，避免孤儿进程）+ `configure_tokio_command_for_background`
//!（Windows 不弹控制台窗口）+ 统一超时。

use std::{process::Stdio, time::Duration};

use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

use super::registry::ResolvedFormatter;
use crate::commands::configure_tokio_command_for_background;

const FORMAT_TIMEOUT: Duration = Duration::from_secs(12);

pub(crate) async fn run_external_formatter(
    formatter: &ResolvedFormatter,
    content: &str,
) -> Result<String, String> {
    let mut command = Command::new(&formatter.executable);
    configure_tokio_command_for_background(&mut command);
    command.kill_on_drop(true);
    command.args(&formatter.args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {} 失败：{error}", formatter.id))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|error| format!("写入 {} 输入失败：{error}", formatter.id))?;
        stdin
            .shutdown()
            .await
            .map_err(|error| format!("关闭 {} 输入失败：{error}", formatter.id))?;
    }

    let output = match timeout(FORMAT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("运行 {} 失败：{error}", formatter.id)),
        Err(_) => {
            return Err(format!(
                "{} 格式化超时（超过 {} 秒）。",
                formatter.id,
                FORMAT_TIMEOUT.as_secs()
            ));
        }
    };

    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map_err(|error| format!("解析 {} 输出失败：{error}", formatter.id));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err(format!("{} 执行失败。", formatter.id));
    }

    Err(format!("{} 执行失败：{stderr}", formatter.id))
}
