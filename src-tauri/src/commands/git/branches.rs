use super::*;
use gix::bstr::ByteSlice;

#[tauri::command]
#[specta::specta]
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
        // 跳过无法实例化的无效引用：例如被误放进 .git/refs 下的杂项文件
        // （如脚本文件 refs/untitled.sh）。单个坏引用不应导致整个分支列表读取
        // 失败，这与 `git branch` 自身遇到无效松散引用时的容错行为一致。
        let reference = match reference {
            Ok(reference) => reference,
            Err(_) => continue,
        };
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
#[specta::specta]
pub fn checkout_git_branch(
    payload: GitBranchCheckoutRequest,
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
    assert_repository_is_clean_for_switch(&repository, "切换分支")?;

    // 通过 gix 切换工作区 / 索引 / HEAD，避免依赖系统安装的 git（免装目标）。
    checkout_to_target(&repository, &repository_root, branch_name)?;

    let repository = open_repository_from_root(&payload.repository_root_path)?;
    super::status::build_git_repository_status_payload(&repository)
}

#[tauri::command]
#[specta::specta]
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

    // 通过 gix 直接创建分支引用，避免依赖系统安装的 git（免装目标）。
    let head_target = repository
        .head_id()
        .map_err(|error| format!("读取 HEAD 失败：{error}"))?
        .detach();
    repository
        .reference(
            format!("refs/heads/{branch_name}"),
            head_target,
            gix::refs::transaction::PreviousValue::MustNotExist,
            "branch: created from HEAD",
        )
        .map_err(|error| format!("创建分支失败：{branch_name}（{error}）"))?;

    if payload.checkout {
        checkout_to_target(&repository, &repository_root, branch_name)?;
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
        upstream_name,
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
    // 通过 gix 读取分支上游配置（branch.<name>.remote / branch.<name>.merge），
    // 拼出形如 "origin/main" 的上游短名，避免依赖系统安装的 git。
    let repository = gix::open(repository_root).ok()?;
    let config = repository.config_snapshot();

    let remote = config.string(format!("branch.{branch_name}.remote").as_str())?;
    let merge = config.string(format!("branch.{branch_name}.merge").as_str())?;

    let remote = remote.to_str_lossy();
    let remote = remote.trim();
    let merge = merge.to_str_lossy();
    let merge_branch = merge
        .strip_prefix("refs/heads/")
        .unwrap_or_else(|| merge.as_ref())
        .trim();

    if remote.is_empty() || merge_branch.is_empty() {
        return None;
    }
    Some(format!("{remote}/{merge_branch}"))
}

