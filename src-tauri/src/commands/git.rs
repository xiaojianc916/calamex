use super::{
    configure_std_command_for_background, decode_script_bytes, find_command_path,
    resolve_workspace_root, workspace_name,
};
use chrono::{TimeZone, Utc};
use git2::{
    build::CheckoutBuilder, Branch, BranchType, ErrorCode, ObjectType, Repository, StashFlags,
    Status, StatusEntry, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

mod branches;
mod diff;
mod history;
mod pull_request;
mod stash;
mod status;

#[cfg(test)]
mod tests;

pub use branches::{checkout_git_branch, create_git_branch, list_git_branches};
pub use diff::get_git_diff_preview;
pub use history::list_git_commit_history;
pub use pull_request::get_git_pull_request_support;
pub use stash::{apply_git_stash, drop_git_stash, list_git_stashes, save_git_stash};
pub use status::{
    commit_git_index, discard_git_paths, get_git_file_baseline, get_git_repository_status,
    init_git_repository, stage_git_paths, unstage_git_paths,
};

const GIT_DIFF_MODE_WORKTREE: &str = "worktree";
const GIT_DIFF_MODE_STAGED: &str = "staged";
const DEFAULT_GIT_HISTORY_LIMIT: usize = 20;
const MAX_GIT_HISTORY_LIMIT: usize = 200;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummaryPayload {
    id: String,
    short_id: String,
    summary: String,
    author_name: String,
    authored_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitHistoryRequest {
    repository_root_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitHistoryPayload {
    entries: Vec<GitCommitSummaryPayload>,
    has_more: bool,
    next_offset: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchPayload {
    name: String,
    shorthand: String,
    kind: String,
    upstream_name: Option<String>,
    is_current: bool,
    is_head: bool,
    ahead: usize,
    behind: usize,
    last_commit: Option<GitCommitSummaryPayload>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListPayload {
    branches: Vec<GitBranchPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryRootRequest {
    repository_root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCheckoutRequest {
    repository_root_path: String,
    branch_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCreateRequest {
    repository_root_path: String,
    branch_name: String,
    checkout: bool,
}

#[derive(Debug, Serialize, Clone)]
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

#[derive(Debug, Serialize, Clone)]
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
    ahead: usize,
    behind: usize,
    staged_count: usize,
    unstaged_count: usize,
    untracked_count: usize,
    conflicted_count: usize,
    files: Vec<GitFileStatusPayload>,
    last_commit: Option<GitCommitSummaryPayload>,
}

#[derive(Debug, Serialize, Clone)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPreviewRequest {
    repository_root_path: String,
    path: String,
    mode: String,
}

#[derive(Debug, Serialize, Clone)]
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResultPayload {
    status: GitRepositoryStatusPayload,
    commit: GitCommitSummaryPayload,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStashFilePayload {
    relative_path: String,
    file_name: String,
    previous_relative_path: Option<String>,
    status: String,
    additions: u32,
    deletions: u32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntryPayload {
    index: usize,
    stash_id: String,
    summary: String,
    branch_name: Option<String>,
    commit_short_id: Option<String>,
    created_at: String,
    file_count: usize,
    additions: u32,
    deletions: u32,
    files: Vec<GitStashFilePayload>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStashListPayload {
    entries: Vec<GitStashEntryPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPathOperationRequest {
    repository_root_path: String,
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    repository_root_path: String,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashSaveRequest {
    repository_root_path: String,
    message: Option<String>,
    include_untracked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashApplyRequest {
    repository_root_path: String,
    stash_index: usize,
    pop: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashDropRequest {
    repository_root_path: String,
    stash_index: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequestSupportPayload {
    available: bool,
    remote_name: Option<String>,
    provider: String,
    repository_url: Option<String>,
    pull_requests_url: Option<String>,
    create_pull_request_url: Option<String>,
}

fn open_repository_from_root(repository_root_path: &str) -> Result<Repository, String> {
    let repository_root = normalize_path_for_git(Path::new(repository_root_path));
    Repository::discover(repository_root).map_err(|error| format!("读取 Git 仓库失败：{error}"))
}

fn resolve_single_relative_path(repository_root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Git Diff 路径不能为空。".to_string());
    }

    let relative_path = resolve_relative_path(repository_root, Path::new(path))?;

    if relative_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!("Git Diff 路径不合法：{path}"));
    }

    if relative_path.as_os_str().is_empty() {
        return Err("Git Diff 路径不能为空。".to_string());
    }

    Ok(relative_path)
}

fn resolve_git_workspace_root(workspace_root_path: Option<String>) -> Result<PathBuf, String> {
    resolve_workspace_root(workspace_root_path).map(|path| normalize_path_for_git(&path))
}

fn build_unavailable_git_status(message: &str) -> GitRepositoryStatusPayload {
    GitRepositoryStatusPayload {
        available: false,
        message: Some(message.into()),
        repository_root_path: None,
        repository_name: None,
        git_dir_path: None,
        head_branch_name: None,
        head_short_name: None,
        head_short_oid: None,
        is_detached: false,
        is_clean: true,
        ahead: 0,
        behind: 0,
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        conflicted_count: 0,
        files: Vec::new(),
        last_commit: None,
    }
}

fn resolve_repository_root(repository: &Repository) -> Result<PathBuf, String> {
    repository
        .workdir()
        .ok_or_else(|| "当前 Git 仓库为 bare 模式，暂不支持工作区版本控制。".to_string())
        .and_then(|path| {
            path.canonicalize()
                .map_err(|error| format!("读取 Git 工作区根目录失败：{error}"))
        })
        .map(|path| normalize_path_for_git(&path))
}

fn resolve_head_commit(repository: &Repository) -> Result<Option<git2::Commit<'_>>, String> {
    match repository.head() {
        Ok(head) => match head.peel_to_commit() {
            Ok(commit) => Ok(Some(commit)),
            Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) => {
                Ok(None)
            }
            Err(error) => Err(format!("读取 Git HEAD 提交失败：{error}")),
        },
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) => {
            Ok(None)
        }
        Err(error) => Err(format!("读取 Git HEAD 失败：{error}")),
    }
}

fn resolve_head_object(repository: &Repository) -> Result<Option<git2::Object<'_>>, String> {
    match repository.head() {
        Ok(head) => head
            .peel(ObjectType::Commit)
            .map(Some)
            .or_else(|error| {
                if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) {
                    Ok(None)
                } else {
                    Err(error)
                }
            })
            .map_err(|error| format!("读取 Git HEAD 对象失败：{error}")),
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) => {
            Ok(None)
        }
        Err(error) => Err(format!("读取 Git HEAD 失败：{error}")),
    }
}

fn resolve_head_branch_name(repository: &Repository) -> Result<Option<String>, String> {
    match repository.head() {
        Ok(head) => {
            if !head.is_branch() {
                return Ok(None);
            }

            Ok(head.shorthand().map(str::to_string))
        }
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) => {
            Ok(None)
        }
        Err(error) => Err(format!("读取 Git 分支信息失败：{error}")),
    }
}

fn resolve_head_detached(repository: &Repository) -> Result<bool, String> {
    repository
        .head_detached()
        .map_err(|error| format!("读取 Git 分支状态失败：{error}"))
}

fn resolve_ahead_behind(
    repository: &Repository,
    branch_name: Option<&str>,
) -> Result<(usize, usize), String> {
    let Some(branch_name) = branch_name else {
        return Ok((0, 0));
    };

    let local_branch = match repository.find_branch(branch_name, BranchType::Local) {
        Ok(branch) => branch,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok((0, 0)),
        Err(error) => return Err(format!("读取 Git 本地分支失败：{error}")),
    };

    let upstream_branch = match local_branch.upstream() {
        Ok(branch) => branch,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok((0, 0)),
        Err(error) => return Err(format!("读取 Git 上游分支失败：{error}")),
    };

    let Some(local_oid) = local_branch.get().target() else {
        return Ok((0, 0));
    };
    let Some(upstream_oid) = upstream_branch.get().target() else {
        return Ok((0, 0));
    };

    repository
        .graph_ahead_behind(local_oid, upstream_oid)
        .map_err(|error| format!("读取 Git ahead/behind 失败：{error}"))
}

fn build_git_commit_summary(commit: &git2::Commit<'_>) -> GitCommitSummaryPayload {
    let authored_at = Utc
        .timestamp_opt(commit.time().seconds(), 0)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339();

    GitCommitSummaryPayload {
        id: commit.id().to_string(),
        short_id: short_commit_id(commit.id()),
        summary: commit.summary().unwrap_or("无提交说明").to_string(),
        author_name: commit.author().name().unwrap_or("未知作者").to_string(),
        authored_at,
    }
}

fn short_commit_id(oid: git2::Oid) -> String {
    let value = oid.to_string();
    value.chars().take(7).collect()
}

fn resolve_relative_path(repository_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let path_candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repository_root.join(path)
    };
    let path_candidate = normalize_path_for_git(&path_candidate);

    path_candidate
        .strip_prefix(repository_root)
        .map(Path::to_path_buf)
        .map_err(|_| "目标文件超出当前 Git 仓库根目录。".to_string())
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
        return PathBuf::from(format!("//{stripped}").replace('/', r"\"));
    }

    if let Some(stripped) = value.strip_prefix("//?/") {
        return PathBuf::from(stripped.replace('/', r"\"));
    }

    path.to_path_buf()
}

#[cfg(not(windows))]
fn normalize_path_for_git(path: &Path) -> PathBuf {
    path.to_path_buf()
}
