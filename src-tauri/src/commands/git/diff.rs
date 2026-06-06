use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GitDiffMode {
    Worktree,
    Staged,
}

impl GitDiffMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Worktree => GIT_DIFF_MODE_WORKTREE,
            Self::Staged => GIT_DIFF_MODE_STAGED,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_git_diff_preview(
    payload: GitDiffPreviewRequest,
) -> Result<GitDiffPreviewPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let mode = parse_git_diff_mode(&payload.mode)?;
    let relative_path = resolve_single_relative_path(&repository_root, &payload.path)?;
    let relative_path_text = path_to_forward_slashes(&relative_path);

    let content_pair = build_git_diff_content_pair(&repository_root, &relative_path, mode)?;
    let is_empty = content_pair.original_content.replace('\r', "") == content_pair.modified_content.replace('\r', "");

    let mode_label = match mode {
        GitDiffMode::Staged => "已暂存",
        GitDiffMode::Worktree => "工作区",
    };

    Ok(GitDiffPreviewPayload {
        id: format!(
            "git-diff:{}:{}:{}",
            mode.as_str(),
            repository_root.to_string_lossy(),
            relative_path_text
        ),
        repository_root_path: repository_root.to_string_lossy().to_string(),
        path: repository_root
            .join(&relative_path)
            .to_string_lossy()
            .to_string(),
        relative_path: relative_path_text.clone(),
        title: format!("{relative_path_text} · {mode_label} Diff"),
        mode: mode.as_str().to_string(),
        original_content: content_pair.original_content,
        modified_content: content_pair.modified_content,
        is_empty,
    })
}

