use super::{
    SshConfigHostPayload, SshConnectionTestPayload, SshConnectionTestRequest,
    SshDirectoryCreatePayload, SshDirectoryCreateRequest, SshDirectoryEntryPayload,
    SshDirectoryListPayload, SshDirectoryListRequest, SshFileDownloadPayload,
    SshFileDownloadRequest, SshFileReadPayload, SshFileReadRequest, SshFileUploadPayload,
    SshFileUploadRequest, SshFileWritePayload, SshFileWriteRequest, SshPasswordGetRequest,
    SshPasswordPayload, SshPasswordSaveRequest, SshPasswordStatusPayload, SshPathDeletePayload,
    SshPathDeleteRequest, SshPathRenamePayload, SshPathRenameRequest,
};
use russh::{
    cipher, client::{connect, Handle}, compression, kex, keys::{
        load_secret_key, Algorithm, EcdsaCurve, HashAlg, PrivateKeyWithHashAlg,
    }, mac, Preferred,
};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use std::{
    collections::HashMap,
    env, fs as std_fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::time::timeout;
use jiff::Timestamp;

// ---- constants ----
const SSH_CONNECT_TIMEOUT_SECONDS: u64 = 8;
const SSH_TEST_TIMEOUT: Duration = Duration::from_secs(12);
const SSH_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_FILE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);
const SSH_FILE_PREVIEW_TIMEOUT: Duration = Duration::from_secs(60);
const SSH_FILE_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_SSH_PORT: u16 = 22;
const SSH_KEYRING_SERVICE: &str = "calamex.ssh";
const SSH_CONFIG_IMPORTED_LABEL: &str = "SSH config";
const SFTP_PARTIAL_SUFFIX: &str = ".aster.partial";
const SFTP_BACKUP_SUFFIX: &str = ".aster.backup";
const SFTP_TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
const SFTP_PIPELINE_DEPTH: usize = 32;

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

// POSIX mode bits used for permission rendering.
const S_IFMT:  u32 = 0o170000;
const S_IFSOCK:u32 = 0o140000;
const S_IFLNK: u32 = 0o120000;
const S_IFREG: u32 = 0o100000;
const S_IFBLK: u32 = 0o060000;
const S_IFDIR: u32 = 0o040000;
const S_IFCHR: u32 = 0o020000;
const S_IFIFO: u32 = 0o010000;

// ---- connection parameters ----
#[derive(Debug, Clone)]
pub(crate) struct SshConnectionParams {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
}

impl Drop for SshConnectionParams {
    fn drop(&mut self) {
        if let Some(p) = self.password.as_mut() {
            unsafe {
                for b in p.as_bytes_mut() {
                    *b = 0;
                }
            }
            p.clear();
        }
    }
}

macro_rules! impl_ssh_connection_params_from_request {
    ($($method:ident => $request:ty),* $(,)?) => {
        impl SshConnectionParams {
            $(
                fn $method(payload: &$request) -> Self {
                    Self {
                        host: payload.host.trim().into(),
                        port: payload.port,
                        username: payload.username.trim().into(),
                        auth_mode: payload.auth_mode.clone(),
                        identity_path: payload.identity_path.clone(),
                        // `password` is a redacted `SecretString` on the wire; take a
                        // plain copy here only for the connection itself. This copy
                        // is scrubbed by `SshConnectionParams::Drop`.
                        password: payload.password.as_ref().map(|p| p.expose().to_string()),
                    }
                }
            )*
        }
    };
}

impl_ssh_connection_params_from_request! {
    from_test_request             => SshConnectionTestRequest,
    from_directory_request        => SshDirectoryListRequest,
    from_download_request         => SshFileDownloadRequest,
    from_upload_request           => SshFileUploadRequest,
    from_delete_request           => SshPathDeleteRequest,
    from_rename_request           => SshPathRenameRequest,
    from_create_directory_request => SshDirectoryCreateRequest,
    from_read_request             => SshFileReadRequest,
    from_write_request            => SshFileWriteRequest,
}

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

