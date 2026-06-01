use super::*;
use super::cli;
use std::{env, fs, time::{SystemTime, UNIX_EPOCH}};

struct TempGitDir { path: PathBuf }

impl TempGitDir {
    fn new(label: &str) -> Result<Self, String> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let path = env::temp_dir().join(format!("calamex-git-{label}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok(Self { path })
    }
    fn init_repository(&self) -> Result<Repository, String> {
        gix::init(&self.path).map_err(|e| e.to_string())?;
        gix::open(&self.path).map_err(|e| e.to_string())
    }
    fn repository_root(&self) -> Result<PathBuf, String> {
        let root = self.path.canonicalize().map_err(|e| e.to_string())?;
        Ok(normalize_path_for_git(&root))
    }
}

impl Drop for TempGitDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.path); } }

fn write_worktree_file(root: &Path, relative_path: &str, content: &str) -> Result<(), String> {
    let file_path = root.join(relative_path);
    if let Some(parent) = file_path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::write(&file_path, content).map_err(|e| e.to_string())
}

fn commit_via_cli(root: &Path, message: &str) -> Result<(), String> {
    cli::run_git_ok(root, &["add", "-A"], "add")?;
    cli::run_git_ok(root, &["commit", "-m", message], "commit")
}

fn add_remote_via_cli(root: &Path, name: &str, url: &str) -> Result<(), String> {
    cli::run_git_ok(root, &["remote", "add", name, url], "add remote")
}

#[cfg(windows)]
#[test]
fn normalize_path_for_git_strips_windows_verbatim_prefix() {
    assert_eq!(normalize_path_for_git(Path::new(r"\\?\D:\workspace\repo")), PathBuf::from(r"D:\workspace\repo"));
    assert_eq!(normalize_path_for_git(Path::new("//?/D:/workspace/repo")), PathBuf::from(r"D:\workspace\repo"));
}

#[test]
fn init_git_repository_creates_repository_at_workspace_root() -> Result<(), String> {
    let temp = TempGitDir::new("init-root")?;
    let status = init_git_repository(Some(temp.path.to_string_lossy().to_string()))?;
    let expected_root = temp.repository_root()?.to_string_lossy().to_string();
    assert!(temp.path.join(".git").exists());
    assert!(status.available);
    assert_eq!(status.repository_root_path.as_deref(), Some(expected_root.as_str()));
    Ok(())
}

#[cfg(windows)]
#[test]
fn init_git_repository_accepts_windows_verbatim_workspace_root() -> Result<(), String> {
    let temp = TempGitDir::new("init-verbatim")?;
    let verbatim = format!(r"\\?\{}", temp.path.display());
    let status = init_git_repository(Some(verbatim))?;
    let expected = temp.repository_root()?.to_string_lossy().to_string();
    assert!(temp.path.join(".git").exists());
    assert!(status.available);
    assert_eq!(status.repository_root_path.as_deref(), Some(expected.as_str()));
    Ok(())
}

#[test]
fn init_git_repository_does_not_reuse_parent_repository() -> Result<(), String> {
    let temp = TempGitDir::new("init-nested")?;
    let _parent = gix::init(&temp.path).map_err(|e| e.to_string())?;
    let child = temp.path.join("child-workspace");
    fs::create_dir_all(&child).map_err(|e| e.to_string())?;
    let status = init_git_repository(Some(child.to_string_lossy().to_string()))?;
    let expected = normalize_path_for_git(&child.canonicalize().map_err(|e| e.to_string())?);
    assert!(child.join(".git").exists());
    assert!(status.available);
    assert_eq!(status.repository_root_path.as_deref(), Some(expected.to_string_lossy().to_string().as_str()));
    Ok(())
}

#[test]
fn get_git_repository_status_reports_unavailable_for_non_git_directory() -> Result<(), String> {
    let temp = TempGitDir::new("status-unavailable")?;
    let non_git = temp.path.join("not-a-repo");
    fs::create_dir_all(&non_git).map_err(|e| e.to_string())?;
    let status = get_git_repository_status(Some(non_git.to_string_lossy().to_string()))?;
    assert!(!status.available);
    assert!(status.message.is_some());
    Ok(())
}

