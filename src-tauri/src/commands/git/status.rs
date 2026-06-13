use super::*;
use super::worktree_io::*;
use crate::commands::workspace_fs::workspace_name;
use gix::bstr::ByteSlice;

#[tauri::command]
#[specta::specta]
pub fn get_git_repository_status(
    workspace_root_path: Option<String>,
) -> Result<GitRepositoryStatusPayload, String> {
    let workspace_root = resolve_git_workspace_root(workspace_root_path)?;
    match gix::discover(&workspace_root) {
        Ok(repository) => build_git_repository_status_payload(&repository),
        Err(_) => Ok(build_unavailable_git_status(
            "当前工作区未检测到 Git 仓库。",
        )),
    }
}

#[tauri::command]
#[specta::specta]
pub fn init_git_repository(
    workspace_root_path: Option<String>,
) -> Result<GitRepositoryStatusPayload, String> {
    let workspace_root = resolve_git_workspace_root(workspace_root_path)?;
    match gix::open(&workspace_root) {
        Ok(repository) => build_git_repository_status_payload(&repository),
        Err(_) => {
            gix::init(&workspace_root).map_err(|e| format!("初始化 Git 仓库失败：{e}"))?;
            let repository = gix::open(&workspace_root)
                .map_err(|e| format!("读取初始化后的 Git 仓库失败：{e}"))?;
            build_git_repository_status_payload(&repository)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_git_file_baseline(path: String) -> Result<GitFileBaselinePayload, String> {
    let file_path = normalize_path_for_git(Path::new(&path));
    let discovery_root = file_path.parent().unwrap_or(file_path.as_path());
    match gix::discover(discovery_root) {
        Ok(repository) => build_git_file_baseline_payload(&repository, &file_path),
        Err(_) => Ok(GitFileBaselinePayload {
            available: false,
            message: Some("当前文件不在 Git 仓库中。".into()),
            repository_root_path: None,
            file_path: path,
            relative_path: None,
            is_tracked: false,
            content: None,
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub fn stage_git_paths(
    payload: GitPathOperationRequest,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() {
        return build_git_repository_status_payload(&repository);
    }
    let exact_pathspecs: std::collections::HashSet<&str> =
        pathspecs.iter().map(String::as_str).collect();

    // 通过 gix 计算当前状态，得到所有可暂存的变更文件（已遵循 .gitignore），
    // 避免依赖系统安装的 git（等价 `git add -- <pathspec>`）。
    let status = build_git_status_via_gix(&repository)?;
    let mut index = open_mut_index_or_empty(&repository)?;
    let mut changed = false;
    for file in &status.files {
        let rel = file.relative_path.as_str();
        if !exact_pathspecs.contains(rel)
            && !pathspecs
                .iter()
                .any(|pathspec| pathspec_matches(pathspec, rel))
        {
            continue;
        }

        // 已暂存且无工作区改动 / 非未跟踪的文件无需重复写入。
        if file.worktree_status.is_none() && !file.is_untracked {
            continue;
        }

        let absolute_path = repository_root.join(Path::new(rel));
        let worktree_deleted = file.worktree_status.as_deref() == Some("deleted");
        if worktree_deleted || !path_exists_in_worktree(&absolute_path) {
            // 暂存删除：从索引移除该路径。
            remove_index_path(&mut index, rel);
            changed = true;
        } else {
            // 将当前工作区内容写入对象库并更新为 stage-0 索引条目。
            let object_id = write_worktree_blob(&repository, &absolute_path)?;
            let mode = index_mode_for_worktree_file(&absolute_path)?;
            upsert_index_entry(&mut index, rel, object_id, mode);
            changed = true;
        }
    }

    if changed {
        index.sort_entries();
        index
            .write(gix::index::write::Options::default())
            .map_err(|error| format!("写入 Git 索引失败：{error}"))?;
    }

    let repository = open_repository_from_root(&payload.repository_root_path)?;
    build_git_repository_status_payload(&repository)
}

#[tauri::command]
#[specta::specta]
pub fn unstage_git_paths(
    payload: GitPathOperationRequest,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() {
        return build_git_repository_status_payload(&repository);
    }
    let exact_pathspecs: std::collections::HashSet<&str> =
        pathspecs.iter().map(String::as_str).collect();

    let mut index = open_mut_index_or_empty(&repository)?;

    // 收集需要重置的路径：索引中匹配 pathspec 的条目，以及精确给出的 pathspec
    //（覆盖「已暂存删除」——HEAD 有、索引无的情况）。
    let mut targets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in index.entries() {
        let entry_path = entry.path(&index).to_str_lossy().into_owned();
        if exact_pathspecs.contains(entry_path.as_str())
            || pathspecs
                .iter()
                .any(|pathspec| pathspec_matches(pathspec, &entry_path))
        {
            targets.insert(entry_path);
        }
    }
    for pathspec in &pathspecs {
        targets.insert(pathspec.clone());
    }

    // HEAD 树用于把索引重置回最近一次提交（等价 `git reset -- <pathspec>`）；
    // 空仓库（unborn）时为 None，对应全部从索引移除。
    let head_tree = repository.head_tree().ok();
    let mut changed = false;
    for rel in &targets {
        let head_entry = match &head_tree {
            Some(tree) => {
                let mut tree = tree.clone();
                tree.peel_to_entry_by_path(Path::new(rel)).ok().flatten()
            }
            None => None,
        };

        match head_entry {
            Some(entry) => {
                let mode = entry.mode();
                let index_mode = if mode.is_tree() || mode.is_commit() {
                    // 目录或子模块项不对应单个索引 blob，跳过。
                    None
                } else if mode.is_link() {
                    Some(gix::index::entry::Mode::SYMLINK)
                } else if mode.is_executable() {
                    Some(gix::index::entry::Mode::FILE_EXECUTABLE)
                } else {
                    Some(gix::index::entry::Mode::FILE)
                };

                if let Some(index_mode) = index_mode {
                    let object_id = entry.id().detach();
                    upsert_index_entry(&mut index, rel, object_id, index_mode);
                    changed = true;
                }
            }
            None => {
                // HEAD 中不存在该路径：取消暂存即从索引移除（恢复为未跟踪 / 新增）。
                if index_has_path(&index, rel) {
                    remove_index_path(&mut index, rel);
                    changed = true;
                }
            }
        }
    }

    if changed {
        index.sort_entries();
        index
            .write(gix::index::write::Options::default())
            .map_err(|error| format!("写入 Git 索引失败：{error}"))?;
    }

    let repository = open_repository_from_root(&payload.repository_root_path)?;
    build_git_repository_status_payload(&repository)
}

#[tauri::command]
#[specta::specta]
pub fn commit_git_index(payload: GitCommitRequest) -> Result<GitCommitResultPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    let message = payload.message.trim();
    if message.is_empty() {
        return Err("Git 提交说明不能为空。".into());
    }

    // 提交前预检 Git 身份（user.name / user.email）：缺失时给出可读的中文提示，
    // 避免底层 gix 在提交阶段抛出难以理解的错误。
    assert_git_identity_configured(&repository)?;

    // 读取索引；存在未解决的合并冲突（stage != 0）时拒绝提交。
    let index = open_mut_index_or_empty(&repository)?;
    if index.entries().iter().any(|entry| entry.stage_raw() != 0) {
        return Err("存在未解决的合并冲突，无法提交。".into());
    }

    // 依据是否给定 pathspec 构建提交树：
    // - 无 pathspec：提交整个索引（等价 `git commit`）。
    // - 有 pathspec：以 HEAD 树为基底，仅应用匹配路径的暂存改动（等价 `git commit -- <pathspec>`）。
    let tree_id = if pathspecs.is_empty() {
        build_tree_from_full_index(&repository, &index)?
    } else {
        build_tree_from_selected_index_paths(&repository, &index, &pathspecs)?
    };

    // 空提交保护：生成的树与 HEAD 树一致时说明没有可提交的改动。
    let head_tree_id = repository.head_tree().ok().map(|tree| tree.id().detach());
    if head_tree_id == Some(tree_id) {
        return Err("没有可提交的改动。".into());
    }

    let parents: Vec<gix::ObjectId> = resolve_head_commit(&repository)?
        .as_ref()
        .map(|commit| commit.id().detach())
        .into_iter()
        .collect();

    // 使用配置中的提交者身份创建提交，并更新 HEAD 所指分支与 reflog（等价 `git commit`）。
    let new_commit_id = repository
        .commit("HEAD", message, tree_id, parents)
        .map_err(|error| format!("创建提交失败：{error}"))?
        .detach();

    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let status = build_git_repository_status_payload(&repository)?;
    Ok(GitCommitResultPayload {
        status,
        commit_id: Some(new_commit_id.to_string()),
    })
}

#[tauri::command]
#[specta::specta]
pub fn discard_git_paths(
    payload: GitPathOperationRequest,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() {
        return build_git_repository_status_payload(&repository);
    }

    // 读取索引快照，用于把已跟踪文件还原回暂存内容（等价 `git checkout -- <path>`），
    // 避免依赖系统安装的 git。
    let index = repository
        .index_or_empty()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;

    for pathspec in &pathspecs {
        let relative_path = Path::new(pathspec);
        if is_tracked_git_path(&repository_root, relative_path)? {
            let path = gix::bstr::BStr::new(pathspec.as_bytes());
            if let Some(entry) = index.entry_by_path(path) {
                restore_worktree_from_index_blob(
                    &repository,
                    &repository_root,
                    pathspec,
                    entry.id,
                    entry.mode,
                )?;
            }
        } else {
            // 未跟踪文件无法用索引还原，直接从工作区删除。
            super::diff::remove_untracked_worktree_path(&repository_root, relative_path)?;
        }
    }

    build_git_repository_status_payload(&repository)
}

/// 核心状态构建：通过 gix 读取 HEAD、领先/落后信息与文件状态，
/// 不再依赖系统安装的 git（免装目标）。
pub(super) fn build_git_repository_status_payload(
    repository: &Repository,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository_root = resolve_repository_root(repository)?;
    let status = build_git_status_via_gix(repository)?;
    let last_commit = resolve_head_commit(repository)
        .ok()
        .flatten()
        .map(|c| build_git_commit_summary(&c));

    Ok(GitRepositoryStatusPayload {
        available: true,
        message: None,
        repository_root_path: Some(repository_root.to_string_lossy().to_string()),
        repository_name: Some(workspace_name(&repository_root)),
        git_dir_path: Some(repository.git_dir().to_string_lossy().to_string()),
        head_branch_name: status.head_branch,
        head_short_name: status.head_short_name,
        head_short_oid: status
            .head_oid
            .as_deref()
            .map(|oid| oid.chars().take(7).collect::<String>()),
        is_detached: status.detached,
        is_clean: status.staged_count == 0
            && status.unstaged_count == 0
            && status.untracked_count == 0,
        ahead: status.ahead,
        behind: status.behind,
        staged_count: status.staged_count,
        unstaged_count: status.unstaged_count,
        untracked_count: status.untracked_count,
        conflicted_count: status.conflicted_count,
        files: status.files,
        last_commit,
    })
}

struct StatusAccum {
    head_branch: Option<String>,
    head_short_name: Option<String>,
    head_oid: Option<String>,
    detached: bool,
    ahead: usize,
    behind: usize,
    staged_count: usize,
    unstaged_count: usize,
    untracked_count: usize,
    conflicted_count: usize,
    files: Vec<GitFileStatusPayload>,
}

/// 通过 gix 的 status 迭代器构建状态，等价于
/// `git status --porcelain=v2 --branch --untracked-files=all --ignored=no`，避免依赖系统安装的 git。
fn build_git_status_via_gix(repository: &Repository) -> Result<StatusAccum, String> {
    let repository_root = resolve_repository_root(repository)?;
    let mut accum = StatusAccum {
        head_branch: None,
        head_short_name: None,
        head_oid: None,
        detached: false,
        ahead: 0,
        behind: 0,
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        conflicted_count: 0,
        files: Vec::new(),
    };

    // HEAD 信息。
    accum.head_oid = repository.head_id().ok().map(|id| id.detach().to_string());
    match repository.head_ref() {
        Ok(Some(reference)) => {
            let short = reference
                .name()
                .category_and_short_name()
                .map(|(_, short)| short.to_string());
            accum.head_branch = short.clone();
            accum.head_short_name = short;
            accum.detached = false;
        }
        // 无符号引用：detached HEAD（已有提交）或尚无提交的空仓库。
        Ok(None) => {
            accum.detached = accum.head_oid.is_some();
        }
        Err(_) => {}
    }

    // 领先/落后：复用 branches 中基于 gix 的修订遍历实现。
    if let Some(branch) = accum.head_short_name.as_deref() {
        let (ahead, behind) = super::branches::resolve_ahead_behind_cli(&repository_root, branch)?;
        accum.ahead = ahead;
        accum.behind = behind;
    }

    // 文件状态。
    let mut files: std::collections::BTreeMap<String, GitFileStatusPayload> =
        std::collections::BTreeMap::new();
    let iter = repository
        .status(gix::progress::Discard)
        .map_err(|error| format!("读取 Git 状态失败：{error}"))?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .into_iter(Vec::new())
        .map_err(|error| format!("枚举 Git 状态失败：{error}"))?;

    for item in iter {
        let item = item.map_err(|error| format!("读取 Git 状态条目失败：{error}"))?;
        let location = item.location().to_str_lossy().into_owned();
        match item {
            gix::status::Item::TreeIndex(change) => {
                apply_tree_index_change(&repository_root, &mut files, &location, &change);
            }
            gix::status::Item::IndexWorktree(change) => {
                apply_index_worktree_change(&repository_root, &mut files, &location, &change);
            }
        }
    }

    accum.files = files.into_values().collect();

    // 统计口径与原 porcelain v2 解析保持一致。
    for entry in &accum.files {
        if entry.index_status.as_deref() == Some("conflicted") {
            accum.conflicted_count += 1;
        } else if entry.index_status.is_some() {
            accum.staged_count += 1;
        }
        if entry.worktree_status.is_some() {
            accum.unstaged_count += 1;
        }
        if entry.is_untracked {
            accum.untracked_count += 1;
        }
    }

    Ok(accum)
}

fn build_status_paths(repository_root: &Path, rel: &str) -> (String, String, String) {
    let relative_path = Path::new(rel);
    let rps = path_to_forward_slashes(relative_path);
    let file_name = relative_path
        .file_name()
        .and_then(|v| v.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| rps.clone());
    let abs = repository_root
        .join(relative_path)
        .to_string_lossy()
        .to_string();
    (abs, rps, file_name)
}

fn status_entry_mut<'a>(
    repository_root: &Path,
    files: &'a mut std::collections::BTreeMap<String, GitFileStatusPayload>,
    rel: &str,
) -> &'a mut GitFileStatusPayload {
    let (abs, rps, file_name) = build_status_paths(repository_root, rel);
    files
        .entry(rps.clone())
        .or_insert_with(|| GitFileStatusPayload {
            path: abs,
            relative_path: rps,
            file_name,
            previous_path: None,
            previous_relative_path: None,
            index_status: None,
            worktree_status: None,
            is_conflicted: false,
            is_untracked: false,
        })
}

/// 暂存区相对 HEAD 树的变更（已暂存状态）。
fn apply_tree_index_change(
    repository_root: &Path,
    files: &mut std::collections::BTreeMap<String, GitFileStatusPayload>,
    location: &str,
    change: &gix::diff::index::ChangeRef<'_, '_>,
) {
    use gix::diff::index::ChangeRef;
    let entry = status_entry_mut(repository_root, files, location);

    // 冲突状态优先，不被暂存状态覆盖。
    if entry.index_status.as_deref() == Some("conflicted") {
        return;
    }

    match change {
        ChangeRef::Addition { .. } => {
            entry.index_status = Some("added".to_string());
        }
        ChangeRef::Deletion { .. } => {
            entry.index_status = Some("deleted".to_string());
        }
        ChangeRef::Modification { .. } => {
            entry.index_status = Some("modified".to_string());
        }
        ChangeRef::Rewrite {
            source_location,
            copy,
            ..
        } => {
            entry.index_status = Some(if *copy { "copied" } else { "renamed" }.to_string());
            let source = source_location.to_str_lossy().into_owned();
            let source_path = Path::new(&source);
            entry.previous_relative_path = Some(path_to_forward_slashes(source_path));
            entry.previous_path = Some(
                repository_root
                    .join(source_path)
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
}

/// 索引相对工作区的变更（未暂存 / 未跟踪 / 冲突状态）。
fn apply_index_worktree_change(
    repository_root: &Path,
    files: &mut std::collections::BTreeMap<String, GitFileStatusPayload>,
    location: &str,
    change: &gix::status::index_worktree::Item,
) {
    use gix::status::index_worktree::iter::Summary;
    let summary = change.summary();
    let entry = status_entry_mut(repository_root, files, location);

    match summary {
        Some(Summary::Conflict) => {
            entry.index_status = Some("conflicted".to_string());
            entry.worktree_status = Some("conflicted".to_string());
            entry.is_conflicted = true;
        }
        Some(Summary::Added) => {
            // 工作区存在但索引中没有：未跟踪文件。
            entry.worktree_status = Some("untracked".to_string());
            entry.is_untracked = true;
        }
        Some(Summary::IntentToAdd) => {
            entry.worktree_status = Some("added".to_string());
        }
        Some(Summary::Removed) => {
            entry.worktree_status = Some("deleted".to_string());
        }
        Some(Summary::Modified) => {
            entry.worktree_status = Some("modified".to_string());
        }
        Some(Summary::TypeChange) => {
            entry.worktree_status = Some("typechange".to_string());
        }
        Some(Summary::Renamed) => {
            entry.worktree_status = Some("renamed".to_string());
        }
        Some(Summary::Copied) => {
            entry.worktree_status = Some("copied".to_string());
        }
        None => {}
    }
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

fn build_git_file_baseline_payload(
    repository: &Repository,
    file_path: &Path,
) -> Result<GitFileBaselinePayload, String> {
    let repository_root = resolve_repository_root(repository)?;
    let relative_path = resolve_relative_path(&repository_root, file_path)?;
    let relative_path_string = path_to_forward_slashes(&relative_path);
    let is_tracked = is_tracked_git_path(&repository_root, &relative_path)?;

    if !is_tracked {
        return Ok(GitFileBaselinePayload {
            available: true,
            message: Some("当前文件未被 Git 跟踪。".into()),
            repository_root_path: Some(repository_root.to_string_lossy().to_string()),
            file_path: file_path.to_string_lossy().to_string(),
            relative_path: Some(relative_path_string),
            is_tracked: false,
            content: None,
        });
    }

    let object_spec = format!("HEAD:{relative_path_string}");
    let content = read_git_revision_text(&repository_root, &object_spec)?;
    Ok(GitFileBaselinePayload {
        available: true,
        message: if content.is_none() {
            Some("当前文件基线不是可直接比较的文本内容。".into())
        } else {
            None
        },
        repository_root_path: Some(repository_root.to_string_lossy().to_string()),
        file_path: file_path.to_string_lossy().to_string(),
        relative_path: Some(relative_path_string),
        is_tracked: true,
        content,
    })
}

pub(super) fn is_tracked_git_path(
    repository_root: &Path,
    relative_path: &Path,
) -> Result<bool, String> {
    // 通过 gix 查询索引判断路径是否被 Git 跟踪（等价于 `git ls-files --error-unmatch`），避免依赖系统安装的 git。
    let repository =
        gix::open(repository_root).map_err(|error| format!("打开 Git 仓库失败：{error}"))?;
    let index = repository
        .index_or_empty()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;
    let rp = path_to_forward_slashes(relative_path);
    let path = gix::bstr::BStr::new(rp.as_bytes());
    Ok(index.entry_by_path(path).is_some())
}

pub(super) fn read_git_revision_text(
    repository_root: &Path,
    object_spec: &str,
) -> Result<Option<String>, String> {
    // 通过 gix 解析修订规格（如 `HEAD:path`）并读取 blob 内容（等价于 `git cat-file -p <spec>`），避免依赖系统安装的 git。
    let repository =
        gix::open(repository_root).map_err(|error| format!("打开 Git 仓库失败：{error}"))?;
    let object_id = match repository.rev_parse_single(object_spec) {
        Ok(id) => id,
        Err(_) => return Ok(None),
    };
    let object = match repository.find_object(object_id) {
        Ok(object) => object,
        Err(_) => return Ok(None),
    };
    if object.kind != gix::objs::Kind::Blob {
        return Ok(None);
    }
    decode_script_bytes(&object.data)
        .map(|(c, _)| Some(c))
        .map_err(|_| "当前对象不是可直接比较的文本内容。".to_string())
}

/// 提交前校验是否已配置 Git 提交身份（user.name / user.email）。
/// 缺失任一项时返回可读的中文错误，避免 gix 在创建提交时抛出难以理解的底层错误。
fn assert_git_identity_configured(repository: &Repository) -> Result<(), String> {
    let config = repository.config_snapshot();
    let name = config
        .string("user.name")
        .map(|value| value.to_str_lossy().trim().to_string())
        .unwrap_or_default();
    let email = config
        .string("user.email")
        .map(|value| value.to_str_lossy().trim().to_string())
        .unwrap_or_default();

    if name.is_empty() || email.is_empty() {
        return Err(
            "尚未配置 Git 提交身份：请设置 user.name 与 user.email（可在仓库的 .git/config 或全局 Git 配置中设置）后再提交。"
                .into(),
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 基于 gix 的索引辅助函数（供 stage / unstage / commit 使用）。
// 工作区 / 索引 / 树的通用读写操作集中在 super::worktree_io，经 `use super::worktree_io::*` 复用。
// ---------------------------------------------------------------------------

/// 打开可写的仓库索引；当 `.git/index` 文件尚不存在（新建 / 尚无提交的 unborn 仓库）时
/// 回退为内存中的空索引。
///
/// gix 的 `open_index()` 在索引文件缺失时会返回
/// "An IO error occurred while opening the index"。这里与本文件其它读路径使用的
/// `index_or_empty()` 语义保持一致，但返回可写的 `gix::index::File`，
/// 以便 stage / unstage / commit 修改后通过 `index.write(..)` 写回。
fn open_mut_index_or_empty(repository: &Repository) -> Result<gix::index::File, String> {
    let index_path = repository.git_dir().join("index");
    if index_path.exists() {
        repository
            .open_index()
            .map_err(|error| format!("读取 Git 索引失败：{error}"))
    } else {
        Ok(gix::index::File::from_state(
            gix::index::State::new(repository.object_hash()),
            index_path,
        ))
    }
}

/// 判断 pathspec 是否匹配候选相对路径：精确相等或作为目录前缀。
fn pathspec_matches(pathspec: &str, candidate: &str) -> bool {
    if candidate == pathspec {
        return true;
    }
    candidate
        .strip_prefix(pathspec)
        .is_some_and(|suffix| suffix.as_bytes().first() == Some(&b'/'))
}

/// 以 HEAD 树为基底，仅应用匹配 pathspec 的暂存改动，构建提交树（等价 `git commit -- <pathspec>` 的提交内容）。
fn build_tree_from_selected_index_paths(
    repository: &Repository,
    index: &gix::index::File,
    pathspecs: &[String],
) -> Result<gix::ObjectId, String> {
    let base_tree = repository.head_tree().ok();
    let empty_tree = repository.empty_tree();
    let mut editor = gix::object::tree::Editor::new(base_tree.as_ref().unwrap_or(&empty_tree))
        .map_err(|error| format!("创建树编辑器失败：{error}"))?;

    // 索引中的全部路径，用于匹配 pathspec（含目录前缀）。
    let index_paths: Vec<String> = index
        .entries()
        .iter()
        .map(|entry| entry.path(index).to_str_lossy().into_owned())
        .collect();

    let mut targets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for path in &index_paths {
        if pathspecs
            .iter()
            .any(|pathspec| pathspec_matches(pathspec, path))
        {
            targets.insert(path.clone());
        }
    }

    // 精确给出的 pathspec 即使索引中已不存在（已暂存删除）也需处理。
    for pathspec in pathspecs {
        let covered = index_paths
            .iter()
            .any(|path| pathspec_matches(pathspec, path));
        if !covered {
            targets.insert(pathspec.clone());
        }
    }

    for rel in &targets {
        let path = gix::bstr::BStr::new(rel.as_bytes());
        match index.entry_by_path(path) {
            Some(entry) => {
                editor
                    .upsert(
                        rel.as_str(),
                        tree_entry_kind_from_index_mode(entry.mode),
                        entry.id,
                    )
                    .map_err(|error| format!("写入树条目失败：{error}"))?;
            }
            None => {
                editor
                    .remove(rel.as_str())
                    .map_err(|error| format!("移除树条目失败：{error}"))?;
            }
        }
    }

    editor
        .write()
        .map(|id| id.detach())
        .map_err(|error| format!("写入树失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::pathspec_matches;

    #[test]
    fn pathspec_matches_exact_file() {
        assert!(pathspec_matches("src/app.rs", "src/app.rs"));
        assert!(!pathspec_matches("src/app.rs", "src/app.rs.bak"));
    }

    #[test]
    fn pathspec_matches_directory_prefix_without_allocating_separator() {
        assert!(pathspec_matches("src", "src/app.rs"));
        assert!(pathspec_matches("src", "src/nested/app.rs"));
        assert!(!pathspec_matches("src", "src-old/app.rs"));
        assert!(!pathspec_matches("src", "source/app.rs"));
    }

    #[test]
    fn pathspec_matches_nested_directory_boundary() {
        assert!(pathspec_matches(
            "src/components",
            "src/components/Button.vue"
        ));
        assert!(!pathspec_matches(
            "src/components",
            "src/components-old/Button.vue"
        ));
    }
}
