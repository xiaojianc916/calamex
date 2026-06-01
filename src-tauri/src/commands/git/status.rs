use super::*;
use super::cli;
use crate::commands::workspace_fs::workspace_name;
use gix::bstr::ByteSlice;

#[tauri::command]
pub fn get_git_repository_status(
    workspace_root_path: Option<String>,
) -> Result<GitRepositoryStatusPayload, String> {
    let workspace_root = resolve_git_workspace_root(workspace_root_path)?;
    match gix::discover(&workspace_root) {
        Ok(repository) => build_git_repository_status_payload(&repository),
        Err(_) => Ok(build_unavailable_git_status("当前工作区未检测到 Git 仓库。")),
    }
}

#[tauri::command]
pub fn init_git_repository(
    workspace_root_path: Option<String>,
) -> Result<GitRepositoryStatusPayload, String> {
    let workspace_root = resolve_git_workspace_root(workspace_root_path)?;
    match gix::open(&workspace_root) {
        Ok(repository) => build_git_repository_status_payload(&repository),
        Err(_) => {
            gix::init(&workspace_root).map_err(|e| format!("初始化 Git 仓库失败：{e}"))?;
            let repository = gix::open(&workspace_root).map_err(|e| format!("读取初始化后的 Git 仓库失败：{e}"))?;
            build_git_repository_status_payload(&repository)
        }
    }
}

#[tauri::command]
pub fn get_git_file_baseline(path: String) -> Result<GitFileBaselinePayload, String> {
    let file_path = normalize_path_for_git(Path::new(&path));
    let discovery_root = file_path.parent().unwrap_or(file_path.as_path());
    match gix::discover(discovery_root) {
        Ok(repository) => build_git_file_baseline_payload(&repository, &file_path),
        Err(_) => Ok(GitFileBaselinePayload {
            available: false, message: Some("当前文件不在 Git 仓库中。".into()),
            repository_root_path: None, file_path: path, relative_path: None,
            is_tracked: false, content: None,
        }),
    }
}

