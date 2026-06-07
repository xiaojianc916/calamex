use super::*;
use gix::bstr::ByteSlice;

const AUTHORITY_PATH_REMOTE_SCHEMES: &[&str] = &["ssh://", "https://", "http://", "git://"];

struct ParsedGitRemoteRepositoryUrl {
    host: String,
    repository_url: String,
}

#[tauri::command]
#[specta::specta]
pub fn get_git_pull_request_support(
    payload: GitRepositoryRootRequest,
) -> Result<GitPullRequestSupportPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;

    let Some((remote_name, remote_url)) = find_preferred_git_remote(&repository)? else {
        return Ok(GitPullRequestSupportPayload {
            available: false,
            remote_name: None,
            provider: "unknown".into(),
            repository_url: None,
            pull_requests_url: None,
            create_pull_request_url: None,
        });
    };

    let Some(parsed_remote) = parse_git_remote_repository_url(&remote_url) else {
        return Ok(GitPullRequestSupportPayload {
            available: false,
            remote_name: Some(remote_name),
            provider: "unknown".into(),
            repository_url: None,
            pull_requests_url: None,
            create_pull_request_url: None,
        });
    };

    let provider = resolve_pull_request_provider(&parsed_remote.host);
    let repository_url = parsed_remote.repository_url;
    let (pull_requests_url, create_pull_request_url) = build_pull_request_urls(provider, &repository_url);

    Ok(GitPullRequestSupportPayload {
        available: pull_requests_url.is_some() || create_pull_request_url.is_some(),
        remote_name: Some(remote_name),
        provider: provider.to_string(),
        repository_url: Some(repository_url),
        pull_requests_url,
        create_pull_request_url,
    })
}

#[tauri::command]
#[specta::specta]
pub fn set_git_remote(
    payload: GitRemoteSetRequest,
) -> Result<GitPullRequestSupportPayload, String> {
    let remote_name = payload.remote_name.trim().to_string();
    let remote_url = payload.remote_url.trim().to_string();

    if remote_name.is_empty() {
        return Err("远程名称不能为空。".to_string());
    }
    if remote_url.is_empty() {
        return Err("远程地址不能为空。".to_string());
    }

    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;

    let remote_already_exists = repository
        .remote_names()
        .iter()
        .any(|name| name.as_bstr().to_str_lossy().as_ref() == remote_name.as_str());

    let subcommand = if remote_already_exists { "set-url" } else { "add" };
    run_git_remote_subcommand(&repository_root, subcommand, &remote_name, &remote_url)?;

    clear_github_pull_request_cache_for_repository(&payload.repository_root_path);
    get_git_pull_request_support(GitRepositoryRootRequest {
        repository_root_path: payload.repository_root_path,
    })
}

fn run_git_remote_subcommand(
    repository_root: &std::path::Path,
    subcommand: &str,
    remote_name: &str,
    remote_url: &str,
) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repository_root)
        .arg("remote")
        .arg(subcommand)
        .arg(remote_name)
        .arg(remote_url)
        .output()
        .map_err(|error| format!("调用 git 配置远程失败：{error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            "git 返回了非零退出码。"
        } else {
            detail
        };
        return Err(format!("配置 Git 远程失败：{detail}"));
    }

    Ok(())
}

fn find_preferred_git_remote(repository: &Repository) -> Result<Option<(String, String)>, String> {
    let names = repository.remote_names();
    let mut remote_list: Vec<String> = names
        .iter()
        .map(|n| n.as_bstr().to_str_lossy().into_owned())
        .collect();

    remote_list.sort_by_key(|name| if name == "origin" { 0 } else { 1 });

    for name in &remote_list {
        let remote = match repository.find_remote(name.as_str()) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let Some(remote_url) = remote.url(gix::remote::Direction::Fetch) else {
            continue;
        };

        let url_str = remote_url.to_bstring().to_str_lossy().into_owned();
        if url_str.trim().is_empty() {
            continue;
        }

        return Ok(Some((name.clone(), url_str)));
    }

    Ok(None)
}