#[test]
fn stage_git_paths_and_unstage_git_paths_round_trip() -> Result<(), String> {
    let temp = TempGitDir::new("stage-unstage")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo hello\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo world\n")?;
    let s = stage_git_paths(GitPathOperationRequest { repository_root_path: root.to_string_lossy().to_string(), paths: vec!["src/app.sh".into()] })?;
    assert_eq!(s.staged_count, 1);
    let s = unstage_git_paths(GitPathOperationRequest { repository_root_path: root.to_string_lossy().to_string(), paths: vec!["src/app.sh".into()] })?;
    assert_eq!(s.staged_count, 0);
    assert_eq!(s.unstaged_count, 1);
    Ok(())
}

#[test]
fn discard_git_paths_restores_committed_content() -> Result<(), String> {
    let temp = TempGitDir::new("discard")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo base\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo changed\n")?;
    discard_git_paths(GitPathOperationRequest { repository_root_path: root.to_string_lossy().to_string(), paths: vec!["src/app.sh".into()] })?;
    let content = fs::read_to_string(temp.path.join("src/app.sh")).map_err(|e| e.to_string())?;
    assert_eq!(content.replace("\r\n", "\n"), "echo base\n");
    Ok(())
}

#[test]
fn get_git_diff_preview_worktree_returns_diff_for_changed_file() -> Result<(), String> {
    let temp = TempGitDir::new("diff-worktree")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo base\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo modified\n")?;
    let preview = get_git_diff_preview(GitDiffPreviewRequest { repository_root_path: root.to_string_lossy().to_string(), path: "src/app.sh".into(), mode: "worktree".into() })?;
    assert!(!preview.is_empty);
    assert!(preview.modified_content.contains("echo modified"));
    assert_eq!(preview.mode, "worktree");
    Ok(())
}

#[test]
fn get_git_diff_preview_staged_returns_diff_for_staged_change() -> Result<(), String> {
    let temp = TempGitDir::new("diff-staged")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo base\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo staged\n")?;
    stage_git_paths(GitPathOperationRequest { repository_root_path: root.to_string_lossy().to_string(), paths: vec!["src/app.sh".into()] })?;
    let preview = get_git_diff_preview(GitDiffPreviewRequest { repository_root_path: root.to_string_lossy().to_string(), path: "src/app.sh".into(), mode: "staged".into() })?;
    assert!(!preview.is_empty);
    assert_eq!(preview.mode, "staged");
    Ok(())
}

#[test]
fn list_git_branches_returns_current_branch_after_init() -> Result<(), String> {
    let temp = TempGitDir::new("branches-list")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo base\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    let branches = list_git_branches(GitRepositoryRootRequest { repository_root_path: root.to_string_lossy().to_string() })?;
    assert!(!branches.branches.is_empty());
    assert!(branches.branches.iter().any(|b| b.is_current));
    Ok(())
}

#[test]
fn git_commit_history_pagination() -> Result<(), String> {
    let temp = TempGitDir::new("history-pagination")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo first\n")?;
    commit_via_cli(&temp.path, "feat: first")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo second\n")?;
    commit_via_cli(&temp.path, "feat: second")?;
    let payload = list_git_commit_history(GitCommitHistoryRequest { repository_root_path: root.to_string_lossy().to_string(), offset: Some(0), limit: Some(1) })?;
    assert_eq!(payload.entries.len(), 1);
    assert_eq!(payload.entries[0].summary, "feat: second");
    assert!(payload.has_more);
    assert_eq!(payload.next_offset, Some(1));
    Ok(())
}

#[test]
fn create_git_branch_with_checkout_updates_head_branch() -> Result<(), String> {
    let temp = TempGitDir::new("branch-create-checkout")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo base\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    let status = create_git_branch(GitBranchCreateRequest { repository_root_path: root.to_string_lossy().to_string(), branch_name: "feature/demo".into(), checkout: true })?;
    assert_eq!(status.head_branch_name.as_deref(), Some("feature/demo"));
    Ok(())
}

