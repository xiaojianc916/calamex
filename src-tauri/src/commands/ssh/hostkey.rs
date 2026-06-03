//! 主机密钥（known_hosts）校验与变更处理。
//!
//! 当一个 *已知* 主机提供了 *不同* 的密钥时，`check_server_key` 无法阻塞等待用户
//! 输入。为此我们按 (host, port) 暂存刚呈现的密钥并拒绝握手；`connect_and_auth`
//! 随后报出结构化的 `ssh/host-key-changed::<fingerprint>` 错误，供 UI 警示用户，并在
//! 确认后调用 `trust_ssh_host_key` 记录新密钥。

use super::DEFAULT_SSH_PORT;
use russh::keys::HashAlg;
use std::{
    collections::HashMap,
    env,
    fs as std_fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

#[derive(Clone)]
pub(crate) struct PendingHostKey {
    pub(crate) key: russh::keys::PublicKey,
    pub(crate) fingerprint: String,
}

static PENDING_HOST_KEYS: LazyLock<Mutex<HashMap<(String, u16), PendingHostKey>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn stash_pending_host_key(host: &str, port: u16, pending: &PendingHostKey) {
    if let Ok(mut map) = PENDING_HOST_KEYS.lock() {
        map.insert((host.to_string(), port), pending.clone());
    }
}

pub(crate) fn take_pending_host_key(host: &str, port: u16) -> Option<PendingHostKey> {
    PENDING_HOST_KEYS
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&(host.to_string(), port)))
}

pub(crate) fn clear_pending_host_key(host: &str, port: u16) {
    if let Ok(mut map) = PENDING_HOST_KEYS.lock() {
        map.remove(&(host.to_string(), port));
    }
}

/// Outcome of verifying a presented host key against the user's `known_hosts`.
pub(crate) enum HostKeyVerdict {
    /// Key matches a known entry, or the host was previously unknown and we
    /// recorded the key (trust on first use).
    Accept,
    /// Host is known but presented a *different* key. Carries the new key so the
    /// caller can prompt the user and optionally trust it (replacing the old).
    Changed(PendingHostKey),
    /// Verification failed for any other reason (e.g. an unreadable known_hosts).
    Reject,
}

/// Trust-on-first-use host-key verification backed by the user's `known_hosts`.
pub(crate) fn verify_known_host(host: &str, port: u16, key: &russh::keys::PublicKey) -> HostKeyVerdict {
    match russh::keys::check_known_hosts(host, port, key) {
        Ok(true) => HostKeyVerdict::Accept,
        Ok(false) => {
            match russh::keys::known_hosts::learn_known_hosts(host, port, key) {
                Ok(()) => tracing::info!(
                    %host,
                    port,
                    "ssh: recorded new host key (trust on first use)"
                ),
                Err(e) => tracing::warn!(
                    %host,
                    port,
                    error = %e,
                    "ssh: failed to record host key to known_hosts"
                ),
            }
            HostKeyVerdict::Accept
        }
        // A known host presenting a different key surfaces as the typed
        // `KeyChanged` variant (possible MITM, but often a legitimate
        // rotation). Match the variant structurally instead of substring-
        // matching the Display text, which is fragile across versions/locales.
        Err(russh::keys::Error::KeyChanged { .. }) => {
            tracing::warn!(
                %host,
                port,
                "ssh: server host key changed – awaiting user confirmation"
            );
            let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
            HostKeyVerdict::Changed(PendingHostKey {
                key: key.clone(),
                fingerprint,
            })
        }
        Err(e) => {
            tracing::error!(
                %host,
                port,
                error = %e,
                "ssh: host key verification failed – refusing connection"
            );
            HostKeyVerdict::Reject
        }
    }
}

// ---- known_hosts file maintenance ----
fn known_hosts_file_path() -> Result<PathBuf, String> {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .map_err(|_| "无法定位用户主目录。".to_string())?;
    Ok(PathBuf::from(home).join(".ssh").join("known_hosts"))
}

pub(crate) fn replace_known_host_key(
    host: &str,
    port: u16,
    key: &russh::keys::PublicKey,
) -> Result<(), String> {
    let path = known_hosts_file_path()?;
    replace_known_host_key_in(&path, host, port, key)
}

