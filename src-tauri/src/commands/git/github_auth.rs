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
use tokio::io::AsyncWriteExt;

const GITHUB_AUTH_CREDENTIAL_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthRequest {
    repository_root_path: String,
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

#[derive(Clone)]
struct GitHubAuthCredentialCacheEntry {
    token: Option<String>,
    expires_at: Instant,
}

struct GitHubAuthTarget {
    host: String,
    api_base: String,
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

fn authenticated(user: GitHubAuthenticatedUser) -> GitHubAuthStatusPayload {
    GitHubAuthStatusPayload {
        authenticated: true,
        login: Some(user.login),
        name: user.name,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
        email: user.email,
        source: Some("git-credential".to_string()),
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

    let api_base = if normalized_host == "github.com" {
        "https://api.github.com".to_string()
    } else {
        format!("https://api.{host}")
    };

    Ok(GitHubAuthTarget {
        host,
        api_base,
        repository_root,
    })
}

fn clear_github_auth_credential_cache_for_host(host: &str) {
    if let Ok(mut cache) = github_auth_credential_cache().lock() {
        cache.remove(&host.to_ascii_lowercase());
    }
}

async fn resolve_github_auth_credential(repository_root: &std::path::Path, host: &str) -> Option<String> {
    let cache_key = host.to_ascii_lowercase();
    let now = Instant::now();

    if let Some(cached) = github_auth_credential_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
    {
        if cached.expires_at > now {
            return cached.token;
        }
    }

    let token = async {
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

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Some(token) = line.strip_prefix("password=") {
                let token = token.trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }

        None
    }
    .await;

    if let Ok(mut cache) = github_auth_credential_cache().lock() {
        cache.insert(
            cache_key,
            GitHubAuthCredentialCacheEntry {
                token: token.clone(),
                expires_at: now + GITHUB_AUTH_CREDENTIAL_CACHE_TTL,
            },
        );
    }

    token
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

async fn fetch_github_auth_status(target: &GitHubAuthTarget) -> Result<GitHubAuthStatusPayload, String> {
    let Some(token) = resolve_github_auth_credential(&target.repository_root, &target.host).await else {
        return Ok(unauthenticated(
            "未发现可用的 GitHub 凭据。请先通过 GitHub CLI、Git Credential Manager 或一次 git push 完成 GitHub 登录。",
        ));
    };

    let client = build_github_auth_client(&token)?;
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
            .and_then(|value| value.get("message").and_then(|message| message.as_str()).map(str::to_string))
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| body.clone());
        return Ok(unauthenticated(format!(
            "GitHub 凭据不可用（{}）：{message}",
            status.as_u16()
        )));
    }

    let user: GitHubAuthenticatedUser = serde_json::from_str(&body)
        .map_err(|error| format!("解析 GitHub 用户信息失败：{error}"))?;

    Ok(authenticated(user))
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
    clear_github_auth_credential_cache_for_host(&target.host);
    Ok(unauthenticated(
        "已清除 Calamex 当前会话中的 GitHub 登录缓存；系统 Git 凭据仍由操作系统或 Git Credential Manager 管理。",
    ))
}
