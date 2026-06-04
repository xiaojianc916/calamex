//! 建链、认证、SFTP 会话获取，以及连接性测试 / 主机密钥信任命令。

use super::hostkey::{
    clear_pending_host_key, replace_known_host_key, stash_pending_host_key, take_pending_host_key,
    verify_known_host, HostKeyVerdict, PendingHostKey,
};
use super::SshConnectionParams;
use crate::commands::ssh_pool::POOL;
use crate::commands::{SshConnectionTestPayload, SshConnectionTestRequest};
use russh::{
    cipher,
    client::{connect, Handle},
    compression, kex,
    keys::{load_secret_key, Algorithm, EcdsaCurve, HashAlg, PrivateKeyWithHashAlg},
    mac, Preferred,
};
use russh_sftp::client::SftpSession;
use std::{
    env,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::timeout;

// ---- constants ----
const SSH_CONNECT_TIMEOUT_SECONDS: u64 = 8;
const SSH_TEST_TIMEOUT: Duration = Duration::from_secs(12);

/// Structured error-code prefix surfaced to the UI when a known host presents a
/// changed key. The full error/message is `ssh/host-key-changed::<fingerprint>`.
const HOST_KEY_CHANGED_CODE: &str = "ssh/host-key-changed";

// ---- optimized SSH algorithm preferences ----
pub(crate) const OPTIMIZED_SSH_PREFERRED: Preferred = Preferred {
    kex: std::borrow::Cow::Borrowed(&[
        kex::CURVE25519,
        kex::MLKEM768X25519_SHA256,
        kex::ECDH_SHA2_NISTP256,
        kex::ECDH_SHA2_NISTP384,
        kex::DH_GEX_SHA256,
        kex::EXTENSION_SUPPORT_AS_CLIENT,
        kex::EXTENSION_SUPPORT_AS_SERVER,
        kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
        kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
    ]),
    key: std::borrow::Cow::Borrowed(&[
        Algorithm::Ed25519,
        Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
        Algorithm::Rsa { hash: Some(HashAlg::Sha256) },
        Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
        Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
        Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
    ]),
    cipher: std::borrow::Cow::Borrowed(&[
        cipher::AES_256_GCM,
        cipher::AES_128_GCM,
        cipher::CHACHA20_POLY1305,
        cipher::AES_256_CTR,
        cipher::AES_128_CTR,
    ]),
    mac: std::borrow::Cow::Borrowed(&[
        mac::HMAC_SHA256_ETM,
        mac::HMAC_SHA512_ETM,
        mac::HMAC_SHA256,
        mac::HMAC_SHA512,
    ]),
    compression: std::borrow::Cow::Borrowed(&[compression::NONE]),
};

// ---- optimised SSH window / buffer parameters ----
pub(crate) const OPTIMIZED_WINDOW_SIZE: u32 = 16 * 1024 * 1024;
pub(crate) const OPTIMIZED_MAX_PACKET_SIZE: u32 = 256 * 1024;
pub(crate) const OPTIMIZED_CHANNEL_BUFFER: usize = 256;

// ---- russh client handler ----
///
/// Carries the target host/port so `check_server_key` can verify the presented
/// host key against the user's `known_hosts` file (trust on first use), plus a
/// per-attempt slot that records a changed key observed during *this* handshake.
pub(crate) struct SshClientHandler {
    host: String,
    port: u16,
    /// Set when this specific connection attempt observed a changed host key.
    /// Scoping it to the attempt (rather than reading the global stash) means a
    /// stale stash can never make an unrelated failure look like a host-key
    /// change.
    seen_changed_key: Arc<Mutex<Option<PendingHostKey>>>,
}

impl russh::client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // `known_hosts` access touches the filesystem; keep it off the reactor.
        let host = self.host.clone();
        let port = self.port;
        let key = server_public_key.clone();
        let verdict =
            match tokio::task::spawn_blocking(move || verify_known_host(&host, port, &key)).await {
                Ok(verdict) => verdict,
                Err(join_err) => {
                    tracing::error!(error = %join_err, "ssh: host-key verification task failed");
                    return Ok(false);
                }
            };

        match verdict {
            HostKeyVerdict::Accept => {
                // Host verifies cleanly now; drop any stale changed-key stash.
                clear_pending_host_key(&self.host, self.port);
                Ok(true)
            }
            HostKeyVerdict::Changed(pending) => {
                // Record globally so `trust_ssh_host_key` (a separate command
                // invocation) can retrieve the actual key, and per-attempt so
                // `connect_and_auth` surfaces the structured error for exactly
                // this attempt.
                stash_pending_host_key(&self.host, self.port, &pending);
                if let Ok(mut slot) = self.seen_changed_key.lock() {
                    *slot = Some(pending);
                }
                Ok(false)
            }
            HostKeyVerdict::Reject => Ok(false),
        }
    }
}

