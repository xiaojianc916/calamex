#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const file = 'src-tauri/src/commands/git/pull_request.rs';
const filePath = resolve(root, file);

const originalText = readFileSync(filePath, 'utf8');
const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
let text = originalText.replace(/\r\n/g, '\n');

const replaceExact = (description, oldText, newText) => {
  const count = text.split(oldText).length - 1;

  if (count === 0) {
    if (text.includes(newText.trim())) {
      console.log(`skipped ${file}: ${description} already applied`);
      return false;
    }

    throw new Error(
      [
        `${file}: ${description} not found`,
        'Expected snippet:',
        oldText,
      ].join('\n'),
    );
  }

  if (count !== 1) {
    throw new Error(
      `${file}: ${description} expected 1 occurrence, found ${count}`,
    );
  }

  text = text.replace(oldText, newText);
  console.log(`patched ${file}: ${description}`);
  return true;
};

const insertAfter = (description, anchor, insertion, alreadyNeedle) => {
  if (text.includes(alreadyNeedle)) {
    console.log(`skipped ${file}: ${description} already applied`);
    return false;
  }

  if (!text.includes(anchor)) {
    throw new Error(
      [
        `${file}: ${description} anchor not found`,
        'Expected anchor:',
        anchor,
      ].join('\n'),
    );
  }

  text = text.replace(anchor, `${anchor}${insertion}`);
  console.log(`patched ${file}: ${description}`);
  return true;
};

insertAfter(
  'add bounded PR list pagination constants',
  `const GITHUB_PULL_REQUEST_STALE_IF_ERROR_TTL: Duration = Duration::from_secs(5 * 60);
`,
  `const GITHUB_PULL_REQUEST_LIST_PAGE_SIZE: u32 = 50;
const GITHUB_PULL_REQUEST_LIST_MAX_PAGES: u32 = 5;
`,
  `const GITHUB_PULL_REQUEST_LIST_MAX_PAGES`,
);

insertAfter(
  'add GitHub Link next-page helper',
  `fn annotate_auth_error(error: String, has_token: bool) -> String {
    if has_token {
        error
    } else {
        format!(
            "{error}\\n提示：未能从本机 git 凭据读取 GitHub Token。请先用 git 登录 GitHub（例如执行一次 git push，或在 Windows 凭据管理器中为 github.com 配置凭据）。"
        )
    }
}

`,
  `fn github_response_has_next_page(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::LINK)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').any(|part| part.contains("rel=\\"next\\"")))
        .unwrap_or(false)
}

`,
  `fn github_response_has_next_page`,
);

const oldListFunction = `#[tauri::command]
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
}`;

const newListFunction = `#[tauri::command]
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

    let mut all_pull_requests: Vec<GitHubPullRequest> = Vec::new();
    let mut first_page_etag: Option<String> = None;

    for page in 1..=GITHUB_PULL_REQUEST_LIST_MAX_PAGES {
        let url = format!(
            "{}/repos/{}/{}/pulls?state={}&per_page={}&page={}&sort=updated&direction=desc",
            target.api_base,
            target.owner,
            target.repo,
            state,
            GITHUB_PULL_REQUEST_LIST_PAGE_SIZE,
            page
        );

        let mut request = client.get(&url);

        // ETag is only safe for the exact first-page query. If page 1 returns
        // 304, reuse the cached aggregate and avoid walking later pages.
        if page == 1 {
            if let Some(etag) = cached.as_ref().and_then(|entry| entry.etag.as_deref()) {
                request = request.header(IF_NONE_MATCH, etag);
            }
        }

        let response = request
            .send()
            .await
            .map_err(|error| annotate_auth_error(format!("请求 GitHub 失败：{error}"), has_token))?;

        if page == 1 && response.status().as_u16() == 304 {
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

        if page == 1 {
            first_page_etag = response
                .headers()
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string);
        }

        let has_next_page = github_response_has_next_page(&response);
        let mut page_pull_requests: Vec<GitHubPullRequest> = read_github_json(response)
            .await
            .map_err(|error| annotate_auth_error(error, has_token))?;

        let page_is_empty = page_pull_requests.is_empty();
        all_pull_requests.append(&mut page_pull_requests);

        if page_is_empty || !has_next_page {
            break;
        }
    }

    remember_pull_requests(cache_key, first_page_etag, all_pull_requests.clone());
    Ok(map_pull_request_list(&all_pull_requests))
}`;

if (!text.includes('GITHUB_PULL_REQUEST_LIST_PAGE_SIZE') || text.includes('per_page=50&sort=updated')) {
  replaceExact(
    'fetch PR list through bounded pagination',
    oldListFunction,
    newListFunction,
  );
} else if (text.includes('for page in 1..=GITHUB_PULL_REQUEST_LIST_MAX_PAGES')) {
  console.log(`skipped ${file}: bounded PR list pagination already applied`);
} else {
  throw new Error(`${file}: unable to determine PR list pagination state`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');