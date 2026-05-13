use super::diff::{
    build_git_diff_content_pair, build_untracked_file_diff, parse_git_diff_mode, GitDiffMode,
};
use super::*;
use git2::Signature;
use std::{
    env, fs,
    time::{SystemTime, UNIX_EPOCH},
};

struct TempGitDir {
    path: PathBuf,
}

impl TempGitDir {
    fn new(label: &str) -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "calamex-git-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        Ok(Self { path })
    }
}

impl Drop for TempGitDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn write_worktree_file(root: &Path, relative_path: &str, content: &str) -> Result<(), String> {
    let file_path = root.join(relative_path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::write(file_path, content).map_err(|error| error.to_string())
}

fn commit_worktree_file(
    repository: &Repository,
    root: &Path,
    relative_path: &str,
    content: &str,
    message: &str,
) -> Result<(), String> {
    write_worktree_file(root, relative_path, content)?;

    let mut index = repository.index().map_err(|error| error.to_string())?;
    index
        .add_path(Path::new(relative_path))
        .map_err(|error| error.to_string())?;
    index.write().map_err(|error| error.to_string())?;
    let tree_id = index.write_tree().map_err(|error| error.to_string())?;
    let tree = repository
        .find_tree(tree_id)
        .map_err(|error| error.to_string())?;
    let signature =
        Signature::now("Calamex Test", "test@example.com").map_err(|error| error.to_string())?;
    let parent_commit = resolve_head_commit(repository)?;
    let parents = parent_commit.iter().collect::<Vec<_>>();

    repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn create_initial_commit(
    repository: &Repository,
    root: &Path,
    relative_path: &str,
    content: &str,
) -> Result<(), String> {
    commit_worktree_file(repository, root, relative_path, content, "feat: initial")
}

#[cfg(windows)]
#[test]
fn normalize_path_for_git_strips_windows_verbatim_prefix() {
    assert_eq!(
        normalize_path_for_git(Path::new(r"\\?\D:\workspace\repo")),
        PathBuf::from(r"D:\workspace\repo")
    );
    assert_eq!(
        normalize_path_for_git(Path::new("//?/D:/workspace/repo")),
        PathBuf::from(r"D:\workspace\repo")
    );
}

#[test]
fn init_git_repository_creates_repository_at_workspace_root() -> Result<(), String> {
    let temp = TempGitDir::new("init-root")?;

    let status = init_git_repository(Some(temp.path.to_string_lossy().to_string()))?;
    let expected_root = normalize_path_for_git(
        &temp
            .path
            .canonicalize()
            .map_err(|error| error.to_string())?,
    );
    let expected_root_text = expected_root.to_string_lossy().to_string();

    assert!(temp.path.join(".git").exists());
    assert!(status.available);
    assert_eq!(
        status.repository_root_path.as_deref(),
        Some(expected_root_text.as_str())
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn init_git_repository_accepts_windows_verbatim_workspace_root() -> Result<(), String> {
    let temp = TempGitDir::new("init-verbatim")?;
    let verbatim_workspace_root = format!(r"\\?\{}", temp.path.display());

    let status = init_git_repository(Some(verbatim_workspace_root))?;
    let expected_root = normalize_path_for_git(
        &temp
            .path
            .canonicalize()
            .map_err(|error| error.to_string())?,
    );
    let expected_root_text = expected_root.to_string_lossy().to_string();

    assert!(temp.path.join(".git").exists());
    assert!(status.available);
    assert_eq!(
        status.repository_root_path.as_deref(),
        Some(expected_root_text.as_str())
    );
    Ok(())
}

#[test]
fn init_git_repository_does_not_reuse_parent_repository() -> Result<(), String> {
    let temp = TempGitDir::new("init-nested")?;
    let parent_repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    let parent_root = resolve_repository_root(&parent_repository)?;
    let child_root = temp.path.join("child-workspace");
    fs::create_dir_all(&child_root).map_err(|error| error.to_string())?;

    let status = init_git_repository(Some(child_root.to_string_lossy().to_string()))?;
    let expected_child_root = normalize_path_for_git(
        &child_root
            .canonicalize()
            .map_err(|error| error.to_string())?,
    );
    let expected_child_root_text = expected_child_root.to_string_lossy().to_string();

    assert!(child_root.join(".git").exists());
    assert_ne!(parent_root, expected_child_root);
    assert_eq!(
        status.repository_root_path.as_deref(),
        Some(expected_child_root_text.as_str())
    );
    Ok(())
}

#[test]
fn build_untracked_file_diff_includes_added_lines() -> Result<(), String> {
    let temp = TempGitDir::new("diff-untracked")?;
    write_worktree_file(&temp.path, "src/new.sh", "echo 1\necho 2\n")?;

    let diff = build_untracked_file_diff(&temp.path, Path::new("src/new.sh"))?;

    assert!(diff.contains("diff --git a/src/new.sh b/src/new.sh"));
    assert!(diff.contains("new file mode 100644"));
    assert!(diff.contains("@@ -0,0 +1,2 @@"));
    assert!(diff.contains("+echo 1\n+echo 2\n"));
    Ok(())
}

#[test]
fn build_untracked_file_diff_handles_empty_file() -> Result<(), String> {
    let temp = TempGitDir::new("diff-empty-untracked")?;
    write_worktree_file(&temp.path, "empty.sh", "")?;

    let diff = build_untracked_file_diff(&temp.path, Path::new("empty.sh"))?;

    assert!(diff.contains("diff --git a/empty.sh b/empty.sh"));
    assert!(diff.contains("@@ -0,0 +1,0 @@"));
    Ok(())
}

#[test]
fn parse_git_diff_mode_rejects_unknown_mode() {
    assert!(parse_git_diff_mode("unknown").is_err());
}

#[test]
fn build_git_diff_content_pair_reads_worktree_versions() -> Result<(), String> {
    let temp = TempGitDir::new("diff-content-worktree")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    create_initial_commit(&repository, &temp.path, "src/app.sh", "echo original\n")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo changed\n")?;

    let pair = build_git_diff_content_pair(
        &repository,
        &temp.path,
        Path::new("src/app.sh"),
        GitDiffMode::Worktree,
    )?;

    assert_eq!(pair.original_content, "echo original\n");
    assert_eq!(pair.modified_content, "echo changed\n");
    Ok(())
}

#[test]
fn build_git_diff_content_pair_reads_staged_versions() -> Result<(), String> {
    let temp = TempGitDir::new("diff-content-staged")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    create_initial_commit(&repository, &temp.path, "src/app.sh", "echo original\n")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo staged\n")?;
    let mut index = repository.index().map_err(|error| error.to_string())?;
    index
        .add_path(Path::new("src/app.sh"))
        .map_err(|error| error.to_string())?;
    index.write().map_err(|error| error.to_string())?;
    write_worktree_file(&temp.path, "src/app.sh", "echo worktree\n")?;

    let pair = build_git_diff_content_pair(
        &repository,
        &temp.path,
        Path::new("src/app.sh"),
        GitDiffMode::Staged,
    )?;

    assert_eq!(pair.original_content, "echo original\n");
    assert_eq!(pair.modified_content, "echo staged\n");
    Ok(())
}

#[test]
fn discard_git_paths_removes_untracked_file() -> Result<(), String> {
    let temp = TempGitDir::new("discard-untracked")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    let repository_root = resolve_repository_root(&repository)?;
    write_worktree_file(&temp.path, "scratch/new.sh", "echo scratch\n")?;

    let status = discard_git_paths(GitPathOperationRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
        paths: vec![repository_root
            .join("scratch/new.sh")
            .to_string_lossy()
            .to_string()],
    })?;

    assert!(!temp.path.join("scratch/new.sh").exists());
    assert_eq!(status.untracked_count, 0);
    Ok(())
}

#[test]
fn discard_git_paths_restores_tracked_worktree_file() -> Result<(), String> {
    let temp = TempGitDir::new("discard-tracked")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    let repository_root = resolve_repository_root(&repository)?;
    create_initial_commit(&repository, &temp.path, "src/app.sh", "echo original\n")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo changed\n")?;

    let status = discard_git_paths(GitPathOperationRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
        paths: vec![repository_root
            .join("src/app.sh")
            .to_string_lossy()
            .to_string()],
    })?;

    let content =
        fs::read_to_string(temp.path.join("src/app.sh")).map_err(|error| error.to_string())?;
    assert_eq!(content.replace("\r\n", "\n"), "echo original\n");
    assert!(status.is_clean);
    Ok(())
}

#[test]
fn list_git_commit_history_paginates_results() -> Result<(), String> {
    let temp = TempGitDir::new("history-pagination")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    let repository_root = resolve_repository_root(&repository)?;
    create_initial_commit(&repository, &temp.path, "src/app.sh", "echo first\n")?;
    commit_worktree_file(
        &repository,
        &temp.path,
        "src/app.sh",
        "echo second\n",
        "feat: second",
    )?;

    let payload = list_git_commit_history(GitCommitHistoryRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
        offset: Some(0),
        limit: Some(1),
    })?;

    assert_eq!(payload.entries.len(), 1);
    assert_eq!(payload.entries[0].summary, "feat: second");
    assert!(payload.has_more);
    assert_eq!(payload.next_offset, Some(1));
    Ok(())
}

#[test]
fn create_git_branch_with_checkout_updates_head_branch() -> Result<(), String> {
    let temp = TempGitDir::new("branch-create-checkout")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    let repository_root = resolve_repository_root(&repository)?;
    create_initial_commit(&repository, &temp.path, "src/app.sh", "echo base\n")?;

    let status = create_git_branch(GitBranchCreateRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
        branch_name: "feature/demo".into(),
        checkout: true,
    })?;