// ---- host-key change handling ----
//
// When a *known* host presents a *different* key, `check_server_key` cannot
// block on user input. Instead we stash the freshly presented key keyed by
// (host, port) and reject the handshake. `connect_and_auth` then surfaces a
// structured `ssh/host-key-changed::<fingerprint>` error so the UI can warn the
// user and, on confirmation, call `trust_ssh_host_key` to record the new key.
#[derive(Clone)]
struct PendingHostKey {
    key: russh::keys::PublicKey,
    fingerprint: String,
}

static PENDING_HOST_KEYS: LazyLock<Mutex<HashMap<(String, u16), PendingHostKey>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn stash_pending_host_key(host: &str, port: u16, pending: &PendingHostKey) {
    if let Ok(mut map) = PENDING_HOST_KEYS.lock() {
        map.insert((host.to_string(), port), pending.clone());
    }
}

fn take_pending_host_key(host: &str, port: u16) -> Option<PendingHostKey> {
    PENDING_HOST_KEYS
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&(host.to_string(), port)))
}

fn clear_pending_host_key(host: &str, port: u16) {
    if let Ok(mut map) = PENDING_HOST_KEYS.lock() {
        map.remove(&(host.to_string(), port));
    }
}

/// Outcome of verifying a presented host key against the user's `known_hosts`.
enum HostKeyVerdict {
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
fn verify_known_host(host: &str, port: u16, key: &russh::keys::PublicKey) -> HostKeyVerdict {
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

fn replace_known_host_key(
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
        std_fs::write(path, &kept).map_err(|e| format!("写入 known_hosts 失败：{e}"))?;
    }
    russh::keys::known_hosts::learn_known_hosts_path(host, port, key, path)
        .map_err(|e| format!("写入 known_hosts 失败：{e}"))
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

// ---- SFTP connection wrapper ----
struct SftpConnection {
    _handle: Arc<Handle<SshClientHandler>>,
    sftp: SftpSession,
}

impl SftpConnection {
    async fn close(self) -> Result<(), String> {
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

async fn open_authenticated_sftp(params: &SshConnectionParams) -> Result<SftpConnection, String> {
    match open_sftp_once(params).await {
        Ok(conn) => Ok(conn),
        Err(err) if err.retryable => {
            super::ssh_pool::POOL.evict(params).await;
            open_sftp_once(params).await.map_err(|e| e.message)
        }
        Err(err) => Err(err.message),
    }
}

async fn open_sftp_once(params: &SshConnectionParams) -> Result<SftpConnection, OpenSftpError> {
    let handle = super::ssh_pool::POOL
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
    if path.starts_with('~') {
        if let Ok(home) = env::var("USERPROFILE").or_else(|_| env::var("HOME")) {
            return path.replacen('~', &home, 1);
        }
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

#[tauri::command]
pub async fn list_ssh_directory(
    payload: SshDirectoryListRequest,
) -> Result<SshDirectoryListPayload, String> {
    let params = SshConnectionParams::from_directory_request(&payload);
    // An empty path means "the default/home directory"; otherwise route through
    // the same `safe_remote_path` hardening every other path-bearing op uses.
    let trimmed = payload.path.trim();
    let effective_path = if trimmed.is_empty() {
        ".".to_string()
    } else {
        safe_remote_path(trimmed).map_err(|e| format!("远程路径不合法：{e}"))?
    };

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = list_dir_inner(&conn.sftp, &effective_path).await;
            let _ = conn.close().await;
            match result {
                Ok(entries) => Ok(SshDirectoryListPayload {
                    path: effective_path,
                    entries,
                }),
                Err(error) => Err(format!("列出 SSH 目录失败：{error}")),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 操作超时。".into()),
    }
}

async fn list_dir_inner(
    sftp: &SftpSession,
    path: &str,
) -> Result<Vec<SshDirectoryEntryPayload>, String> {
    let entries = sftp.read_dir(path).await.map_err(|e| format!("{e}"))?;

    let mut result: Vec<SshDirectoryEntryPayload> = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let file_type = entry.file_type();
        let kind = if file_type.is_dir() {
            "directory".to_string()
        } else if file_type.is_symlink() {
            "symlink".to_string()
        } else {
            "file".to_string()
        };
        let metadata = entry.metadata();
        let size = metadata.size.unwrap_or(0);
        result.push(SshDirectoryEntryPayload {
            name,
            kind,
            path: entry.path(),
            size,
        });
    }
    Ok(result)
}

#[tauri::command]
pub async fn download_ssh_file(
    payload: SshFileDownloadRequest,
) -> Result<SshFileDownloadPayload, String> {
    let params = SshConnectionParams::from_download_request(&payload);
    let remote = safe_remote_path(&payload.remote_path)
        .map_err(|e| format!("远程路径不合法：{e}"))?;
    let local = PathBuf::from(&payload.local_path);

    match timeout(SSH_FILE_TRANSFER_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = download_file_inner(&conn.sftp, &remote, &local).await;
            let _ = conn.close().await;
            match result {
                Ok(size) => Ok(SshFileDownloadPayload {
                    remote_path: remote,
                    local_path: local.to_string_lossy().into_owned(),
                    byte_size: size,
                }),
                Err(e) => {
                    cleanup_local_partial(&local);
                    Err(e)
                }
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 文件下载超时。".into()),
    }
}

async fn download_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
) -> Result<u64, String> {
    let expected_size = sftp.metadata(remote_path).await.ok().and_then(|m| m.size);

    let partial = local_partial_path(local_path);
    let mut file = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("无法打开远程文件 {remote_path}：{e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(SFTP_PIPELINE_DEPTH);

    let partial_for_write = partial.clone();
    let write_handle = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let mut local = std_fs::File::create(&partial_for_write)
            .map_err(|e| format!("无法创建本地文件 {partial_for_write:?}：{e}"))?;
        let mut total: u64 = 0;
        while let Some(data) = rx.blocking_recv() {
            local
                .write_all(&data)
                .map_err(|e| format!("写入本地文件失败：{e}"))?;
            total += data.len() as u64;
        }
        local
            .sync_all()
            .map_err(|e| format!("刷新本地文件失败：{e}"))?;
        Ok(total)
    });

    let mut read_error: Option<String> = None;
    let mut buf = vec![0u8; SFTP_TRANSFER_CHUNK_BYTES];
    loop {
        match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).await.is_err() {
                    break;
                }
            }
            Err(e) => {
                read_error = Some(format!("读取远程文件失败：{e}"));
                break;
            }
        }
    }
    drop(tx);

    let written = write_handle
        .await
        .map_err(|e| format!("写入任务异常终止：{e}"))??;

    if let Some(e) = read_error {
    return Err(e);
}

// 校验下载字节数，防止静默截断（与上传路径保持一致）。
if let Some(expected) = expected_size {
    ensure_expected_transfer_size(written, expected, "下载远程文件")?;
}

let partial_for_rename = partial.clone();
    let target = local_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        std_fs::rename(&partial_for_rename, &target)
            .map_err(|e| format!("重命名本地文件失败：{e}"))
    })
    .await
    .map_err(|e| format!("重命名任务异常终止：{e}"))??;

    Ok(written)
}