fn parse_git_remote_repository_url(url: &str) -> Option<ParsedGitRemoteRepositoryUrl> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (host, raw_path) = if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = AUTHORITY_PATH_REMOTE_SCHEMES
        .iter()
        .find_map(|scheme| trimmed.strip_prefix(scheme))
    {
        parse_authority_path_remote(rest)?
    } else {
        return None;
    };

    let host = host
        .split('@')
        .next_back()
        .unwrap_or(host.as_str())
        .split(':')
        .next()
        .unwrap_or(host.as_str())
        .trim_matches('/')
        .to_string();

    let repository_path = raw_path.trim_matches('/');
    if repository_path.is_empty() {
        return None;
    }

    let repository_path = repository_path
        .strip_suffix(".git")
        .unwrap_or(repository_path)
        .to_string();

    let repository_url = ["https://", host.as_str(), "/", repository_path.as_str()].concat();

    Some(ParsedGitRemoteRepositoryUrl {
        host,
        repository_url,
    })
}

fn parse_authority_path_remote(input: &str) -> Option<(String, String)> {
    let (authority, path) = input.split_once('/')?;
    Some((authority.to_string(), path.to_string()))
}

fn resolve_pull_request_provider(host: &str) -> &'static str {
    let normalized_host = host.to_ascii_lowercase();
    if normalized_host == "github.com" || normalized_host.contains("github.") {
        return "github";
    }
    if normalized_host == "gitlab.com" || normalized_host.contains("gitlab.") {
        return "gitlab";
    }
    if normalized_host == "bitbucket.org" || normalized_host.contains("bitbucket") {
        return "bitbucket";
    }
    if normalized_host.contains("gitea") {
        return "gitea";
    }
    "unknown"
}

fn build_pull_request_urls(
    provider: &str,
    repository_url: &str,
) -> (Option<String>, Option<String>) {
    match provider {
        "github" => (
            Some(format!("{repository_url}/pulls")),
            Some(format!("{repository_url}/compare")),
        ),
        "gitlab" => (
            Some(format!("{repository_url}/-/merge_requests")),
            Some(format!("{repository_url}/-/merge_requests/new")),
        ),
        "bitbucket" => (
            Some(format!("{repository_url}/pull-requests")),
            Some(format!("{repository_url}/pull-requests/new")),
        ),
        "gitea" => (
            Some(format!("{repository_url}/pulls")),
            Some(format!("{repository_url}/compare")),
        ),
        _ => (None, None),
    }
}

