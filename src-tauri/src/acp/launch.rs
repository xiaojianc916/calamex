//! 宿主侧 ACP stdio 子进程的启动配置解析。
//!
//! 职责：把「用哪个 node、跑哪个 ACP 入口、注入哪些子进程环境变量」解析成
//! `client::AcpClientConfig { program, args, env }`,供 `spawn_acp_client` 派生 stdio 子进程。
//!
//! 本模块的进程/入口/env 解析逻辑忺实自旧 `agent_sidecar/mod.rs`(原 HTTP 路径的
//! `resolve_sidecar_root` / `resolve_node_executable` / env 注入等),以便后续删除旧
//! 模块后本文件仍自包含。与旧 HTTP 路径的关键区别:
//!   * 入口改为 ACP stdio 入口 `dist/acp/stdio-entry.js`(回退 `tsx + src/acp/stdio-entry.ts`),
//!     而非旧 `dist/server.js`;
//!   * stdio 无 HTTP 监听,故不注入 `AGENT_SIDECAR_PORT` / `AGENT_SIDECAR_TOKEN`
//!     (二者仅用于旧 HTTP 服务的端口与 Bearer 鉴权);
//!   * 模型配置走逐请求通道(chat / restore 请求携带 `model_config`),而 stdio-entry 仅在
//!     启动时用 env 做可选预热(`createMastraModelConfigFromEnv()`,缺失会优雅跳过),故
//!     launch 层不耦合凭证 / 网关,不注入模型 env(职责分离更干净;预热仅推迟到首
//!     个请求,不影响正确性)。
//!
//! SDK 的 `AcpAgent::spawn_process` 只设置 command / args / env,不设 `cwd`;故 `program`
//! 与入口路径均采用绝对路径,保证与工作目录无关。
//!
//! 按 cargo feature `acp_client` 门控;接线前不影响现有路径。

#![allow(dead_code)]

use std::env;
use fs_err as fs;
use std::path::{Path, PathBuf};

use super::client::AcpClientConfig;

const SIDECAR_ROOT_ENV: &str = "XIAOJIANC_AGENT_SIDECAR_ROOT";
const NODE_EXE_ENV: &str = "XIAOJIANC_NODE_EXE";
const MCP_UVX_PATH_ENV: &str = "AGENT_MCP_UVX_PATH";
const TAVILY_API_KEY_ENV: &str = "TAVILY_API_KEY";

/// 解析启动 ACP stdio 子进程所需的完整配置。
///
/// `program` = 解析出的 node 绝对路径;`args` = ACP 入口(优先预编译产物,否则 tsx + 源码);
/// `env` = 子进程环境变量(工具所需 + 编译缓存)。
pub fn build_acp_client_config() -> Result<AcpClientConfig, String> {
    let sidecar_root = resolve_sidecar_root()?;
    let node = resolve_node_executable()?;
    let args = resolve_entry_args(&sidecar_root)?;
    let env = build_sidecar_env(&sidecar_root);

    Ok(AcpClientConfig {
        program: path_to_string(&node),
        args,
        env,
    })
}

/// 解析 ACP stdio 入口参数:优先预编译 `dist/acp/stdio-entry.js`(无需运行时 tsx 转译,
/// 冷启动更快更稳);不存在时回退 `tsx + src/acp/stdio-entry.ts`,保持开发态与未构建
/// 场景可用。均使用绝对路径(SDK 不设 cwd)。
fn resolve_entry_args(sidecar_root: &Path) -> Result<Vec<String>, String> {
    let compiled = sidecar_root.join("dist").join("acp").join("stdio-entry.js");
    if compiled.is_file() {
        return Ok(vec![path_to_string(&compiled)]);
    }

    let tsx_cli = sidecar_root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    let entry = sidecar_root.join("src").join("acp").join("stdio-entry.ts");

    if !tsx_cli.is_file() {
        return Err(format!(
            "AGENT_SIDECAR_UNAVAILABLE: 未找到 sidecar TSX 启动器：{}",
            tsx_cli.display()
        ));
    }

    if !entry.is_file() {
        return Err(format!(
            "AGENT_SIDECAR_UNAVAILABLE: 未找到 ACP stdio 入口：{}",
            entry.display()
        ));
    }

    Ok(vec![path_to_string(&tsx_cli), path_to_string(&entry)])
}