pub(super) fn resolve_ahead_behind_cli(
    repository_root: &Path,
    branch_name: &str,
) -> Result<(usize, usize), String> {
    // 比较「该分支」与「它自己的上游」，而不是当前 HEAD 的上游。
    // 通过 gix 的修订遍历计算 ahead/behind，等价于
    // `git rev-list --count --left-right <branch>...<upstream>`，避免依赖系统安装的 git。
    let repository = gix::open(repository_root)
        .map_err(|error| format!("打开 Git 仓库失败：{error}"))?;

    let local_id = match repository.rev_parse_single(branch_name) {
        Ok(id) => id.detach(),
        Err(_) => return Ok((0, 0)),
    };

    let upstream_name = match resolve_branch_upstream(repository_root, branch_name) {
        Some(name) => name,
        None => return Ok((0, 0)),
    };
    let upstream_id = match repository.rev_parse_single(upstream_name.as_str()) {
        Ok(id) => id.detach(),
        Err(_) => return Ok((0, 0)),
    };

    // ahead：本地分支可达、但上游不可达的提交数。
    let ahead = repository
        .rev_walk(Some(local_id))
        .with_hidden(Some(upstream_id))
        .selected(|_| true)
        .map_err(|error| format!("计算领先提交数失败：{error}"))?
        .count();

    // behind：上游可达、但本地分支不可达的提交数。
    let behind = repository
        .rev_walk(Some(upstream_id))
        .with_hidden(Some(local_id))
        .selected(|_| true)
        .map_err(|error| format!("计算落后提交数失败：{error}"))?
        .count();

    Ok((ahead, behind))
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

// ---------------------------------------------------------------------------
// 基于 gix 的分支 / 提交切换实现（移除对系统安装 git 的依赖）。
//
// 前置条件：调用方已通过 `assert_repository_is_clean_for_switch` 确认工作区干净
// （无暂存 / 未暂存 / 未跟踪改动），此时索引与工作区都等于 HEAD 树。这里只需把
// 「HEAD 树 → 目标树」的差异应用到工作区与索引，再移动 HEAD 即可，既快又不会
// 破坏未跟踪文件（干净前提下不存在未跟踪文件）。
//
// 下列 checkout_restore_worktree_blob / checkout_upsert_index_entry /
// checkout_remove_index_path / checkout_recreate_symlink 与 status.rs 中的同名
// 实现保持一致；因 Rust 模块私有可见性此处保留一份本地副本，修改时应同步两处。
// ---------------------------------------------------------------------------

fn checkout_to_target(
    repository: &Repository,
    repository_root: &Path,
    target_name: &str,
) -> Result<(), String> {
    let target_name = target_name.trim();
    if target_name.is_empty() {
        return Err("切换目标不能为空。".into());
    }

    // 解析目标提交（用于分离 HEAD）与目标树。
    let target_commit_id = repository
        .rev_parse_single(target_name)
        .map_err(|error| format!("解析切换目标失败：{target_name}（{error}）"))?
        .detach();
    // peel 到 tree 的修订语法需要字面花括号 "^{tree}"，用字符串拼接构造。
    let target_tree_id = repository
        .rev_parse_single([target_name, "^{tree}"].concat().as_str())
        .map_err(|error| format!("解析目标树失败：{target_name}（{error}）"))?
        .detach();

    let old_tree = repository
        .head_tree()
        .map_err(|error| format!("读取 HEAD 树失败：{error}"))?;
    let new_tree = repository
        .find_tree(target_tree_id)
        .map_err(|error| format!("读取目标树失败：{error}"))?;

    let mut changes = repository
        .diff_tree_to_tree(Some(&old_tree), Some(&new_tree), None)
        .map_err(|error| format!("计算切换差异失败：{error}"))?;
    // 先删除、后写入，避免「文件 ↔ 目录」互换时父目录冲突。
    changes.sort_by_key(checkout_change_order);

    let mut index = repository
        .open_index()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;
    for change in changes {
        apply_checkout_change(repository, repository_root, &mut index, change)?;
    }
    index.sort_entries();
    index
        .write(gix::index::write::Options::default())
        .map_err(|error| format!("写入 Git 索引失败：{error}"))?;

    checkout_update_head(repository, target_name, target_commit_id)
}

/// 差异处理顺序：删除(0) → 重命名(1) → 新增/修改(2)。
fn checkout_change_order(change: &gix::diff::tree_with_rewrites::Change) -> u8 {
    use gix::diff::tree_with_rewrites::Change;
    match change {
        Change::Deletion { .. } => 0,
        Change::Rewrite { .. } => 1,
        _ => 2,
    }
}

/// 把单条树差异应用到工作区与索引。
fn apply_checkout_change(
    repository: &Repository,
    repository_root: &Path,
    index: &mut gix::index::File,
    change: gix::diff::tree_with_rewrites::Change,
) -> Result<(), String> {
    use gix::diff::tree_with_rewrites::Change;
    use gix::index::entry::Mode;

    match change {
        Change::Addition { location, entry_mode, id, .. }
        | Change::Modification { location, entry_mode, id, .. } => {
            if entry_mode.is_tree() || entry_mode.is_commit() {
                return Ok(());
            }
            let mode = if entry_mode.is_link() {
                Mode::SYMLINK
            } else if entry_mode.is_executable() {
                Mode::FILE_EXECUTABLE
            } else {
                Mode::FILE
            };
            let path = location.to_str_lossy().into_owned();
            checkout_restore_worktree_blob(repository, repository_root, &path, id, mode)?;
            checkout_upsert_index_entry(index, &path, id, mode);
        }
        Change::Deletion { location, .. } => {
            let path = location.to_str_lossy().into_owned();
            checkout_remove_worktree_path(repository_root, &path);
            checkout_remove_index_path(index, &path);
        }
        Change::Rewrite { source_location, location, entry_mode, id, .. } => {
            let source = source_location.to_str_lossy().into_owned();
            checkout_remove_worktree_path(repository_root, &source);
            checkout_remove_index_path(index, &source);
            if !(entry_mode.is_tree() || entry_mode.is_commit()) {
                let mode = if entry_mode.is_link() {
                    Mode::SYMLINK
                } else if entry_mode.is_executable() {
                    Mode::FILE_EXECUTABLE
                } else {
                    Mode::FILE
                };
                let path = location.to_str_lossy().into_owned();
                checkout_restore_worktree_blob(repository, repository_root, &path, id, mode)?;
                checkout_upsert_index_entry(index, &path, id, mode);
            }
        }
    }
    Ok(())
}

/// 移动 HEAD：目标为本地分支则写符号引用（`ref: refs/heads/<name>`），
/// 否则写入提交 ID 进入分离 HEAD。直接改写 `<git_dir>/HEAD`，避免依赖系统安装的 git。
fn checkout_update_head(
    repository: &Repository,
    target_name: &str,
    target_commit_id: gix::ObjectId,
) -> Result<(), String> {
    let local_ref = format!("refs/heads/{target_name}");
    let is_local_branch = repository.rev_parse_single(local_ref.as_str()).is_ok();
    let content = if is_local_branch {
        format!("ref: {local_ref}\n")
    } else {
        format!("{target_commit_id}\n")
    };
    let git_dir = repository.git_dir();
    let head_path = git_dir.join("HEAD");
    // 原子写入：先写入同目录临时文件，再 rename 覆盖目标，避免进程在写一半时
    // 崩溃导致 .git/HEAD 被截断/损坏（同一文件系统内 rename 是原子操作）。
    let temp_path = git_dir.join("HEAD.calamex.tmp");
    fs::write(&temp_path, content).map_err(|error| format!("更新 HEAD 失败：{error}"))?;
    fs::rename(&temp_path, &head_path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("更新 HEAD 失败：{error}")
    })
}

