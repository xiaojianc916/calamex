//! node / shellcheck / bash-language-server CLI 可执行文件路径解析。

use std::path::PathBuf;

/// 解析 bash-language-server 的启动参数:(node 可执行文件, CLI 入口 JS)。
pub(crate) fn resolve_lsp_command() -> Result<(PathBuf, PathBuf), String> {
    let node = resolve_node_executable()?;
    let cli_js = resolve_lsp_cli_js()?;
    Ok((node, cli_js))
}

fn resolve_node_executable() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("XIAOJIANC_NODE_EXE") {
        let p = PathBuf::from(&path);
        if p.is_file() {
            return Ok(p);
        }
    }

    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(&pf).join("nodejs").join(exe_name));
        }
        if let Ok(pfx86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(&pfx86).join("nodejs").join(exe_name));
        }
    } else {
        candidates.push(PathBuf::from("/usr/local/bin").join(exe_name));
        candidates.push(PathBuf::from("/usr/bin").join(exe_name));
        // nvm: ~/.nvm/versions/node/<version>/bin/node — 取按名字最大的那个版本
        if let Ok(home) = std::env::var("HOME") {
            let nvm_root = PathBuf::from(&home).join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm_root) {
                let mut versions: Vec<PathBuf> =
                    entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                versions.sort();
                for v in versions.iter().rev() {
                    let candidate = v.join("bin").join(exe_name);
                    if candidate.is_file() {
                        candidates.push(candidate);
                        break;
                    }
                }
            }
        }
    }

    for c in &candidates {
        if c.is_file() {
            log::info!("找到 node: {}", c.display());
            return Ok(c.clone());
        }
    }

    if let Some(p) = find_in_path(exe_name) {
        log::info!("PATH 中找到 node: {}", p.display());
        return Ok(p);
    }

    Err("未找到 node 可执行文件。请安装 Node.js 或设置 XIAOJIANC_NODE_EXE 环境变量。".into())
}

/// 解析 shellcheck 可执行文件的绝对路径。
///
/// bash-language-server 的诊断完全来自 shellcheck。重要:它的 onInitialize 不读
/// initializationOptions,只从环境变量 SHELLCHECK_PATH 或 workspace/configuration 读。
/// 本函数解析出绝对路径,调用方将其作为子进程环境变量 SHELLCHECK_PATH 传入。
/// 查找优先级:
///   1. 环境变量 XIAOJIANC_SHELLCHECK_EXE
///   2. 项目 node_modules 里 shellcheck npm 包自带的二进制(最常见)
///   3. 常见系统安装位置(scoop/winget/choco/Homebrew 等)
///   4. 兑底 PATH
///
/// 找不到时返回 None，调用方退回裸名 "shellcheck"（至少保持旧行为）。
pub(crate) fn resolve_shellcheck_executable() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("XIAOJIANC_SHELLCHECK_EXE") {
        let p = PathBuf::from(&path);
        if p.is_file() {
            return Some(p);
        }
    }

    let exe_name = if cfg!(windows) { "shellcheck.exe" } else { "shellcheck" };

    // 最优先:项目 node_modules 里 shellcheck npm 包自带的二进制。
    // 该包(shellcheck@4.x)把真实二进制放在 <pkg>/bin/shellcheck(.exe)。
    // 跟 bash-language-server CLI 一样优先用项目本地版本,避免依赖系统 PATH。
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(workspace_root) = manifest_dir.parent() {
            let nm = workspace_root
                .join("node_modules")
                .join("shellcheck")
                .join("bin")
                .join(exe_name);
            if nm.is_file() {
                log::info!("找到 node_modules 内置 shellcheck: {}", nm.display());
                return Some(nm);
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        // scoop (用户级): %USERPROFILE%\scoop\shims\shellcheck.exe
        if let Ok(home) = std::env::var("USERPROFILE") {
            candidates.push(PathBuf::from(&home).join("scoop").join("shims").join(exe_name));
        }
        if let Ok(progdata) = std::env::var("ProgramData") {
            // scoop (全局)
            candidates.push(
                PathBuf::from(&progdata).join("scoop").join("shims").join(exe_name),
            );
            // chocolatey
            candidates.push(
                PathBuf::from(&progdata).join("chocolatey").join("bin").join(exe_name),
            );
        }
        // winget links
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(&local)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join(exe_name),
            );
        }
    } else {
        candidates.push(PathBuf::from("/usr/local/bin").join(exe_name));
        candidates.push(PathBuf::from("/usr/bin").join(exe_name));
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(exe_name));
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(PathBuf::from(&home).join(".local").join("bin").join(exe_name));
        }
    }

    for c in &candidates {
        if c.is_file() {
            log::info!("找到 shellcheck: {}", c.display());
            return Some(c.clone());
        }
    }

    if let Some(p) = find_in_path(exe_name) {
        log::info!("PATH 中找到 shellcheck: {}", p.display());
        return Some(p);
    }

    log::warn!(
        "未找到 shellcheck 可执行文件。bash-language-server 的诊断依赖 shellcheck，未安装将不会出现任何诊断。请安装 shellcheck 或设置 XIAOJIANC_SHELLCHECK_EXE 环境变量。"
    );
    None
}

/// 解析 bash-language-server 的 CLI 入口 JS。
/// 它是应用内置依赖，不存在「系统版本」回退：内置优先 → 开发期项目 node_modules。
fn resolve_lsp_cli_js() -> Result<PathBuf, String> {
    // 1) 打包优先：安装目录内自带的 CLI（路径由启动钩子注入）。
    if let Ok(path) = std::env::var("XIAOJIANC_LSP_CLI_JS") {
        let p = PathBuf::from(&path);
        if p.is_file() {
            log::info!("使用内置 bash-language-server CLI: {}", p.display());
            return Ok(p);
        }
    }

    // 2) 开发模式：项目 node_modules（pnpm install 后）。
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir.parent().ok_or("无法定位项目根目录")?;
    let candidate = workspace_root
        .join("node_modules")
        .join("bash-language-server")
        .join("out")
        .join("cli.js");
    if candidate.is_file() {
        log::info!("找到项目 bash-language-server CLI: {}", candidate.display());
        return Ok(candidate);
    }

    Err(format!(
        "未找到 bash-language-server CLI（内置与项目 node_modules 均不存在）。开发环境请运行 pnpm install。\n查找路径: {}",
        candidate.display()
    ))
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path).find_map(|dir| {
            let candidate = dir.join(name);
            candidate.is_file().then_some(candidate)
        })
    })
}