    assert_eq!(status.head_branch_name.as_deref(), Some("feature/demo"));
    assert_eq!(status.head_short_name.as_deref(), Some("feature/demo"));
    Ok(())
}

#[test]
fn save_git_stash_and_list_git_stashes_round_trip() -> Result<(), String> {
    let temp = TempGitDir::new("stash-round-trip")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    let repository_root = resolve_repository_root(&repository)?;
    create_initial_commit(&repository, &temp.path, "src/app.sh", "echo base\n")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo changed\n")?;

    save_git_stash(GitStashSaveRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
        message: Some("demo stash".into()),
        include_untracked: false,
    })?;

    let stashes = list_git_stashes(GitRepositoryRootRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
    })?;

    assert_eq!(stashes.entries.len(), 1);
    assert!(stashes.entries[0].summary.contains("demo stash"));
    assert_eq!(stashes.entries[0].file_count, 1);
    assert_eq!(stashes.entries[0].additions, 1);
    assert_eq!(stashes.entries[0].deletions, 1);
    assert_eq!(stashes.entries[0].files.len(), 1);
    assert_eq!(stashes.entries[0].files[0].relative_path, "src/app.sh");
    assert_eq!(stashes.entries[0].files[0].file_name, "app.sh");
    assert_eq!(stashes.entries[0].files[0].status, "modified");
    assert_eq!(stashes.entries[0].files[0].additions, 1);
    assert_eq!(stashes.entries[0].files[0].deletions, 1);
    assert!(!stashes.entries[0].created_at.is_empty());
    Ok(())
}

