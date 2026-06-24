//! 外部(及内置)ACP 后端的「凭证预置 + 启动配置」统一抽象与注册表(ADR-0015 通用化)。
//!
//! 背景:历史上「拉起前要不要 seed 凭证」与「用什么 program/args/env 启动」分散在
//! launch.rs 的 prepare_external_backend_launch / build_acp_client_config_for 两处 match,
//! 新增一个后端要同时改两处臂、易漏。这里把「每个后端怎么准备自己」收敛成一个 trait +
//! 注册表:新增 agent = 实现 ExternalAgentProvisioner + 在 provisioner_for 注册一行;
//! 凭证存储仍是单一事实源(keyring + credential::default_provider_base_url),不变。
//!
//! 自包含(ADR-0015 阶段 2):各外部后端(Kimi / Codex)的「启动配置构造 + 凭证 seed」实现已从
//! launch.rs 内联至本模块——每个 provisioner 自带 program/args/env 解析与配置文件预置,
//! launch.rs 仅保留自家 Node 边车(Builtin)的共享边车解析,以及若干被本模块复用的进程/路径/env
//! 基元(resolve_node_executable / path_to_string / env_or_user_env,经 pub(super) 暴露)。
//! 新增一个 ACP agent = 在本文件实现 ExternalAgentProvisioner + 在 provisioner_for 注册一行,
//! 无需再改 launch。
//!
//! 按 cargo feature acp_client 门控;接线前不影响现有路径。

#![allow(dead_code)]

use fs_err as fs;
use std::path::{Path, PathBuf};

use super::client::AcpClientConfig;
use super::launch::{self, env_or_user_env, path_to_string, resolve_node_executable, AcpBackendId};

// 外部 ACP 后端的可执行路径覆盖与凭证 env 键(ADR-0015)。
const KIMI_EXE_ENV: &str = "XIAOJIANC_KIMI_EXE";
const CODEX_ACP_EXE_ENV: &str = "XIAOJIANC_CODEX_ACP_EXE";
const OPENAI_API_KEY_ENV: &str = "OPENAI_API_KEY";

// Kimi Code 的 provider 级凭证 env 名与默认端点（官方文档核对：moonshotai.github.io/kimi-code）。
// 注意：`kimi acp` 服务经终端 `/login` 自持久化凭证（Kimi Code OAuth 或 Moonshot 开放平台
// API key，落 KIMI_CODE_HOME），并不从启动环境读取这些变量；故 build_kimi_client_config 不注入它们
// （子进程 env 仅注入 KIMI_CODE_HOME 指向托管目录）。此处仅作文档与未来「托管直连」之用，不改变运行时行为。
const KIMI_API_KEY_ENV: &str = "KIMI_API_KEY";
const KIMI_BASE_URL_ENV: &str = "KIMI_BASE_URL";
const KIMI_DEFAULT_BASE_URL: &str = "https://api.moonshot.ai/v1";

// calamex 托管 Kimi 配置目录：经 KIMI_CODE_HOME 环境变量把 kimi acp 子进程的配置目录指向本程序
// 自管目录(品牌存储根下 kimi-home)，使 seed 写入与子进程读取恒为同一份，避免被用户既有的
// 全局 ~/.kimi/config.toml 截断(详见 resolved_kimi_home / kimi_child_env)。
const KIMI_CODE_HOME_ENV: &str = "KIMI_CODE_HOME";
const KIMI_MANAGED_HOME_DIR: &str = "kimi-home";

// 托管 config.toml 的归属标记：写在文件首行，标明该 config.toml 由 calamex 完全接管。
// 自 KIMI_CODE_HOME 指向 calamex 自管目录(kimi-home，非全局 ~/.kimi)后，托管目录下的
// config.toml 恒由本程序覆盖写入(完全接管)；marker 仅作归属戳记与排查用途，不再用于
// 「是否跳过写入」的判断。
const KIMI_MANAGED_MARKER: &str = "# managed-by: calamex (ACP gateway bridge)";

