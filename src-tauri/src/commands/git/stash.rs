use super::*;
use git2::Delta;

#[tauri::command]
pub fn list_git_stashes(payload: GitRepositoryRootRequest) -> Result<GitStashListPayload, String> {
    let mut repository = open_repository_from_root(&payload.repository_root_path)?;
    let mut stash_refs = Vec::new();

    repository
        .stash_foreach(|index, name, oid| {
            stash_refs.push((index, name.to_string(), *oid));
            true
        })
        .map_err(|error| format!("读取 Git 贮藏列表失败：{error}"))?;

    let mut entries = Vec::with_capacity(stash_refs.len());
    for (index, summary, oid) in stash_refs {
        entries.push(build_git_stash_entry_payload(&repository, index, &summary, oid)?);
    }

    Ok(GitStashListPayload { entries })
}

#[tauri::command]
pub fn save_git_stash(payload: GitStashSaveRequest) -> Result<GitRepositoryStatusPayload, String> {
    let mut repository = open_repository_from_root(&payload.repository_root_path)?;
    let status = super::status::build_git_repository_status_payload(&repository)?;
    if status.is_clean {
        return Err("当前没有可贮藏的改动。".into());
    }
    if status.conflicted_count > 0 {
        return Err("存在冲突文件，解决冲突后再执行贮藏。".into());
    }

    let signature = repository.signature().map_err(|error| {
        format!("读取 Git 贮藏身份失败：{error}。请先配置 user.name 和 user.email。")
    })?;
    let message = payload
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let flags = payload
        .include_untracked
        .then_some(StashFlags::INCLUDE_UNTRACKED);
    repository
        .stash_save2(&signature, message, flags)
        .map_err(|error| format!("保存 Git 贮藏失败：{error}"))?;

    super::status::build_git_repository_status_payload(&repository)
}

#[tauri::command]
pub fn apply_git_stash(
    payload: GitStashApplyRequest,
) -> Result<GitRepositoryStatusPayload, String> {
    let mut repository = open_repository_from_root(&payload.repository_root_path)?;
    super::branches::assert_repository_is_clean_for_switch(
        &repository,
        if payload.pop {
            "应用并移除贮藏"
        } else {
            "应用贮藏"
        },
    )?;

    if payload.pop {
        repository
            .stash_pop(payload.stash_index, None)
            .map_err(|error| format!("应用并移除 Git 贮藏失败：{error}"))?;
    } else {
        repository
            .stash_apply(payload.stash_index, None)
            .map_err(|error| format!("应用 Git 贮藏失败：{error}"))?;
    }

    super::status::build_git_repository_status_payload(&repository)
}

#[tauri::command]
pub fn drop_git_stash(payload: GitStashDropRequest) -> Result<GitRepositoryStatusPayload, String> {
    let mut repository = open_repository_from_root(&payload.repository_root_path)?;
    repository
        .stash_drop(payload.stash_index)
        .map_err(|error| format!("删除 Git 贮藏失败：{error}"))?;
    super::status::build_git_repository_status_payload(&repository)
}

fn build_git_stash_entry_payload(
    repository: &Repository,
    index: usize,
    summary: &str,
    oid: git2::Oid,
) -> Result<GitStashEntryPayload, String> {
    let commit = repository
        .find_commit(oid)
        .map_err(|error| format!("读取 Git 贮藏提交失败：{error}"))?;
    let details = build_git_stash_details(repository, &commit)?;
    let (branch_name, commit_short_id) = parse_git_stash_name(summary);

    Ok(GitStashEntryPayload {
        index,
        stash_id: format!("stash@{{{index}}}"),
        summary: summary.to_string(),
        branch_name,
        commit_short_id: commit_short_id.or_else(|| Some(short_commit_id(oid))),
        created_at: details.created_at,
        file_count: details.file_count,
        additions: details.additions,
        deletions: details.deletions,
        files: details.files,
    })
}

