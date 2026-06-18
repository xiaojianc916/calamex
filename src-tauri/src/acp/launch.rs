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
//! 多后端注册表(ADR-0015 阶段 1):`build_acp_client_config_for(AcpBackendId)` 按后端标识
//! 解析启动配置。`Builtin` 复用上述自家边车解析(行为与历史一致);外部 ACP
//! 编码 agent(Kimi Code / Codex 等)给出「程序 + 参数 + env」描述。本阶段仅产出启动
//! 配置,尚未接入 runtime(接线见阶段 2)。
//!
//! 按 cargo feature `acp_client` 门控;接线前不影响现有路径。

#![allow(dead_code)]

use fs_err as fs;
use std::env;
use std::path::{Path, PathBuf};

use super::client::AcpClientConfig;

const SIDECAR_ROOT_ENV: &str = "XIAOJIANC_AGENT_SIDECAR_ROOT";
const NODE_EXE_ENV: &str = "XIAOJIANC_NODE_EXE";
const MCP_UVX_PATH_ENV: &str = "AGENT_MCP_UVX_PATH";
const TAVILY_API_KEY_ENV: &str = "TAVILY_API_KEY";

// 外部 ACP 后端的可执行路径覆盖与凭证 env 键(ADR-0015 阶段 1)。
const KIMI_EXE_ENV: &str = "XIAOJIANC_KIMI_EXE";
const CODEX_ACP_EXE_ENV: &str = "XIAOJIANC_CODEX_ACP_EXE";
const OPENAI_API_KEY_ENV: &str = "OPENAI_API_KEY";

// Kimi Code 的 provider 级凭证 env 名与默认端点(官方文档核对:moonshotai.github.io/kimi-code)。
// 注意:`kimi acp` 服务经终端 `/login` 自持久化凭证(Kimi Code OAuth 或 Moonshot 开放平台
// API key,落 `~/.kimi`),并不从启动环境读取这些变量;故 build_kimi_client_config 有意不注入
// 它们(env 为空)。此处仅作文档与未来「托管直连」之用,不改变任何运行时行为。
const KIMI_API_KEY_ENV: &str = "KIMI_API_KEY";
const KIMI_BASE_URL_ENV: &str = "KIMI_BASE_URL";
const KIMI_DEFAULT_BASE_URL: &str = "https://api.moonshot.ai/v1";

/// 可挂载的 ACP 后端标识(ADR-0015)。`Builtin` 为自家 Node 边车(默认后端,
/// 行为与历史一致);其余为外部 ACP 编码 agent。本阶段仅提供启动配置,接线在阶段 2。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpBackendId {
    /// 自家 Node Mastra 边车(默认后端,行为与历史一致)。
    Builtin,
    /// Kimi Code(@moonshot-ai/kimi-code):原生 ACP;优先工程内置包(node <入口> acp),否则回退裸 kimi acp;可经 XIAOJIANC_KIMI_EXE 覆盖为绝对路径。
    Kimi,
    /// Codex CLI:经社区适配器 `codex-acp`,凭 `OPENAI_API_KEY`。
    Codex,
}

/// 解析「默认后端(自家边车)」的启动配置。保持历史签名与行为不变:
/// 等价于 `build_acp_client_config_for(AcpBackendId::Builtin)`。
pub fn build_acp_client_config() -> Result<AcpClientConfig, String> {
    build_acp_client_config_for(AcpBackendId::Builtin)
}

/// 按后端标识解析 ACP stdio 子进程启动配置(ADR-0015 阶段 1:多后端启动注册表)。
///
/// `Builtin` 复用自家边车解析(node + ACP 入口 + 工具 env),行为与历史一致;
/// 外部后端给出「程序 + 参数 + env」描述,凭证经 env 注入(遵守 ADR-0009:密钥仅在
/// Rust/边车侧)。注意:本函数仅产出启动配置,尚未接入 runtime(接线见阶段 2)。
pub fn build_acp_client_config_for(backend: AcpBackendId) -> Result<AcpClientConfig, String> {
    match backend {
        AcpBackendId::Builtin => build_builtin_client_config(),
        AcpBackendId::Kimi => Ok(build_kimi_client_config()),
        AcpBackendId::Codex => Ok(build_codex_client_config()),
    }
}