#[tauri::command]
pub async fn upload_ssh_file(
    payload: SshFileUploadRequest,
) -> Result<SshFileUploadPayload, String> {
    let params = SshConnectionParams::from_upload_request(&payload);
    let remote = safe_remote_path(&payload.remote_directory)
        .map_err(|e| format!("远程路径不合法：{e}"))?;
    let local = PathBuf::from(&payload.local_path);
    let file_size = std_fs::metadata(&local)
        .map_err(|e| format!("无法获取本地文件信息 {local:?}：{e}"))?
        .len();

    match timeout(SSH_FILE_TRANSFER_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = upload_file_inner(&conn.sftp, &remote, &local, file_size).await;
            if result.is_err() {
                cleanup_remote_partial(&conn.sftp, &remote).await;
            }
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshFileUploadPayload {
                    local_path: payload.local_path.clone(),
                    remote_path: remote,
                    byte_size: file_size,
                }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 文件上传超时。".into()),
    }
}

async fn upload_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
    file_size: u64,
) -> Result<(), String> {
    let remote_partial = remote_partial_path(remote_path);

    let mut file = sftp
        .open_with_flags(
            &remote_partial,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("无法创建远程文件 {remote_partial}：{e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(SFTP_PIPELINE_DEPTH);
    let local_path_clone = local_path.to_path_buf();

    let read_handle = tokio::task::spawn_blocking(move || {
        let mut local = std_fs::File::open(&local_path_clone)
            .map_err(|e| format!("无法打开本地文件 {local_path_clone:?}：{e}"))?;
        let mut buf = vec![0u8; SFTP_TRANSFER_CHUNK_BYTES];
        loop {
            let n = local
                .read(&mut buf)
                .map_err(|e| format!("读取本地文件失败：{e}"))?;
            if n == 0 {
                break;
            }
            if tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                break;
            }
        }
        Ok::<_, String>(())
    });

    let mut written: u64 = 0;
    while let Some(chunk) = rx.recv().await {
        let data = chunk?;
        file.write_all(&data)
            .await
            .map_err(|e| format!("写入远程文件失败：{e}"))?;
        written += data.len() as u64;
    }

    read_handle
        .await
        .map_err(|e| format!("读取任务异常终止：{e}"))?
        .map_err(|e| e.to_string())?;

    file.shutdown()
        .await
        .map_err(|e| format!("关闭远程文件写入失败：{e}"))?;

    ensure_expected_transfer_size(written, file_size, "上传本地文件")?;

    sftp.rename(&remote_partial, remote_path)
        .await
        .map_err(|e| format!("重命名远程文件 {remote_partial} -> {remote_path} 失败：{e}"))?;
    Ok(())
}

fn local_partial_path(local: &Path) -> PathBuf {
    let mut p = local.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    p.set_file_name(format!("{name}{SFTP_PARTIAL_SUFFIX}"));
    p
}

fn remote_partial_path(remote: &str) -> String {
    format!("{remote}{SFTP_PARTIAL_SUFFIX}")
}

fn cleanup_local_partial(local_path: &Path) {
    let partial = local_partial_path(local_path);
    let _ = std_fs::remove_file(partial);
}

async fn cleanup_remote_partial(sftp: &SftpSession, remote_path: &str) {
    let partial = remote_partial_path(remote_path);
    let _ = sftp.remove_file(&partial).await;
}

fn ensure_expected_transfer_size(actual: u64, expected: u64, operation: &str) -> Result<(), String> {
    if actual != expected {
        return Err(format!(
            "{operation}大小不一致（预期 {expected} 字节，实际 {actual} 字节）。"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn read_ssh_file(
    payload: SshFileReadRequest,
) -> Result<SshFileReadPayload, String> {
    let params = SshConnectionParams::from_read_request(&payload);
    let remote_path = safe_remote_path(&payload.remote_path)
        .map_err(|e| format!("远程路径不合法：{e}"))?;

    match timeout(SSH_FILE_PREVIEW_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = read_file_inner(&conn.sftp, &remote_path).await;
            let _ = conn.close().await;
            result
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 文件读取超时。".into()),
    }
}

fn preview_read_limit(size: Option<u64>) -> u64 {
    match size {
        Some(size) => SSH_FILE_PREVIEW_MAX_BYTES.min(size.max(1)),
        None => SSH_FILE_PREVIEW_MAX_BYTES,
    }
}

async fn read_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
) -> Result<SshFileReadPayload, String> {
    let metadata = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("无法获取远程文件信息 {remote_path}：{e}"))?;

    let file_size = metadata.size.unwrap_or(0);
    let read_limit = preview_read_limit(metadata.size);

    let mut file = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("无法打开远程文件 {remote_path}：{e}"))?;

    let mut raw: Vec<u8> = Vec::with_capacity(read_limit.min(SFTP_TRANSFER_CHUNK_BYTES as u64) as usize);
    let mut buf = vec![0u8; SFTP_TRANSFER_CHUNK_BYTES];
    while (raw.len() as u64) < read_limit {
        let remaining = (read_limit - raw.len() as u64) as usize;
        let take = remaining.min(buf.len());
        let n = file
            .read(&mut buf[..take])
            .await
            .map_err(|e| format!("读取远程文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
    }
    let _ = file.shutdown().await;

    let raw = truncate_at_utf8_boundary(raw);

    let (decoded, encoding, line_ending) = decode_remote_preview_text(raw)?;
    let line_count = decoded.lines().count() as u64;

    let permission = metadata
        .permissions
        .map(format_remote_permission_from_bits)
        .unwrap_or_else(|| "---------".into());
    let owner = metadata
        .uid
        .map(|u| u.to_string())
        .unwrap_or_else(|| "0".into());
    let modified_at = metadata.mtime.map(|t| {
        let secs = t as i64;
        Timestamp::from_second(secs)
            .map(|ts| ts.to_string())
            .unwrap_or_default()
    });

    Ok(SshFileReadPayload {
        remote_path: remote_path.into(),
        content: decoded,
        byte_size: file_size,
        encoding,
        line_count,
        line_ending,
        permission,
        owner,
        modified_at,
    })
}

#[tauri::command]
pub async fn write_ssh_file(
    payload: SshFileWriteRequest,
) -> Result<SshFileWritePayload, String> {
    let params = SshConnectionParams::from_write_request(&payload);
    let remote_path = safe_remote_path(&payload.remote_path)
        .map_err(|e| format!("远程路径不合法：{e}"))?;
    let raw =
        encode_remote_preview_text(&payload.content, &payload.encoding, &payload.line_ending)?;
    let byte_size = raw.len() as u64;

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = write_file_inner(&conn.sftp, &remote_path, &raw).await;
            if result.is_err() {
                cleanup_remote_partial(&conn.sftp, &remote_path).await;
            }
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshFileWritePayload {
                    remote_path,
                    byte_size,
                }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 文件写入超时。".into()),
    }
}

async fn write_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
    data: &[u8],
) -> Result<(), String> {
    let partial = remote_partial_path(remote_path);
    let mut file = sftp
        .open_with_flags(
            &partial,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("无法创建远程文件 {partial}：{e}"))?;
    file.write_all(data)
        .await
        .map_err(|e| format!("写入远程文件失败：{e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("关闭远程文件写入失败：{e}"))?;

    swap_partial_onto_target(sftp, &partial, remote_path).await
}

async fn swap_partial_onto_target(
    sftp: &SftpSession,
    partial: &str,
    target: &str,
) -> Result<(), String> {
    if sftp.rename(partial, target).await.is_ok() {
        return Ok(());
    }

    let backup = format!("{target}{SFTP_BACKUP_SUFFIX}");
    let had_backup = sftp.rename(target, &backup).await.is_ok();

    match sftp.rename(partial, target).await {
        Ok(()) => {
            if had_backup {
                let _ = sftp.remove_file(&backup).await;
            }
            Ok(())
        }
        Err(e) => {
            if had_backup {
                let _ = sftp.rename(&backup, target).await;
            }
            let _ = sftp.remove_file(partial).await;
            Err(format!("重命名远程文件 {partial} -> {target} 失败：{e}"))
        }
    }
}

#[tauri::command]
pub async fn delete_ssh_path(
    payload: SshPathDeleteRequest,
) -> Result<SshPathDeletePayload, String> {
    let params = SshConnectionParams::from_delete_request(&payload);
    let remote_path = safe_remote_path(&payload.remote_path)
        .map_err(|e| format!("远程路径不合法：{e}"))?;
    validate_remote_mutation_name(&remote_path)?;

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = delete_path_inner(&conn.sftp, &remote_path).await;
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshPathDeletePayload { remote_path }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 路径删除超时。".into()),
    }
}

async fn delete_path_inner(sftp: &SftpSession, remote_path: &str) -> Result<(), String> {
    let meta = sftp.metadata(remote_path).await;
    match meta {
        Ok(attrs) => {
            if attrs.file_type().is_dir() {
                sftp.remove_dir(remote_path)
                    .await
                    .map_err(|e| format!("无法删除远程目录 {remote_path}：{e}"))?;
            } else {
                sftp.remove_file(remote_path)
                    .await
                    .map_err(|e| format!("无法删除远程文件 {remote_path}：{e}"))?;
            }
            Ok(())
        }
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("NoSuchFile") || err_str.to_lowercase().contains("no such") {
                Err(format!("远程路径不存在：{remote_path}"))
            } else {
                Err(format!("无法获取远程路径信息 {remote_path}：{e}"))
            }
        }
    }
}

#[tauri::command]
pub async fn rename_ssh_path(
    payload: SshPathRenameRequest,
) -> Result<SshPathRenamePayload, String> {
    let params = SshConnectionParams::from_rename_request(&payload);
    let old = safe_remote_path(&payload.remote_path)
        .map_err(|e| format!("原路径不合法：{e}"))?;
    let new = safe_remote_path(&payload.new_name)
        .map_err(|e| format!("新路径不合法：{e}"))?;
    validate_remote_mutation_name(&old)?;
    validate_remote_mutation_name(&new)?;

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = conn
                .sftp
                .rename(&old, &new)
                .await
                .map_err(|e| format!("重命名远程路径失败：{e}"));
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshPathRenamePayload {
                    old_path: old,
                    new_path: new,
                }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 路径重命名超时。".into()),
    }
}

#[tauri::command]
pub async fn create_ssh_directory(
    payload: SshDirectoryCreateRequest,
) -> Result<SshDirectoryCreatePayload, String> {
    let params = SshConnectionParams::from_create_directory_request(&payload);
    let remote_path = safe_remote_path(&payload.remote_directory)
        .map_err(|e| format!("远程路径不合法：{e}"))?;

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = conn
                .sftp
                .create_dir(&remote_path)
                .await
                .map_err(|e| format!("创建远程目录 {remote_path} 失败：{e}"));
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshDirectoryCreatePayload { remote_path }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 目录创建超时。".into()),
    }
}