#[test]
fn apply_git_stash_with_pop_restores_worktree_and_clears_stash() -> Result<(), String> {
    let temp = TempGitDir::new("stash-pop")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    let repository_root = resolve_repository_root(&repository)?;
    create_initial_commit(&repository, &temp.path, "src/app.sh", "echo base\n")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo changed\n")?;

    save_git_stash(GitStashSaveRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
        message: Some("demo pop".into()),
        include_untracked: false,
    })?;

    let status = apply_git_stash(GitStashApplyRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
        stash_index: 0,
        pop: true,
    })?;
    let content =
        fs::read_to_string(temp.path.join("src/app.sh")).map_err(|error| error.to_string())?;
    let stashes = list_git_stashes(GitRepositoryRootRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
    })?;

    assert_eq!(content.replace("\r\n", "\n"), "echo changed\n");
    assert_eq!(status.unstaged_count, 1);
    assert!(stashes.entries.is_empty());
    Ok(())
}

#[test]
fn get_git_pull_request_support_parses_github_remote() -> Result<(), String> {
    let temp = TempGitDir::new("pull-request-support")?;
    let repository = Repository::init(&temp.path).map_err(|error| error.to_string())?;
    let repository_root = resolve_repository_root(&repository)?;
    repository
        .remote("origin", "git@github.com:owner/repo.git")
        .map_err(|error| error.to_string())?;

    let payload = get_git_pull_request_support(GitRepositoryRootRequest {
        repository_root_path: repository_root.to_string_lossy().to_string(),
    })?;

    assert!(payload.available);
    assert_eq!(payload.provider, "github");
    assert_eq!(
        payload.repository_url.as_deref(),
        Some("https://github.com/owner/repo")
    );
    assert_eq!(
        payload.pull_requests_url.as_deref(),
        Some("https://github.com/owner/repo/pulls")
    );
    Ok(())
}
