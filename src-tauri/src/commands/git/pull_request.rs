use super::*;
use gix::bstr::ByteSlice;

const AUTHORITY_PATH_REMOTE_SCHEMES: &[&str] =
    &["ssh://", "https://", "http://", "git://"];

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
    let (pull_requests_url, create_pull_request_url) =
        build_pull_request_urls(provider, &repository_url);

    Ok(GitPullRequestSupportPayload {
        available: pull_requests_url.is_some() || create_pull_request_url.is_some(),
        remote_name: Some(remote_name),
        provider: provider.to_string(),
        repository_url: Some(repository_url),
        pull_requests_url,
        create_pull_request_url,
    })
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

    let repository_url = format!("https://{host}/{repository_path}");
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