#[test]
fn save_git_stash_and_list_git_stashes_round_trip() -> Result<(), String> {
    let temp = TempGitDir::new("stash-round-trip")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo base\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo changed\n")?;
    save_git_stash(GitStashSaveRequest { repository_root_path: root.to_string_lossy().to_string(), message: Some("demo stash".into()), include_untracked: false })?;
    let stashes = list_git_stashes(GitRepositoryRootRequest { repository_root_path: root.to_string_lossy().to_string() })?;
    assert_eq!(stashes.entries.len(), 1);
    assert!(stashes.entries[0].summary.contains("demo stash"));
    Ok(())
}

#[test]
fn apply_git_stash_with_pop_restores_worktree_and_clears_stash() -> Result<(), String> {
    let temp = TempGitDir::new("stash-pop")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo base\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    write_worktree_file(&temp.path, "src/app.sh", "echo changed\n")?;
    save_git_stash(GitStashSaveRequest { repository_root_path: root.to_string_lossy().to_string(), message: Some("demo pop".into()), include_untracked: false })?;
    let status = apply_git_stash(GitStashApplyRequest { repository_root_path: root.to_string_lossy().to_string(), stash_index: 0, pop: true })?;
    let content = fs::read_to_string(temp.path.join("src/app.sh")).map_err(|e| e.to_string())?;
    let stashes = list_git_stashes(GitRepositoryRootRequest { repository_root_path: root.to_string_lossy().to_string() })?;
    assert_eq!(content.replace("\r\n", "\n"), "echo changed\n");
    assert_eq!(status.unstaged_count, 1);
    assert!(stashes.entries.is_empty());
    Ok(())
}

#[test]
fn get_git_pull_request_support_parses_github_remote() -> Result<(), String> {
    let temp = TempGitDir::new("pull-request-support")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    add_remote_via_cli(&temp.path, "origin", "git@github.com:owner/repo.git")?;
    let payload = get_git_pull_request_support(GitRepositoryRootRequest { repository_root_path: root.to_string_lossy().to_string() })?;
    assert!(payload.available);
    assert_eq!(payload.provider, "github");
    assert_eq!(payload.repository_url.as_deref(), Some("https://github.com/owner/repo"));
    Ok(())
}

#[test]
fn get_git_repository_status_reports_renamed_path_correctly() -> Result<(), String> {
    let temp = TempGitDir::new("status-rename")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/old_name.sh", "echo hello\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    cli::run_git_ok(&temp.path, &["mv", "src/old_name.sh", "src/new_name.sh"], "rename")?;
    let status = get_git_repository_status(Some(root.to_string_lossy().to_string()))?;
    let renamed = status.files.iter().find(|f| f.relative_path == "src/new_name.sh")
        .ok_or_else(|| "未找到重命名后的路径".to_string())?;
    assert_eq!(renamed.index_status.as_deref(), Some("renamed"));
    assert_eq!(renamed.previous_relative_path.as_deref(), Some("src/old_name.sh"));
    Ok(())
}

#[test]
fn discard_git_paths_removes_untracked_file_without_error() -> Result<(), String> {
    let temp = TempGitDir::new("discard-untracked")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo base\n")?;
    commit_via_cli(&temp.path, "feat: initial")?;
    write_worktree_file(&temp.path, "src/extra.sh", "echo extra\n")?;
    discard_git_paths(GitPathOperationRequest { repository_root_path: root.to_string_lossy().to_string(), paths: vec!["src/extra.sh".into()] })?;
    assert!(!temp.path.join("src/extra.sh").exists());
    Ok(())
}

#[test]
fn git_commit_history_preserves_pipe_in_message() -> Result<(), String> {
    let temp = TempGitDir::new("history-pipe")?;
    let _repo = temp.init_repository()?;
    let root = temp.repository_root()?;
    write_worktree_file(&temp.path, "src/app.sh", "echo first\n")?;
    commit_via_cli(&temp.path, "feat: a | b | c")?;
    let payload = list_git_commit_history(GitCommitHistoryRequest { repository_root_path: root.to_string_lossy().to_string(), offset: Some(0), limit: Some(5) })?;
    assert_eq!(payload.entries[0].summary, "feat: a | b | c");
    assert!(!payload.entries[0].authored_at.is_empty());
    Ok(())
}