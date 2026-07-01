//! 宿主侧 ACP stdio 子进程的启动配置解析（自家 Node 边车 / Builtin）。
//!
//! 职责：把「用哪个 node、跑哪个 ACP 入口、注入哪些子进程环境变量」解析成
//! `client::AcpClientConfig { program, args, env }`，供 `spawn_acp_client` 派生 stdio 子进程。
//!
//! 本模块的进程/入口/env 解析逻辑总实自旧 `builtin_agent/mod.rs`（原 HTTP 路径的
//!     `resolve_builtin_agent_root` / `resolve_node_executable` / env 注入等），以便后续删除旧
//!     模块后本文件仍自包含。与旧 HTTP 路径的关键区别：
//!   * 入口改为 ACP stdio 入口 `dist/acp/stdio-entry.js`（回退 `tsx + src/acp/stdio-entry.ts`），
//!     而非旧 `dist/server.js`；
//!   * stdio 无 HTTP 监听，故不注入 `BUILTIN_AGENT_PORT` / `BUILTIN_AGENT_TOKEN`
//!     （二者仅用于旧 HTTP 服务的端口与 Bearer 鉴权）；
//!   * 模型配置走逐请求通道（chat / restore 请求携带 `model_config`），而 stdio-entry 仅在
//!     启动时用 env 做可选预热（`createMastraModelConfigFromEnv()`，缺失会优雅跳过），故
//!     launch 层不耦合凭证 / 网关，不注入模型 env（职责分离更干净；预热仅推迟到首
//!     个请求，不影响正确性）。
//!
//! SDK 的 `AcpAgent::spawn_process` 只设置 command / args / env，不设 `cwd`；故 `program`
//! 与入口路径均采用绝对路径，保证与工作目录无关。
//!
//! 多后端（ADR-0015）：本模块只负责**自家 Node 边车（Builtin）**的启动配置解析，并向同
//! 目录的 `provisioner` 模块暴露若干共享进程/路径/env 基元（`resolve_node_executable` /
//! `path_to_string` / `env_or_user_env`，均 `pub(super)`）。外部 ACP 编码 agent（Kimi Code /
//! Codex 等）的启动配置与凭证预置由各自的 `ExternalAgentProvisioner` 实现自包含，不再经由
//! 本模块（见 `provisioner.rs`）。
//!
//! 本模块已随默认特性（含 `acp_client`）编译，并已接线为 builtin-agent 的启动配置解析层。

#![allow(dead_code)]

use std::env;
use std::path::{Path, PathBuf};

use super::client::AcpClientConfig;

const BUILTIN_AGENT_ROOT_ENV: &str = "XIAOJIANC_BUILTIN_AGENT_ROOT";
const NODE_EXE_ENV: &str = "XIAOJIANC_NODE_EXE";
const MCP_UVX_PATH_ENV: &str = "AGENT_MCP_UVX_PATH";
const TAVILY_API_KEY_ENV: &str = "TAVILY_API_KEY";
/// 全局技能目录的跨进程契约：宿主解析后经此 env 注入边车，Node 侧据此定位技能库
/// （见 builtin-agent workspace.ts 的 resolveGlobalSkillsDirectory / CALAMEX_SKILLS_DIR 分支）。
const SKILLS_DIR_ENV: &str = "CALAMEX_SKILLS_DIR";

/// 可挂载的 ACP 后端标识（ADR-0015）。`Builtin` 为自家 Node 边车（默认后端，行为与历史
/// 一致）；其余为外部 ACP 编码 agent，其启动配置与凭证预置由 `provisioner` 模块的各
/// `ExternalAgentProvisioner` 实现自包含（见 `provisioner.rs`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpBackendId {
    /// 自家 Node Mastra 边车（默认后端，行为与历史一致）。
    Builtin,
    /// Kimi Code（@moonshot-ai/kimi-code）：原生 ACP；优先工程内置包（node <入口> acp），否则回退裸 kimi acp；可经 XIAOJIANC_KIMI_EXE 覆盖为绝对路径。
    Kimi,
    /// Codex CLI：经社区适配器 `codex-acp`，凭 `OPENAI_API_KEY`。
    Codex,
}

/// 解析「默认后端（自家边车）」的启动配置（历史签名与行为不变）。
pub fn build_acp_client_config() -> Result<AcpClientConfig, String> {
    build_builtin_client_config()
}

/// 自家 Node 边车启动配置（默认后端）。
///
/// `program` = 解析出的 node 绝对路径；`args` = ACP 入口（优先预编译产物，否则 tsx + 源码）；
/// `env` = 子进程环境变量（工具所需 + 编译缓存）。
fn build_builtin_client_config() -> Result<AcpClientConfig, String> {
    let sidecar_root = resolve_builtin_agent_root()?;
    let node = resolve_node_executable()?;
    let args = resolve_entry_args(&sidecar_root)?;
    let env = build_builtin_agent_env();

    Ok(AcpClientConfig {
        program: path_to_string(&node),
        args,
        env,
    })
}

