use super::*;
use gix::bstr::ByteSlice;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{io::AsyncWriteExt, time::sleep};

const GITHUB_AUTH_CREDENTIAL_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const GITHUB_DEVICE_AUTH_MAX_WAIT: Duration = Duration::from_secs(120);
const GITHUB_DEVICE_AUTH_SCOPE: &str = "read:user user:email repo";
const GITHUB_KEYRING_SERVICE: &str = "calamex.github";

// GitHub OAuth client IDs are public identifiers. This mirrors VS Code's
// device-code strategy: use a native-app flow that does not require a client
// secret, then store the resulting token in the OS keyring.
const GITHUB_OAUTH_CLIENT_ID: &str = "01ab8ac9400c4e429b23";

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthRequest {
    repository_root_path: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDeviceAuthCompleteRequest {
    repository_root_path: String,
    device_code: String,
    #[specta(type = u32)]
    interval: u64,
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
pub struct GitHubDeviceAuthPayload {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[specta(type = u32)]
    interval: u64,
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
struct GitHubDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
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

static GITHUB_AUTH_CREDENTIAL_CACHE: OnceLock<Mutex<HashMap<String, GitHubAuthCredentialCacheEntry>>> =
    OnceLock::new();

fn github_auth_credential_cache() -> &'static Mutex<HashMap<String, GitHubAuthCredentialCacheEntry>> {
    GITHUB_AUTH_CREDENTIAL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
    if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, _) = rest.split_once(':')?;
        return Some(host.trim().to_string());
    }

    for scheme in ["https://", "http://", "ssh://", "git://"] {
        if let Some(rest) = trimmed.strip_prefix(scheme) {
            let authority = rest.split('/').next()?.trim();
            let host = authority
                .split('@')
                .next_back()
                .unwrap_or(authority)
                .split(':')
                .next()
                .unwrap_or(authority)
                .trim_matches('/');
            if !host.is_empty() {
                return Some(host.to_string());
            }
        }
    }

    None
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
    {
        if cached.expires_at > now {
            return cached.credential;
        }
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
    let Some(credential) = resolve_github_auth_credential(&target.repository_root, &target.host).await
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

    if user.email.as_deref().map(str::trim).unwrap_or_default().is_empty() {
        user.email = fetch_github_primary_email(&client, target).await;
    }

    Ok(authenticated(user, credential.source))
}

async fn request_github_device_code(
    target: &GitHubAuthTarget,
) -> Result<GitHubDeviceAuthPayload, String> {
    let client = build_github_oauth_client()?;
    let response = client
        .post(format!("{}/login/device/code", target.auth_base))
        .header(ACCEPT, "application/json")
        .form(&[
            ("client_id", GITHUB_OAUTH_CLIENT_ID),
            ("scope", GITHUB_DEVICE_AUTH_SCOPE),
        ])
        .send()
        .await
        .map_err(|error| format!("请求 GitHub 设备授权码失败：{error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 GitHub 设备授权码失败：{error}"))?;

    if !status.is_success() {
        return Err(format!("请求 GitHub 设备授权码失败（{}）：{body}", status.as_u16()));
    }

    let payload: GitHubDeviceCodeResponse = serde_json::from_str(&body)
        .map_err(|error| format!("解析 GitHub 设备授权码失败：{error}"))?;

    Ok(GitHubDeviceAuthPayload {
        device_code: payload.device_code,
        user_code: payload.user_code,
        verification_uri: payload.verification_uri,
        interval: payload.interval.max(1),
        expires_in: payload.expires_in,
    })
}

async fn poll_github_device_token(
    target: &GitHubAuthTarget,
    request: &GitHubDeviceAuthCompleteRequest,
) -> Result<String, String> {
    let client = build_github_oauth_client()?;
    let started_at = Instant::now();
    let mut interval = request.interval.max(1);

    while started_at.elapsed() < GITHUB_DEVICE_AUTH_MAX_WAIT {
        sleep(Duration::from_secs(interval)).await;

        let response = client
            .post(format!("{}/login/oauth/access_token", target.auth_base))
            .header(ACCEPT, "application/json")
            .form(&[
                ("client_id", GITHUB_OAUTH_CLIENT_ID),
                ("device_code", request.device_code.as_str()),
                (
                    "grant_type",
                    "urn:ietf:params:oauth:grant-type:device_code",
                ),
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

        if let Some(token) = token_response.access_token {
            if !token.trim().is_empty() {
                return Ok(token);
            }
        }

        match token_response.error.as_deref() {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                interval += 5;
            }
            Some("expired_token") => return Err("GitHub 授权码已过期，请重新连接。".to_string()),
            Some("access_denied") => return Err("GitHub 授权已取消。".to_string()),
            Some(error) => {
                return Err(
                    token_response
                        .error_description
                        .unwrap_or_else(|| format!("GitHub 授权失败：{error}")),
                );
            }
            None => return Err("GitHub 授权响应缺少访问令牌。".to_string()),
        }
    }

    Err("GitHub 授权等待超时，请重新连接。".to_string())
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
pub async fn begin_github_device_auth(
    payload: GitHubAuthRequest,
) -> Result<GitHubDeviceAuthPayload, String> {
    let target = resolve_github_auth_target(&payload.repository_root_path)?;
    clear_github_auth_credential_cache_for_host(&target.host);
    request_github_device_code(&target).await
}

#[tauri::command]
#[specta::specta]
pub async fn complete_github_device_auth(
    payload: GitHubDeviceAuthCompleteRequest,
) -> Result<GitHubAuthStatusPayload, String> {
    let target = resolve_github_auth_target(&payload.repository_root_path)?;
    clear_github_auth_credential_cache_for_host(&target.host);
    let token = poll_github_device_token(&target, &payload).await?;
    let host = target.host.clone();
    tokio::task::spawn_blocking(move || save_keyring_token(&host, &token))
        .await
        .map_err(|error| format!("保存 GitHub 凭据任务异常终止：{error}"))??;
    clear_github_auth_credential_cache_for_host(&target.host);
    fetch_github_auth_status(&target).await
}

#[tauri::command]
#[specta::specta]
pub async fn connect_github(
    payload: GitHubAuthRequest,
) -> Result<GitHubAuthStatusPayload, String> {
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
    fn resolve_github_api_base_omits_literal_braces() {
        assert_eq!(resolve_github_api_base("github.com"), "https://api.github.com");
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
    fn parse_git_credential_password_extracts_password_field() {
        assert_eq!(
            parse_git_credential_password("protocol=https\nhost=github.com\nusername=x\npassword=gho_token\n"),
            Some("gho_token".to_string())
        );
        assert_eq!(parse_git_credential_password("username=x\n"), None);
    }
}
