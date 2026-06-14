use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use gix::bstr::ByteSlice;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};

const GITHUB_AUTH_CREDENTIAL_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const GITHUB_BROWSER_AUTH_MAX_WAIT: Duration = Duration::from_secs(180);
const GITHUB_OAUTH_SCOPE: &str = "read:user user:email repo";
const GITHUB_KEYRING_SERVICE: &str = "calamex.github";
const GITHUB_OAUTH_CALLBACK_PATH: &str = "/github/oauth/callback";

// GitHub OAuth client IDs are public identifiers. Calamex uses browser-based
// Authorization Code + PKCE and stores the resulting token in the OS keyring.
const GITHUB_OAUTH_CLIENT_ID: &str = "01ab8ac9400c4e429b23";

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthRequest {
    repository_root_path: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubBrowserAuthCompleteRequest {
    repository_root_path: String,
    state: String,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthStatusPayload {
    authenticated: bool,
    login: Option<String>,
    name: Option<String>,
    avatar_url: Option<String>,
    html_url: Option<String>,
    email: Option<String>,
    source: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubBrowserAuthPayload {
    authorization_url: String,
    state: String,
    #[specta(type = u32)]
    expires_in: u64,
}

#[derive(Clone)]
struct GitHubAuthCredentialCacheEntry {
    credential: Option<GitHubResolvedCredential>,
    expires_at: Instant,
}

#[derive(Clone)]
struct GitHubResolvedCredential {
    token: String,
    source: String,
}

struct GitHubAuthTarget {
    host: String,
    api_base: String,
    auth_base: String,
    repository_root: PathBuf,
}

struct GitHubBrowserAuthSession {
    host: String,
    repository_root: PathBuf,
    redirect_uri: String,
    code_verifier: String,
    expires_at: Instant,
    callback_task: tokio::task::JoinHandle<Result<GitHubBrowserCallback, String>>,
}

struct GitHubBrowserCallback {
    state: String,
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Clone, Deserialize)]
struct GitHubAuthenticatedUser {
    login: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Deserialize)]
struct GitHubUserEmail {
    email: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    verified: bool,
}

#[derive(Deserialize)]
struct GitHubOAuthTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

static GITHUB_AUTH_CREDENTIAL_CACHE: OnceLock<
    Mutex<HashMap<String, GitHubAuthCredentialCacheEntry>>,
> = OnceLock::new();
static GITHUB_BROWSER_AUTH_SESSIONS: OnceLock<
    Mutex<HashMap<String, GitHubBrowserAuthSession>>,
> = OnceLock::new();

fn github_auth_credential_cache() -> &'static Mutex<HashMap<String, GitHubAuthCredentialCacheEntry>> {
    GITHUB_AUTH_CREDENTIAL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn github_browser_auth_sessions() -> &'static Mutex<HashMap<String, GitHubBrowserAuthSession>> {
    GITHUB_BROWSER_AUTH_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn unauthenticated(message: impl Into<String>) -> GitHubAuthStatusPayload {
    GitHubAuthStatusPayload {
        authenticated: false,
        login: None,
        name: None,
        avatar_url: None,
        html_url: None,
        email: None,
        source: None,
        message: Some(message.into()),
    }
}

fn authenticated(user: GitHubAuthenticatedUser, source: String) -> GitHubAuthStatusPayload {
    GitHubAuthStatusPayload {
        authenticated: true,
        login: Some(user.login),
        name: user.name,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
        email: user.email,
        source: Some(source),
        message: None,
    }
}

fn find_preferred_remote_url(repository: &Repository) -> Result<Option<String>, String> {
    let names = repository.remote_names();
    let mut remote_list: Vec<String> = names
        .iter()
        .map(|name| name.as_bstr().to_str_lossy().into_owned())
        .collect();

    remote_list.sort_by_key(|name| if name == "origin" { 0 } else { 1 });

    for name in &remote_list {
        let remote = match repository.find_remote(name.as_str()) {
            Ok(remote) => remote,
            Err(_) => continue,
        };

        let Some(remote_url) = remote.url(gix::remote::Direction::Fetch) else {
            continue;
        };

        let value = remote_url.to_bstring().to_str_lossy().into_owned();
        if !value.trim().is_empty() {
            return Ok(Some(value));
        }
    }

    Ok(None)
}

fn parse_github_remote_host(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = gix::url::parse(gix::bstr::BStr::new(trimmed)).ok()?;
    let host = parsed.host()?.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn resolve_github_api_base(host: &str) -> String {
    let normalized_host = host.to_ascii_lowercase();
    if normalized_host == "github.com" {
        "https://api.github.com".to_string()
    } else {
        let mut api_base = "https://api.".to_string();
        api_base.push_str(host);
        api_base
    }
}

fn resolve_github_auth_base(host: &str) -> String {
    let normalized_host = host.to_ascii_lowercase();
    if normalized_host == "github.com" {
        "https://github.com".to_string()
    } else {
        let mut auth_base = "https://".to_string();
        auth_base.push_str(host);
        auth_base
    }
}

fn resolve_github_auth_target(repository_root_path: &str) -> Result<GitHubAuthTarget, String> {
    let repository = open_repository_from_root(repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;

    let Some(remote_url) = find_preferred_remote_url(&repository)? else {
        return Err("当前仓库没有可用的远程地址，请先配置 GitHub 远程仓库。".to_string());
    };

    let Some(host) = parse_github_remote_host(&remote_url) else {
        return Err("无法解析当前仓库的 GitHub 远程地址。".to_string());
    };

    let normalized_host = host.to_ascii_lowercase();
    if normalized_host != "github.com" && !normalized_host.contains("github.") {
        return Err("当前仓库远程不是 GitHub，暂不需要 GitHub 登录。".to_string());
    }

    Ok(GitHubAuthTarget {
        api_base: resolve_github_api_base(&host),
        auth_base: resolve_github_auth_base(&host),
        host,
        repository_root,
    })
}

fn clear_github_auth_credential_cache_for_host(host: &str) {
    if let Ok(mut cache) = github_auth_credential_cache().lock() {
        cache.remove(&host.to_ascii_lowercase());
    }
}

fn github_keyring_account(host: &str) -> String {
    format!("oauth:{}", host.to_ascii_lowercase())
}

fn get_keyring_token(host: &str) -> Option<String> {
    let account = github_keyring_account(host);
    let entry = keyring::Entry::new(GITHUB_KEYRING_SERVICE, &account).ok()?;
    let token = entry.get_password().ok()?;
    if token.trim().is_empty() {
        return None;
    }
    Some(token)
}

fn save_keyring_token(host: &str, token: &str) -> Result<(), String> {
    let account = github_keyring_account(host);
    let token = token.to_string();
    keyring::Entry::new(GITHUB_KEYRING_SERVICE, &account)
        .map_err(|error| format!("无法创建 GitHub 凭据条目：{error}"))?
        .set_password(&token)
        .map_err(|error| format!("无法保存 GitHub 凭据：{error}"))
}

fn delete_keyring_token(host: &str) -> Result<(), String> {
    let account = github_keyring_account(host);
    let entry = keyring::Entry::new(GITHUB_KEYRING_SERVICE, &account)
        .map_err(|error| format!("无法创建 GitHub 凭据条目：{error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除 GitHub 凭据：{error}")),
    }
}

async fn delete_keyring_token_for_host(host: &str) {
    let host = host.to_string();
    let _ = tokio::task::spawn_blocking(move || delete_keyring_token(&host)).await;
}

fn is_app_oauth_credential_source(source: &str) -> bool {
    source == "calamex-oauth"
}

async fn resolve_keyring_credential(host: &str) -> Option<GitHubResolvedCredential> {
    let host = host.to_string();
    tokio::task::spawn_blocking(move || get_keyring_token(&host))
        .await
        .ok()
        .flatten()
        .map(|token| GitHubResolvedCredential {
            token,
            source: "calamex-oauth".to_string(),
        })
}

async fn resolve_github_auth_credential(
    repository_root: &std::path::Path,
    host: &str,
) -> Option<GitHubResolvedCredential> {
    let cache_key = host.to_ascii_lowercase();
    let now = Instant::now();

    if let Some(cached) = github_auth_credential_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
        && cached.expires_at > now
    {
        return cached.credential;
    }

    let credential = if let Some(credential) = resolve_keyring_credential(host).await {
        Some(credential)
    } else if let Some(token) = resolve_github_cli_token(host) {
        Some(GitHubResolvedCredential {
            token,
            source: "github-cli".to_string(),
        })
    } else {
        resolve_git_credential_token(repository_root, host)
            .await
            .map(|token| GitHubResolvedCredential {
                token,
                source: "git-credential".to_string(),
            })
    };

    if let Ok(mut cache) = github_auth_credential_cache().lock() {
        cache.insert(
            cache_key,
            GitHubAuthCredentialCacheEntry {
                credential: credential.clone(),
                expires_at: now + GITHUB_AUTH_CREDENTIAL_CACHE_TTL,
            },
        );
    }

    credential
}

async fn resolve_git_credential_token(
    repository_root: &std::path::Path,
    host: &str,
) -> Option<String> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(repository_root)
        .arg("credential")
        .arg("fill")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut child = command.spawn().ok()?;
    {
        let mut stdin = child.stdin.take()?;
        let query = format!("protocol=https\nhost={host}\n\n");
        stdin.write_all(query.as_bytes()).await.ok()?;
    }

    let output = child.wait_with_output().await.ok()?;
    if !output.status.success() {
        return None;
    }

    parse_git_credential_password(&String::from_utf8_lossy(&output.stdout))
}

fn resolve_github_cli_token(host: &str) -> Option<String> {
    let output = std::process::Command::new("gh")
        .arg("auth")
        .arg("token")
        .arg("--hostname")
        .arg(host)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return None;
    }

    Some(token)
}