/// 外部(及内置)ACP 后端的「自我准备」抽象:凭证预置 + stdio 启动配置。
///
/// 一个后端 = 一个实现 + 注册表里一行。runtime 拉起后端时:先 prepare() 预置凭证,
/// 再用 launch_config() 派生子进程。
pub trait ExternalAgentProvisioner {
    /// 该 provisioner 对应的后端标识。
    fn backend_id(&self) -> AcpBackendId;

    /// 拉起子进程前的凭证预置(side-effect:写该 agent 自己的配置文件 / 落 env)。
    /// 默认 no-op(内置边车与 Codex 暂无需 seed);Kimi 覆盖为写托管 KIMI_CODE_HOME/config.toml。
    /// 约定:绝不阻断启动——失败由实现内部记录日志并吞掉,回退该 agent 自身既有登录。
    fn prepare(&self) {}

    /// 该后端的 ACP stdio 启动配置(program / args / env)。
    fn launch_config(&self) -> Result<AcpClientConfig, String>;
}

/// 自家 Node 边车(默认后端):无需 seed;启动配置复用 launch 既有共享边车解析(行为与历史一致)。
pub struct BuiltinProvisioner;

impl ExternalAgentProvisioner for BuiltinProvisioner {
    fn backend_id(&self) -> AcpBackendId {
        AcpBackendId::Builtin
    }

    fn launch_config(&self) -> Result<AcpClientConfig, String> {
        launch::build_acp_client_config()
    }
}

/// Kimi Code:拉起前把项目网关凭证 seed 进托管 KIMI_CODE_HOME/config.toml;启动 kimi acp。
pub struct KimiProvisioner;

impl ExternalAgentProvisioner for KimiProvisioner {
    fn backend_id(&self) -> AcpBackendId {
        AcpBackendId::Kimi
    }

    fn prepare(&self) {
        // 凭证预置(side-effect:写托管 KIMI_CODE_HOME/config.toml)。best-effort + 分级日志,
        // 失败仅记录、不阻断启动(回退 Kimi 自身既有登录)。
        match ensure_kimi_managed_config() {
            Ok(true) => log::info!(
                target: "acp",
                "已用项目网关配置完全接管覆盖托管 KIMI_CODE_HOME 的 config.toml（Kimi 复用项目内既有 Key）。"
            ),
            Ok(false) => log::info!(
                target: "acp",
                "跳过写入托管 KIMI_CODE_HOME 的 config.toml（项目尚无可桥接的网关模型：主模型缺 Key 或其厂商无默认端点）；沿用 Kimi 既有登录。"
            ),
            Err(error) => log::warn!(
                target: "acp",
                "预置托管 KIMI_CODE_HOME 的 config.toml 失败（回退 Kimi 既有登录）：{error}"
            ),
        }
    }

    fn launch_config(&self) -> Result<AcpClientConfig, String> {
        Ok(build_kimi_client_config())
    }
}

/// Codex CLI:经社区 codex-acp 适配器,凭 OPENAI_API_KEY(注入子进程 env)。
pub struct CodexProvisioner;

impl ExternalAgentProvisioner for CodexProvisioner {
    fn backend_id(&self) -> AcpBackendId {
        AcpBackendId::Codex
    }

    fn launch_config(&self) -> Result<AcpClientConfig, String> {
        Ok(build_codex_client_config())
    }
}

/// 后端 → provisioner 的注册表。新增一个 ACP agent 后端 = 实现 ExternalAgentProvisioner
/// + 在此 match 增加一行(编译器的穷尽性检查会强制补齐)。
pub fn provisioner_for(backend: AcpBackendId) -> Box<dyn ExternalAgentProvisioner> {
    match backend {
        AcpBackendId::Builtin => Box::new(BuiltinProvisioner),
        AcpBackendId::Kimi => Box::new(KimiProvisioner),
        AcpBackendId::Codex => Box::new(CodexProvisioner),
    }
}

// ── 外部后端启动配置构造(自 launch.rs 内联;Builtin 仍委托 launch 的共享边车解析)──────────

