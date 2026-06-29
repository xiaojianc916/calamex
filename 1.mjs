// 6.mjs — #9 恢复后端 ShellCheck 真诊断（与 LSP 并行；stdin 喂入，无临时文件/翻译层）
// 仅改后端两文件，契约 payload 形状不变 ⇒ 无需重生成 specta bindings。
import { readFileSync, writeFileSync } from "node:fs";

const r = String.raw;
const ROOT = process.cwd();

function patch(relPath, edits, residual = []) {
  const path = `${ROOT}/${relPath}`.replace(/\\/g, "/");
  let src = readFileSync(path, "utf8");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const toEol = (s) => (eol === "\n" ? s : s.replace(/\n/g, eol));

  for (const [label, findRaw, replRaw, expected = 1] of edits) {
    const find = toEol(findRaw);
    const repl = toEol(replRaw);
    const hits = src.split(find).length - 1;
    if (hits !== expected) {
      throw new Error(
        `[中止] ${relPath} :: ${label} 锚点命中 ${hits} 次（期望 ${expected}）。锚点首行：${findRaw.split("\n")[0]}`,
      );
    }
    src = src.split(find).join(repl);
  }

  for (const [label, needle, shouldExist] of residual) {
    const has = src.includes(toEol(needle));
    if (shouldExist && !has) throw new Error(`[校验失败] ${relPath} :: 期望存在「${label}」但未找到。`);
    if (!shouldExist && has) throw new Error(`[校验失败] ${relPath} :: 期望已移除「${label}」但仍存在。`);
  }

  writeFileSync(path, src, "utf8");
  console.log(`[完成] ${relPath}（EOL=${eol === "\r\n" ? "CRLF" : "LF"}，${edits.length} 处）`);
}

// ── 1) mod.rs：重新导出诊断类型（被 shell_tools 的 use super::{...} 引用）──
patch(
  "src-tauri/src/commands/mod.rs",
  [
    [
      "contracts 重导出",
      r`pub use contracts::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, DocumentEncoding, ExecutionEnvironment,`,
      r`pub use contracts::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, DocumentEncoding, ExecutionEnvironment,
    ScriptDiagnosticPayload, ScriptDiagnosticSeverity,`,
    ],
  ],
  [["ScriptDiagnosticPayload 重导出", "ScriptDiagnosticPayload, ScriptDiagnosticSeverity,", true]],
);

// ── 2) shell_tools.rs：重新接入 ShellCheck ──
patch(
  "src-tauri/src/commands/shell_tools.rs",
  [
    // A. use super：加入诊断类型 + serde::Deserialize
    [
      "use super 引入诊断类型",
      r`use super::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, FormatScriptPayload, FormatScriptRequest,
    configure_std_command_for_background, configure_tokio_command_for_background, count_to_u32,
};`,
      r`use super::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, FormatScriptPayload, FormatScriptRequest,
    ScriptDiagnosticPayload, ScriptDiagnosticSeverity, configure_std_command_for_background,
    configure_tokio_command_for_background, count_to_u32,
};
use serde::Deserialize;`,
    ],
    // B. std imports：加入 ffi::OsString
    [
      "std 引入 OsString",
      r`use std::{
    env,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};`,
      r`use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};`,
    ],
    // C. 常量 + 结构体
    [
      "ShellCheck 常量与结构体",
      r`const SHFMT_TIMEOUT: Duration = Duration::from_secs(12);

struct ShfmtCandidate {`,
      r`const SHELLCHECK_TIMEOUT: Duration = Duration::from_secs(12);
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

struct ShfmtCandidate {`,
    ],
    // D. analyze_script：从 stub 改为真正运行 shellcheck
    [
      "analyze_script 接入 shellcheck",
      r`pub async fn analyze_script(payload: AnalyzeScriptRequest) -> Result<AnalyzeScriptPayload, String> {
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
}`,
      r`pub async fn analyze_script(payload: AnalyzeScriptRequest) -> Result<AnalyzeScriptPayload, String> {
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
}`,
    ],
    // E. 在 infer_script_name 之前插入全部 shellcheck 辅助函数
    [
      "插入 shellcheck 辅助函数",
      r`fn infer_script_name(path: Option<&str>, name: Option<&str>) -> String {`,
      r`fn parse_shellcheck_diagnostics(output: &str) -> Result<Vec<ScriptDiagnosticPayload>, String> {
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

fn infer_script_name(path: Option<&str>, name: Option<&str>) -> String {`,
    ],
    // F. 测试：补回 should_run_shellcheck 的 3 个用例
    [
      "补回 should_run_shellcheck 测试",
      r`mod tests {
    use super::{detect_shellcheck_dialect, shell_from_shebang};

    #[test]
    fn shellcheck_dialect_prefers_shebang_then_filename() {`,
      r`mod tests {
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
    fn shellcheck_dialect_prefers_shebang_then_filename() {`,
    ],
  ],
  [
    ["旧 stub 注释已移除", "ShellCheck 诊断已迁移至 bash-language-server (LSP) 管线", false],
    ["run_shellcheck 已加入", "async fn run_shellcheck(", true],
    ["parse 已加入", "fn parse_shellcheck_diagnostics(", true],
    ["resolve 已加入", "fn resolve_shellcheck_candidate(", true],
    ["不可用分支", "available: false,", true],
  ],
);

console.log("[全部完成] #9 后端 ShellCheck 真诊断已恢复。请运行 cargo build && cargo test。");