// ===== Host-key trust =====
#[derive(serde::Serialize)]
pub struct SshHostKeyTrustPayload {
    pub trusted: bool,
}

#[tauri::command]
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

// ===== SSH Password Management (keyring) =====
#[tauri::command]
pub async fn save_ssh_password(
    payload: SshPasswordSaveRequest,
) -> Result<SshPasswordStatusPayload, String> {
    let account = ssh_password_account(&payload.host, payload.port, &payload.username)?;
    let password = payload.password.expose().to_string();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SSH_KEYRING_SERVICE, &account)
            .map_err(|e| format!("无法创建凭据条目：{e}"))?;
        entry
            .set_password(&password)
            .map_err(|e| format!("无法保存 SSH 密码：{e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("保存密码任务异常终止：{e}"))??;
    Ok(SshPasswordStatusPayload { has_password: true })
}

#[tauri::command]
pub async fn get_ssh_password(
    payload: SshPasswordGetRequest,
) -> Result<SshPasswordPayload, String> {
    let account = ssh_password_account(&payload.host, payload.port, &payload.username)?;
    let password = tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SSH_KEYRING_SERVICE, &account)
            .map_err(|e| format!("无法创建凭据条目：{e}"))?;
        match entry.get_password() {
            Ok(password) => Ok(password),
            Err(keyring::Error::NoEntry) => Err("未找到该连接的已保存密码。".to_string()),
            Err(e) => Err(format!("无法读取 SSH 密码：{e}")),
        }
    })
    .await
    .map_err(|e| format!("读取密码任务异常终止：{e}"))??;
    Ok(SshPasswordPayload { password })
}