fn build_git_stash_details(
    repository: &Repository,
    commit: &git2::Commit<'_>,
) -> Result<GitStashDetails, String> {
    let created_at = Utc
        .timestamp_opt(commit.time().seconds(), 0)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339();
    let stash_tree = commit
        .tree()
        .map_err(|error| format!("读取 Git 贮藏快照失败：{error}"))?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|error| format!("读取 Git 贮藏基线失败：{error}"))?
                .tree()
                .map_err(|error| format!("读取 Git 贮藏基线树失败：{error}"))?,
        )
    } else {
        None
    };
    let mut diff = repository
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&stash_tree), None)
        .map_err(|error| format!("读取 Git 贮藏差异失败：{error}"))?;

    diff.find_similar(None)
        .map_err(|error| format!("解析 Git 贮藏文件变更失败：{error}"))?;

    let stats = diff
        .stats()
        .map_err(|error| format!("统计 Git 贮藏变更失败：{error}"))?;
    let mut files = Vec::new();

    for (delta_index, delta) in diff.deltas().enumerate() {
        files.push(build_git_stash_file_payload(&diff, delta_index, delta)?);
    }

    Ok(GitStashDetails {
        created_at,
        file_count: stats.files_changed(),
        additions: clamp_git_counter(stats.insertions()),
        deletions: clamp_git_counter(stats.deletions()),
        files,
    })
}

fn build_git_stash_file_payload(
    diff: &git2::Diff<'_>,
    delta_index: usize,
    delta: git2::DiffDelta<'_>,
) -> Result<GitStashFilePayload, String> {
    let relative_path = delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(path_to_forward_slashes)
        .ok_or_else(|| "解析 Git 贮藏文件路径失败。".to_string())?;
    let previous_relative_path = delta
        .old_file()
        .path()
        .map(path_to_forward_slashes)
        .filter(|value| value != &relative_path);
    let file_name = Path::new(&relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| relative_path.clone());
    let patch = git2::Patch::from_diff(diff, delta_index)
        .map_err(|error| format!("读取 Git 贮藏补丁失败：{error}"))?;
    let (additions, deletions) = if let Some(patch) = patch {
        let (_, additions, deletions) = patch
            .line_stats()
            .map_err(|error| format!("统计 Git 贮藏文件差异失败：{error}"))?;
        (clamp_git_counter(additions), clamp_git_counter(deletions))
    } else {
        (0, 0)
    };

    Ok(GitStashFilePayload {
        relative_path,
        file_name,
        previous_relative_path,
        status: map_git_stash_delta_status(delta.status()).to_string(),
        additions,
        deletions,
    })
}

fn map_git_stash_delta_status(status: Delta) -> &'static str {
    match status {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Renamed => "renamed",
        Delta::Typechange => "typechange",
        _ => "modified",
    }
}

fn clamp_git_counter(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

struct GitStashDetails {
    created_at: String,
    file_count: usize,
    additions: u32,
    deletions: u32,
    files: Vec<GitStashFilePayload>,
}

fn parse_git_stash_name(name: &str) -> (Option<String>, Option<String>) {
    let trimmed = name.trim();

    if let Some(rest) = trimmed.strip_prefix("WIP on ") {
        if let Some((branch_name, remainder)) = rest.split_once(':') {
            let remainder = remainder.trim();
            let commit_short_id = remainder
                .split_whitespace()
                .next()
                .filter(|value| is_short_git_commit_id(value))
                .map(str::to_string);

            return (Some(branch_name.trim().to_string()), commit_short_id);
        }
    }

    if let Some(rest) = trimmed.strip_prefix("On ") {
        if let Some((branch_name, _)) = rest.split_once(':') {
            return (Some(branch_name.trim().to_string()), None);
        }
    }

    (None, None)
}

fn is_short_git_commit_id(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.chars().all(|character| character.is_ascii_hexdigit())
}