// ---- SFTP connection wrapper ----
pub(crate) struct SftpConnection {
    _handle: Arc<Handle<SshClientHandler>>,
    pub(crate) sftp: SftpSession,
}

impl SftpConnection {
    pub(crate) async fn close(self) -> Result<(), String> {
        self.sftp
            .close()
            .await
            .map_err(|e| format!("关闭 SFTP 会话失败：{e}"))
    }
}

// ---- core: connect + auth (shared with connection pool) ----
pub(crate) async fn connect_and_auth(
    params: &SshConnectionParams,
) -> Result<Handle<SshClientHandler>, String> {
    // Harden every SSH operation uniformly: reject endpoints containing control
    // characters or a leading '-' before we ever open a socket. Previously only
    // `test_ssh_connection` performed this check.
    validate_ssh_endpoint(&params.host, &params.username)?;

    let config = Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(SSH_CONNECT_TIMEOUT_SECONDS)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        preferred: OPTIMIZED_SSH_PREFERRED,
        window_size: OPTIMIZED_WINDOW_SIZE,
        maximum_packet_size: OPTIMIZED_MAX_PACKET_SIZE,
        channel_buffer_size: OPTIMIZED_CHANNEL_BUFFER,
        nodelay: true,
        ..Default::default()
    });

    // Per-attempt slot: populated only if THIS handshake observes a changed host
    // key. Scoping it to the attempt (instead of consulting the global stash)
    // means a stale stash can't masquerade as a host-key change, and a
    // concurrent connect can't wipe a key the user is still confirming.
    let seen_changed_key: Arc<Mutex<Option<PendingHostKey>>> = Arc::new(Mutex::new(None));
    let handler = SshClientHandler {
        host: params.host.clone(),
        port: params.port,
        seen_changed_key: seen_changed_key.clone(),
    };
    let connect_result = timeout(
        Duration::from_secs(SSH_CONNECT_TIMEOUT_SECONDS),
        connect(config, (params.host.as_str(), params.port), handler),
    )
    .await
    .map_err(|_| "SSH 连接超时。".to_string())?;

    let mut handle = match connect_result {
        Ok(handle) => handle,
        Err(e) => {
            // If this attempt was aborted because the server's host key changed,
            // surface a structured, machine-readable error so the UI can offer to
            // trust the new key instead of failing outright.
            if let Some(pending) =
                seen_changed_key.lock().ok().and_then(|mut slot| slot.take())
            {
                return Err(format!("{HOST_KEY_CHANGED_CODE}::{}", pending.fingerprint));
            }
            return Err(format!("SSH 连接失败：{e}"));
        }
    };

    match params.auth_mode.as_str() {
        "password" => {
            let password = params.password.as_deref().unwrap_or("");
            let result = handle
                .authenticate_password(&params.username, password)
                .await
                .map_err(|e| format!("SSH 密码认证失败：{e}"))?;
            if !result.success() {
                return Err("SSH 密码认证被拒绝，请检查用户名和密码。".into());
            }
        }
        "key" => {
            let key_path = params
                .identity_path
                .as_deref()
                .ok_or_else(|| "未指定密钥文件路径。".to_string())?;
            let expanded = expand_tilde(key_path);
            let key = tokio::task::spawn_blocking(move || {
                load_secret_key(&expanded, None)
                    .map_err(|e| format!("无法加载私钥 {expanded}：{e}"))
            })
            .await
            .map_err(|e| format!("加载私钥任务异常终止：{e}"))??;
            let key_pair = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            let result = handle
                .authenticate_publickey(&params.username, key_pair)
                .await
                .map_err(|e| format!("SSH 公钥认证失败：{e}"))?;
            if !result.success() {
                return Err("SSH 公钥认证被拒绝，请检查用户名和密钥。".into());
            }
        }
        _ => return Err("不支持的 SSH 认证方式。".into()),
    }

    Ok(handle)
}