fn ssh_password_account(host: &str, port: u16, username: &str) -> Result<String, String> {
    let host = host.trim();
    let username = username.trim();
    if host.is_empty() || username.is_empty() {
        return Err("主机地址或用户名不能为空。".into());
    }
    if host.contains('\n')
        || host.contains('\r')
        || username.contains('\n')
        || username.contains('\r')
        || username.contains('@')
    {
        return Err("主机地址或用户名包含不允许的字符。".into());
    }
    Ok(format!("password:{username}@{host}:{port}"))
}

// ===== SSH config listing =====
#[tauri::command]
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
        if let Some(name) = self.name.take() {
            if !name.contains('*') && !name.contains('!') {
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

// ===== Utility functions =====
fn safe_remote_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("远程路径不能为空。".into());
    }
    if trimmed.contains('\r') || trimmed.contains('\n') {
        return Err("远程路径包含非法控制字符。".into());
    }
    Ok(trimmed.replace('\\', "/"))
}

fn validate_remote_mutation_name(path: &str) -> Result<(), String> {
    if path
        .split(['/', '\\'])
        .any(|segment| segment.trim() == "..")
    {
        return Err(format!("远程路径名不合法：{path}"));
    }
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or(std::borrow::Cow::Borrowed(path));
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return Err(format!("远程路径名不合法：{name}"));
    }
    Ok(())
}

