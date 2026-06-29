use super::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, FormatScriptPayload, FormatScriptRequest,
    ScriptDiagnosticPayload, ScriptDiagnosticSeverity, configure_std_command_for_background,
    configure_tokio_command_for_background, count_to_u32,
};
use serde::Deserialize;
use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

const SHELLCHECK_TIMEOUT: Duration = Duration::from_secs(12);
const SHFMT_TIMEOUT: Duration = Duration::from_secs(12);
const SHELLCHECK_SCRIPT_EXTENSIONS: &[&str] = &["sh", "bash", "dash", "ksh", "bats"];
const SHELLCHECK_SCRIPT_NAMES: &[&str] = &[
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".profile",
    ".kshrc",
    "bashrc",
    "profile",
];

struct ShellCheckCandidate {
    executable: PathBuf,
    arguments: Vec<OsString>,
    use_wsl: bool,
}

#[derive(Debug, Deserialize)]
struct ShellCheckJsonPayload {
    comments: Vec<ShellCheckComment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellCheckComment {
    line: usize,
    end_line: usize,
    column: usize,
    end_column: usize,
    level: String,
    code: u64,
    message: String,
}

struct ShfmtCandidate {
    executable: PathBuf,
    use_wsl: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn analyze_script(payload: AnalyzeScriptRequest) -> Result<AnalyzeScriptPayload, String> {
    // ShellCheck 本地一次性诊断：在 bash-language-server (LSP) 之外并行提供，供 AI 应用补丁
    // 后的快速校验与编辑器静态检查复用。脚本经 stdin 直接喂给 shellcheck（--format=json1），
    // 不落临时文件，规避 WSL 路径转换与清理开销。
    let normalized_content = normalize_shellcheck_content(&payload.content);
    let dialect = detect_shellcheck_dialect(
        payload.path.as_deref(),
        payload.name.as_deref(),
        &normalized_content,
    )
    .to_string();

    let should_check = should_run_shellcheck(
        payload.path.as_deref(),
        payload.name.as_deref(),
        &normalized_content,
    );

    if normalized_content.trim().is_empty() || !should_check {
        return Ok(AnalyzeScriptPayload {
            available: true,
            message: None,
            dialect,
            diagnostics: Vec::new(),
        });
    }

    let Some(shellcheck) = resolve_shellcheck_candidate() else {
        return Ok(AnalyzeScriptPayload {
            available: false,
            message: Some("未检测到可用的 ShellCheck，本地实时诊断暂不可用。".into()),
            dialect,
            diagnostics: Vec::new(),
        });
    };

    let output = run_shellcheck(&shellcheck, &normalized_content, &dialect).await?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let diagnostics = parse_shellcheck_diagnostics(&stdout)?;

    Ok(AnalyzeScriptPayload {
        available: true,
        message: None,
        dialect,
        diagnostics,
    })
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

fn parse_shellcheck_diagnostics(output: &str) -> Result<Vec<ScriptDiagnosticPayload>, String> {
    if output.trim().is_empty() {
        return Ok(Vec::new());
    }

    let payload: ShellCheckJsonPayload = serde_json::from_str(output)
        .map_err(|error| format!("解析 ShellCheck 结果失败：{error}"))?;

    payload
        .comments
        .into_iter()
        .map(|item| {
            let code = format!("SC{}", item.code);

            Ok(ScriptDiagnosticPayload {
                line: count_to_u32(item.line.max(1), "诊断行号")?,
                end_line: count_to_u32(item.end_line.max(item.line).max(1), "诊断结束行号")?,
                column: count_to_u32(item.column.max(1), "诊断列号")?,
                end_column: count_to_u32(item.end_column.max(item.column).max(1), "诊断结束列号")?,
                level: ScriptDiagnosticSeverity::try_from(item.level.as_str())?,
                message: item.message,
                code,
            })
        })
        .collect()
}

fn should_run_shellcheck(path: Option<&str>, name: Option<&str>, content: &str) -> bool {
    let inferred_name = infer_script_name(path, name);
    let extension_matches = Path::new(&inferred_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|extension| SHELLCHECK_SCRIPT_EXTENSIONS.contains(&extension))
        .unwrap_or(false);

    extension_matches
        || SHELLCHECK_SCRIPT_NAMES.contains(&inferred_name.as_str())
        || shell_from_shebang(content).is_some()
}

fn resolve_shellcheck_candidate() -> Option<ShellCheckCandidate> {
    if let Some(configured_path) = env::var_os("SHELLCHECK_BIN") {
        let configured_path = PathBuf::from(configured_path);
        if configured_path.exists()
            && let Some(candidate) = build_wrapped_shellcheck_candidate(configured_path)
        {
            return Some(candidate);
        }
    }

    let shellcheck_command = if cfg!(windows) {
        "shellcheck.exe"
    } else {
        "shellcheck"
    };

    // 打包优先：安装目录内自带的 shellcheck（与 shfmt 的随包解析策略一致）。
    for root in bundled_resource_roots() {
        let bundled = root.join(shellcheck_command);
        if bundled.is_file()
            && let Some(candidate) = build_wrapped_shellcheck_candidate(bundled)
        {
            return Some(candidate);
        }
    }

    // 开发模式：源码树 node_modules 内的 shellcheck（npm 包）。
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf);
    if let Some(repo_root) = repo_root {
        let local_candidates = [
            repo_root
                .join("node_modules")
                .join("shellcheck")
                .join("bin")
                .join("shellcheck.js"),
            repo_root
                .join("node_modules")
                .join(".bin")
                .join(if cfg!(windows) {
                    "shellcheck.cmd"
                } else {
                    "shellcheck"
                }),
            repo_root
                .join("node_modules")
                .join("shellcheck")
                .join("bin")
                .join(shellcheck_command),
        ];

        for local_candidate in local_candidates {
            if !local_candidate.exists() {
                continue;
            }
            if let Some(candidate) = build_wrapped_shellcheck_candidate(local_candidate) {
                return Some(candidate);
            }
        }
    }

    let system_commands: &[&str] = if cfg!(windows) {
        &["shellcheck.exe", "shellcheck.cmd"]
    } else {
        &["shellcheck"]
    };

    for command_name in system_commands {
        if let Some(system_binary) = super::find_command_path(command_name, &[])
            && let Some(candidate) = build_wrapped_shellcheck_candidate(system_binary)
        {
            return Some(candidate);
        }
    }

    let wsl_path = super::find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"])?;
    let mut command = StdCommand::new(&wsl_path);
    configure_std_command_for_background(&mut command);
    if command
        .args(["--", "shellcheck", "--version"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .is_some_and(|status| status.success())
    {
        return Some(ShellCheckCandidate {
            executable: wsl_path,
            arguments: Vec::new(),
            use_wsl: true,
        });
    }

    None
}

fn build_wrapped_shellcheck_candidate(executable: PathBuf) -> Option<ShellCheckCandidate> {
    let extension = executable
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    match extension.as_deref() {
        Some("js" | "mjs" | "cjs") => {
            let node_executable = resolve_node_command_path()?;
            Some(ShellCheckCandidate {
                executable: node_executable,
                arguments: vec![executable.into_os_string()],
                use_wsl: false,
            })
        }
        Some("cmd" | "bat") => {
            let command_shell = resolve_cmd_command_path()?;
            Some(ShellCheckCandidate {
                executable: command_shell,
                arguments: vec![OsString::from("/C"), executable.into_os_string()],
                use_wsl: false,
            })
        }
        _ => Some(ShellCheckCandidate {
            executable,
            arguments: Vec::new(),
            use_wsl: false,
        }),
    }
}

fn resolve_node_command_path() -> Option<PathBuf> {
    if cfg!(windows) {
        return super::find_command_path(
            "node.exe",
            &[
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Program Files (x86)\\nodejs\\node.exe",
            ],
        );
    }

    super::find_command_path("node", &[])
}

fn resolve_cmd_command_path() -> Option<PathBuf> {
    if cfg!(windows) {
        return super::find_command_path("cmd.exe", &["C:\\Windows\\System32\\cmd.exe"]);
    }

    None
}

async fn run_shellcheck(
    candidate: &ShellCheckCandidate,
    content: &str,
    dialect: &str,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(&candidate.executable);
    configure_tokio_command_for_background(&mut command);
    // 超时分支会 drop child；显式 kill_on_drop 避免 shellcheck 超时后残留孤儿进程。
    command.kill_on_drop(true);

    if candidate.use_wsl {
        command.args(["--", "shellcheck", "--format=json1", "--shell", dialect, "-"]);
    } else {
        command
            .args(&candidate.arguments)
            .args(["--format=json1", "--shell", dialect, "-"]);
    }

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 ShellCheck 失败：{error}"))?;

    // 并发写 stdin：与排空 stdout 同时进行，规避大脚本下的双向管道死锁。
    let stdin = child.stdin.take();
    let input = content.as_bytes().to_vec();
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            stdin.write_all(&input).await?;
            stdin.shutdown().await?;
        }
        Ok::<(), std::io::Error>(())
    });