struct OpenSftpError {
    message: String,
    retryable: bool,
}

pub(crate) async fn open_authenticated_sftp(
    params: &SshConnectionParams,
) -> Result<SftpConnection, String> {
    match open_sftp_once(params).await {
        Ok(conn) => Ok(conn),
        Err(err) if err.retryable => {
            POOL.evict(params).await;
            open_sftp_once(params).await.map_err(|e| e.message)
        }
        Err(err) => Err(err.message),
    }
}

async fn open_sftp_once(params: &SshConnectionParams) -> Result<SftpConnection, OpenSftpError> {
    let handle = POOL
        .acquire(params)
        .await
        .map_err(|message| OpenSftpError {
            message,
            retryable: false,
        })?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| OpenSftpError {
            retryable: russh_error_is_connection_level(&e),
            message: format!("无法打开 SSH 会话通道：{e}"),
        })?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| OpenSftpError {
            retryable: russh_error_is_connection_level(&e),
            message: format!("无法请求 SFTP 子系统：{e}"),
        })?;
    let stream = channel.into_stream();
    let sftp = SftpSession::new(stream)
        .await
        .map_err(|e| OpenSftpError {
            retryable: true,
            message: format!("无法创建 SFTP 会话：{e}"),
        })?;

    Ok(SftpConnection {
        _handle: handle,
        sftp,
    })
}

fn russh_error_is_connection_level(err: &russh::Error) -> bool {
    use std::error::Error as StdError;
    // russh 0.61 的 Error::IO 用 #[error(transparent)] 包裹 std::io::Error：
    // 其 source() 会转发到内层 io::Error 的 source()（通常为 None），从而“跳过”
    // io::Error 本体，导致下面的 source 链遍历取不到它。故先对 IO 变体直接取内层判定。
    if let russh::Error::IO(io) = err {
        return io_error_is_connection_level(io);
    }
    let mut current: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = current {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            return io_error_is_connection_level(io);
        }
        current = e.source();
    }
    let lower = err.to_string().to_lowercase();
    lower.contains("disconnect")
        || lower.contains("hup")
        || lower.contains("not connected")
        || lower.contains("timeout")
}

fn io_error_is_connection_level(io: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        io.kind(),
        ConnectionReset
            | ConnectionAborted
            | ConnectionRefused
            | BrokenPipe
            | UnexpectedEof
            | NotConnected
            | TimedOut
    )
}

// ---- validate SSH endpoint ----
fn validate_ssh_endpoint(host: &str, username: &str) -> Result<(), String> {
    if host.contains('\r')
        || host.contains('\n')
        || username.contains('\r')
        || username.contains('\n')
    {
        return Err("主机地址或用户名包含非法控制字符。".into());
    }
    if host.starts_with('-') || username.starts_with('-') {
        return Err("主机地址或用户名不能以 - 开头（防止命令行注入）。".into());
    }
    Ok(())
}

// ---- expand tilde ----
fn expand_tilde(path: &str) -> String {
    if path.starts_with('~')
        && let Ok(home) = env::var("USERPROFILE").or_else(|_| env::var("HOME")) {
            return path.replacen('~', &home, 1);
        }
    path.to_string()
}

// ---- error classification ----
fn classify_ssh_error(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("auth") || lower.contains("permission") {
        "ssh/auth-failed".into()
    } else if lower.contains("timeout") {
        "ssh/timeout".into()
    } else if lower.contains("resolve") || lower.contains("dns") || lower.contains("invalid") {
        "ssh/invalid-target".into()
    } else if lower.contains("connect") || lower.contains("refused") {
        "ssh/connect-failed".into()
    } else {
        "ssh/error".into()
    }
}