/// 自家 Node 边车启动配置(原 `build_acp_client_config` 主体,逐字保留)。
///
/// `program` = 解析出的 node 绝对路径;`args` = ACP 入口(优先预编译产物,否则 tsx + 源码);
/// `env` = 子进程环境变量(工具所需 + 编译缓存)。
fn build_builtin_client_config() -> Result<AcpClientConfig, String> {
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

/// Kimi Code(Kimi CLI)启动配置:`kimi acp`(原生 ACP)。
///
/// 优先工程内置包 @moonshot-ai/kimi-code(node <绝对入口> acp),否则回退 kimi acp;可经 XIAOJIANC_KIMI_EXE 覆盖为绝对路径。
/// 鉴权由 Kimi CLI 自身负责(凭据落 ~/.kimi,登录由其自身流程处理),故此处不注入模型 env。
fn build_kimi_client_config() -> AcpClientConfig {
    // 1) 绝对路径覆盖优先:随包/非 PATH 安装的逃生舱,直接作为 program 执行 <exe> acp。
    if let Some(program) = env_or_user_env(KIMI_EXE_ENV) {
        return AcpClientConfig {
            program,
            args: vec!["acp".to_string()],
            env: Vec::new(),
        };
    }

    // 2) 工程内置 npm 包(@moonshot-ai/kimi-code):以 node <绝对入口> acp 运行,
    //    Windows 正确,绕开 node_modules/.bin/kimi shim 的 ENOENT。
    if let Some(config) = resolve_bundled_kimi_client_config() {
        return config;
    }

    // 3) 兜底:回退裸 kimi(系统 PATH);仅在既无 env 覆盖也未找到内置包时使用。
    AcpClientConfig {
        program: "kimi".to_string(),
        args: vec!["acp".to_string()],
        env: Vec::new(),
    }
}

/// 解析「工程内置」Kimi Code(@moonshot-ai/kimi-code,经 pnpm add -D 装入工程根 node_modules)
/// 的启动配置:node <绝对入口> acp。形态为 npm 包(JS CLI),以 node 直接运行绝对入口脚本——
/// 绝对入口绕开 Windows 上 node_modules/.bin/kimi.CMD shim 的 ENOENT(GUI 进程不继承终端
/// PATH)。node 解析复用 builtin 的 resolve_node_executable(随包 node 优先,再常见安装位置,
/// 最后 PATH)。任一步缺失则返回 None,交由上层兜底。
fn resolve_bundled_kimi_client_config() -> Option<AcpClientConfig> {
    let node = resolve_node_executable().ok()?;
    let package_dir = find_kimi_package_dir()?;
    let entry = resolve_package_bin_entry(&package_dir, "kimi")?;

    Some(AcpClientConfig {
        program: path_to_string(&node),
        args: vec![path_to_string(&entry), "acp".to_string()],
        env: Vec::new(),
    })
}

/// 在候选根的 node_modules/@moonshot-ai/kimi-code 下定位含 package.json 的包目录。
/// 候选根:随包资源根(打包态)在前,仓库工作区根(开发态,pnpm add -D 落此处的 node_modules)
/// 兜底——与 sidecar/node 的「随包优先,源码树兜底」解析策略一致。
fn find_kimi_package_dir() -> Option<PathBuf> {
    for root in kimi_package_search_roots() {
        let package_dir = root
            .join("node_modules")
            .join("@moonshot-ai")
            .join("kimi-code");
        if package_dir.join("package.json").is_file() {
            return Some(package_dir);
        }
    }
    None
}

/// 内置 Kimi 包的候选搜索根:随包资源根(打包态)在前,仓库工作区根(开发态)兜底。
fn kimi_package_search_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for root in crate::commands::shell_tools::bundled_resource_roots() {
        roots.push(root.to_path_buf());
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(workspace_root) = manifest_dir.parent() {
        roots.push(workspace_root.to_path_buf());
    }
    roots
}

/// 从包 package.json 的 bin 字段解析指定命令的入口脚本绝对路径。bin 可为字符串(单一入口)
/// 或对象(优先 bin_name,否则取首个值);入口相对包目录解析。字段缺失或入口文件不存在时
/// 返回 None。
fn resolve_package_bin_entry(package_dir: &Path, bin_name: &str) -> Option<PathBuf> {
    let manifest = fs::read_to_string(package_dir.join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    let relative = match value.get("bin")? {
        serde_json::Value::String(path) => path.clone(),
        serde_json::Value::Object(map) => map
            .get(bin_name)
            .or_else(|| map.values().next())
            .and_then(|entry| entry.as_str())
            .map(|entry| entry.to_string())?,
        _ => return None,
    };

    let entry = package_dir.join(relative);
    entry.is_file().then_some(entry)
}

/// Codex CLI 启动配置:经社区适配器 `codex-acp`(非原生 ACP)。
///
/// 可执行名默认 `codex-acp`,可经 `XIAOJIANC_CODEX_ACP_EXE` 覆盖。凭 `OPENAI_API_KEY`
/// 鉴权:优先进程/用户环境读取后注入子进程 env(遵守 ADR-0009:密钥仅在 Rust 侧)。
fn build_codex_client_config() -> AcpClientConfig {
    let program = env_or_user_env(CODEX_ACP_EXE_ENV).unwrap_or_else(|| "codex-acp".to_string());
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(key) = env_or_user_env(OPENAI_API_KEY_ENV) {
        env.push((OPENAI_API_KEY_ENV.to_string(), key));
    }
    AcpClientConfig {
        program,
        args: Vec::new(),
        env,
    }
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

        // Strip "export " prefix for Unix shell convention: export KEY=value
        let name = name.trim();
        let name = name.strip_prefix("export ").unwrap_or(name).trim();

        if name != key {
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

// ── Kimi Code 凭证预置（复用项目已保存的网关模型配置）────────────────────────────
//
// `kimi acp` 默认从 `~/.kimi/config.toml` 读取 provider / model / 凭证（见 kimi-cli「Config
// Files」文档）。本项目已在 AI 设置里保存了网关模型（selected_model + base_url）与逐厂商
// API Key（CredentialStore），统一由 `crate::ai::gateway::current_sidecar_model_config()`
// 组装。这里把它映射为一个 OpenAI 兼容（`openai_legacy`）provider 写入 `~/.kimi/config.toml`，
// 免去用户在终端 `/login`，直接复用项目内既有 Key——解决「acp protocol error:
// Authentication required」。
//
// 安全：仅在该文件「不存在」或「由本程序托管（含下方 marker）」时才写，绝不覆盖用户手动
// 维护 / OAuth 登录得到的 config.toml（无 marker 即视为用户自管，跳过并保留其既有登录）。
const KIMI_MANAGED_MARKER: &str = "# managed-by: calamex (ACP gateway bridge)";

/// 外部 ACP 后端拉起前的凭证预置（ADR-0015 / ADR-0009）。Kimi 之外为 no-op。
///
/// 副作用（FS 写）有意放在「真正拉起子进程」的 runtime spawn 路径，而非纯启动配置解析
/// `build_acp_client_config_for`（后者被单测覆盖，应保持无副作用）。失败仅记录、不阻断
/// 启动（回退 Kimi 自身既有登录）。
pub(crate) fn prepare_external_backend_launch(backend: AcpBackendId) {
    if backend != AcpBackendId::Kimi {
        return;
    }
    match ensure_kimi_managed_config() {
        Ok(true) => log::info!(
            target: "acp",
            "已用项目网关配置写入 ~/.kimi/config.toml（Kimi 复用项目内既有 Key）。"
        ),
        Ok(false) => log::info!(
            target: "acp",
            "跳过写入 ~/.kimi/config.toml（用户自管配置已存在，或项目未配置网关地址）；沿用 Kimi 既有登录。"
        ),
        Err(error) => log::warn!(
            target: "acp",
            "预置 ~/.kimi/config.toml 失败（回退 Kimi 既有登录）：{error}"
        ),
    }
}

/// 解析 `~/.kimi` 目录：优先 `KIMI_HOME`，否则用户主目录下 `.kimi`。
fn kimi_home_dir() -> Option<PathBuf> {
    if let Some(custom) = env_or_user_env("KIMI_HOME") {
        return Some(PathBuf::from(custom));
    }
    #[cfg(windows)]
    let home = env_or_user_env("USERPROFILE");
    #[cfg(not(windows))]
    let home = env_or_user_env("HOME");
    home.map(|value| PathBuf::from(value).join(".kimi"))
}

/// 用 Rust Debug 产出带引号且转义合法的字符串，等价于 TOML 基本字符串字面量。
fn toml_str(value: &str) -> String {
    format!("{value:?}")
}

/// 用项目已保存的网关模型配置渲染一份 Kimi `config.toml`（单 provider + 单 model）。
/// 固定内部名 `calamex-gateway` 作 provider/model 键，避免 model_id 里的 `/` 触发 TOML 路径解析。
fn render_kimi_config_toml(model_id: &str, api_key: &str, base_url: &str) -> String {
    let entry = "calamex-gateway";
    format!(
        "{marker}\ndefault_model = {entry_q}\n\n[providers.{entry}]\ntype = \"openai_legacy\"\nbase_url = {base_url_q}\napi_key = {api_key_q}\n\n[models.{entry}]\nprovider = {entry_q}\nmodel = {model_q}\nmax_context_size = 262144\n",
        marker = KIMI_MANAGED_MARKER,
        entry = entry,
        entry_q = toml_str(entry),
        base_url_q = toml_str(base_url),
        api_key_q = toml_str(api_key),
        model_q = toml_str(model_id),
    )
}

/// 在拉起 `kimi acp` 前确保 `~/.kimi/config.toml` 含可用凭证（复用项目已存网关配置）。
///
/// 返回 `Ok(true)`：已写入/刷新托管配置；`Ok(false)`：有意跳过（用户自管配置已存在，或项目
/// 尚无可桥接的网关地址）；`Err`：IO / 配置获取失败（调用方仅记录，不阻断启动）。
fn ensure_kimi_managed_config() -> Result<bool, String> {
    let Some(kimi_dir) = kimi_home_dir() else {
        return Err("无法定位用户主目录（~/.kimi）。".to_string());
    };
    let config_path = kimi_dir.join("config.toml");

    // 已存在且非本程序托管 → 视为用户自管（含 OAuth / 手动 Key），保留不动。
    if config_path.is_file() {
        let existing = fs::read_to_string(&config_path)
            .map_err(|error| format!("读取 ~/.kimi/config.toml 失败：{error}"))?;
        if !existing.contains(KIMI_MANAGED_MARKER) {
            return Ok(false);
        }
    }

    // 取项目已保存的主模型网关配置（selected_model + base_url + 逐厂商 Key）。
    let model_config = crate::ai::gateway::current_sidecar_model_config()?;
    let Some(base_url) = model_config
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        // 无显式网关地址时无法构造 openai_legacy provider；交回 Kimi 自身登录。
        return Ok(false);
    };

    let rendered =
        render_kimi_config_toml(&model_config.model_id, model_config.api_key.expose(), base_url);

    fs::create_dir_all(&kimi_dir).map_err(|error| format!("创建 ~/.kimi 目录失败：{error}"))?;
    fs::write(&config_path, rendered)
        .map_err(|error| format!("写入 ~/.kimi/config.toml 失败：{error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kimi_client_config_uses_acp_subcommand() {
        // Kimi Code 末位参数恒为 acp:env 覆盖 / 内置包(node <入口> acp)/ PATH 兜底三态统一,program 非空。
        let config = build_kimi_client_config();
        assert_eq!(config.args.last().map(String::as_str), Some("acp"));
        assert!(!config.program.trim().is_empty());
    }

    #[test]
    fn codex_client_config_has_no_positional_args() {
        // Codex 适配器 `codex-acp` 无位置参数;凭证经 env 注入(此处不断言 env 内容,
        // 因其依赖真实进程环境)。
        let config = build_codex_client_config();
        assert!(config.args.is_empty());
        assert!(!config.program.trim().is_empty());
    }

    #[test]
    fn backend_dispatch_routes_external_agents() {
        // 后端调度:Kimi 末位参数恒为 acp(三态统一),Codex 无位置参数,两者均能产出配置。
        let kimi = build_acp_client_config_for(AcpBackendId::Kimi).expect("kimi config");
        assert_eq!(kimi.args.last().map(String::as_str), Some("acp"));
        let codex = build_acp_client_config_for(AcpBackendId::Codex).expect("codex config");
        assert!(codex.args.is_empty());
    }

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
    fn find_dotenv_value_strips_export_prefix() {
        assert_eq!(
            find_dotenv_value("export TAVILY_API_KEY=tvly-exported", "TAVILY_API_KEY")
                .as_deref(),
            Some("tvly-exported")
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
