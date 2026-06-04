//! 解析 ~/.ssh/config 主机列表命令。

use super::DEFAULT_SSH_PORT;
use crate::commands::SshConfigHostPayload;
use std::{env, fs as std_fs, path::PathBuf};

const SSH_CONFIG_IMPORTED_LABEL: &str = "SSH config";

#[tauri::command]
#[specta::specta]
pub async fn list_ssh_config_hosts() -> Result<Vec<SshConfigHostPayload>, String> {
    let Some(config_path) = default_ssh_config_path() else {
        return Ok(Vec::new());
    };
    let content = match std_fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parse_ssh_config_hosts(&content))
}

fn default_ssh_config_path() -> Option<PathBuf> {
    if let Ok(home) = env::var("USERPROFILE").or_else(|_| env::var("HOME")) {
        let p = PathBuf::from(home).join(".ssh").join("config");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[derive(Default)]
struct SshConfigHostBuilder {
    name: Option<String>,
    username: String,
    host: String,
    port: u16,
    identity: Option<String>,
    has_proxyjump: bool,
}

impl SshConfigHostBuilder {
    fn new() -> Self {
        Self {
            port: DEFAULT_SSH_PORT,
            ..Default::default()
        }
    }

    fn flush(&mut self, hosts: &mut Vec<SshConfigHostPayload>) {
        if let Some(name) = self.name.take()
            && !name.contains('*') && !name.contains('!') {
                let host = if self.host.is_empty() || self.has_proxyjump {
                    if self.host.is_empty() {
                        name.clone()
                    } else {
                        self.host.clone()
                    }
                } else {
                    self.host.clone()
                };
                hosts.push(SshConfigHostPayload {
                    id: name.clone(),
                    name,
                    username: std::mem::take(&mut self.username),
                    host,
                    port: self.port,
                    identity_path: self.identity.take(),
                    last_used_label: SSH_CONFIG_IMPORTED_LABEL.into(),
                });
            }
        self.username.clear();
        self.host.clear();
        self.port = DEFAULT_SSH_PORT;
        self.identity = None;
        self.has_proxyjump = false;
    }
}

fn concrete_host_alias(patterns: &str) -> Option<String> {
    patterns
        .split_whitespace()
        .find(|p| !p.starts_with('!') && !p.contains('*') && !p.contains('?'))
        .map(|p| p.to_string())
}

fn parse_ssh_config_hosts(content: &str) -> Vec<SshConfigHostPayload> {
    let mut hosts: Vec<SshConfigHostPayload> = Vec::new();
    let mut cur = SshConfigHostBuilder::new();

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((keyword, value)) = split_ssh_config_line(line) else {
            continue;
        };
        match keyword.to_lowercase().as_str() {
            "host" => {
                cur.flush(&mut hosts);
                cur.name = concrete_host_alias(&value);
            }
            "hostname"
                if !value.contains('*') => {
                    cur.host = value;
                }
            "user" => cur.username = value,
            "port" => {
                if let Ok(p) = value.parse::<u16>() {
                    cur.port = p;
                }
            }
            "identityfile" => {
                let cleaned = value.trim_matches('"').trim_matches('\'');
                cur.identity = Some(cleaned.to_string());
            }
            "proxyjump" | "proxycommand" => cur.has_proxyjump = true,
            _ => {}
        }
    }
    cur.flush(&mut hosts);
    hosts
}

fn split_ssh_config_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let parts: Vec<&str> = trimmed
        .splitn(2, |c: char| c.is_ascii_whitespace() || c == '=')
        .collect();
    if parts.len() < 2 {
        return None;
    }
    let keyword = parts[0].trim().to_string();
    let value = parts[1].trim();
    let value = if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
    {
        value[1..value.len() - 1].to_string()
    } else {
        let comment_pos = value.find('#').unwrap_or(value.len());
        value[..comment_pos].trim().to_string()
    };
    Some((keyword, value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ssh_config_hosts_extracts_hostname_user_port_and_key() {
        let content = "Host dev-box\n  HostName 192.168.56.10\n  User ubuntu\n  Port 2202\n  IdentityFile ~/.ssh/dev key\n";
        let hosts = parse_ssh_config_hosts(content);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "dev-box");
        assert_eq!(hosts[0].host, "192.168.56.10");
        assert_eq!(hosts[0].username, "ubuntu");
        assert_eq!(hosts[0].port, 2202);
        assert_eq!(hosts[0].identity_path.as_deref(), Some("~/.ssh/dev key"));
    }

    #[test]
    fn parse_ssh_config_hosts_uses_alias_when_proxy_jump_is_required() {
        let content = "Host prod-app\n  HostName 10.0.12.31\n  User deploy\n  ProxyJump bastion\n  IdentityFile \"~/.ssh/prod # key\"\n";
        let hosts = parse_ssh_config_hosts(content);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "prod-app");
        assert_eq!(hosts[0].host, "10.0.12.31");
        assert_eq!(hosts[0].username, "deploy");
        assert_eq!(hosts[0].identity_path.as_deref(), Some("~/.ssh/prod # key"));
    }

    #[test]
    fn parse_ssh_config_hosts_resets_state_between_hosts() {
        let content = "Host a\n  HostName 10.0.0.1\n  ProxyJump bastion\nHost b\n  User root\n";
        let hosts = parse_ssh_config_hosts(content);
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[1].name, "b");
        assert_eq!(hosts[1].host, "b");
        assert_eq!(hosts[1].port, DEFAULT_SSH_PORT);
    }

    #[test]
    fn parse_ssh_config_hosts_filters_wildcard_aliases() {
        let content = "Host * !blocked concrete-host\n  User root\n";
        let hosts = parse_ssh_config_hosts(content);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "concrete-host");
    }
}
