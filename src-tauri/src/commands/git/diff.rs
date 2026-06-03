use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GitDiffMode { Worktree, Staged }

impl GitDiffMode {
    fn as_str(self) -> &'static str {
        match self { Self::Worktree => GIT_DIFF_MODE_WORKTREE, Self::Staged => GIT_DIFF_MODE_STAGED }
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_git_diff_preview(payload: GitDiffPreviewRequest) -> Result<GitDiffPreviewPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let mode = parse_git_diff_mode(&payload.mode)?;
    let relative_path = resolve_single_relative_path(&repository_root, &payload.path)?;
    let relative_path_text = path_to_forward_slashes(&relative_path);
    let content_pair = build_git_diff_content_pair(&repository_root, &relative_path, mode)?;
    let is_empty = content_pair.original_content.replace('\r', "")
    == content_pair.modified_content.replace('\r', "");
    let mode_label = match mode { GitDiffMode::Staged => "已暂存", GitDiffMode::Worktree => "工作区" };

    Ok(GitDiffPreviewPayload {
        id: format!("git-diff:{}:{}:{}", mode.as_str(), repository_root.to_string_lossy(), relative_path_text),
        repository_root_path: repository_root.to_string_lossy().to_string(),
        path: repository_root.join(&relative_path).to_string_lossy().to_string(),
        relative_path: relative_path_text.clone(),
        title: format!("{relative_path_text} · {mode_label} Diff"),
        mode: mode.as_str().to_string(),
        original_content: content_pair.original_content,
        modified_content: content_pair.modified_content,
        is_empty,
    })
}

pub(super) fn parse_git_diff_mode(value: &str) -> Result<GitDiffMode, String> {
    match value {
        GIT_DIFF_MODE_WORKTREE => Ok(GitDiffMode::Worktree),
        GIT_DIFF_MODE_STAGED => Ok(GitDiffMode::Staged),
        _ => Err(format!("不支持的 Git Diff 模式：{value}")),
    }
}

pub(super) fn remove_untracked_worktree_path(repository_root: &Path, relative_path: &Path) -> Result<(), String> {
    let target_path = repository_root.join(relative_path);
    if !target_path.exists() { return Ok(()); }
    let canonical_root = normalize_path_for_git(&repository_root.canonicalize().map_err(|e| format!("读取 Git 工作区根目录失败：{e}"))?);
    let canonical_target = normalize_path_for_git(&target_path.canonicalize().map_err(|e| format!("读取未跟踪文件路径失败：{e}"))?);
    if !canonical_target.starts_with(&canonical_root) { return Err("拒绝删除 Git 工作区之外的未跟踪路径。".into()); }
    let metadata = fs::symlink_metadata(&target_path).map_err(|e| format!("读取未跟踪路径元数据失败：{e}"))?;
    if metadata.is_dir() { fs::remove_dir_all(&target_path).map_err(|e| format!("删除未跟踪目录失败：{e}"))?; }
    else { fs::remove_file(&target_path).map_err(|e| format!("删除未跟踪文件失败：{e}"))?; }
    Ok(())
}

fn resolve_single_relative_path(repository_root: &Path, path: &str) -> Result<PathBuf, String> {
    resolve_relative_path(repository_root, Path::new(path))
}

fn read_worktree_text(repository_root: &Path, relative_path: &Path) -> Result<Option<String>, String> {
    let file_path = repository_root.join(relative_path);
    if !file_path.exists() { return Ok(None); }
    if file_path.is_dir() { return Err("当前路径是目录，暂不支持直接预览目录 Diff。".to_string()); }
    let bytes = fs::read(&file_path).map_err(|e| format!("读取工作区文件失败：{e}"))?;
    decode_script_bytes(&bytes).map(|(c, _)| Some(c)).map_err(|_| "当前工作区文件不是可直接比较的文本内容。".to_string())
}

pub(super) fn build_git_diff_content_pair(
    repository_root: &Path,
    relative_path: &Path,
    mode: GitDiffMode,
) -> Result<GitDiffContentPair, String> {
    let relative_path_text = path_to_forward_slashes(relative_path);
    match mode {
        GitDiffMode::Worktree => {
            let original = if is_untracked_git_path(repository_root, relative_path)? {
                String::new()
            } else {
                super::status::read_git_revision_text(repository_root, &format!(":{relative_path_text}"))?.unwrap_or_default()
            };
            let modified = read_worktree_text(repository_root, relative_path)?.unwrap_or_default();
            Ok(GitDiffContentPair { original_content: original, modified_content: modified })
        }
        GitDiffMode::Staged => {
            let original = super::status::read_git_revision_text(repository_root, &format!("HEAD:{relative_path_text}"))?.unwrap_or_default();
            let modified = super::status::read_git_revision_text(repository_root, &format!(":{relative_path_text}"))?.unwrap_or_default();
            Ok(GitDiffContentPair { original_content: original, modified_content: modified })
        }
    }
}

fn is_untracked_git_path(repository_root: &Path, relative_path: &Path) -> Result<bool, String> {
    Ok(!super::status::is_tracked_git_path(repository_root, relative_path)?)
}