/// 返回特定提交中单个文件的 diff（对比父提交）。
#[tauri::command]
#[specta::specta]
pub fn get_git_commit_file_diff(
    payload: GitCommitFileDiffRequest,
) -> Result<GitCommitFileDiffPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let commit_id = payload.commit_id.trim().to_string();
    let commit_oid: gix::ObjectId = commit_id
        .parse()
        .map_err(|_| format!("无效的提交 ID：{commit_id}"))?;
    let commit = repository
        .find_commit(commit_oid)
        .map_err(|e| format!("读取提交失败：{e}"))?;
    let relative_path = resolve_single_relative_path(&repository_root, &payload.relative_path)?;
    let relative_path_str = path_to_forward_slashes(&relative_path);
    let file_name = relative_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&payload.relative_path)
        .to_string();

    // 当前提交的文件内容
    let new_content_opt = super::status::read_git_revision_text(
        &repository_root,
        &format!("{commit_id}:{relative_path_str}"),
    )?;
    // 父提交的文件内容（根提交则为空）
    let old_content_opt = match commit.parent_ids().next() {
        Some(parent_id) => {
            let parent_str = parent_id.detach().to_string();
            super::status::read_git_revision_text(
                &repository_root,
                &format!("{parent_str}:{relative_path_str}"),
            )?
        }
        None => None,
    };

    // 二进制检测：两端都无法解码为文本
    let is_binary = new_content_opt.is_none() && old_content_opt.is_none();
    if is_binary {
        return Ok(GitCommitFileDiffPayload {
            relative_path: relative_path_str,
            file_name,
            title: String::new(),
            hunks: Vec::new(),
            is_binary: true,
            is_empty: false,
        });
    }

    let old_content = old_content_opt.unwrap_or_default();
    let new_content = new_content_opt.unwrap_or_default();
    let diff = similar::TextDiff::from_lines(old_content.as_str(), new_content.as_str());
    let mut hunks: Vec<GitDiffHunk> = Vec::new();

    for group in diff.grouped_ops(3) {
        if group.is_empty() {
            continue;
        }
        let first_op = &group[0];
        let last_op = &group[group.len() - 1];
        let old_start = first_op.old_range().start as u32 + 1;
        let new_start = first_op.new_range().start as u32 + 1;
        let old_count = (last_op.old_range().end - first_op.old_range().start) as u32;
        let new_count = (last_op.new_range().end - first_op.new_range().start) as u32;

        let mut lines: Vec<GitDiffLine> = Vec::new();
        for op in &group {
            for change in diff.iter_changes(op) {
                let tag = match change.tag() {
                    similar::ChangeTag::Delete => "remove",
                    similar::ChangeTag::Insert => "add",
                    similar::ChangeTag::Equal => "context",
                };
                let mut content = change.value().to_string();
                if content.ends_with('\n') {
                    content.pop();
                    if content.ends_with('\r') {
                        content.pop();
                    }
                }
                lines.push(GitDiffLine {
                    tag: tag.to_string(),
                    old_line: change.old_index().map(|i| i as u32 + 1),
                    new_line: change.new_index().map(|i| i as u32 + 1),
                    content,
                });
            }
        }
        hunks.push(GitDiffHunk {
            old_start,
            old_count,
            new_start,
            new_count,
            lines,
        });
    }

    let is_empty = hunks.is_empty();
    let short = &commit_id[..commit_id.len().min(7)];
    Ok(GitCommitFileDiffPayload {
        relative_path: relative_path_str,
        file_name: file_name.clone(),
        title: format!("{file_name} · {short}"),
        hunks,
        is_binary: false,
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

pub(super) fn remove_untracked_worktree_path(
    repository_root: &Path,
    relative_path: &Path,
) -> Result<(), String> {
    let target_path = repository_root.join(relative_path);
    if !target_path.exists() {
        return Ok(());
    }

    let canonical_root = normalize_path_for_git(
        &repository_root
            .canonicalize()
            .map_err(|e| format!("读取 Git 工作区根目录失败：{e}"))?,
    );
    let canonical_target = normalize_path_for_git(
        &target_path
            .canonicalize()
            .map_err(|e| format!("读取未跟踪文件路径失败：{e}"))?,
    );

    if !canonical_target.starts_with(&canonical_root) {
        return Err("拒绝删除 Git 工作区之外的未跟踪路径。".into());
    }

    let metadata = fs::symlink_metadata(&target_path).map_err(|e| format!("读取未跟踪路径元数据失败：{e}"))?;
    if metadata.is_dir() {
        fs::remove_dir_all(&target_path).map_err(|e| format!("删除未跟踪目录失败：{e}"))?;
    } else {
        fs::remove_file(&target_path).map_err(|e| format!("删除未跟踪文件失败：{e}"))?;
    }

    Ok(())
}

fn resolve_single_relative_path(repository_root: &Path, path: &str) -> Result<PathBuf, String> {
    resolve_relative_path(repository_root, Path::new(path))
}

fn read_worktree_text(
    repository_root: &Path,
    relative_path: &Path,
) -> Result<Option<String>, String> {
    let file_path = repository_root.join(relative_path);
    if !file_path.exists() {
        return Ok(None);
    }
    if file_path.is_dir() {
        return Err("当前路径是目录，暂不支持直接预览目录 Diff。".to_string());
    }

    let bytes = fs::read(&file_path).map_err(|e| format!("读取工作区文件失败：{e}"))?;
    decode_script_bytes(&bytes)
        .map(|(c, _)| Some(c))
        .map_err(|_| "当前工作区文件不是可直接比较的文本内容。".to_string())
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
                super::status::read_git_revision_text(
                    repository_root,
                    &format!(":{relative_path_text}"),
                )?
                .unwrap_or_default()
            };
            let modified = read_worktree_text(repository_root, relative_path)?.unwrap_or_default();
            Ok(GitDiffContentPair {
                original_content: original,
                modified_content: modified,
            })
        }
        GitDiffMode::Staged => {
            let original = super::status::read_git_revision_text(
                repository_root,
                &format!("HEAD:{relative_path_text}"),
            )?
            .unwrap_or_default();
            let modified = super::status::read_git_revision_text(
                repository_root,
                &format!(":{relative_path_text}"),
            )?
            .unwrap_or_default();
            Ok(GitDiffContentPair {
                original_content: original,
                modified_content: modified,
            })
        }
    }
}

fn is_untracked_git_path(repository_root: &Path, relative_path: &Path) -> Result<bool, String> {
    Ok(!super::status::is_tracked_git_path(
        repository_root,
        relative_path,
    )?)
}