// ===========================================================================
// GitHub Pull Request 真·功能：通过 GitHub REST API 拉取/创建/合并/关闭 PR。
// Token 复用本机 git 凭据（git credential fill），无需用户另填 PAT。
// 结构体就近定义于此（子模块可访问父模块私有项，故无需改动 git.rs）。
// ===========================================================================
use reqwest::header::{
    ACCEPT, AUTHORIZATION, ETAG, HeaderMap, HeaderName, HeaderValue, IF_NONE_MATCH,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;

const GITHUB_CREDENTIAL_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const GITHUB_PULL_REQUEST_FRESH_TTL: Duration = Duration::from_secs(15);
const GITHUB_PULL_REQUEST_STALE_IF_ERROR_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestListRequest {
    repository_root_path: String,
    state: Option<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestDetailRequest {
    repository_root_path: String,
    number: u32,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestCreateRequest {
    repository_root_path: String,
    title: String,
    body: Option<String>,
    base: String,
    head: String,
    draft: Option<bool>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestMergeRequest {
    repository_root_path: String,
    number: u32,
    merge_method: Option<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestCloseRequest {
    repository_root_path: String,
    number: u32,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestSummaryPayload {
    number: u32,
    title: String,
    state: String,
    is_draft: bool,
    author: Option<String>,
    head_ref: String,
    base_ref: String,
    html_url: String,
    created_at: String,
    updated_at: String,
    comments: Option<u32>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestDetailPayload {
    number: u32,
    title: String,
    state: String,
    is_draft: bool,
    author: Option<String>,
    head_ref: String,
    base_ref: String,
    html_url: String,
    created_at: String,
    updated_at: String,
    body: String,
    comments: Option<u32>,
    additions: Option<u32>,
    deletions: Option<u32>,
    changed_files: Option<u32>,
    mergeable: Option<bool>,
    mergeable_state: Option<String>,
}

struct GitHubRepositoryTarget {
    owner: String,
    repo: String,
    host: String,
    api_base: String,
    repository_root: std::path::PathBuf,
}

#[derive(Clone, Deserialize)]
struct GitHubUser {
    login: String,
}

#[derive(Clone, Deserialize)]
struct GitHubBranchRef {
    #[serde(rename = "ref")]
    ref_name: String,
}

#[derive(Clone, Deserialize)]
struct GitHubPullRequest {
    number: u32,
    title: String,
    state: String,
    #[serde(default)]
    draft: Option<bool>,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    user: Option<GitHubUser>,
    head: GitHubBranchRef,
    base: GitHubBranchRef,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    comments: Option<u32>,
    #[serde(default)]
    additions: Option<u32>,
    #[serde(default)]
    deletions: Option<u32>,
    #[serde(default)]
    changed_files: Option<u32>,
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    mergeable_state: Option<String>,
}

#[derive(Clone)]
struct GitHubCredentialCacheEntry {
    token: Option<String>,
    expires_at: Instant,
}

#[derive(Clone)]
struct GitHubPullRequestCacheEntry {
    etag: Option<String>,
    pull_requests: Vec<GitHubPullRequest>,
    fetched_at: Instant,
}

#[derive(Clone)]
struct GitHubPullRequestDetailCacheEntry {
    etag: Option<String>,
    pull_request: GitHubPullRequest,
    fetched_at: Instant,
}

static GITHUB_CREDENTIAL_CACHE: OnceLock<Mutex<HashMap<String, GitHubCredentialCacheEntry>>> = OnceLock::new();
static GITHUB_PULL_REQUEST_CACHE: OnceLock<Mutex<HashMap<String, GitHubPullRequestCacheEntry>>> = OnceLock::new();
static GITHUB_PULL_REQUEST_DETAIL_CACHE: OnceLock<Mutex<HashMap<String, GitHubPullRequestDetailCacheEntry>>> = OnceLock::new();

fn github_credential_cache() -> &'static Mutex<HashMap<String, GitHubCredentialCacheEntry>> {
    GITHUB_CREDENTIAL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn github_pull_request_cache() -> &'static Mutex<HashMap<String, GitHubPullRequestCacheEntry>> {
    GITHUB_PULL_REQUEST_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn github_pull_request_detail_cache() -> &'static Mutex<HashMap<String, GitHubPullRequestDetailCacheEntry>> {
    GITHUB_PULL_REQUEST_DETAIL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn clear_github_pull_request_cache_for_repository(repository_root_path: &str) {
    let normalized_root = normalize_path_for_git(Path::new(repository_root_path))
        .to_string_lossy()
        .to_string();
    let repository_prefix = format!("{normalized_root}|");

    if let Ok(mut cache) = github_pull_request_cache().lock() {
        cache.retain(|key, _| !key.starts_with(&repository_prefix));
    }
    if let Ok(mut cache) = github_pull_request_detail_cache().lock() {
        cache.retain(|key, _| !key.starts_with(&repository_prefix));
    }
}

fn pull_request_cache_key(target: &GitHubRepositoryTarget, state: &str) -> String {
    [
        target.repository_root.to_string_lossy().as_ref(),
        target.api_base.as_str(),
        target.owner.as_str(),
        target.repo.as_str(),
        state,
    ]
    .join("|")
}

fn pull_request_detail_cache_key(target: &GitHubRepositoryTarget, number: u32) -> String {
    [
        target.repository_root.to_string_lossy().as_ref(),
        target.api_base.as_str(),
        target.owner.as_str(),
        target.repo.as_str(),
        number.to_string().as_str(),
    ]
    .join("|")
}

fn cached_pull_requests(cache_key: &str) -> Option<GitHubPullRequestCacheEntry> {
    github_pull_request_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(cache_key).cloned())
}

fn cached_pull_request_detail(cache_key: &str) -> Option<GitHubPullRequestDetailCacheEntry> {
    github_pull_request_detail_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(cache_key).cloned())
}

fn remember_pull_requests(
    cache_key: String,
    etag: Option<String>,
    pull_requests: Vec<GitHubPullRequest>,
) {
    if let Ok(mut cache) = github_pull_request_cache().lock() {
        cache.insert(
            cache_key,
            GitHubPullRequestCacheEntry {
                etag,
                pull_requests,
                fetched_at: Instant::now(),
            },
        );
    }
}

fn remember_pull_request_detail(
    cache_key: String,
    etag: Option<String>,
    pull_request: GitHubPullRequest,
) {
    if let Ok(mut cache) = github_pull_request_detail_cache().lock() {
        cache.insert(
            cache_key,
            GitHubPullRequestDetailCacheEntry {
                etag,
                pull_request,
                fetched_at: Instant::now(),
            },
        );
    }
}

fn touch_pull_request_cache(cache_key: &str) {
    if let Ok(mut cache) = github_pull_request_cache().lock() {
        if let Some(entry) = cache.get_mut(cache_key) {
            entry.fetched_at = Instant::now();
        }
    }
}

fn touch_pull_request_detail_cache(cache_key: &str) {
    if let Ok(mut cache) = github_pull_request_detail_cache().lock() {
        if let Some(entry) = cache.get_mut(cache_key) {
            entry.fetched_at = Instant::now();
        }
    }
}

fn map_pull_request_list(
    pull_requests: &[GitHubPullRequest],
) -> Vec<GitPullRequestSummaryPayload> {
    pull_requests.iter().map(map_pull_request_summary).collect()
}

fn resolve_github_repository_target(
    repository_root_path: &str,
) -> Result<GitHubRepositoryTarget, String> {
    let repository = open_repository_from_root(repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;

    let Some((_, remote_url)) = find_preferred_git_remote(&repository)? else {
        return Err("当前仓库没有可用的远程地址，请先配置远程后再使用 Pull Request。".to_string());
    };

    let Some(parsed) = parse_git_remote_repository_url(&remote_url) else {
        return Err("无法解析当前仓库的远程地址。".to_string());
    };

    if resolve_pull_request_provider(&parsed.host) != "github" {
        return Err("当前仅支持 GitHub 仓库的 Pull Request。".to_string());
    }

    let path_part = parsed
        .repository_url
        .strip_prefix("https://")
        .and_then(|rest| rest.split_once('/'))
        .map(|(_, path)| path.trim_matches('/').to_string())
        .unwrap_or_default();

    let mut segments = path_part.splitn(2, '/');
    let owner = segments.next().unwrap_or_default().trim().to_string();
    let repo = segments
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string();

    if owner.is_empty() || repo.is_empty() {
        return Err("无法从远程地址解析出 GitHub 的 owner/repo。".to_string());
    }

    let api_base = if parsed.host.eq_ignore_ascii_case("github.com") {
        "https://api.github.com".to_string()
    } else {
        let mut api_base = "https://api.".to_string();
        api_base.push_str(&parsed.host);
        api_base
    };

    Ok(GitHubRepositoryTarget {
        owner,
        repo,
        host: parsed.host,
        api_base,
        repository_root,
    })
}

async fn resolve_github_credential(repository_root: &std::path::Path, host: &str) -> Option<String> {
    let cache_key = host.to_ascii_lowercase();
    let now = Instant::now();

    if let Some(cached) = github_credential_cache()
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

    if let Ok(mut cache) = github_credential_cache().lock() {
        cache.insert(
            cache_key,
            GitHubCredentialCacheEntry {
                token: token.clone(),
                expires_at: now + GITHUB_CREDENTIAL_CACHE_TTL,
            },
        );
    }

    token
}

fn build_github_client(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        HeaderName::from_static("x-github-api-version"),
        HeaderValue::from_static("2022-11-28"),
    );

    if let Some(token) = token {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "GitHub 凭据包含非法字符。".to_string())?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }

    reqwest::Client::builder()
        .user_agent("calamex-git-panel")
        .default_headers(headers)
        .build()
        .map_err(|error| format!("创建 GitHub 客户端失败：{error}"))
}

fn annotate_auth_error(error: String, has_token: bool) -> String {
    if has_token {
        error
    } else {
        format!(
            "{error}\n提示：未能从本机 git 凭据读取 GitHub Token。请先用 git 登录 GitHub（例如执行一次 git push，或在 Windows 凭据管理器中为 github.com 配置凭据）。"
        )
    }
}

async fn read_github_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 GitHub 响应失败：{error}"))?;

    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(|message| message.as_str())
                    .map(|message| message.to_string())
            })
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| body.clone());

        return Err(format!(
            "GitHub API 返回错误（{}）：{message}",
            status.as_u16()
        ));
    }

    serde_json::from_str::<T>(&body).map_err(|error| format!("解析 GitHub 响应失败：{error}"))
}