/// 构造子进程环境变量。仅含 stdio 入口真正需要的项:
///   * `NODE_COMPILE_CACHE`:复用编译缓存,缩短冷启动(与旧路径一致);
///   * `TAVILY_API_KEY`:web 工具所需,优先进程/用户环境,缺失时回退 sidecar `.env`;
///   * `AGENT_MCP_UVX_PATH`:MCP 工具拉起 uvx 所需(Windows 解析)。
fn build_sidecar_env(sidecar_root: &Path) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();

    env.push((
        "NODE_COMPILE_CACHE".to_string(),
        path_to_string(&sidecar_runtime_dir().join("node-compile-cache")),
    ));

    // 优先用进程/用户环境的 TAVILY_API_KEY;缺失时才回退 sidecar `.env`(与旧路径优先级一致)。
    if let Some(value) = env_or_user_env(TAVILY_API_KEY_ENV)
        .or_else(|| read_dotenv_key(sidecar_root, TAVILY_API_KEY_ENV))
    {
        env.push((TAVILY_API_KEY_ENV.to_string(), value));
    }

    if let Some(path) = resolve_windows_uvx_path() {
        env.push((MCP_UVX_PATH_ENV.to_string(), path_to_string(&path)));
    }

    env
}

/// 运行时可写目录:统一落到品牌根 `.calamex/ai-service`(与 `storage_paths` 一致)。
fn sidecar_runtime_dir() -> PathBuf {
    crate::storage_paths::local_root().join("ai-service")
}

fn resolve_sidecar_root() -> Result<PathBuf, String> {
    if let Some(path) = env_or_user_env(SIDECAR_ROOT_ENV).map(PathBuf::from)
        && path.is_dir()
    {
        return Ok(path);
    }

    // 随包优先:安装包内 resources-bundle/agent-sidecar(含 dist 与 node_modules)。
    // 与 shell_tools 的解析策略一致:随包优先 → 源码树兑底。
    for root in crate::commands::shell_tools::bundled_resource_roots() {
        let bundled = root.join("agent-sidecar");
        if bundled.join("package.json").is_file() {
            return Ok(bundled);
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let Some(workspace_root) = manifest_dir.parent() else {
        return Err("AGENT_SIDECAR_UNAVAILABLE: 无法定位仓库根目录。".to_string());
    };
    let sidecar_root = workspace_root.join("agent-sidecar");

    if sidecar_root.is_dir() {
        return Ok(sidecar_root);
    }

    Err(format!(
        "AGENT_SIDECAR_UNAVAILABLE: 未找到 agent-sidecar 目录：{}",
        sidecar_root.display()
    ))
}

fn resolve_node_executable() -> Result<PathBuf, String> {
    if let Some(path) = env_or_user_env(NODE_EXE_ENV).map(PathBuf::from)
        && path.is_file()
    {
        return Ok(path);
    }

    // 随包优先:安装包内 resources-bundle/node/node.exe(目标机无系统 Node 也能运行)。
    for root in crate::commands::shell_tools::bundled_resource_roots() {
        let node_dir = root.join("node");
        for name in ["node.exe", "node"] {
            let bundled = node_dir.join(name);
            if bundled.is_file() {
                return Ok(bundled);
            }
        }
    }

    for candidate in node_executable_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    find_executable_in_path("node.exe")
        .or_else(|| find_executable_in_path("node"))
        .ok_or_else(|| {
            "AGENT_SIDECAR_UNAVAILABLE: 未找到 node.exe，请设置 XIAOJIANC_NODE_EXE。".to_string()
        })
}

fn node_executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(program_files) = env_or_user_env("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
    }
    if let Some(program_files_x86) = env_or_user_env("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("nodejs")
                .join("node.exe"),
        );
    }
    candidates
}

fn find_executable_in_path(file_name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path_value| {
        env::split_paths(&path_value)
            .map(|directory| directory.join(file_name))
            .find(|candidate| candidate.is_file())
    })
}

/// 解析 uvx 可执行路径(优先 env,其次常见安装位置)。非 Windows 上候选多不存在，返回 None。
fn resolve_windows_uvx_path() -> Option<PathBuf> {
    if let Some(path) = env_or_user_env(MCP_UVX_PATH_ENV).map(PathBuf::from)
        && path.is_file()
    {
        return Some(path);
    }

    windows_uvx_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn windows_uvx_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(user_profile) = env_or_user_env("USERPROFILE") {
        let user_profile = PathBuf::from(user_profile);
        candidates.push(user_profile.join(".local").join("bin").join("uvx.exe"));
        candidates.push(user_profile.join(".cargo").join("bin").join("uvx.exe"));
    }
    if let Some(local_app_data) = env_or_user_env("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        candidates.push(local_app_data.join("Programs").join("uv").join("uvx.exe"));
        candidates.push(local_app_data.join("uv").join("uvx.exe"));
    }
    if let Some(program_files) = env_or_user_env("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("uv").join("uvx.exe"));
    }
    if let Some(program_files_x86) = env_or_user_env("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(program_files_x86).join("uv").join("uvx.exe"));
    }
    candidates
}