#[tauri::command]
pub fn stage_git_paths(payload: GitPathOperationRequest) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() { return build_git_repository_status_payload(&repository); }

    // 通过 gix 计算当前状态，得到所有可暂存的变更文件（已遵循 .gitignore），
    // 避免依赖系统安装的 git（等价 `git add -- <pathspec>`）。
    let status = build_git_status_via_gix(&repository)?;
    let mut index = repository
        .open_index()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;
    let mut changed = false;

    for file in &status.files {
        let rel = file.relative_path.as_str();
        if !pathspecs.iter().any(|pathspec| pathspec_matches(pathspec, rel)) {
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
pub fn unstage_git_paths(payload: GitPathOperationRequest) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() { return build_git_repository_status_payload(&repository); }

    let mut index = repository
        .open_index()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;

    // 收集需要重置的路径：索引中匹配 pathspec 的条目，以及精确给出的 pathspec
    //（覆盖「已暂存删除」——HEAD 有、索引无的情况）。
    let mut targets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in index.entries() {
        let entry_path = entry.path(&index).to_str_lossy().into_owned();
        if pathspecs.iter().any(|pathspec| pathspec_matches(pathspec, &entry_path)) {
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
pub fn commit_git_index(payload: GitCommitRequest) -> Result<GitCommitResultPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    let message = payload.message.trim();
    if message.is_empty() { return Err("Git 提交说明不能为空。".into()); }
    let mut arg_list = vec!["commit", "-m", message];
    if !pathspecs.is_empty() {
        arg_list.push("--");
        let ps_refs: Vec<&str> = pathspecs.iter().map(|s| s.as_str()).collect();
        arg_list.extend_from_slice(&ps_refs);
    }
    cli::run_git_ok(&repository_root, &arg_list, "提交")?;
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let commit_id = resolve_head_commit(&repository).ok().flatten().map(|commit| commit.id().to_string());
    let status = build_git_repository_status_payload(&repository)?;
    Ok(GitCommitResultPayload { status, commit_id })
}

#[tauri::command]
pub fn discard_git_paths(payload: GitPathOperationRequest) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() { return build_git_repository_status_payload(&repository); }

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

    let last_commit = resolve_head_commit(repository).ok().flatten().map(|c| build_git_commit_summary(&c));

    Ok(GitRepositoryStatusPayload {
        available: true, message: None,
        repository_root_path: Some(repository_root.to_string_lossy().to_string()),
        repository_name: Some(workspace_name(&repository_root)),
        git_dir_path: Some(repository.git_dir().to_string_lossy().to_string()),
        head_branch_name: status.head_branch,
        head_short_name: status.head_short_name,
        head_short_oid: status.head_oid.as_deref().map(|oid| oid.chars().take(7).collect::<String>()),
        is_detached: status.detached,
        is_clean: status.staged_count == 0 && status.unstaged_count == 0 && status.untracked_count == 0,
        ahead: status.ahead, behind: status.behind,
        staged_count: status.staged_count, unstaged_count: status.unstaged_count,
        untracked_count: status.untracked_count, conflicted_count: status.conflicted_count,
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
        head_branch: None, head_short_name: None, head_oid: None, detached: false,
        ahead: 0, behind: 0,
        staged_count: 0, unstaged_count: 0, untracked_count: 0, conflicted_count: 0,
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
    let abs = repository_root.join(relative_path).to_string_lossy().to_string();
    (abs, rps, file_name)
}

fn status_entry_mut<'a>(
    repository_root: &Path,
    files: &'a mut std::collections::BTreeMap<String, GitFileStatusPayload>,
    rel: &str,
) -> &'a mut GitFileStatusPayload {
    let (abs, rps, file_name) = build_status_paths(repository_root, rel);
    files.entry(rps.clone()).or_insert_with(|| GitFileStatusPayload {
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
        ChangeRef::Rewrite { source_location, copy, .. } => {
            entry.index_status = Some(if *copy { "copied" } else { "renamed" }.to_string());
            let source = source_location.to_str_lossy().into_owned();
            let source_path = Path::new(&source);
            entry.previous_relative_path = Some(path_to_forward_slashes(source_path));
            entry.previous_path =
                Some(repository_root.join(source_path).to_string_lossy().to_string());
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
        available: false, message: Some(message.into()),
        repository_root_path: None, repository_name: None, git_dir_path: None,
        head_branch_name: None, head_short_name: None, head_short_oid: None,
        is_detached: false, is_clean: true,
        ahead: 0, behind: 0,
        staged_count: 0, unstaged_count: 0, untracked_count: 0, conflicted_count: 0,
        files: Vec::new(), last_commit: None,
    }
}

fn build_git_file_baseline_payload(repository: &Repository, file_path: &Path) -> Result<GitFileBaselinePayload, String> {
    let repository_root = resolve_repository_root(repository)?;
    let relative_path = resolve_relative_path(&repository_root, file_path)?;
    let relative_path_string = path_to_forward_slashes(&relative_path);
    let is_tracked = is_tracked_git_path(&repository_root, &relative_path)?;
    if !is_tracked {
        return Ok(GitFileBaselinePayload {
            available: true, message: Some("当前文件未被 Git 跟踪。".into()),
            repository_root_path: Some(repository_root.to_string_lossy().to_string()),
            file_path: file_path.to_string_lossy().to_string(),
            relative_path: Some(relative_path_string), is_tracked: false, content: None,
        });
    }
    let object_spec = format!("HEAD:{relative_path_string}");
    let content = read_git_revision_text(&repository_root, &object_spec)?;
    Ok(GitFileBaselinePayload {
        available: true,
        message: if content.is_none() { Some("当前文件基线不是可直接比较的文本内容。".into()) } else { None },
        repository_root_path: Some(repository_root.to_string_lossy().to_string()),
        file_path: file_path.to_string_lossy().to_string(),
        relative_path: Some(relative_path_string), is_tracked: true, content,
    })
}

pub(super) fn is_tracked_git_path(repository_root: &Path, relative_path: &Path) -> Result<bool, String> {
    // 通过 gix 查询索引判断路径是否被 Git 跟踪（等价于 `git ls-files --error-unmatch`），避免依赖系统安装的 git。
    let repository = gix::open(repository_root)
        .map_err(|error| format!("打开 Git 仓库失败：{error}"))?;
    let index = repository
        .index_or_empty()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;
    let rp = path_to_forward_slashes(relative_path);
    let path = gix::bstr::BStr::new(rp.as_bytes());
    Ok(index.entry_by_path(path).is_some())
}

pub(super) fn read_git_revision_text(repository_root: &Path, object_spec: &str) -> Result<Option<String>, String> {
    // 通过 gix 解析修订规格（如 `HEAD:path`）并读取 blob 内容（等价于 `git cat-file -p <spec>`），避免依赖系统安装的 git。
    let repository = gix::open(repository_root)
        .map_err(|error| format!("打开 Git 仓库失败：{error}"))?;
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

// ---------------------------------------------------------------------------
// 基于 gix 的索引 / 工作区写操作辅助函数（供 stage / unstage / discard 使用）。
// ---------------------------------------------------------------------------

/// 判断 pathspec 是否匹配候选相对路径：精确相等或作为目录前缀。
fn pathspec_matches(pathspec: &str, candidate: &str) -> bool {
    candidate == pathspec || candidate.starts_with(&format!("{pathspec}/"))
}

/// 工作区中是否存在该路径（含损坏的符号链接）。
fn path_exists_in_worktree(absolute_path: &Path) -> bool {
    fs::symlink_metadata(absolute_path).is_ok()
}

/// 将工作区文件内容写入对象库，返回 blob 的对象 ID。
fn write_worktree_blob(repository: &Repository, absolute_path: &Path) -> Result<gix::ObjectId, String> {
    let metadata = fs::symlink_metadata(absolute_path)
        .map_err(|error| format!("读取文件元数据失败：{error}"))?;
    let bytes = if metadata.file_type().is_symlink() {
        // 符号链接：blob 内容即链接目标（使用正斜杠，匹配 Git 存储约定）。
        let target = fs::read_link(absolute_path)
            .map_err(|error| format!("读取符号链接失败：{error}"))?;
        target.to_string_lossy().replace('\\', "/").into_bytes()
    } else {
        fs::read(absolute_path).map_err(|error| format!("读取工作区文件失败：{error}"))?
    };
    repository
        .write_blob(bytes)
        .map(|id| id.detach())
        .map_err(|error| format!("写入 Git blob 失败：{error}"))
}

/// 依据工作区文件类型推断索引条目的文件模式。
fn index_mode_for_worktree_file(absolute_path: &Path) -> Result<gix::index::entry::Mode, String> {
    use gix::index::entry::Mode;
    let metadata = fs::symlink_metadata(absolute_path)
        .map_err(|error| format!("读取文件元数据失败：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Ok(Mode::SYMLINK);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return Ok(Mode::FILE_EXECUTABLE);
        }
    }
    Ok(Mode::FILE)
}

/// 从索引移除某路径的所有条目（含各冲突阶段）。
fn remove_index_path(index: &mut gix::index::File, relative_path: &str) {
    index.remove_entries(|_, entry_path, _| entry_path.to_str_lossy().as_ref() == relative_path);
}

/// 索引中是否存在该精确路径。
fn index_has_path(index: &gix::index::File, relative_path: &str) -> bool {
    let path = gix::bstr::BStr::new(relative_path.as_bytes());
    index.entry_by_path(path).is_some()
}

/// 插入或替换 stage-0 的索引条目（先移除同路径旧条目）。
fn upsert_index_entry(
    index: &mut gix::index::File,
    relative_path: &str,
    object_id: gix::ObjectId,
    mode: gix::index::entry::Mode,
) {
    use gix::index::entry::{Flags, Stat};
    remove_index_path(index, relative_path);
    let path = gix::bstr::BStr::new(relative_path.as_bytes());
    // path-length 存放于 flags 低 12 位（上限 0xFFF），stage 为 0。
    let flags = Flags::from_bits_retain(relative_path.len().min(0xFFF) as _);
    index.dangerously_push_entry(Stat::default(), object_id, flags, mode, path);
}

/// 将索引中记录的 blob 内容写回工作区文件（等价 `git checkout -- <path>`）。
fn restore_worktree_from_index_blob(
    repository: &Repository,
    repository_root: &Path,
    relative_path: &str,
    object_id: gix::ObjectId,
    mode: gix::index::entry::Mode,
) -> Result<(), String> {
    use gix::index::entry::Mode;
    let object = repository
        .find_object(object_id)
        .map_err(|error| format!("读取 Git 对象失败：{error}"))?;
    let bytes = object.data;
    let target_path = repository_root.join(Path::new(relative_path));
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    if mode == Mode::SYMLINK {
        let link_target = String::from_utf8_lossy(&bytes).into_owned();
        recreate_symlink(&target_path, &link_target)?;
    } else {
        if fs::symlink_metadata(&target_path).is_ok() {
            // 先移除既有文件 / 链接，避免写入时跟随旧符号链接。
            let _ = fs::remove_file(&target_path);
        }
        fs::write(&target_path, &bytes).map_err(|error| format!("写入工作区文件失败：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if mode == Mode::FILE_EXECUTABLE {
                let _ = fs::set_permissions(&target_path, fs::Permissions::from_mode(0o755));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn recreate_symlink(target_path: &Path, link_target: &str) -> Result<(), String> {
    let _ = fs::remove_file(target_path);
    std::os::unix::fs::symlink(link_target, target_path)
        .map_err(|error| format!("创建符号链接失败：{error}"))
}

#[cfg(windows)]
fn recreate_symlink(target_path: &Path, link_target: &str) -> Result<(), String> {
    // Windows 下退化为写入链接目标文本，避免符号链接权限问题。
    let _ = fs::remove_file(target_path);
    fs::write(target_path, link_target.as_bytes())
        .map_err(|error| format!("写入符号链接占位失败：{error}"))
}
