use std::{
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::commands::configure_std_command_for_background;

const WSL_TEMP_DIRECTORY: &str = "/tmp";
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// 将 Windows 路径中的扩展路径前缀归一化为常规本地路径。
pub fn normalize_windows_path_for_wsl(value: &str) -> Result<String, String> {
    if let Some(network_path) = value.strip_prefix("\\\\?\\UNC\\") {
        return Err(format!(
            "暂不支持将网络共享路径转换为 WSL 路径：\\\\{}",
            network_path
        ));
    }

    if let Some(extended_path) = value.strip_prefix("\\\\?\\") {
        return Ok(extended_path.to_string());
    }

    Ok(value.to_string())
}

/// 将 Windows 本地磁盘路径转换为 WSL `/mnt/<drive>/...` 路径。
pub fn to_wsl_path(path: &Path) -> Result<String, String> {
    let normalized = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();

    let normalized = normalize_windows_path_for_wsl(&normalized)?;

    let drive_letter = normalized
        .chars()
        .next()
        .ok_or_else(|| "无法识别 Windows 路径。".to_string())?;

    if !drive_letter.is_ascii_alphabetic() || !normalized.contains(':') {
        return Err("仅支持 Windows 本地磁盘路径转换为 WSL 路径。".into());
    }

    let rest = normalized
        .get(2..)
        .ok_or_else(|| "Windows 路径格式无效。".to_string())?;

    Ok(format!(
        "/mnt/{}/{}",
        drive_letter.to_ascii_lowercase(),
        rest.replace('\\', "/").trim_start_matches('/'),
    ))
}

/// 对即将插入 bash 命令行的字符串做单引号转义。
pub fn bash_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// 构造跨命令共享的临时文件后缀，包含微秒时间戳与进程内递增序列。
pub(crate) fn build_temp_file_suffix() -> Result<String, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_micros();
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);

    Ok(format!("{stamp}-{sequence}"))
}

/// 基于原始文件名构造 WSL `/tmp` 下的临时脚本路径。
pub(crate) fn build_terminal_temp_script_path(original_name: &str) -> Result<String, String> {
    let suffix = build_temp_file_suffix()?;
    let stem = Path::new(original_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("untitled");

    Ok(format!("{WSL_TEMP_DIRECTORY}/{stem}-{suffix}.tmp.sh"))
}

/// 通过 WSL stdin 安全写入文件并设置为仅当前用户可读写。
pub fn write_wsl_file(wsl_command_path: PathBuf, path: &str, content: &[u8]) -> Result<(), String> {
    let shell_command = format!(
        "umask 077 && cat > {} && chmod 600 {}",
        bash_quote(path),
        bash_quote(path),
    );
    let mut command = StdCommand::new(wsl_command_path);
    configure_std_command_for_background(&mut command);
    command
        .args(["--", "sh", "-lc", &shell_command])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("写入 WSL 临时文件失败：{error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "WSL 写入通道不可用。".to_string())?;
    std::io::Write::write_all(&mut stdin, content)
        .map_err(|error| format!("写入 WSL 临时文件失败：{error}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 WSL 临时文件写入完成失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err("写入 WSL 临时文件失败。".into())
    } else {
        Err(format!("写入 WSL 临时文件失败：{stderr}"))
    }
}