/// Kimi Code（Kimi CLI）启动配置：`kimi acp`（原生 ACP）。
///
/// 优先工程内置包 @moonshot-ai/kimi-code（node <绝对入口> acp），否则回退 kimi acp；可经 XIAOJIANC_KIMI_EXE 覆盖为绝对路径。
/// 鉴权由 Kimi CLI 自身负责（凭据落托管 KIMI_CODE_HOME，登录由其自身流程处理），故此处不注入模型 env，仅注入 KIMI_CODE_HOME。
fn build_kimi_client_config() -> AcpClientConfig {
    // 1) 绝对路径覆盖优先：随包/非 PATH 安装的逃生舱，直接作为 program 执行 <exe> acp。
    if let Some(program) = env_or_user_env(KIMI_EXE_ENV) {
        return AcpClientConfig {
            program,
            args: vec!["acp".to_string()],
            env: kimi_child_env(),
        };
    }

    // 2) 工程内置 npm 包（@moonshot-ai/kimi-code）：以 node <绝对入口> acp 运行，
    //    Windows 正确，绕开 node_modules/.bin/kimi shim 的 ENOENT。
    if let Some(config) = resolve_bundled_kimi_client_config() {
        return config;
    }

    // 3) 兑底：回退裸 kimi（系统 PATH）；仅在既无 env 覆盖也未找到内置包时使用。
    AcpClientConfig {
        program: "kimi".to_string(),
        args: vec!["acp".to_string()],
        env: kimi_child_env(),
    }
}

/// 解析「工程内置」Kimi Code（@moonshot-ai/kimi-code，经 pnpm add -D 装入工程根 node_modules）
/// 的启动配置：node <绝对入口> acp。形态为 npm 包（JS CLI），以 node 直接运行绝对入口脚本——
/// 绝对入口绕开 Windows 上 node_modules/.bin/kimi.CMD shim 的 ENOENT（GUI 进程不继承终端
/// PATH）。node 解析复用 builtin 的 resolve_node_executable（随包 node 优先，再常见安装位置,
/// 最后 PATH）。任一步缺失则返回 None，交由上层兑底。
fn resolve_bundled_kimi_client_config() -> Option<AcpClientConfig> {
    let node = resolve_node_executable().ok()?;
    let package_dir = find_kimi_package_dir()?;
    let entry = resolve_package_bin_entry(&package_dir, "kimi")?;

    Some(AcpClientConfig {
        program: path_to_string(&node),
        args: vec![path_to_string(&entry), "acp".to_string()],
        env: kimi_child_env(),
    })
}

/// 在候选根的 node_modules/@moonshot-ai/kimi-code 下定位含 package.json 的包目录。
/// 候选根：随包资源根（打包态）在前，仓库工作区根（开发态，pnpm add -D 落此处的 node_modules）
/// 兑底——与 sidecar/node 的「随包优先，源码树兑底」解析策略一致。
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

/// 内置 Kimi 包的候选搜索根：随包资源根（打包态）在前，仓库工作区根（开发态）兑底。
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

/// 从包 package.json 的 bin 字段解析指定命令的入口脚本绝对路径。bin 可为字符串（单一入口）
/// 或对象（优先 bin_name，否则取首个值）；入口相对包目录解析。字段缺失或入口文件不存在时
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

/// Codex CLI 启动配置：经社区适配器 `codex-acp`（非原生 ACP）。
///
/// 可执行名默认 `codex-acp`，可经 `XIAOJIANC_CODEX_ACP_EXE` 覆盖。凭 `OPENAI_API_KEY`
/// 鉴权：优先进程/用户环境读取后注入子进程 env（遵守 ADR-0009：密钥仅在 Rust 侧）。
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

// ── Kimi Code 凭证预置（复用项目已保存的网关模型配置）────────────────
//
// `kimi acp` 从 `KIMI_CODE_HOME/config.toml` 读取 provider / model / 凭证（默认 `~/.kimi`，本程序经
// kimi_child_env 注入 KIMI_CODE_HOME 指向托管目录，见 kimi-cli「Config Files」文档）。本项目已在
// AI 设置里保存了网关模型（selected_model + base_url）与逐API Key（CredentialStore），
// 统一由 `crate::ai::gateway::current_sidecar_model_config()` 组装。这里把它映射为一个 OpenAI
// 兼容（`openai`）provider 写入托管 KIMI_CODE_HOME 的 config.toml，免去用户在终端 `/login`，
// 直接复用项目内既有 Key——解决「acp protocol error: Authentication required」。
//
// 接管策略：KIMI_CODE_HOME 指向 calamex 自管目录（kimi-home，非全局 ~/.kimi），该托管目录下的
// config.toml 由本程序「完全接管」——每次拉起前恒以项目网关配置覆盖写入（用户在此托管目录内的手动
// `/login` 会被清掉）。要用 Kimi 托管模型，请在 AI 设置里选 moonshotai 厂商 + 填 Key，走同一份 seed。