fn parse_git_credential_password(output: &str) -> Option<String> {
    for line in output.lines() {
        if let Some(token) = line.strip_prefix("password=") {
            let token = token.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }

    None
}

fn build_github_auth_client(token: &str) -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        HeaderName::from_static("x-github-api-version"),
        HeaderValue::from_static("2022-11-28"),
    );

    let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "GitHub 凭据包含非法字符。".to_string())?;
    authorization.set_sensitive(true);
    headers.insert(AUTHORIZATION, authorization);

    reqwest::Client::builder()
        .user_agent("calamex-github-auth")
        .default_headers(headers)
        .build()
        .map_err(|error| format!("创建 GitHub 登录客户端失败：{error}"))
}

fn build_github_oauth_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("calamex-github-auth")
        .build()
        .map_err(|error| format!("创建 GitHub 授权客户端失败：{error}"))
}

fn random_base64_url(byte_len: usize) -> Result<String, String> {
    let mut bytes = vec![0_u8; byte_len];
    getrandom::fill(&mut bytes).map_err(|error| format!("生成 GitHub 授权随机数失败：{error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn build_pkce_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn percent_encode_query_value(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn percent_decode_query_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    output.push(byte);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&output).into_owned()
}

fn extract_query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key == name {
            Some(percent_decode_query_value(value))
        } else {
            None
        }
    })
}

