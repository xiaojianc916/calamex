use super::{decode_script_bytes, resolve_workspace_root};
use gix::bstr::ByteSlice;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) mod branches;
pub(crate) mod diff;
pub(crate) mod github_auth;
pub(crate) mod history;
pub(crate) mod pull_request;
pub(crate) mod revision;
pub(crate) mod stash;
pub(crate) mod status;

#[cfg(test)]
mod tests;

// 命令由 `tauri_bindings.rs` 以定义子模块限定路径登记（如 `git::status::commit_git_index`），
// 以便 tauri-specta 解析配套宏；故此处不再重新导出扁平命令名。
// 子模块均为 `pub(crate)`，测试按其真实路径（如 `super::status::init_git_repository`）引用。

const GIT_DIFF_MODE_WORKTREE: &str = "worktree";
const GIT_DIFF_MODE_STAGED: &str = "staged";
const DEFAULT_GIT_HISTORY_LIMIT: usize = 20;
const MAX_GIT_HISTORY_LIMIT: usize = 200;

type Repository = gix::Repository;

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRefPayload {
    name: String,
    kind: String,
    is_head: bool,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummaryPayload {
    id: String,
    short_id: String,
    summary: String,
    author_name: String,
    author_email: String,
    authored_at: String,
    parent_ids: Vec<String>,
    refs: Vec<GitCommitRefPayload>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitHistoryRequest {
    repository_root_path: String,
    #[specta(type = Option<u32>)]
    offset: Option<usize>,
    #[specta(type = Option<u32>)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitHistoryPayload {
    entries: Vec<GitCommitSummaryPayload>,
    has_more: bool,
    #[specta(type = Option<u32>)]
    next_offset: Option<usize>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetailRequest {
    repository_root_path: String,
    commit_id: String,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileChangePayload {
    relative_path: String,
    file_name: String,
    previous_relative_path: Option<String>,
    status: String,
    additions: u32,
    deletions: u32,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetailPayload {
    id: String,
    short_id: String,
    summary: String,
    body: String,
    author_name: String,
    author_email: String,
    authored_at: String,
    parent_ids: Vec<String>,
    refs: Vec<GitCommitRefPayload>,
    #[specta(type = u32)]
    file_count: usize,
    additions: u32,
    deletions: u32,
    files: Vec<GitCommitFileChangePayload>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchPayload {
    name: String,
    shorthand: String,
    kind: String,
    upstream_name: Option<String>,
    is_current: bool,
    is_head: bool,
    #[specta(type = u32)]
    ahead: usize,
    #[specta(type = u32)]
    behind: usize,
    last_commit: Option<GitCommitSummaryPayload>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListPayload {
    branches: Vec<GitBranchPayload>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryRootRequest {
    repository_root_path: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCheckoutRequest {
    repository_root_path: String,
    branch_name: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCreateRequest {
    repository_root_path: String,
    branch_name: String,
    checkout: bool,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatusPayload {
    path: String,
    relative_path: String,
    file_name: String,
    previous_path: Option<String>,
    previous_relative_path: Option<String>,
    index_status: Option<String>,
    worktree_status: Option<String>,
    is_conflicted: bool,
    is_untracked: bool,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryStatusPayload {
    available: bool,
    message: Option<String>,
    repository_root_path: Option<String>,
    repository_name: Option<String>,
    git_dir_path: Option<String>,
    head_branch_name: Option<String>,
    head_short_name: Option<String>,
    head_short_oid: Option<String>,
    is_detached: bool,
    is_clean: bool,
    #[specta(type = u32)]
    ahead: usize,
    #[specta(type = u32)]
    behind: usize,
    #[specta(type = u32)]
    staged_count: usize,
    #[specta(type = u32)]
    unstaged_count: usize,
    #[specta(type = u32)]
    untracked_count: usize,
    #[specta(type = u32)]
    conflicted_count: usize,
    files: Vec<GitFileStatusPayload>,
    last_commit: Option<GitCommitSummaryPayload>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitFileBaselinePayload {
    available: bool,
    message: Option<String>,
    repository_root_path: Option<String>,
    file_path: String,
    relative_path: Option<String>,
    is_tracked: bool,
    content: Option<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPreviewRequest {
    repository_root_path: String,
    path: String,
    mode: String,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPreviewPayload {
    id: String,
    repository_root_path: String,
    path: String,
    relative_path: String,
    title: String,
    mode: String,
    original_content: String,
    modified_content: String,
    is_empty: bool,
}

struct GitDiffContentPair {
    original_content: String,
    modified_content: String,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResultPayload {
    status: GitRepositoryStatusPayload,
    commit_id: Option<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    repository_root_path: String,
    message: String,
    paths: Vec<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPathOperationRequest {
    repository_root_path: String,
    paths: Vec<String>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntryPayload {
    #[specta(type = u32)]
    index: usize,
    stash_id: String,
    summary: String,
    branch_name: Option<String>,
    commit_short_id: Option<String>,
    created_at: String,
    #[specta(type = u32)]
    file_count: usize,
    additions: u32,
    deletions: u32,
    files: Vec<GitStashFilePayload>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStashFilePayload {
    relative_path: String,
    file_name: String,
    previous_relative_path: Option<String>,
    status: String,
    additions: u32,
    deletions: u32,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStashListPayload {
    entries: Vec<GitStashEntryPayload>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStashSaveRequest {
    repository_root_path: String,
    message: Option<String>,
    include_untracked: bool,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStashApplyRequest {
    repository_root_path: String,
    #[specta(type = u32)]
    stash_index: usize,
    pop: bool,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStashDropRequest {
    repository_root_path: String,
    #[specta(type = u32)]
    stash_index: usize,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestSupportPayload {
    available: bool,
    remote_name: Option<String>,
    provider: String,
    repository_url: Option<String>,
    pull_requests_url: Option<String>,
    create_pull_request_url: Option<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteSetRequest {
    repository_root_path: String,
    remote_name: String,
    remote_url: String,
}

// ── commit file diff ──────────────────────────────────────────────────────────
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileDiffRequest {
    repository_root_path: String,
    commit_id: String,
    relative_path: String,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLine {
    tag: String,
    old_line: Option<u32>,
    new_line: Option<u32>,
    content: String,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffHunk {
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
    lines: Vec<GitDiffLine>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileDiffPayload {
    relative_path: String,
    file_name: String,
    title: String,
    hunks: Vec<GitDiffHunk>,
    is_binary: bool,
    is_empty: bool,
}
// ─────────────────────────────────────────────────────────────────────────────

fn open_repository_from_root(root: &str) -> Result<Repository, String> {
    let root = normalize_path_for_git(Path::new(root));
    gix::open(&root).map_err(|error| format!("打开 Git 仓库失败：{error}"))
}

pub(super) fn resolve_repository_root(repository: &Repository) -> Result<PathBuf, String> {
    repository
        .workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| "当前 Git 仓库没有工作区。".to_string())
}

fn resolve_git_workspace_root(workspace_root_path: Option<String>) -> Result<PathBuf, String> {
    match workspace_root_path {
        Some(value) if !value.trim().is_empty() => {
            let path = normalize_path_for_git(Path::new(value.trim()));
            Ok(path)
        }
        _ => resolve_workspace_root(None),
    }
}

fn resolve_head_commit(repository: &Repository) -> Result<Option<gix::Commit<'_>>, String> {
    match repository.head_commit() {
        Ok(commit) => Ok(Some(commit)),
        Err(error) => {
            match repository.head() {
                Ok(head) if head.id().is_none() => Ok(None),
                _ => Err(format!("读取 Git HEAD 提交失败：{error}")),
            }
        }
    }
}

fn build_git_commit_summary(commit: &gix::Commit<'_>) -> GitCommitSummaryPayload {
    let authored_at = jiff::Timestamp::from_second(commit.time().unwrap_or_default().seconds)
        .unwrap_or_else(|_| jiff::Timestamp::now())
        .to_string();

    let summary = commit
        .message()
        .ok()
        .map(|m| m.summary().to_str_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "无提交说明".to_string());

    let (author_name, author_email) = commit
        .author()
        .map(|author| (author.name.to_string(), author.email.to_string()))
        .unwrap_or_else(|_| ("未知作者".to_string(), String::new()));

    GitCommitSummaryPayload {
        id: commit.id().to_string(),
        short_id: short_commit_id(commit.id().detach()),
        summary,
        author_name,
        author_email,
        authored_at,
        parent_ids: commit
            .parent_ids()
            .map(|id| id.detach().to_string())
            .collect(),
        refs: Vec::new(),
    }
}

fn short_commit_id(id: gix::ObjectId) -> String {
    id.to_string().chars().take(7).collect()
}

fn resolve_relative_path(repository_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let path_candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repository_root.join(path)
    };
    let path_candidate = normalize_path_for_git(&path_candidate);
    strip_repository_prefix(repository_root, &path_candidate)
        .ok_or_else(|| "目标文件超出当前 Git 仓库根目录。".to_string())
}

fn strip_repository_prefix(repository_root: &Path, candidate: &Path) -> Option<PathBuf> {
    let mut root_components = repository_root.components();
    let mut candidate_components = candidate.components();

    loop {
        match root_components.next() {
            None => return Some(candidate_components.as_path().to_path_buf()),
            Some(root_component) => {
                let candidate_component = candidate_components.next()?;
                if !path_components_match(root_component, candidate_component) {
                    return None;
                }
            }
        }
    }
}

#[cfg(windows)]
fn path_components_match(left: Component<'_>, right: Component<'_>) -> bool {
    left.as_os_str().eq_ignore_ascii_case(right.as_os_str())
}

#[cfg(not(windows))]
fn path_components_match(left: Component<'_>, right: Component<'_>) -> bool {
    left == right
}

fn resolve_pathspecs(repository_root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let mut pathspecs = Vec::new();
    for path in paths {
        if path.trim().is_empty() {
            continue;
        }
        let relative_path = resolve_relative_path(repository_root, Path::new(path))?;
        if relative_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(format!("Git 变更路径不合法：{path}"));
        }
        let pathspec = path_to_forward_slashes(&relative_path);
        if !pathspec.is_empty() {
            pathspecs.push(pathspec);
        }
    }
    Ok(pathspecs)
}

fn path_to_forward_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(windows)]
fn normalize_path_for_git(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(stripped) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped.to_string());
    }
    if let Some(stripped) = value.strip_prefix("//?/UNC/") {
        return PathBuf::from(format!("//{stripped}").replace('/', r"\\"));
    }
    if let Some(stripped) = value.strip_prefix("//?/") {
        return PathBuf::from(stripped.replace('/', r"\\"));
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn normalize_path_for_git(path: &Path) -> PathBuf {
    path.to_path_buf()
}