fn truncate_at_utf8_boundary(mut raw: Vec<u8>) -> Vec<u8> {
    if std::str::from_utf8(&raw).is_ok() {
        return raw;
    }
    let mut end = raw.len();
    while end > 0 {
        end -= 1;
        if std::str::from_utf8(&raw[..end]).is_ok() {
            raw.truncate(end);
            return raw;
        }
    }
    raw.clear();
    raw
}

fn decode_remote_preview_text(raw: Vec<u8>) -> Result<(String, String, String), String> {
    let has_bom = raw.starts_with(&[0xef, 0xbb, 0xbf]);
    let encoding = if has_bom { "utf-8-bom" } else { "utf-8" };
    let decoded = if has_bom {
        String::from_utf8(raw[3..].to_vec()).map_err(|e| format!("UTF-8 解码失败：{e}"))?
    } else {
        String::from_utf8(raw).map_err(|e| format!("UTF-8 解码失败：{e}"))?
    };
    let line_ending = detect_line_ending(decoded.as_bytes());
    Ok((decoded, encoding.to_string(), line_ending.to_string()))
}

fn detect_line_ending(data: &[u8]) -> &'static str {
    let mut has_crlf = false;
    let mut has_lf = false;
    let mut has_cr = false;
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' {
            if i + 1 < data.len() && data[i + 1] == b'\n' {
                has_crlf = true;
                i += 1;
            } else {
                has_cr = true;
            }
        } else if data[i] == b'\n' {
            has_lf = true;
        }
        i += 1;
    }
    match (has_crlf, has_lf, has_cr) {
        (true, false, false) => "crlf",
        (false, true, false) => "lf",
        (false, false, true) => "cr",
        (true, true, _) | (true, _, true) | (_, true, true) => "mixed",
        _ => "lf",
    }
}