fn build_browser_authorization_url(
    target: &GitHubAuthTarget,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> String {
    let params = [
        ("client_id", GITHUB_OAUTH_CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("scope", GITHUB_OAUTH_SCOPE),
        ("state", state),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("prompt", "select_account"),
    ];
    let query = params
        .iter()
        .map(|(key, value)| format!("{key}={}", percent_encode_query_value(value)))
        .collect::<Vec<_>>()
        .join("&");

    format!("{}/login/oauth/authorize?{query}", target.auth_base)
}

fn build_oauth_callback_response(title: &str, message: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\nconnection: close\r\n\r\n<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>{title}</title><body style=\"font-family:system-ui,sans-serif;padding:32px;line-height:1.6\"><h1>{title}</h1><p>{message}</p><p>可以关闭此页面并返回 Calamex。</p></body></html>"
    )
}

async fn receive_github_oauth_callback(
    listener: TcpListener,
) -> Result<GitHubBrowserCallback, String> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|error| format!("接收 GitHub 浏览器回调失败：{error}"))?;
    let mut buffer = [0_u8; 8192];
    let bytes_read = stream
        .read(&mut buffer)
        .await
        .map_err(|error| format!("读取 GitHub 浏览器回调失败：{error}"))?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let request_target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "GitHub 浏览器回调请求格式无效。".to_string())?;

    if !request_target.starts_with(GITHUB_OAUTH_CALLBACK_PATH) {
        let response = build_oauth_callback_response("GitHub 授权失败", "收到的回调路径无效。");
        let _ = stream.write_all(response.as_bytes()).await;
        return Err("GitHub 浏览器回调路径无效。".to_string());
    }

    let query = request_target
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or_default();
    let callback = GitHubBrowserCallback {
        state: extract_query_param(query, "state").unwrap_or_default(),
        code: extract_query_param(query, "code"),
        error: extract_query_param(query, "error"),
        error_description: extract_query_param(query, "error_description"),
    };

    let (title, message) = if callback.error.is_some() {
        (
            "GitHub 授权失败",
            callback
                .error_description
                .as_deref()
                .unwrap_or("GitHub 返回了授权错误。"),
        )
    } else if callback.code.as_deref().unwrap_or_default().trim().is_empty() {
        ("GitHub 授权失败", "GitHub 回调缺少授权码。")
    } else {
        ("GitHub 授权完成", "Calamex 正在完成连接。")
    };
    let response = build_oauth_callback_response(title, message);
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;

    Ok(callback)
}

