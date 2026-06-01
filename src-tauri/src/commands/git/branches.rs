use super::*;
use super::cli;
use gix::bstr::ByteSlice;

#[tauri::command]
pub fn list_git_branches(
    payload: GitRepositoryRootRequest,
) -> Result<GitBranchListPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let mut branches = Vec::new();

    let references_platform = repository
        .references()
        .map_err(|error| format!("读取 Git 分支列表失败：{error}"))?;
    let references = references_platform
        .all()
        .map_err(|error| format!("读取 Git 分支列表失败：{error}"))?;

    for reference in references {
        let reference = reference.map_err(|error| format!("读取 Git 分支失败：{error}"))?;
        let name = reference.name();
        let (category, shorthand) = match name.category_and_short_name() {
            Some((cat, short)) => (cat, short.to_string()),
            None => continue,
        };

        let branch_kind = match category {
            gix::refs::Category::LocalBranch => "local",
            gix::refs::Category::RemoteBranch => "remote",
            _ => continue,
        };

        if branch_kind == "remote" && shorthand.ends_with("/HEAD") {
            continue;
        }

        if let Some(branch_payload) = build_git_branch_payload_from_ref(
            &repository,
            &repository_root,
            &reference,
            branch_kind,
            &shorthand,
        )? {
            branches.push(branch_payload);
        }
    }

    branches.sort_by(|left, right| {
        resolve_branch_sort_key(left).cmp(&resolve_branch_sort_key(right))
    });

    Ok(GitBranchListPayload { branches })
}

#[tauri::command]
pub fn checkout_git_branch(
    payload: GitBranchCheckoutRequest,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    assert_repository_is_clean_for_switch(&repository, "切换分支")?;

    cli::run_git_ok(
        &repository_root,
        &["checkout", payload.branch_name.trim()],
        "切换分支",
    )?;

    let repository = open_repository_from_root(&payload.repository_root_path)?;
    super::status::build_git_repository_status_payload(&repository)
}

#[tauri::command]
pub fn create_git_branch(
    payload: GitBranchCreateRequest,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let branch_name = payload.branch_name.trim();
    if branch_name.is_empty() {
        return Err("Git 分支名称不能为空。".into());
    }
    if !is_valid_git_branch_name(branch_name) {
        return Err(format!("Git 分支名称不合法：{branch_name}"));
    }
    if payload.checkout {
        assert_repository_is_clean_for_switch(&repository, "创建并切换分支")?;
    }

    cli::run_git_ok(&repository_root, &["branch", branch_name], "创建分支")?;

    if payload.checkout {
        cli::run_git_ok(&repository_root, &["checkout", branch_name], "切换分支")?;
    }

    let repository = open_repository_from_root(&payload.repository_root_path)?;
    super::status::build_git_repository_status_payload(&repository)
}

fn is_valid_git_branch_name(name: &str) -> bool {
    if name.is_empty() { return false; }
    if name.starts_with('.') || name.ends_with('.') { return false; }
    if name.ends_with(".lock") { return false; }
    if name.contains("..") { return false; }
    if name.contains(' ') || name.contains('~') || name.contains('^')
        || name.contains(':') || name.contains('?') || name.contains('*')
        || name.contains('[') { return false; }
    if name.contains("@{") { return false; }
    if name.as_bytes().iter().any(|&b| b == 0x7f || b < 0x20) { return false; }
    if name.starts_with('/') || name.ends_with('/') { return false; }
    true
}

fn resolve_branch_sort_key(branch: &GitBranchPayload) -> (usize, usize, &str) {
    (
        if branch.is_current { 0 } else { 1 },
        if branch.kind == "local" { 0 } else { 1 },
        branch.shorthand.as_str(),
    )
}

fn build_git_branch_payload_from_ref(
    repository: &Repository,
    repository_root: &Path,
    reference: &gix::Reference<'_>,
    kind: &str,
    shorthand: &str,
) -> Result<Option<GitBranchPayload>, String> {
    let name = reference.name().as_bstr().to_str_lossy().into_owned();
    let target_id = reference.id().detach();

    let is_current = is_current_branch(repository, reference);

    let (ahead, behind, upstream_name) = if kind == "local" {
    let upstream_name = resolve_branch_upstream(repository_root, shorthand);
    let (ahead, behind) = if upstream_name.is_some() {
        resolve_ahead_behind_cli(repository_root, shorthand)?
    } else {
        (0, 0)
    };
    (ahead, behind, upstream_name)
} else {
    (0, 0, None)
};

    let last_commit = repository
        .find_commit(target_id)
        .ok()
        .map(|commit| build_git_commit_summary(&commit));

    Ok(Some(GitBranchPayload {
        name,
        shorthand: shorthand.to_string(),
        kind: kind.to_string(),
        upstream_name: None,
        is_current,
        is_head: is_current,
        ahead,
        behind,
        last_commit,
    }))
}

fn is_current_branch(repository: &Repository, reference: &gix::Reference<'_>) -> bool {
    let Ok(Some(head_ref)) = repository.head_ref() else {
        return false;
    };
    head_ref.name().as_bstr() == reference.name().as_bstr()
}

fn resolve_branch_upstream(repository_root: &Path, branch_name: &str) -> Option<String> {
    let upstream_ref = [branch_name, "@{upstream}"].concat();
    let output = cli::run_git_text_allow_exit_one(
        repository_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", &upstream_ref],
        "读取上游分支",
    ).ok().flatten()?;
    let trimmed = output.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

fn resolve_ahead_behind_cli(
    repository_root: &Path,
    branch_name: &str,
) -> Result<(usize, usize), String> {
    // 比较「该分支」与「它自己的上游」，而不是当前 HEAD 的上游。
    let upstream_ref = [branch_name, "@{upstream}"].concat();
    let range = [branch_name, "...", &upstream_ref].concat();
    let output = cli::run_git_text_allow_exit_one(
        repository_root,
        &["rev-list", "--count", "--left-right", &range],
        "读取 ahead/behind",
    );

    match output {
        Ok(Some(output)) => {
            let parts: Vec<&str> = output.trim().split('\t').collect();
            if parts.len() >= 2 {
                Ok((parts[0].parse::<usize>().unwrap_or(0), parts[1].parse::<usize>().unwrap_or(0)))
            } else {
                Ok((0, 0))
            }
        }
        _ => Ok((0, 0)),
    }
}

pub(super) fn assert_repository_is_clean_for_switch(
    repository: &Repository,
    action: &str,
) -> Result<(), String> {
    let status = super::status::build_git_repository_status_payload(repository)?;
    if status.conflicted_count > 0 {
        return Err(format!("当前工作区存在冲突，{action} 前请先解决冲突。"));
    }
    if !status.is_clean {
        return Err(format!(
            "当前工作区存在未提交改动，{action} 前请先提交、贮藏或放弃当前改动。"
        ));
    }
    Ok(())
}