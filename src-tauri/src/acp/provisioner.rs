//! 外部(及内置)ACP 后端的「凭证预置 + 启动配置」统一抽象与注册表(ADR-0015 通用化)。
//!
//! 背景:历史上「拉起前要不要 seed 凭证」与「用什么 program/args/env 启动」分散在
//! launch.rs 的 prepare_external_backend_launch / build_acp_client_config_for 两处 match,
//! 新增一个后端要同时改两处臂、易漏。这里把「每个后端怎么准备自己」收敛成一个 trait +
//! 注册表:新增 agent = 实现 ExternalAgentProvisioner + 在 provisioner_for 注册一行;
//! 凭证存储仍是单一事实源(keyring + credential::default_provider_base_url),不变。
//!
//! 迁移遵循本目录既定的「先加新层 → cargo 验证 → 绿了再切 → 最后删旧」:本阶段各 provisioner
//! 仅「委托」到 launch.rs 既有自由函数(行为零变化),runtime 接线见后续阶段;待接线稳定后再把
//! 实现内联进各 Provisioner、移除旧自由函数。
//!
//! 按 cargo feature acp_client 门控;接线前不影响现有路径。

#![allow(dead_code)]

use super::client::AcpClientConfig;
use super::launch::{self, AcpBackendId};

/// 外部(及内置)ACP 后端的「自我准备」抽象:凭证预置 + stdio 启动配置。
///
/// 一个后端 = 一个实现 + 注册表里一行。runtime 拉起后端时:先 prepare() 预置凭证,
/// 再用 launch_config() 派生子进程。
pub trait ExternalAgentProvisioner {
    /// 该 provisioner 对应的后端标识。
    fn backend_id(&self) -> AcpBackendId;

    /// 拉起子进程前的凭证预置(side-effect:写该 agent 自己的配置文件 / 落 env)。
    /// 默认 no-op(内置边车与 Codex 暂无需 seed);Kimi 覆盖为写托管 KIMI_HOME/config.toml。
    /// 约定:绝不阻断启动——失败由实现内部记录日志并吞掉,回退该 agent 自身既有登录。
    fn prepare(&self) {}

    /// 该后端的 ACP stdio 启动配置(program / args / env)。
    fn launch_config(&self) -> Result<AcpClientConfig, String>;
}

/// 自家 Node 边车(默认后端):无需 seed;启动配置复用 launch 既有解析(行为与历史一致)。
pub struct BuiltinProvisioner;

impl ExternalAgentProvisioner for BuiltinProvisioner {
    fn backend_id(&self) -> AcpBackendId {
        AcpBackendId::Builtin
    }

    fn launch_config(&self) -> Result<AcpClientConfig, String> {
        launch::build_acp_client_config_for(AcpBackendId::Builtin)
    }
}

/// Kimi Code:拉起前把项目网关凭证 seed 进托管 KIMI_HOME/config.toml;启动 kimi acp。
pub struct KimiProvisioner;

impl ExternalAgentProvisioner for KimiProvisioner {
    fn backend_id(&self) -> AcpBackendId {
        AcpBackendId::Kimi
    }

    fn prepare(&self) {
        // 委托 launch 既有 seed(内部已 best-effort + 分级日志);本阶段不改变其行为。
        launch::prepare_external_backend_launch(AcpBackendId::Kimi);
    }

    fn launch_config(&self) -> Result<AcpClientConfig, String> {
        launch::build_acp_client_config_for(AcpBackendId::Kimi)
    }
}

/// Codex CLI:经社区 codex-acp 适配器,凭 OPENAI_API_KEY(由 launch 注入子进程 env)。
pub struct CodexProvisioner;

impl ExternalAgentProvisioner for CodexProvisioner {
    fn backend_id(&self) -> AcpBackendId {
        AcpBackendId::Codex
    }

    fn launch_config(&self) -> Result<AcpClientConfig, String> {
        launch::build_acp_client_config_for(AcpBackendId::Codex)
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
}
