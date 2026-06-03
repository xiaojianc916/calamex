use super::{
    configure_std_command_for_background, configure_tokio_command_for_background,
    AnalyzeScriptPayload, AnalyzeScriptRequest, FormatScriptPayload, FormatScriptRequest,
};
use std::{
    env,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
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
pub async fn analyze_script(payload: AnalyzeScriptRequest) -> Result<AnalyzeScriptPayload, String> {
    // ShellCheck 诊断已迁移至 bash-language-server (LSP) 管线。
    // 此命令仅返回方言信息，供 AI 分析上下文使用。
    let normalized_content = normalize_shellcheck_content(&payload.content);
    let dialect = detect_shellcheck_dialect(
        payload.path.as_deref(),
        payload.name.as_deref(),
        &normalized_content,
    )
    .to_string();

    Ok(AnalyzeScriptPayload {
        available: true,
        message: None,
        dialect,
        diagnostics: Vec::new(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn format_script(payload: FormatScriptRequest) -> Result<FormatScriptPayload, String> {
    let Some(shfmt) = resolve_shfmt_candidate() else {
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

fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

fn infer_script_name(path: Option<&str>, name: Option<&str>) -> String {
    path.and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        .or(name)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn shell_from_shebang(content: &str) -> Option<&'static str> {
    let first_line = content.lines().next()?.trim_start().to_ascii_lowercase();

    if !first_line.starts_with("#!") {
        return None;
    }

    let normalized = first_line.replace('\\', "/");
    let tokens = normalized
        .split(|character: char| character.is_whitespace() || character == '/')
        .filter(|token| !token.is_empty());

    for token in tokens {
        match token {
            "bash" => return Some("bash"),
            "dash" => return Some("dash"),
            "ksh" | "ksh93" => return Some("ksh"),
            "sh" => return Some("sh"),
            _ => {}
        }
    }

    None
}

fn normalize_shellcheck_content(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn detect_shellcheck_dialect(
    path: Option<&str>,
    name: Option<&str>,
    content: &str,
) -> &'static str {
    let first_line = content
        .lines()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if first_line.starts_with("#!") {
        if let Some(shell) = shell_from_shebang(content) {
            return shell;
        }
    }

    let inferred_name = infer_script_name(path, name);

    if inferred_name.ends_with(".dash") {
        return "dash";
    }
    if inferred_name.ends_with(".ksh") {
        return "ksh";
    }
    if inferred_name.ends_with(".sh") || inferred_name.ends_with(".bash") {
        return "bash";
    }

    "bash"
}

/// 候选「随包资源」根目录：打包后用于定位安装目录内自带的运行时 / 二进制。
/// 解析策略统一为「随包优先 → 系统兜底」。开发模式 (`tauri dev`) 下这些目录
/// 通常不存在，候选会被 is_file() 过滤掉，因此对开发流程无副作用。
///
/// 同时供 agent_sidecar 复用以定位随包的 agent-sidecar 与 Node 运行时，
/// 确保打包侧 (prepare-bundle-resources.ts) 与运行时侧的产物布局契约一致。
pub(crate) fn bundled_resource_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("resources-bundle"));
            roots.push(dir.join("resources").join("resources-bundle"));
            roots.push(dir.to_path_buf());
        }
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

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|error| format!("写入 shfmt 输入失败：{error}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|error| format!("关闭 shfmt 输入失败：{error}"))?;
    }

    let output = match timeout(SHFMT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("运行 shfmt 失败：{error}")),
        Err(_) => {
            return Err(format!(
                "shfmt 格式化超时（超过 {} 秒）。",
                SHFMT_TIMEOUT.as_secs()
            ))
        }
    };

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

#[cfg(test)]
mod tests {
    use super::{detect_shellcheck_dialect, shell_from_shebang};

    #[test]
    fn shellcheck_dialect_prefers_shebang_then_filename() {
        assert_eq!(
            shell_from_shebang("#!/usr/bin/env bash\necho ok"),
            Some("bash")
        );
        assert_eq!(shell_from_shebang("#!/bin/dash\necho ok"), Some("dash"));
        assert_eq!(
            detect_shellcheck_dialect(Some("scripts/install.sh"), None, "#!/bin/ksh\necho ok"),
            "ksh"
        );
        assert_eq!(
            detect_shellcheck_dialect(Some("scripts/install.dash"), None, "echo ok"),
            "dash"
        );
        assert_eq!(
            detect_shellcheck_dialect(Some(".bashrc"), None, "alias ll='ls -la'"),
            "bash"
        );
    }
}