/// 解析「calamex 托管」的 Kimi 配置目录。优先外部显式 KIMI_CODE_HOME(逃生舱：用户/CI 可强制
/// 指向自管目录)，否则用 calamex 自管目录(品牌存储根下 kimi-home，如 ~/.calamex/kimi-home)。
/// 不再回退全局 ~/.kimi——避免被用户既有的、非本程序托管的全局 config.toml 截断
/// (那会导致 seed 跳过、kimi acp 子进程无凭证而报 Authentication required)。
fn resolved_kimi_home() -> PathBuf {
    if let Some(custom) = env_or_user_env(KIMI_CODE_HOME_ENV) {
        return PathBuf::from(custom);
    }
    managed_kimi_home()
}

/// calamex 自管的 Kimi home：品牌存储根下 kimi-home(如 ~/.calamex/kimi-home)。
/// 与 storage_paths::local_root() 同源，保证 seed 写入路径与子进程读取路径恒一致。
fn managed_kimi_home() -> PathBuf {
    crate::storage_paths::local_root().join(KIMI_MANAGED_HOME_DIR)
}

/// 拉起 kimi acp 子进程时注入的 env：把 KIMI_CODE_HOME 指向 calamex 托管目录，
/// 使子进程读取的 config.toml 与 ensure_kimi_managed_config 写入的恒为同一份。
fn kimi_child_env() -> Vec<(String, String)> {
    vec![(
        KIMI_CODE_HOME_ENV.to_string(),
        path_to_string(&resolved_kimi_home()),
    )]
}

/// 解析 Kimi 配置目录(供 seed 写入)。委托 resolved_kimi_home，恒返回 Some，
/// 与子进程注入的 KIMI_CODE_HOME 指向同一目录。
fn kimi_home_dir() -> Option<PathBuf> {
    Some(resolved_kimi_home())
}

/// 用 Rust Debug 产出带引号且转义合法的字符串，等价于 TOML 基本字符串字面量。
fn toml_str(value: &str) -> String {
    format!("{value:?}")
}

/// Kimi 凭证预置所需的「厂商 → 默认 OpenAI 兼容端点」解析，委托至单一事实源
/// [`crate::ai::credential::default_provider_base_url`]。
///
/// 当用户未在 AI 设置里显式填写「Provider 地址」时，网关配置的 base_url 为空，但 Kimi 的
/// `openai` provider 必须有一个 base_url 才能复用项目内既存 Key——否则
/// `collect_kimi_model_entry` 返回 None、整份 config.toml 被跳过，`kimi acp` 启动无凭证而报
/// 「acp protocol error: Authentication required」。
///
/// 端点表此前在本文件与主链路 sidecar 各写一份（双写易漂移），现已统一收敛到
/// `ai::credential::default_provider_base_url`；本函数仅作薄封装，保留既有调用点与单测。
fn default_gateway_base_url(platform: &str) -> Option<&'static str> {
    crate::ai::credential::default_provider_base_url(platform)
}

/// 单个 Kimi provider 条目（openai：复用项目内某平台的网关地址 + Key）。
struct KimiProviderEntry {
    /// TOML 安全的 provider 裸键（由平台名清洗而来）。
    name: String,
    base_url: String,
    api_key: String,
}

/// 单个 Kimi model 条目（provider 指向同名 KimiProviderEntry）。
struct KimiModelEntry {
    /// TOML 安全的 model 裸键（由 model_id 清洗而来）。
    name: String,
    /// 所属 provider 的 TOML 裸键。
    provider: String,
    /// 原始 model_id（写入 model = ...，保留厂商前缀）。
    model_id: String,
}

/// 一个待写入的网关模型解析结果：provider 与 model 成对出现。
struct KimiSeedEntry {
    provider: KimiProviderEntry,
    model: KimiModelEntry,
}

