#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const file = 'src-tauri/src/commands/git/tests.rs';
const filePath = resolve(root, file);

const text = readFileSync(filePath, 'utf8');

const alreadyAppliedNeedle = 'get_git_pull_request_support_parses_github_enterprise_remote';

if (text.includes(alreadyAppliedNeedle)) {
  console.log(`${file}: PR backend remote tests already applied`);
  process.exit(0);
}

const insertion = `

#[test]
fn get_git_pull_request_support_parses_github_enterprise_remote() -> Result<(), String> {
    let temp = TempGitDir::new("pull-request-ghe")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    add_remote(&temp.path, "origin", "git@github.example.com:platform/repo.git")?;

    let payload = get_git_pull_request_support(GitRepositoryRootRequest {
        repository_root_path: root.to_string_lossy().to_string(),
    })?;

    assert!(payload.available);
    assert_eq!(payload.provider, "github");
    assert_eq!(
        payload.repository_url.as_deref(),
        Some("https://github.example.com/platform/repo")
    );
    assert_eq!(
        payload.pull_requests_url.as_deref(),
        Some("https://github.example.com/platform/repo/pulls")
    );
    assert_eq!(
        payload.create_pull_request_url.as_deref(),
        Some("https://github.example.com/platform/repo/compare")
    );

    Ok(())
}

#[test]
fn get_git_pull_request_support_prefers_origin_remote() -> Result<(), String> {
    let temp = TempGitDir::new("pull-request-origin-priority")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;

    add_remote(&temp.path, "upstream", "https://github.com/upstream/repo.git")?;
    add_remote(&temp.path, "origin", "https://github.com/owner/repo.git")?;

    let payload = get_git_pull_request_support(GitRepositoryRootRequest {
        repository_root_path: root.to_string_lossy().to_string(),
    })?;

    assert!(payload.available);
    assert_eq!(payload.remote_name.as_deref(), Some("origin"));
    assert_eq!(payload.provider, "github");
    assert_eq!(
        payload.repository_url.as_deref(),
        Some("https://github.com/owner/repo")
    );

    Ok(())
}

#[test]
fn get_git_pull_request_support_parses_gitlab_remote() -> Result<(), String> {
    let temp = TempGitDir::new("pull-request-gitlab")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    add_remote(&temp.path, "origin", "https://gitlab.com/group/repo.git")?;

    let payload = get_git_pull_request_support(GitRepositoryRootRequest {
        repository_root_path: root.to_string_lossy().to_string(),
    })?;

    assert!(payload.available);
    assert_eq!(payload.provider, "gitlab");
    assert_eq!(
        payload.repository_url.as_deref(),
        Some("https://gitlab.com/group/repo")
    );
    assert_eq!(
        payload.pull_requests_url.as_deref(),
        Some("https://gitlab.com/group/repo/-/merge_requests")
    );
    assert_eq!(
        payload.create_pull_request_url.as_deref(),
        Some("https://gitlab.com/group/repo/-/merge_requests/new")
    );

    Ok(())
}
`;

const normalizedText = text.endsWith('\n') || text.endsWith('\r\n') ? text : `${text}\n`;
const nextText = `${normalizedText}${insertion}`;

writeFileSync(filePath, nextText, 'utf8');

console.log(`patched ${file}: appended PR backend remote tests`);