    let output = match timeout(SHELLCHECK_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("运行 ShellCheck 失败：{error}")),
        Err(_) => {
            return Err(format!(
                "ShellCheck 分析超时（超过 {} 秒）。",
                SHELLCHECK_TIMEOUT.as_secs()
            ));
        }
    };

    // shellcheck 解析失败会提前关闭 stdin，写入失败属其副作用；仅在子进程异常退出时才追究。
    match writer.await {
        Ok(Ok(())) => {}
        Ok(Err(_)) if matches!(output.status.code(), Some(0 | 1)) => {}
        Ok(Err(write_error)) => return Err(format!("写入 ShellCheck 输入失败：{write_error}")),
        Err(join_error) => return Err(format!("ShellCheck 输入任务异常退出：{join_error}")),
    }

    if matches!(output.status.code(), Some(0 | 1)) {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err("ShellCheck 执行失败。".into());
    }

    Err(format!("ShellCheck 执行失败：{stderr}"))
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

/// 行结束符归一化：将 CRLF 和 lone CR 统一为 LF。
/// 跨语言约定：TS 侧 src/utils/file/ssh-file-preview.ts 的 normalizeSshPreviewContent
/// 做完全相同的操作，修改时请同步两端。
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
    if first_line.starts_with("#!")
        && let Some(shell) = shell_from_shebang(content)
    {
        return shell;
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

#[cfg(test)]
mod tests {
    use super::{detect_shellcheck_dialect, shell_from_shebang, should_run_shellcheck};

    #[test]
    fn shellcheck_runs_for_common_shell_extensions() {
        assert!(should_run_shellcheck(
            Some("scripts/install.sh"),
            None,
            "echo ok"
        ));
        assert!(should_run_shellcheck(
            Some("scripts/install.bash"),
            None,
            "echo ok"
        ));
        assert!(should_run_shellcheck(
            Some("scripts/install.dash"),
            None,
            "echo ok"
        ));
        assert!(should_run_shellcheck(
            Some("scripts/install.ksh"),
            None,
            "echo ok"
        ));
        assert!(should_run_shellcheck(
            Some("tests/install.bats"),
            None,
            "echo ok"
        ));
    }

    #[test]
    fn shellcheck_runs_for_shell_dotfiles_and_shebangs() {
        assert!(should_run_shellcheck(
            Some("C:/Users/me/.bashrc"),
            None,
            "alias ll='ls -la'"
        ));
        assert!(should_run_shellcheck(
            None,
            Some(".profile"),
            "export PATH=\"$PATH:/opt/bin\""
        ));
        assert!(should_run_shellcheck(
            None,
            Some("run"),
            "#!/usr/bin/env bash\necho ok"
        ));
        assert!(should_run_shellcheck(
            None,
            Some("run"),
            "#!/bin/sh -e\necho ok"
        ));
    }

    #[test]
    fn shellcheck_skips_non_shell_files_without_shell_shebang() {
        assert!(!should_run_shellcheck(
            Some("src/main.rs"),
            None,
            "fn main() {}"
        ));
        assert!(!should_run_shellcheck(
            Some("README.md"),
            None,
            "#!/usr/bin/env node\nconsole.log(1)"
        ));
    }

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