fn map_pull_request_summary(pull_request: &GitHubPullRequest) -> GitPullRequestSummaryPayload {
    let state = if pull_request.merged_at.is_some() {
        "merged".to_string()
    } else {
        pull_request.state.clone()
    };

    GitPullRequestSummaryPayload {
        number: pull_request.number,
        title: pull_request.title.clone(),
        state,
        is_draft: pull_request.draft.unwrap_or(false),
        author: pull_request.user.as_ref().map(|user| user.login.clone()),
        head_ref: pull_request.head.ref_name.clone(),
        base_ref: pull_request.base.ref_name.clone(),
        html_url: pull_request.html_url.clone(),
        created_at: pull_request.created_at.clone(),
        updated_at: pull_request.updated_at.clone(),
        comments: pull_request.comments,
    }
}

fn map_pull_request_detail(pull_request: &GitHubPullRequest) -> GitPullRequestDetailPayload {
    let state = if pull_request.merged_at.is_some() {
        "merged".to_string()
    } else {
        pull_request.state.clone()
    };

    GitPullRequestDetailPayload {
        number: pull_request.number,
        title: pull_request.title.clone(),
        state,
        is_draft: pull_request.draft.unwrap_or(false),
        author: pull_request.user.as_ref().map(|user| user.login.clone()),
        head_ref: pull_request.head.ref_name.clone(),
        base_ref: pull_request.base.ref_name.clone(),
        html_url: pull_request.html_url.clone(),
        created_at: pull_request.created_at.clone(),
        updated_at: pull_request.updated_at.clone(),
        body: pull_request.body.clone().unwrap_or_default(),
        comments: pull_request.comments,
        additions: pull_request.additions,
        deletions: pull_request.deletions,
        changed_files: pull_request.changed_files,
        mergeable: pull_request.mergeable,
        mergeable_state: pull_request.mergeable_state.clone(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn list_git_pull_requests(
    payload: GitPullRequestListRequest,
) -> Result<Vec<GitPullRequestSummaryPayload>, String> {
    let target = resolve_github_repository_target(&payload.repository_root_path)?;
    let token = resolve_github_credential(&target.repository_root, &target.host).await;
    let has_token = token.is_some();
    let client = build_github_client(token.as_deref())?;

    let state = match payload.state.as_deref() {
        Some("closed") => "closed",
        Some("all") => "all",
        _ => "open",
    };

    let cache_key = pull_request_cache_key(&target, state);
    let cached = cached_pull_requests(&cache_key);

    if let Some(cached) = cached.as_ref() {
        if cached.fetched_at.elapsed() <= GITHUB_PULL_REQUEST_FRESH_TTL {
            return Ok(map_pull_request_list(&cached.pull_requests));
        }
    }

    let url = format!(
        "{}/repos/{}/{}/pulls?state={}&per_page=50&sort=updated&direction=desc",
        target.api_base, target.owner, target.repo, state
    );

    let mut request = client.get(&url);
    if let Some(etag) = cached.as_ref().and_then(|entry| entry.etag.as_deref()) {
        request = request.header(IF_NONE_MATCH, etag);
    }

    let response = request
        .send()
        .await
        .map_err(|error| annotate_auth_error(format!("请求 GitHub 失败：{error}"), has_token))?;

    if response.status().as_u16() == 304 {
        if let Some(cached) = cached {
            touch_pull_request_cache(&cache_key);
            return Ok(map_pull_request_list(&cached.pull_requests));
        }
    }

    if !response.status().is_success() {
        if let Some(cached) = cached {
            if cached.fetched_at.elapsed() <= GITHUB_PULL_REQUEST_STALE_IF_ERROR_TTL {
                return Ok(map_pull_request_list(&cached.pull_requests));
            }
        }

        return read_github_json::<Vec<GitHubPullRequest>>(response)
            .await
            .map(|pull_requests| {
                remember_pull_requests(cache_key, None, pull_requests.clone());
                map_pull_request_list(&pull_requests)
            })
            .map_err(|error| annotate_auth_error(error, has_token));
    }

    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    let pull_requests: Vec<GitHubPullRequest> = read_github_json(response)
        .await
        .map_err(|error| annotate_auth_error(error, has_token))?;

    remember_pull_requests(cache_key, etag, pull_requests.clone());
    Ok(map_pull_request_list(&pull_requests))
}

#[tauri::command]
#[specta::specta]
pub async fn get_git_pull_request_detail(
    payload: GitPullRequestDetailRequest,
) -> Result<GitPullRequestDetailPayload, String> {
    let target = resolve_github_repository_target(&payload.repository_root_path)?;
    let token = resolve_github_credential(&target.repository_root, &target.host).await;
    let has_token = token.is_some();
    let client = build_github_client(token.as_deref())?;
    let cache_key = pull_request_detail_cache_key(&target, payload.number);
    let cached = cached_pull_request_detail(&cache_key);

    if let Some(cached) = cached.as_ref() {
        if cached.fetched_at.elapsed() <= GITHUB_PULL_REQUEST_FRESH_TTL {
            return Ok(map_pull_request_detail(&cached.pull_request));
        }
    }

    let url = format!(
        "{}/repos/{}/{}/pulls/{}",
        target.api_base, target.owner, target.repo, payload.number
    );

    let mut request = client.get(&url);
    if let Some(etag) = cached.as_ref().and_then(|entry| entry.etag.as_deref()) {
        request = request.header(IF_NONE_MATCH, etag);
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            if let Some(cached) = cached {
                if cached.fetched_at.elapsed() <= GITHUB_PULL_REQUEST_STALE_IF_ERROR_TTL {
                    return Ok(map_pull_request_detail(&cached.pull_request));
                }
            }
            return Err(annotate_auth_error(format!("请求 GitHub 失败：{error}"), has_token));
        }
    };

    if response.status().as_u16() == 304 {
        if let Some(cached) = cached {
            touch_pull_request_detail_cache(&cache_key);
            return Ok(map_pull_request_detail(&cached.pull_request));
        }
    }

    if !response.status().is_success() {
        if let Some(cached) = cached {
            if cached.fetched_at.elapsed() <= GITHUB_PULL_REQUEST_STALE_IF_ERROR_TTL {
                return Ok(map_pull_request_detail(&cached.pull_request));
            }
        }

        return read_github_json::<GitHubPullRequest>(response)
            .await
            .map(|pull_request| {
                remember_pull_request_detail(cache_key, None, pull_request.clone());
                map_pull_request_detail(&pull_request)
            })
            .map_err(|error| annotate_auth_error(error, has_token));
    }

    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    let pull_request: GitHubPullRequest = read_github_json(response)
        .await
        .map_err(|error| annotate_auth_error(error, has_token))?;

    remember_pull_request_detail(cache_key, etag, pull_request.clone());
    Ok(map_pull_request_detail(&pull_request))
}

#[tauri::command]
#[specta::specta]
pub async fn create_git_pull_request(
    payload: GitPullRequestCreateRequest,
) -> Result<GitPullRequestSummaryPayload, String> {
    let title = payload.title.trim().to_string();
    let base = payload.base.trim().to_string();
    let head = payload.head.trim().to_string();

    if title.is_empty() {
        return Err("Pull Request 标题不能为空。".to_string());
    }
    if base.is_empty() || head.is_empty() {
        return Err("请填写目标分支（base）与来源分支（head）。".to_string());
    }

    let target = resolve_github_repository_target(&payload.repository_root_path)?;
    let token = resolve_github_credential(&target.repository_root, &target.host).await;
    let has_token = token.is_some();
    let client = build_github_client(token.as_deref())?;

    let request_body = serde_json::json!({
        "title": title,
        "head": head,
        "base": base,
        "body": payload.body.unwrap_or_default(),
        "draft": payload.draft.unwrap_or(false),
    });

    let url = format!(
        "{}/repos/{}/{}/pulls",
        target.api_base, target.owner, target.repo
    );

    let response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|error| annotate_auth_error(format!("请求 GitHub 失败：{error}"), has_token))?;

    let pull_request: GitHubPullRequest = read_github_json(response)
        .await
        .map_err(|error| annotate_auth_error(error, has_token))?;

    clear_github_pull_request_cache_for_repository(
        target.repository_root.to_string_lossy().as_ref(),
    );

    Ok(map_pull_request_summary(&pull_request))
}

#[tauri::command]
#[specta::specta]
pub async fn merge_git_pull_request(
    payload: GitPullRequestMergeRequest,
) -> Result<GitPullRequestSummaryPayload, String> {
    let target = resolve_github_repository_target(&payload.repository_root_path)?;
    let token = resolve_github_credential(&target.repository_root, &target.host).await;
    let has_token = token.is_some();
    let client = build_github_client(token.as_deref())?;

    let merge_method = match payload.merge_method.as_deref() {
        Some("squash") => "squash",
        Some("rebase") => "rebase",
        _ => "merge",
    };

    let request_body = serde_json::json!({
        "merge_method": merge_method
    });

    let merge_url = format!(
        "{}/repos/{}/{}/pulls/{}/merge",
        target.api_base, target.owner, target.repo, payload.number
    );

    let response = client
        .put(&merge_url)
        .json(&request_body)
        .send()
        .await
        .map_err(|error| annotate_auth_error(format!("请求 GitHub 失败：{error}"), has_token))?;

    let _: serde_json::Value = read_github_json(response)
        .await
        .map_err(|error| annotate_auth_error(error, has_token))?;

    clear_github_pull_request_cache_for_repository(
        target.repository_root.to_string_lossy().as_ref(),
    );

    let detail_url = format!(
        "{}/repos/{}/{}/pulls/{}",
        target.api_base, target.owner, target.repo, payload.number
    );

    let detail_response = client
        .get(&detail_url)
        .send()
        .await
        .map_err(|error| annotate_auth_error(format!("请求 GitHub 失败：{error}"), has_token))?;

    let pull_request: GitHubPullRequest = read_github_json(detail_response)
        .await
        .map_err(|error| annotate_auth_error(error, has_token))?;

    Ok(map_pull_request_summary(&pull_request))
}

#[tauri::command]
#[specta::specta]
pub async fn close_git_pull_request(
    payload: GitPullRequestCloseRequest,
) -> Result<GitPullRequestSummaryPayload, String> {
    let target = resolve_github_repository_target(&payload.repository_root_path)?;
    let token = resolve_github_credential(&target.repository_root, &target.host).await;
    let has_token = token.is_some();
    let client = build_github_client(token.as_deref())?;

    let request_body = serde_json::json!({
        "state": "closed"
    });

    let url = format!(
        "{}/repos/{}/{}/pulls/{}",
        target.api_base, target.owner, target.repo, payload.number
    );

    let response = client
        .patch(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|error| annotate_auth_error(format!("请求 GitHub 失败：{error}"), has_token))?;

    let pull_request: GitHubPullRequest = read_github_json(response)
        .await
        .map_err(|error| annotate_auth_error(error, has_token))?;

    clear_github_pull_request_cache_for_repository(
        target.repository_root.to_string_lossy().as_ref(),
    );

    Ok(map_pull_request_summary(&pull_request))
}