/// 从工作区删除某路径（忽略不存在的情况）。
fn checkout_remove_worktree_path(repository_root: &Path, relative_path: &str) {
    let target_path = repository_root.join(Path::new(relative_path));
    if fs::symlink_metadata(&target_path).is_ok() {
        let _ = fs::remove_file(&target_path);
    }
}

/// 将对象库中的 blob 写回工作区文件（含符号链接与可执行位处理）。
fn checkout_restore_worktree_blob(
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
    let bytes = object.data.as_slice();
    let target_path = repository_root.join(Path::new(relative_path));
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    if mode == Mode::SYMLINK {
        let link_target = String::from_utf8_lossy(bytes).into_owned();
        checkout_recreate_symlink(&target_path, &link_target)?;
    } else {
        if fs::symlink_metadata(&target_path).is_ok() {
            let _ = fs::remove_file(&target_path);
        }
        fs::write(&target_path, bytes).map_err(|error| format!("写入工作区文件失败：{error}"))?;
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

/// 插入或替换 stage-0 的索引条目（先移除同路径旧条目）。
fn checkout_upsert_index_entry(
    index: &mut gix::index::File,
    relative_path: &str,
    object_id: gix::ObjectId,
    mode: gix::index::entry::Mode,
) {
    use gix::index::entry::{Flags, Stat};
    checkout_remove_index_path(index, relative_path);
    let path = gix::bstr::BStr::new(relative_path.as_bytes());
    // path-length 存放于 flags 低 12 位（上限 0xFFF），stage 为 0。
    let flags = Flags::from_bits_retain(relative_path.len().min(0xFFF) as _);
    index.dangerously_push_entry(Stat::default(), object_id, flags, mode, path);
}

/// 从索引移除某路径的所有条目（含各冲突阶段）。
fn checkout_remove_index_path(index: &mut gix::index::File, relative_path: &str) {
    index.remove_entries(|_, entry_path, _| entry_path.to_str_lossy().as_ref() == relative_path);
}

#[cfg(unix)]
fn checkout_recreate_symlink(target_path: &Path, link_target: &str) -> Result<(), String> {
    let _ = fs::remove_file(target_path);
    std::os::unix::fs::symlink(link_target, target_path)
        .map_err(|error| format!("创建符号链接失败：{error}"))
}

#[cfg(windows)]
fn checkout_recreate_symlink(target_path: &Path, link_target: &str) -> Result<(), String> {
    // Windows 下退化为写入链接目标文本，避免符号链接权限问题。
    let _ = fs::remove_file(target_path);
    fs::write(target_path, link_target.as_bytes())
        .map_err(|error| format!("写入符号链接占位失败：{error}"))
}