fn encode_remote_preview_text(
    content: &str,
    encoding: &str,
    line_ending: &str,
) -> Result<Vec<u8>, String> {
    let lf_only = content.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = match line_ending {
        "crlf" => lf_only.replace('\n', "\r\n"),
        "cr" => lf_only.replace('\n', "\r"),
        _ => lf_only,
    };
    let mut bytes = normalized.into_bytes();
    if encoding == "utf-8-bom" {
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.append(&mut bytes);
        Ok(bom)
    } else {
        Ok(bytes)
    }
}

fn format_remote_permission_from_bits(bits: u32) -> String {
    let kind = match bits & S_IFMT {
        S_IFDIR  => 'd',
        S_IFLNK  => 'l',
        S_IFBLK  => 'b',
        S_IFCHR  => 'c',
        S_IFIFO  => 'p',
        S_IFSOCK => 's',
        S_IFREG  => '-',
        _        => '-',
    };
    let mode = bits & 0o777;
    let mut s = String::with_capacity(10);
    s.push(kind);
    s.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o100 != 0 { 'x' } else { '-' });
    s.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o010 != 0 { 'x' } else { '-' });
    s.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o001 != 0 { 'x' } else { '-' });
    s
}

// ===== Tests =====
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
    fn transfer_partial_paths_use_stable_suffix() {
        assert_eq!(
            remote_partial_path("/home/app/0.txt"),
            "/home/app/0.txt.aster.partial"
        );
        assert_eq!(
            local_partial_path(Path::new("0.txt")),
            PathBuf::from("0.txt.aster.partial")
        );
    }

    #[test]
    fn ensure_expected_transfer_size_rejects_short_copy() {
        assert!(ensure_expected_transfer_size(8, 8, "上传本地文件").is_ok());
        assert!(ensure_expected_transfer_size(7, 8, "上传本地文件").is_err());
    }

    #[test]
    fn preview_read_limit_handles_unknown_and_known_sizes() {
        assert_eq!(preview_read_limit(None), SSH_FILE_PREVIEW_MAX_BYTES);
        assert_eq!(preview_read_limit(Some(10)), 10);
        assert_eq!(preview_read_limit(Some(0)), 1);
        assert_eq!(
            preview_read_limit(Some(SSH_FILE_PREVIEW_MAX_BYTES + 5)),
            SSH_FILE_PREVIEW_MAX_BYTES
        );
    }

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
    fn ssh_password_account_trims_and_scopes_connection() {
        assert_eq!(
            ssh_password_account(" 192.168.1.10 ", 22, " root ").unwrap(),
            "password:root@192.168.1.10:22"
        );
    }

    #[test]
    fn ssh_password_account_rejects_unsafe_identity() {
        assert!(ssh_password_account("example.com", 22, "root@other").is_err());
        assert!(ssh_password_account("example.com\nbad", 22, "root").is_err());
        assert!(ssh_password_account("", 22, "root").is_err());
    }

    #[test]
    fn validate_remote_mutation_names_rejects_path_control_names() {
        assert!(validate_remote_mutation_name("release").is_ok());
        assert!(validate_remote_mutation_name("../release").is_err());
        assert!(validate_remote_mutation_name("bad\nname").is_err());
        assert!(safe_remote_path("bad\rpath").is_err());
    }

    #[test]
    fn detect_line_ending_distinguishes_lf_crlf_and_mixed() {
        assert_eq!(detect_line_ending(b"alpha\nbeta\n"), "lf");
        assert_eq!(detect_line_ending(b"alpha\r\nbeta\r\n"), "crlf");
        assert_eq!(detect_line_ending(b"alpha\rbeta\r"), "cr");
        assert_eq!(detect_line_ending(b"alpha\r\nbeta\n"), "mixed");
        assert_eq!(detect_line_ending(b"alpha beta"), "lf");
    }

    #[test]
    fn decode_and_encode_remote_preview_text_preserve_utf8_bom_and_line_endings() {
        let (decoded, encoding, line_ending) =
            decode_remote_preview_text(vec![0xef, 0xbb, 0xbf, b'a', b'\r', b'\n', b'b'])
                .expect("preview text should decode");
        assert_eq!(decoded, "a\r\nb");
        assert_eq!(encoding, "utf-8-bom");
        assert_eq!(line_ending, "crlf");
        let encoded = encode_remote_preview_text("a\nb", &encoding, &line_ending)
            .expect("preview text should encode");
        assert_eq!(encoded, vec![0xef, 0xbb, 0xbf, b'a', b'\r', b'\n', b'b']);
    }

    #[test]
    fn encode_does_not_double_expand_existing_crlf() {
        let out = encode_remote_preview_text("a\r\nb", "utf-8", "crlf").unwrap();
        assert_eq!(out, b"a\r\nb");
    }

    #[test]
    fn format_remote_permission_renders_posix_mode_bits() {
        assert_eq!(format_remote_permission_from_bits(0o100755), "-rwxr-xr-x");
        assert_eq!(format_remote_permission_from_bits(0o040755), "drwxr-xr-x");
        assert_eq!(format_remote_permission_from_bits(0o120777), "lrwxrwxrwx");
    }

    #[test]
    fn expand_tilde_resolves_home_directory() {
        let expanded = expand_tilde("~/.ssh/id_rsa");
        assert!(!expanded.starts_with('~'), "tilde should be expanded: {expanded}");
    }

    #[test]
    fn safe_remote_path_normalizes_backslashes() {
        assert_eq!(
            safe_remote_path(r"\home\user\file").unwrap(),
            "/home/user/file"
        );
    }

    #[test]
    fn truncate_at_utf8_boundary_backs_off_mid_codepoint() {
        let v = vec![0xe4, 0xbd];
        let out = truncate_at_utf8_boundary(v);
        assert!(out.is_empty());

        let v = vec![b'a', 0xe4, 0xbd];
        let out = truncate_at_utf8_boundary(v);
        assert_eq!(out, b"a");
    }
}