async fn request_github_browser_auth(
    target: &GitHubAuthTarget,
) -> Result<GitHubBrowserAuthPayload, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("启动 GitHub 本地授权回调失败：{error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("读取 GitHub 本地授权回调端口失败：{error}"))?;
    let redirect_uri = format!(
        "http://127.0.0.1:{}{}",
        local_addr.port(),
        GITHUB_OAUTH_CALLBACK_PATH
    );
    let state = random_base64_url(32)?;
    let code_verifier = random_base64_url(32)?;
    let code_challenge = build_pkce_challenge(&code_verifier);
    let authorization_url =
        build_browser_authorization_url(target, &redirect_uri, &state, &code_challenge);
    let expires_at = Instant::now() + GITHUB_BROWSER_AUTH_MAX_WAIT;
    let callback_task = tokio::spawn(receive_github_oauth_callback(listener));

    if let Ok(mut sessions) = github_browser_auth_sessions().lock() {
        sessions.retain(|_, session| session.expires_at > Instant::now());
        sessions.insert(
            state.clone(),
            GitHubBrowserAuthSession {
                host: target.host.clone(),
                repository_root: target.repository_root.clone(),
                redirect_uri,
                code_verifier,
                expires_at,
                callback_task,
            },
        );
    } else {
        return Err("GitHub 浏览器授权会话不可用。".to_string());
    }

    Ok(GitHubBrowserAuthPayload {
        authorization_url,
        state,
        expires_in: GITHUB_BROWSER_AUTH_MAX_WAIT.as_secs(),
    })
}

async fn exchange_github_browser_code(
    target: &GitHubAuthTarget,
    redirect_uri: &str,
    code_verifier: &str,
    code: &str,
) -> Result<String, String> {
    let client = build_github_oauth_client()?;
    let response = client
        .post(format!("{}/login/oauth/access_token", target.auth_base))
        .header(ACCEPT, "application/json")
        .form(&[
            ("client_id", GITHUB_OAUTH_CLIENT_ID),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|error| format!("请求 GitHub 访问令牌失败：{error}"))?;

    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 GitHub 访问令牌失败：{error}"))?;
    let token_response: GitHubOAuthTokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("解析 GitHub 访问令牌失败：{error}"))?;

    if let Some(token) = token_response.access_token
        && !token.trim().is_empty()
    {
        return Ok(token);
    }

    Err(token_response
        .error_description
        .or(token_response.error)
        .unwrap_or_else(|| "GitHub 授权响应缺少访问令牌。".to_string()))
}

