//! External formatter 子进程执行：stdin 进 / stdout 出，失败回传 stderr。
//!
//! 范式对齐 shell_tools::run_shfmt：tokio `Command` + `kill_on_drop`（超时分支
//! drop child 时一并终止，避免孤儿进程）+ `configure_tokio_command_for_background`
//!（Windows 不弹控制台窗口）+ 统一超时。

use std::{process::Stdio, time::Duration};

use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

use super::error::FormatErrorKind;
use super::registry::ResolvedFormatter;
use crate::commands::configure_tokio_command_for_background;

const FORMAT_TIMEOUT: Duration = Duration::from_secs(12);

pub(crate) async fn run_external_formatter(
    formatter: &ResolvedFormatter,
    content: &str,
) -> Result<String, FormatErrorKind> {
    let mut command = Command::new(&formatter.executable);
    configure_tokio_command_for_background(&mut command);
    command.kill_on_drop(true);
    command.args(&formatter.args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| FormatErrorKind::SpawnFailed {
        formatter: formatter.id.to_string(),
        message: error.to_string(),
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|error| FormatErrorKind::StdinFailed {
                formatter: formatter.id.to_string(),
                message: error.to_string(),
            })?;
        stdin
            .shutdown()
            .await
            .map_err(|error| FormatErrorKind::StdinFailed {
                formatter: formatter.id.to_string(),
                message: error.to_string(),
            })?;
    }

    let output = match timeout(FORMAT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Err(FormatErrorKind::RunFailed {
                formatter: formatter.id.to_string(),
                message: error.to_string(),
            });
        }
        Err(_) => {
            return Err(FormatErrorKind::Timeout {
                formatter: formatter.id.to_string(),
                timeout_secs: FORMAT_TIMEOUT.as_secs(),
            });
        }
    };

    if output.status.success() {
        return String::from_utf8(output.stdout).map_err(|error| FormatErrorKind::OutputNotUtf8 {
            formatter: formatter.id.to_string(),
            message: error.to_string(),
        });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err(FormatErrorKind::FormatterFailedSilent {
            formatter: formatter.id.to_string(),
        });
    }

    Err(FormatErrorKind::FormatterFailed {
        formatter: formatter.id.to_string(),
        stderr,
    })
}