fn replace_known_host_key_in(
    path: &Path,
    host: &str,
    port: u16,
    key: &russh::keys::PublicKey,
) -> Result<(), String> {
    if path.exists() {
        let content =
            std_fs::read_to_string(path).map_err(|e| format!("读取 known_hosts 失败：{e}"))?;
        let mut kept = String::with_capacity(content.len());
        for line in content.lines() {
            if known_hosts_line_targets_host(line, host, port) {
                continue; // drop the stale entry for this host
            }
            kept.push_str(line);
            kept.push('\n');
        }
        // 原子重写：避免在截断 + 重写之间崩溃 / 断电导致 known_hosts 内容丢失。
        atomic_rewrite(path, &kept)?;
    }
    russh::keys::known_hosts::learn_known_hosts_path(host, port, key, path)
        .map_err(|e| format!("写入 known_hosts 失败：{e}"))
}

/// 原子重写文件：先写入同目录下的临时文件，再 rename 覆盖目标，
/// 避免重写过程中崩溃 / 断电把 known_hosts 截断、丢失既有可信主机条目。
fn atomic_rewrite(path: &Path, contents: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("known_hosts");
    let temp_path = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(format!(".{file_name}.tmp")),
        _ => PathBuf::from(format!(".{file_name}.tmp")),
    };

    std_fs::write(&temp_path, contents.as_bytes())
        .map_err(|e| format!("写入 known_hosts 失败：{e}"))?;
    if let Err(e) = std_fs::rename(&temp_path, path) {
        let _ = std_fs::remove_file(&temp_path);
        return Err(format!("写入 known_hosts 失败：{e}"));
    }
    Ok(())
}

fn known_hosts_line_targets_host(line: &str, host: &str, port: u16) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return false;
    }
    let mut tokens = trimmed.split_whitespace();
    let Some(first) = tokens.next() else {
        return false;
    };
    let hosts_field = if first.starts_with('@') {
        match tokens.next() {
            Some(field) => field,
            None => return false,
        }
    } else {
        first
    };
    if hosts_field.starts_with('|') {
        return false;
    }
    let ported = format!("[{host}]:{port}");
    hosts_field.split(',').any(|pattern| {
        let pattern = pattern.trim();
        if port == DEFAULT_SSH_PORT {
            pattern == host || pattern == ported
        } else {
            pattern == ported
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_hosts_line_targets_host_matches_plain_and_ported_entries() {
        assert!(known_hosts_line_targets_host(
            "example.com ssh-ed25519 AAAAC3NzaC1lZDI1",
            "example.com",
            22,
        ));
        assert!(known_hosts_line_targets_host(
            "[example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1",
            "example.com",
            2222,
        ));
        assert!(!known_hosts_line_targets_host(
            "[example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1",
            "example.com",
            22,
        ));
        assert!(!known_hosts_line_targets_host(
            "|1|abcd|efgh ssh-ed25519 AAAAC3NzaC1lZDI1",
            "example.com",
            22,
        ));
        assert!(!known_hosts_line_targets_host("# a comment", "example.com", 22));
        assert!(known_hosts_line_targets_host(
            "@cert-authority example.com ssh-ed25519 AAAAC3NzaC1lZDI1",
            "example.com",
            22,
        ));
        assert!(known_hosts_line_targets_host(
            "other.example,example.com ssh-rsa AAAAB3Nza",
            "example.com",
            22,
        ));
    }

    #[test]
    fn atomic_rewrite_replaces_existing_contents() {
        let dir = std::env::temp_dir().join(format!("calamex_known_hosts_{}", std::process::id()));
        std_fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("known_hosts");
        std_fs::write(&path, "stale entry\n").expect("seed file");

        atomic_rewrite(&path, "fresh-a\nfresh-b\n").expect("atomic rewrite");

        assert_eq!(
            std_fs::read_to_string(&path).expect("read back"),
            "fresh-a\nfresh-b\n"
        );
        let _ = std_fs::remove_dir_all(&dir);
    }
}