/// 解析 ACP stdio 入口参数：优先预编译 `dist/acp/stdio-entry.js`（无需运行时 tsx 转译，
/// 冷启动更快更稳）；不存在时回退 `tsx + src/acp/stdio-entry.ts`，保持开发态与未构建
/// 场景可用。均使用绝对路径（SDK 不设 cwd）。
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
            "BUILTIN_AGENT_UNAVAILABLE: 未找到 sidecar TSX 启动器：{}",
            tsx_cli.display()
        ));
    }

    if !entry.is_file() {
        return Err(format!(
            "BUILTIN_AGENT_UNAVAILABLE: 未找到 ACP stdio 入口：{}",
            entry.display()
        ));
    }

    Ok(vec![path_to_string(&tsx_cli), path_to_string(&entry)])
}

/// 构造子进程环境变量。仅含 stdio 入口真正需要的项：
///   * `NODE_COMPILE_CACHE`：复用编译缓存，缩短冷启动（与旧路径一致）；
///   * `TAVILY_API_KEY`：web 工具所需，统一从 OS keyring 读取（与其它 AI 凭证同源）；
///   * `AGENT_MCP_UVX_PATH`：MCP 工具拉起 uvx 所需（Windows 解析）。
fn build_builtin_agent_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();

    env.push((
        "NODE_COMPILE_CACHE".to_string(),
        path_to_string(&builtin_agent_runtime_dir().join("node-compile-cache")),
    ));

    // Tavily（web 工具）Key 由 Rust 宿主从 OS keyring 读出后注入子进程环境，子进程据此读
    // process.env。keyring 为唯一来源：不再读 .env，也不回退进程/用户环境，杜绝新旧杂糅。
    if let Some(value) = crate::ai::credential::CredentialStore::get_tavily() {
        env.push((TAVILY_API_KEY_ENV.to_string(), value));
    }

    if let Some(path) = resolve_windows_uvx_path() {
        env.push((MCP_UVX_PATH_ENV.to_string(), path_to_string(&path)));
    }

    // 全局技能目录：由宿主（唯一事实源）解析后经 env 注入子进程，杜绝 Node 侧
    // %APPDATA%/.calamex/skills 与 Rust 侧 ~/.calamex/skills 各算各的（此前在 Windows
    // 上指向不同目录，导致 UI 存的技能 Agent 读不到）。与 commands::skills 同源。
    if let Some(root) = crate::storage_paths::roaming_root() {
        env.push((SKILLS_DIR_ENV.to_string(), path_to_string(&root.join("skills"))));
    }

    env
}

/// 运行时可写目录：统一落到品牌根 `.calamex/ai-service`（与 `storage_paths` 一致）。
fn builtin_agent_runtime_dir() -> PathBuf {
    crate::storage_paths::local_root().join("ai-service")
}

fn resolve_builtin_agent_root() -> Result<PathBuf, String> {
    if let Some(path) = env_or_user_env(BUILTIN_AGENT_ROOT_ENV).map(PathBuf::from)
        && path.is_dir()
    {
        return Ok(path);
    }

    // 随包优先：安装包内 resources-bundle/builtin-agent（含 dist 与 node_modules）。
    // 与 shell_tools 的解析策略一致：随包优先 → 源码树兑底。
    for root in crate::commands::shell_tools::bundled_resource_roots() {
        let bundled = root.join("builtin-agent");
        if bundled.join("package.json").is_file() {
            return Ok(bundled);
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let Some(workspace_root) = manifest_dir.parent() else {
        return Err("BUILTIN_AGENT_UNAVAILABLE: 无法定位仓库根目录。".to_string());
    };
    let sidecar_root = workspace_root.join("builtin-agent");

    if sidecar_root.is_dir() {
        return Ok(sidecar_root);
    }

    Err(format!(
        "BUILTIN_AGENT_UNAVAILABLE: 未找到 builtin-agent 目录：{}",
        sidecar_root.display()
    ))
}

pub(super) fn resolve_node_executable() -> Result<PathBuf, String> {
    if let Some(path) = env_or_user_env(NODE_EXE_ENV).map(PathBuf::from)
        && path.is_file()
    {
        return Ok(path);
    }

    // 随包优先：安装包内 resources-bundle/node/node.exe（目标机无系统 Node 也能运行）。
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
            "BUILTIN_AGENT_UNAVAILABLE: 未找到 node.exe，请设置 XIAOJIANC_NODE_EXE。".to_string()
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

/// 解析 uvx 可执行路径（优先 env，其次常见安装位置）。非 Windows 上候选多不存在，返回 None。
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

/// 进程环境优先，其次 Windows 用户环境（HKCU\\Environment）；均去首尾空白且空值视为无。
pub(super) fn env_or_user_env(key: &str) -> Option<String> {
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
    // 直接读注册表 HKCU\\Environment，取代起 reg.exe 子进程 + 文本解析 stdout 的手搓做法
    // （后者对 REG_EXPAND_SZ / 含多空格值 / 本地化输出都脆弱，且每次 fork 一个进程）。
    // winreg 的 get_value::<String> 原生处理 REG_SZ / REG_EXPAND_SZ；去空白由调用方
    // env_or_user_env 的 non_empty_string 兑。参见地基审查 H1。
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let environment = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Environment")
        .ok()?;
    environment.get_value::<String, _>(key).ok()
}

#[cfg(not(windows))]
fn read_user_environment_value(_key: &str) -> Option<String> {
    None
}

/// 路径 → String（lossy）。ACP 入口 / node 路径在目标平台上均可 UTF-8 表示。
pub(super) fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