fn format_ssh_error_message(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("auth") || lower.contains("permission") {
        format!("SSH 认证失败：{error}")
    } else if lower.contains("timeout") {
        format!("SSH 连接超时：{error}")
    } else if lower.contains("resolve") || lower.contains("dns") {
        format!("无法解析主机地址：{error}")
    } else if lower.contains("refused") {
        format!("SSH 连接被拒绝：{error}")
    } else {
        format!("SSH 错误：{error}")
    }
}

fn failed(code: &str, message: &str) -> SshConnectionTestPayload {
    SshConnectionTestPayload {
        ok: false,
        code: code.into(),
        message: message.into(),
    }
}

// ===== Tauri Commands =====
#[tauri::command]
#[specta::specta]
pub async fn test_ssh_connection(
    payload: SshConnectionTestRequest,
) -> Result<SshConnectionTestPayload, String> {
    let params = SshConnectionParams::from_test_request(&payload);

    if params.host.is_empty() {
        return Ok(failed("ssh/invalid-host", "请填写主机地址。"));
    }
    if params.username.is_empty() {
        return Ok(failed("ssh/invalid-username", "请填写用户名。"));
    }
    if let Err(message) = validate_ssh_endpoint(&params.host, &params.username) {
        return Ok(failed("ssh/invalid-target", &message));
    }
    if params.auth_mode != "key" && params.auth_mode != "password" {
        return Ok(failed("ssh/invalid-auth-mode", "不支持的 SSH 认证方式。"));
    }
    if params.auth_mode == "password"
        && params
            .password
            .as_deref()
            .map(str::is_empty)
            .unwrap_or(true)
    {
        return Ok(failed("ssh/password-missing", "请填写 SSH 登录密码。"));
    }

    match timeout(SSH_TEST_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let _ = conn.close().await;
            Ok(SshConnectionTestPayload {
                ok: true,
                code: "ssh/ok".into(),
                message: "SSH 连接验证成功。".into(),
            })
        }
        Ok(Err(error)) => {
            if error.starts_with(&format!("{HOST_KEY_CHANGED_CODE}::")) {
                Ok(failed(HOST_KEY_CHANGED_CODE, &error))
            } else {
                Ok(failed(
                    &classify_ssh_error(&error),
                    &format_ssh_error_message(&error),
                ))
            }
        }
        Err(_) => Ok(failed("ssh/timeout", "SSH 连接测试超时。")),
    }
}

// ===== Host-key trust =====
#[derive(serde::Serialize, specta::Type)]
pub struct SshHostKeyTrustPayload {
    pub trusted: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn trust_ssh_host_key(
    host: String,
    port: u16,
) -> Result<SshHostKeyTrustPayload, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("主机地址不能为空。".into());
    }
    let Some(pending) = take_pending_host_key(&host, port) else {
        return Err("没有待确认的主机密钥变更，请重新发起连接。".into());
    };
    let key = pending.key;
    tokio::task::spawn_blocking(move || replace_known_host_key(&host, port, &key))
        .await
        .map_err(|e| format!("更新 known_hosts 任务异常终止：{e}"))??;
    Ok(SshHostKeyTrustPayload { trusted: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_error_connection_kinds_are_classified() {
        use std::io::{Error, ErrorKind};
        assert!(io_error_is_connection_level(&Error::from(ErrorKind::ConnectionReset)));
        assert!(io_error_is_connection_level(&Error::from(ErrorKind::BrokenPipe)));
        assert!(io_error_is_connection_level(&Error::from(ErrorKind::UnexpectedEof)));
        assert!(io_error_is_connection_level(&Error::from(ErrorKind::TimedOut)));
        assert!(!io_error_is_connection_level(&Error::from(ErrorKind::PermissionDenied)));
        assert!(!io_error_is_connection_level(&Error::from(ErrorKind::NotFound)));
    }

    #[test]
    fn russh_io_errors_are_treated_as_connection_level() {
        let err = russh::Error::from(std::io::Error::from(std::io::ErrorKind::ConnectionReset));
        assert!(russh_error_is_connection_level(&err));
    }

    #[test]
    fn expand_tilde_resolves_home_directory() {
        let expanded = expand_tilde("~/.ssh/id_rsa");
        assert!(!expanded.starts_with('~'), "tilde should be expanded: {expanded}");
    }
}