/// 把任意标识（平台名 / model_id）清洗成 TOML 裸键安全形式：仅保留 ASCII 字母数字与 _ -，
/// 其余字符（含 model_id 里的 /）替换为 -；清洗后为空时回退占位，避免空键。
fn toml_key_sanitize(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    // 全部为非字母数字字符(清洗后只剩连字符/下划线、无实际内容)也视为空，回退占位，
    // 避免产生形如 "---" 的无意义 TOML 裸键(原 is_empty 漏掉了这种情况)。
    if !sanitized.chars().any(|ch| ch.is_ascii_alphanumeric()) {
        "calamex-gateway".to_string()
    } else {
        sanitized
    }
}

/// 把一个 sidecar 模型配置解析成「provider + model」成对条目。base_url 经统一凭证解析器
/// credential::resolve_provider_base_url 派生（用户显式网关地址优先，否则回退该厂商默认 OpenAI
/// 兼容端点）；仅当 model_id 为空，或厂商既无显式地址又无默认端点时返回 None，交由调用方跳过或回退。
fn collect_kimi_model_entry(
    config: &crate::commands::contracts::AgentSidecarModelConfigPayload,
) -> Option<KimiSeedEntry> {
    let model_id = config.model_id.trim();
    if model_id.is_empty() {
        return None;
    }
    let platform = model_id
        .split_once('/')
        .map(|(platform, _)| platform.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(model_id);
    // base_url：经统一凭证解析器 credential::resolve_provider_base_url 派生——显式网关地址优先，
    // 缺失则回退该厂商默认 OpenAI 兼容端点；与内置边车 / 未来其他 agent 共用同一处解析（单一事实源），
    // 不再本地复制「显式优先、否则默认」控制流。返回 None（既无显式地址也无默认端点）时整体跳过、
    // 交回 Kimi 自身登录——此即修复 Authentication required 的关键路径。
    let base_url =
        crate::ai::credential::resolve_provider_base_url(platform, config.base_url.as_deref())?;
    let provider_name = toml_key_sanitize(platform);
    Some(KimiSeedEntry {
        provider: KimiProviderEntry {
            name: provider_name.clone(),
            base_url,
            api_key: config.api_key.expose().to_string(),
        },
        model: KimiModelEntry {
            name: toml_key_sanitize(model_id),
            provider: provider_name,
            model_id: model_id.to_string(),
        },
    })
}

/// 把一对 provider/model 并入累积列表：provider 按 TOML 键去重（同平台只写一次，沿用首次
/// 出现的 base_url/Key），model 按 TOML 键去重（同模型只写一次）。
fn push_kimi_entry(
    providers: &mut Vec<KimiProviderEntry>,
    models: &mut Vec<KimiModelEntry>,
    entry: KimiSeedEntry,
) {
    if !providers
        .iter()
        .any(|item| item.name == entry.provider.name)
    {
        providers.push(entry.provider);
    }
    if !models.iter().any(|item| item.name == entry.model.name) {
        models.push(entry.model);
    }
}

/// 用项目已保存的网关模型配置渲染一份 Kimi config.toml（多 provider + 多 model）。
/// default_model 指向当前所选主模型；TOML 键均经 toml_key_sanitize 清洗。
fn render_kimi_config_toml(
    default_model: &str,
    providers: &[KimiProviderEntry],
    models: &[KimiModelEntry],
) -> String {
    let mut out = String::new();
    out.push_str(KIMI_MANAGED_MARKER);
    out.push_str(&format!(
        r#"
default_model = {}
"#,
        toml_str(default_model)
    ));

    for provider in providers {
        out.push_str(&format!(
            r#"
[providers.{name}]
type = "openai"
base_url = {base_url_q}
api_key = {api_key_q}
"#,
            name = provider.name,
            base_url_q = toml_str(&provider.base_url),
            api_key_q = toml_str(&provider.api_key),
        ));
    }

    for model in models {
        out.push_str(&format!(
            r#"
[models.{name}]
provider = {provider_q}
model = {model_q}
max_context_size = 262144
"#,
            name = model.name,
            provider_q = toml_str(&model.provider),
            model_q = toml_str(&model.model_id),
        ));
    }

    out
}

/// 在拉起 `kimi acp` 前确保托管 KIMI_CODE_HOME 的 `config.toml` 含可用凭证（复用项目已存网关配置）。
///
/// 返回 `Ok(true)`：已写入/刷新托管配置；`Ok(false)`：有意跳过（项目尚无可桥接的网关模型——
/// 主模型缺 Key 或其厂商无默认端点）；`Err`：IO / 配置获取失败（调用方仅记录，不阻断启动）。
///
/// 完全接管：托管 KIMI_CODE_HOME 下的 config.toml 恒被覆盖写入，不再因「已存在且无 marker」而跳过——
/// 托管目录是 calamex 自管的 kimi-home（非全局 ~/.kimi），用户在该目录内的手动 `/login` 会被清掉。
fn ensure_kimi_managed_config() -> Result<bool, String> {
    let Some(kimi_dir) = kimi_home_dir() else {
        return Err("无法定位托管 KIMI_CODE_HOME 目录。".to_string());
    };
    let config_path = kimi_dir.join("config.toml");

    // 收集可桥接的网关模型：主模型必备（缺网关地址且无默认端点则整体跳过，交回 Kimi 登录），
    // Narrator 为尽力而为的附加模型（解析失败仅跳过该条，不影响主模型 seed）。
    let main_config = crate::ai::gateway::current_sidecar_model_config()?;
    let Some(default_entry) = collect_kimi_model_entry(&main_config) else {
        // 主模型既无显式网关地址、其厂商也无默认 OpenAI 兼容端点时，无法构造 openai
        // provider；交回 Kimi 自身登录。
        return Ok(false);
    };

    let default_model_name = default_entry.model.name.clone();
    let mut providers: Vec<KimiProviderEntry> = Vec::new();
    let mut models: Vec<KimiModelEntry> = Vec::new();
    push_kimi_entry(&mut providers, &mut models, default_entry);

    // Narrator 模型：已配置且凭证可解析时附加为可切换模型；否则静默跳过。
    if let Ok(narrator_config) = crate::ai::gateway::narrator_sidecar_model_config()
        && let Some(entry) = collect_kimi_model_entry(&narrator_config)
    {
        push_kimi_entry(&mut providers, &mut models, entry);
    }

    // 全量「可原生切换」清单：前端持久化下发（seeded_models）中、用户有 Key 的模型逐条附加，
    // 使 Kimi 启动即把整张清单写入 config.toml → 原生 session/set_config_option 覆盖全部模型、
    // 切换零重启。逐条 best-effort：缺凭证/无默认端点者已在 seeded_sidecar_model_configs /
    // collect_kimi_model_entry 内跳过；provider 与 model 均按 TOML 键去重，与 main/narrator 重叠者自然合并。
    for seeded in crate::ai::gateway::seeded_sidecar_model_configs() {
        if let Some(entry) = collect_kimi_model_entry(&seeded) {
            push_kimi_entry(&mut providers, &mut models, entry);
        }
    }

    let rendered = render_kimi_config_toml(&default_model_name, &providers, &models);

    fs::create_dir_all(&kimi_dir).map_err(|error| format!("创建托管 KIMI_CODE_HOME 目录失败：{error}"))?;
    fs::write(&config_path, rendered)
        .map_err(|error| format!("写入托管 KIMI_CODE_HOME 的 config.toml 失败：{error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_maps_each_backend_to_matching_provisioner() {
        for backend in [
            AcpBackendId::Builtin,
            AcpBackendId::Kimi,
            AcpBackendId::Codex,
        ] {
            assert_eq!(provisioner_for(backend).backend_id(), backend);
        }
    }

    #[test]
    fn kimi_provisioner_launch_config_uses_acp_subcommand() {
        // launch_config 为纯解析(只读 FS、不写),可安全单测;Kimi 末位参数恒为 acp。
        let config = KimiProvisioner
            .launch_config()
            .expect("kimi launch config");
        assert_eq!(config.args.last().map(String::as_str), Some("acp"));
        assert!(!config.program.trim().is_empty());
    }

    #[test]
    fn codex_provisioner_launch_config_has_no_positional_args() {
        let config = CodexProvisioner
            .launch_config()
            .expect("codex launch config");
        assert!(config.args.is_empty());
    }

    #[test]
    fn builtin_and_codex_prepare_are_noop() {
        // 默认 prepare 不做任何事(不 panic、无 FS 副作用);仅 Kimi 覆盖为 seed,
        // 故此处不调用 Kimi.prepare()(其会写托管 config.toml 并读网关配置)。
        BuiltinProvisioner.prepare();
        CodexProvisioner.prepare();
    }

    #[test]
    fn kimi_child_env_injects_managed_kimi_home() {
        // 子进程 env 注入 KIMI_CODE_HOME，指向 calamex 托管目录(resolved_kimi_home)，
        // 保证 seed 写入与子进程读取路径一致；该 env 恰含一项且非空。
        let env = kimi_child_env();
        assert_eq!(env.len(), 1);
        let (key, value) = &env[0];
        assert_eq!(key, KIMI_CODE_HOME_ENV);
        assert_eq!(value, &path_to_string(&resolved_kimi_home()));
        assert!(!value.trim().is_empty());
    }

    #[test]
    fn toml_key_sanitize_replaces_slash_and_unsafe_chars() {
        assert_eq!(
            toml_key_sanitize("deepseek/deepseek-v4-pro"),
            "deepseek-deepseek-v4-pro"
        );
        assert_eq!(toml_key_sanitize("zhipuai"), "zhipuai");
        assert_eq!(toml_key_sanitize("  a.b:c  "), "a-b-c");
        assert_eq!(toml_key_sanitize("///"), "calamex-gateway");
    }

    #[test]
    fn default_gateway_base_url_covers_supported_providers() {
        // 与 credential::supported_provider_ids() 对齐：每个受支持厂商都有默认 OpenAI 兼容端点，
        // 避免出现「有 Key 却因无默认端点被跳过」的盲区。
        for provider_id in crate::ai::credential::supported_provider_ids() {
            assert!(
                default_gateway_base_url(provider_id).is_some(),
                "缺少厂商默认端点：{provider_id}"
            );
        }
        // 关键厂商端点与同源常量保持一致。
        assert_eq!(
            default_gateway_base_url("deepseek"),
            Some("https://api.deepseek.com/v1")
        );
        assert_eq!(default_gateway_base_url("moonshotai"), Some(KIMI_DEFAULT_BASE_URL));
        // 前后空白容忍；未知厂商无默认端点。
        assert_eq!(
            default_gateway_base_url("  zhipuai  "),
            Some("https://open.bigmodel.cn/api/paas/v4")
        );
        assert_eq!(default_gateway_base_url("unknown-vendor"), None);
    }

    #[test]
    fn collect_kimi_model_entry_falls_back_to_default_endpoint() {
        // 网关配置未携带 base_url（最常见：用户未手填 Provider 地址）时，按厂商回退默认端点而非
        // 整体跳过——这是修复 Authentication required 的关键路径。
        let config = crate::commands::contracts::AgentSidecarModelConfigPayload {
            model_id: "zhipuai/glm-4-flash".to_string(),
            api_key: "sk-zhipu".into(),
            base_url: None,
        };
        let entry = collect_kimi_model_entry(&config).expect("应回退默认端点而非跳过");
        assert_eq!(entry.provider.name, "zhipuai");
        assert_eq!(
            entry.provider.base_url,
            "https://open.bigmodel.cn/api/paas/v4"
        );
        assert_eq!(entry.provider.api_key, "sk-zhipu");
        assert_eq!(entry.model.model_id, "zhipuai/glm-4-flash");
    }

    #[test]
    fn collect_kimi_model_entry_prefers_explicit_base_url() {
        // 用户显式填写的网关地址优先于默认端点。
        let config = crate::commands::contracts::AgentSidecarModelConfigPayload {
            model_id: "deepseek/deepseek-v4-pro".to_string(),
            api_key: "sk-deepseek".into(),
            base_url: Some("https://gw.example/v1".to_string()),
        };
        let entry = collect_kimi_model_entry(&config).expect("有显式地址应能解析");
        assert_eq!(entry.provider.base_url, "https://gw.example/v1");
    }

    #[test]
    fn collect_kimi_model_entry_skips_unknown_provider_without_base_url() {
        // 厂商既无显式地址也无默认端点时仍返回 None（交回 Kimi 自身登录）。
        let config = crate::commands::contracts::AgentSidecarModelConfigPayload {
            model_id: "mystery/some-model".to_string(),
            api_key: "sk-x".into(),
            base_url: None,
        };
        assert!(collect_kimi_model_entry(&config).is_none());
    }

    #[test]
    fn render_kimi_config_toml_emits_marker_default_and_blocks() {
        let providers = vec![KimiProviderEntry {
            name: "deepseek".to_string(),
            base_url: "https://gw.example/v1".to_string(),
            api_key: "sk-secret".to_string(),
        }];
        let models = vec![KimiModelEntry {
            name: "deepseek-deepseek-v4-pro".to_string(),
            provider: "deepseek".to_string(),
            model_id: "deepseek/deepseek-v4-pro".to_string(),
        }];
        let rendered = render_kimi_config_toml("deepseek-deepseek-v4-pro", &providers, &models);
        assert!(rendered.starts_with(KIMI_MANAGED_MARKER));
        assert!(rendered.contains("default_model = "));
        assert!(rendered.contains("[providers.deepseek]"));
        assert!(rendered.contains("openai"));
        assert!(rendered.contains("base_url = "));
        assert!(rendered.contains("[models.deepseek-deepseek-v4-pro]"));
        assert!(rendered.contains("deepseek/deepseek-v4-pro"));
        assert!(rendered.contains("max_context_size = 262144"));
    }

    #[test]
    fn push_kimi_entry_dedupes_providers_keeps_distinct_models() {
        let mut providers: Vec<KimiProviderEntry> = Vec::new();
        let mut models: Vec<KimiModelEntry> = Vec::new();
        let make = |platform: &str, model: &str| KimiSeedEntry {
            provider: KimiProviderEntry {
                name: toml_key_sanitize(platform),
                base_url: "https://gw.example/v1".to_string(),
                api_key: "sk-xxx".to_string(),
            },
            model: KimiModelEntry {
                name: toml_key_sanitize(model),
                provider: toml_key_sanitize(platform),
                model_id: model.to_string(),
            },
        };
        push_kimi_entry(&mut providers, &mut models, make("deepseek", "deepseek/a"));
        push_kimi_entry(&mut providers, &mut models, make("deepseek", "deepseek/b"));
        // 同平台 provider 只保留一次；两个不同模型都保留。
        assert_eq!(providers.len(), 1);
        assert_eq!(models.len(), 2);
    }

    #[test]
    fn render_kimi_config_toml_emits_all_seeded_models_and_dedup_providers() {
        // 模拟「整张清单 seed」：多模型跨两个厂商，provider 去重为 2、model 全保留为 3。
        let providers = vec![
            KimiProviderEntry {
                name: "deepseek".to_string(),
                base_url: "https://api.deepseek.com/v1".to_string(),
                api_key: "sk-d".to_string(),
            },
            KimiProviderEntry {
                name: "zhipuai".to_string(),
                base_url: "https://open.bigmodel.cn/api/paas/v4".to_string(),
                api_key: "sk-z".to_string(),
            },
        ];
        let models = vec![
            KimiModelEntry {
                name: "deepseek-deepseek-v4-pro".to_string(),
                provider: "deepseek".to_string(),
                model_id: "deepseek/deepseek-v4-pro".to_string(),
            },
            KimiModelEntry {
                name: "deepseek-deepseek-chat".to_string(),
                provider: "deepseek".to_string(),
                model_id: "deepseek/deepseek-chat".to_string(),
            },
            KimiModelEntry {
                name: "zhipuai-glm-4-7-flash".to_string(),
                provider: "zhipuai".to_string(),
                model_id: "zhipuai/glm-4.7-flash".to_string(),
            },
        ];
        let rendered = render_kimi_config_toml("deepseek-deepseek-v4-pro", &providers, &models);
        assert_eq!(rendered.matches("[providers.").count(), 2);
        assert_eq!(rendered.matches("[models.").count(), 3);
        assert!(rendered.contains("deepseek/deepseek-chat"));
        assert!(rendered.contains("zhipuai/glm-4.7-flash"));
    }
}