async fn fetch_github_primary_email(
    client: &reqwest::Client,
    target: &GitHubAuthTarget,
) -> Option<String> {
    let response = client
        .get(format!("{}/user/emails", target.api_base))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let emails: Vec<GitHubUserEmail> = response.json().await.ok()?;
    emails
        .iter()
        .find(|email| email.primary && email.verified && !email.email.trim().is_empty())
        .or_else(|| {
            emails
                .iter()
                .find(|email| email.verified && !email.email.trim().is_empty())
        })
        .or_else(|| emails.iter().find(|email| !email.email.trim().is_empty()))
        .map(|email| email.email.clone())
}

async fn fetch_github_auth_status(
    target: &GitHubAuthTarget,
) -> Result<GitHubAuthStatusPayload, String> {
    let Some(credential) =
        resolve_github_auth_credential(&target.repository_root, &target.host).await
    else {
        return Ok(unauthenticated(
            "未发现可用的 GitHub 凭据。请先连接 GitHub 账号。",
        ));
    };

    let client = build_github_auth_client(&credential.token)?;
    let response = client
        .get(format!("{}/user", target.api_base))
        .send()
        .await
        .map_err(|error| format!("请求 GitHub 登录状态失败：{error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 GitHub 登录状态失败：{error}"))?;

    if !status.is_success() {
        clear_github_auth_credential_cache_for_host(&target.host);
        if is_app_oauth_credential_source(&credential.source) {
            delete_keyring_token_for_host(&target.host).await;
        }
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(|message| message.as_str())
                    .map(str::to_string)
            })
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| body.clone());
        return Ok(unauthenticated(format!(
            "GitHub 凭据不可用（{}）：{message}",
            status.as_u16()
        )));
    }

    let mut user: GitHubAuthenticatedUser = serde_json::from_str(&body)
        .map_err(|error| format!("解析 GitHub 用户信息失败：{error}"))?;

    if user
        .email
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        user.email = fetch_github_primary_email(&client, target).await;
    }

    Ok(authenticated(user, credential.source))
}

#[tauri::command]
#[specta::specta]
pub async fn get_github_auth_status(
    payload: GitHubAuthRequest,
) -> Result<GitHubAuthStatusPayload, String> {
    let target = resolve_github_auth_target(&payload.repository_root_path)?;
    fetch_github_auth_status(&target).await
}

#[tauri::command]
#[specta::specta]
pub async fn begin_github_browser_auth(
    payload: GitHubAuthRequest,
) -> Result<GitHubBrowserAuthPayload, String> {
    let target = resolve_github_auth_target(&payload.repository_root_path)?;
    clear_github_auth_credential_cache_for_host(&target.host);
    request_github_browser_auth(&target).await
}

#[tauri::command]
#[specta::specta]
pub async fn complete_github_browser_auth(
    payload: GitHubBrowserAuthCompleteRequest,
) -> Result<GitHubAuthStatusPayload, String> {
    let target = resolve_github_auth_target(&payload.repository_root_path)?;
    let session = github_browser_auth_sessions()
        .lock()
        .map_err(|_| "GitHub 浏览器授权会话不可用。".to_string())?
        .remove(&payload.state)
        .ok_or_else(|| "GitHub 浏览器授权会话已过期，请重新连接。".to_string())?;

    let GitHubBrowserAuthSession {
        host,
        repository_root,
        redirect_uri,
        code_verifier,
        callback_task,
        ..
    } = session;

    if host.to_ascii_lowercase() != target.host.to_ascii_lowercase()
        || repository_root != target.repository_root
    {
        callback_task.abort();
        return Err("GitHub 浏览器授权会话与当前仓库不匹配。".to_string());
    }

    let mut callback_task = callback_task;
    let callback = match timeout(GITHUB_BROWSER_AUTH_MAX_WAIT, &mut callback_task).await {
        Ok(join_result) => join_result
            .map_err(|error| format!("GitHub 浏览器授权任务异常终止：{error}"))??,
        Err(_) => {
            callback_task.abort();
            return Err("GitHub 浏览器授权等待超时，请重新连接。".to_string());
        }
    };

    if callback.state != payload.state {
        return Err("GitHub 浏览器授权状态校验失败，请重新连接。".to_string());
    }

    if let Some(error) = callback.error {
        return Err(callback
            .error_description
            .unwrap_or_else(|| format!("GitHub 浏览器授权失败：{error}")));
    }

    let code = callback
        .code
        .filter(|code| !code.trim().is_empty())
        .ok_or_else(|| "GitHub 浏览器回调缺少授权码。".to_string())?;
    let token = exchange_github_browser_code(&target, &redirect_uri, &code_verifier, &code).await?;
    let host = target.host.clone();
    tokio::task::spawn_blocking(move || save_keyring_token(&host, &token))
        .await
        .map_err(|error| format!("保存 GitHub 凭据任务异常终止：{error}"))??;
    clear_github_auth_credential_cache_for_host(&target.host);
    fetch_github_auth_status(&target).await
}