/// 从 sidecar `.env` 读取指定键(仅在进程/用户环境缺失时作为回退)。
fn read_dotenv_key(sidecar_root: &Path, key: &str) -> Option<String> {
    let content = fs::read_to_string(sidecar_root.join(".env")).ok()?;
    find_dotenv_value(&content, key)
}

/// 纯函数:从 dotenv 文本中提取 `key` 的值(跳过空行/注释,去首尾引号,空值视为无)。
fn find_dotenv_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((name, raw_value)) = trimmed.split_once('=') else {
            continue;
        };

        if name.trim() != key {
            continue;
        }

        let value = raw_value.trim().trim_matches(['"', '\'']);
        return (!value.is_empty()).then(|| value.to_string());
    }

    None
}

/// 进程环境优先,其次 Windows 用户环境(HKCU\\Environment);均去首尾空白且空值视为无。
fn env_or_user_env(key: &str) -> Option<String> {
    let process_value = env::var(key).ok().and_then(non_empty_string);
    if process_value.is_some() {
        return process_value;
    }

    read_user_environment_value(key).and_then(non_empty_string)
}

fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(windows)]
fn read_user_environment_value(key: &str) -> Option<String> {
    use std::process::{Command, Stdio};

    let output = Command::new("reg.exe")
        .args(["query", "HKCU\\Environment", "/v", key])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_reg_query_value(&stdout, key)
}

#[cfg(not(windows))]
fn read_user_environment_value(_key: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn parse_reg_query_value(output: &str, key: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with(key) {
            return None;
        }

        let mut parts = trimmed.split_whitespace();
        let name = parts.next()?;
        let _kind = parts.next()?;
        let value = parts.collect::<Vec<_>>().join(" ");

        (name == key).then_some(value).and_then(non_empty_string)
    })
}

/// 路径 → String(lossy)。ACP 入口 / node 路径在目标平台上均可 UTF-8 表示。
fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_dotenv_value_extracts_key_skipping_comments_and_blanks() {
        let content = "# comment\n\nTAVILY_API_KEY=tvly-from-dotenv\nOTHER=ignored\n";
        assert_eq!(
            find_dotenv_value(content, "TAVILY_API_KEY").as_deref(),
            Some("tvly-from-dotenv")
        );
    }

    #[test]
    fn find_dotenv_value_trims_surrounding_quotes() {
        assert_eq!(
            find_dotenv_value("TAVILY_API_KEY=\"quoted-value\"", "TAVILY_API_KEY").as_deref(),
            Some("quoted-value")
        );
        assert_eq!(
            find_dotenv_value("TAVILY_API_KEY='single'", "TAVILY_API_KEY").as_deref(),
            Some("single")
        );
    }

    #[test]
    fn find_dotenv_value_returns_none_for_missing_or_empty() {
        assert_eq!(find_dotenv_value("OTHER=x", "TAVILY_API_KEY"), None);
        assert_eq!(find_dotenv_value("TAVILY_API_KEY=", "TAVILY_API_KEY"), None);
        assert_eq!(
            find_dotenv_value("TAVILY_API_KEY=   ", "TAVILY_API_KEY"),
            None
        );
    }

    #[test]
    fn non_empty_string_trims_and_rejects_blank() {
        assert_eq!(
            non_empty_string("  value  ".to_string()).as_deref(),
            Some("value")
        );
        assert_eq!(non_empty_string("   ".to_string()), None);
        assert_eq!(non_empty_string(String::new()), None);
    }

    #[test]
    fn path_to_string_roundtrips_simple_path() {
        let path = PathBuf::from("dist").join("acp").join("stdio-entry.js");
        assert_eq!(path_to_string(&path), path.to_string_lossy().into_owned());
    }

    #[cfg(windows)]
    #[test]
    fn parse_reg_query_value_extracts_value_with_spaces() {
        let output = "\r\nHKEY_CURRENT_USER\\Environment\r\n    TAVILY_API_KEY    REG_SZ    tvly with spaces\r\n";
        assert_eq!(
            parse_reg_query_value(output, "TAVILY_API_KEY").as_deref(),
            Some("tvly with spaces")
        );
        assert_eq!(parse_reg_query_value(output, "MISSING"), None);
    }
}
