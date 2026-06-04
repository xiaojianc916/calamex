use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Mutex, OnceLock};

use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::errors;
use crate::commands::contracts::{
    AiAgentNetworkPermissionPayload, AiAgentSetNetworkPermissionRequest,
};

static NETWORK_PERMISSION: OnceLock<Mutex<String>> = OnceLock::new();

fn network_permission_state() -> &'static Mutex<String> {
    NETWORK_PERMISSION.get_or_init(|| Mutex::new("ask".to_string()))
}

pub fn current_permission() -> Result<String, String> {
    let guard = network_permission_state().lock().map_err(|_| {
        errors::error(
            "AI_AGENT_RUN_FAILED",
            "AI Agent 网络权限状态锁定失败，请稍后重试。",
        )
    })?;

    Ok(guard.clone())
}

pub fn set_network_permission(
    payload: AiAgentSetNetworkPermissionRequest,
) -> Result<AiAgentNetworkPermissionPayload, String> {
    let permission = payload.permission.trim();

    if !matches!(permission, "off" | "ask" | "allowed-this-run") {
        return Err(errors::error(
            "AI_AGENT_TOOL_NOT_ALLOWED",
            "AI Agent 网络权限值无效。",
        ));
    }

    let mut guard = network_permission_state().lock().map_err(|_| {
        errors::error(
            "AI_AGENT_RUN_FAILED",
            "AI Agent 网络权限状态锁定失败，请稍后重试。",
        )
    })?;

    *guard = permission.to_string();
    audit::emit(AiAuditEventKind::AgentPermissionChanged);

    Ok(AiAgentNetworkPermissionPayload {
        permission: permission.to_string(),
    })
}

pub fn ensure_network_allowed() -> Result<(), String> {
    match current_permission()?.as_str() {
        "allowed-this-run" => Ok(()),
        "off" => Err(errors::error(
            "AI_AGENT_NETWORK_NOT_ALLOWED",
            "AI Agent 网络访问已关闭。",
        )),
        "ask" => Err(errors::error(
            "AI_AGENT_TOOL_CONFIRMATION_REQUIRED",
            "AI Agent 联网前需要用户授权。",
        )),
        _ => Err(errors::error(
            "AI_AGENT_NETWORK_NOT_ALLOWED",
            "AI Agent 网络权限状态无效。",
        )),
    }
}

pub fn validate_public_http_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| errors::error("AI_AGENT_WEB_SOURCE_BLOCKED", "web_fetch URL 格式无效。"))?;

    match url.scheme() {
        "http" | "https" => {}
        _ => {
            return Err(errors::error(
                "AI_AGENT_WEB_SOURCE_BLOCKED",
                "web_fetch 只允许访问 http / https URL。",
            ));
        }
    }

    let Some(host) = url.host_str() else {
        return Err(errors::error(
            "AI_AGENT_WEB_SOURCE_BLOCKED",
            "web_fetch URL 缺少主机名。",
        ));
    };

    let host_lower = host.to_ascii_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".localhost") {
        return Err(errors::error(
            "AI_AGENT_WEB_SOURCE_BLOCKED",
            "web_fetch 禁止访问 localhost。",
        ));
    }

    let ip_candidate = host_lower.trim_matches(['[', ']']);
    if let Ok(ip) = ip_candidate.parse::<IpAddr>()
        && is_blocked_ip(ip) {
            return Err(errors::error(
                "AI_AGENT_WEB_SOURCE_BLOCKED",
                "web_fetch 禁止访问内网或本机 IP。",
            ));
        }

    Ok(url)
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => is_blocked_ipv4(value),
        IpAddr::V6(value) => is_blocked_ipv6(value),
    }
}

fn is_blocked_ipv4(value: Ipv4Addr) -> bool {
    let first = value.octets()[0];
    value.is_private()
        || value.is_loopback()
        || value.is_link_local()
        || value.is_unspecified()
        || value.is_multicast()
        || first == 0
        || first >= 240
        || first == 100 && (value.octets()[1] & 0xc0) == 64
}

fn is_blocked_ipv6(value: Ipv6Addr) -> bool {
    if let Some(mapped) = value.to_ipv4_mapped() {
        return is_blocked_ipv4(mapped);
    }
    let s0 = value.segments()[0];
    value.is_loopback()
        || value.is_unspecified()
        || (s0 & 0xfe00) == 0xfc00
        || (s0 & 0xffc0) == 0xfe80
        || (s0 & 0xff00) == 0xff00
}

#[cfg(test)]
mod tests {
    use super::{ensure_network_allowed, set_network_permission, validate_public_http_url};
    use crate::commands::contracts::AiAgentSetNetworkPermissionRequest;

    #[test]
    fn defaults_to_ask_and_requires_confirmation() {
        set_network_permission(AiAgentSetNetworkPermissionRequest {
            permission: "ask".to_string(),
        })
        .expect("reset permission to ask");

        let error = ensure_network_allowed().expect_err("ask should require confirmation");

        assert!(error.contains("AI_AGENT_TOOL_CONFIRMATION_REQUIRED"));
    }

    #[test]
    fn allows_network_after_explicit_approval() {
        set_network_permission(AiAgentSetNetworkPermissionRequest {
            permission: "allowed-this-run".to_string(),
        })
        .expect("set allowed permission");

        assert!(ensure_network_allowed().is_ok());

        set_network_permission(AiAgentSetNetworkPermissionRequest {
            permission: "ask".to_string(),
        })
        .expect("reset permission to ask");
    }

    #[test]
    fn rejects_local_and_private_targets() {
        for value in [
            "file:///C:/secret.txt",
            "ftp://example.com",
            "http://localhost:1420",
            "http://sub.localhost",
            "http://127.0.0.1:1420",
            "http://192.168.1.1",
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://169.254.169.254",
            "http://0.0.0.0",
            "http://100.64.0.1",
            "http://224.0.0.1",
            "http://255.255.255.255",
            "http://[::1]:8080",
            "http://[fe80::1]",
            "http://[fc00::1]",
            "http://[ff02::1]",
            "http://[::ffff:127.0.0.1]",
            "http://[::ffff:10.0.0.1]",
        ] {
            assert!(
                validate_public_http_url(value).is_err(),
                "{value} should be blocked"
            );
        }
    }

    #[test]
    fn accepts_public_http_targets() {
        assert!(validate_public_http_url("https://example.com/docs").is_ok());
        assert!(validate_public_http_url("http://example.com/docs").is_ok());
        assert!(validate_public_http_url("https://[2606:4700::1111]/").is_ok());
    }
}