#[tauri::command]
#[specta::specta]
pub async fn connect_github(payload: GitHubAuthRequest) -> Result<GitHubAuthStatusPayload, String> {
    let target = resolve_github_auth_target(&payload.repository_root_path)?;
    clear_github_auth_credential_cache_for_host(&target.host);
    fetch_github_auth_status(&target).await
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect_github(
    payload: GitHubAuthRequest,
) -> Result<GitHubAuthStatusPayload, String> {
    let target = resolve_github_auth_target(&payload.repository_root_path)?;
    let host = target.host.clone();
    tokio::task::spawn_blocking(move || delete_keyring_token(&host))
        .await
        .map_err(|error| format!("删除 GitHub 凭据任务异常终止：{error}"))??;
    clear_github_auth_credential_cache_for_host(&target.host);
    Ok(unauthenticated("已断开 GitHub 账号。"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_github_remote_host_supports_common_remote_urls() {
        assert_eq!(
            parse_github_remote_host("git@github.com:owner/repo.git"),
            Some("github.com".to_string())
        );
        assert_eq!(
            parse_github_remote_host("https://github.com/owner/repo.git"),
            Some("github.com".to_string())
        );
        assert_eq!(
            parse_github_remote_host("ssh://git@github.enterprise.local/owner/repo.git"),
            Some("github.enterprise.local".to_string())
        );
    }

    #[test]
    fn parse_github_remote_host_supports_scp_and_ssh_variants() {
        assert_eq!(
            parse_github_remote_host("git@github.enterprise.local:owner/repo.git"),
            Some("github.enterprise.local".to_string())
        );
        assert_eq!(
            parse_github_remote_host("ssh://git@github.com:22/owner/repo.git"),
            Some("github.com".to_string())
        );
        assert_eq!(parse_github_remote_host("/local/path/repo"), None);
        assert_eq!(parse_github_remote_host("   "), None);
    }

    #[test]
    fn resolve_github_api_base_omits_literal_braces() {
        assert_eq!(
            resolve_github_api_base("github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            resolve_github_api_base("github.enterprise.local"),
            "https://api.github.enterprise.local"
        );
    }

    #[test]
    fn resolve_github_auth_base_targets_browser_origin() {
        assert_eq!(resolve_github_auth_base("github.com"), "https://github.com");
        assert_eq!(
            resolve_github_auth_base("github.enterprise.local"),
            "https://github.enterprise.local"
        );
    }

    #[test]
    fn github_keyring_account_scopes_by_host() {
        assert_eq!(github_keyring_account("GitHub.com"), "oauth:github.com");
    }

    #[test]
    fn app_oauth_source_is_the_only_keyring_cleanup_source() {
        assert!(is_app_oauth_credential_source("calamex-oauth"));
        assert!(!is_app_oauth_credential_source("github-cli"));
        assert!(!is_app_oauth_credential_source("git-credential"));
    }

    #[test]
    fn parse_git_credential_password_extracts_password_field() {
        assert_eq!(
            parse_git_credential_password(
                "protocol=https\nhost=github.com\nusername=x\npassword=gho_token\n"
            ),
            Some("gho_token".to_string())
        );
        assert_eq!(parse_git_credential_password("username=x\n"), None);
    }

    #[test]
    fn pkce_challenge_uses_sha256_base64url_without_padding() {
        assert_eq!(
            build_pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn query_percent_encoding_round_trips_callback_values() {
        let value = "http://127.0.0.1:49152/github/oauth/callback?x=a b";
        assert_eq!(
            percent_decode_query_value(&percent_encode_query_value(value)),
            value
        );
    }
}
