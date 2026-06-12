//! 提交级别的变更操作：检出（已在 branches.rs 实现）、回滚。
//!
//! `revert_git_commit` 等价于 `git revert --no-commit <commit>`：
//! 把目标提交 C 的改动反向应用到工作区与索引，让用户自行检查后提交。
//! 前提：工作区干净（等价于 ours == HEAD == base），因此所有改动均可无冲突落地。
use super::*;
use gix::bstr::ByteSlice;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRevertRequest {
    repository_root_path: String,
    commit_id: String,
}

/// 回滚指定提交：把该提交的改动反向应用到工作区与索引（等价 `git revert --no-commit`）。
/// 要求工作区干净；结果以「已暂存」状态呈现，用户检查后可直接提交。
#[tauri::command]
#[specta::specta]
pub fn revert_git_commit(
    payload: GitCommitRevertRequest,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    super::branches::assert_repository_is_clean_for_switch(&repository, "回滚提交")?;

    let object_id: gix::ObjectId = payload
        .commit_id
        .trim()
        .parse()
        .map_err(|_| "无效的提交 ID。".to_string())?;
    let commit = repository
        .find_commit(object_id)
        .map_err(|error| format!("读取提交对象失败：{error}"))?;

    let parent_ids: Vec<gix::ObjectId> = commit.parent_ids().map(|id| id.detach()).collect();
    if parent_ids.len() > 1 {
        return Err("暂不支持回滚合并提交（存在多个父提交）。".into());
    }

    // base 树 = 目标提交 C 的树。
    let base_tree_id = commit
        .tree_id()
        .map_err(|error| format!("读取提交树失败：{error}"))?
        .detach();

    // theirs 树 = C 的父提交 P 的树；根提交无父则取空树。
    let theirs_tree_id = match parent_ids.first() {
        Some(parent) => repository
            .find_commit(*parent)
            .map_err(|error| format!("读取父提交失败：{error}"))?
            .tree_id()
            .map_err(|error| format!("读取父提交树失败：{error}"))?
            .detach(),
        None => repository.empty_tree().id().detach(),
    };

    // diff(C → P) 就是该提交的反向改动。工作区干净 → 可全部无冲突落地。
    let base_tree = repository
        .find_tree(base_tree_id)
        .map_err(|error| format!("读取提交树失败：{error}"))?;
    let theirs_tree = repository
        .find_tree(theirs_tree_id)
        .map_err(|error| format!("读取目标树失败：{error}"))?;

    let mut changes = repository
        .diff_tree_to_tree(Some(&base_tree), Some(&theirs_tree), None)
        .map_err(|error| format!("计算回滚差异失败：{error}"))?;
    // 先删后加，避免 file ↔ directory 类路径冲突。
    changes.sort_by_key(revert_change_order);

    let mut index = repository
        .open_index()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;

    use gix::diff::tree_with_rewrites::Change;
    for change in changes {
        match change {
            Change::Addition {
                location,
                id,
                entry_mode,
                ..
            } => {
                if entry_mode.is_tree() || entry_mode.is_commit() {
                    continue;
                }
                let path = location.to_str_lossy().into_owned();
                let mode = revert_resolve_mode(entry_mode);
                revert_write_blob(&repository, &repository_root, &path, id, mode)?;
                revert_upsert_index(&mut index, &path, id, mode);
            }
            Change::Deletion { location, .. } => {
                let path = location.to_str_lossy().into_owned();
                revert_remove_worktree(&repository_root, &path);
                revert_remove_index(&mut index, &path);
            }
            Change::Modification {
                location,
                id,
                entry_mode,
                ..
            } => {
                if entry_mode.is_tree() || entry_mode.is_commit() {
                    continue;
                }
                let path = location.to_str_lossy().into_owned();
                let mode = revert_resolve_mode(entry_mode);
                revert_write_blob(&repository, &repository_root, &path, id, mode)?;
                revert_upsert_index(&mut index, &path, id, mode);
            }
            Change::Rewrite {
                source_location,
                location,
                id,
                entry_mode,
                ..
            } => {
                let source = source_location.to_str_lossy().into_owned();
                revert_remove_worktree(&repository_root, &source);
                revert_remove_index(&mut index, &source);
                if !(entry_mode.is_tree() || entry_mode.is_commit()) {
                    let path = location.to_str_lossy().into_owned();
                    let mode = revert_resolve_mode(entry_mode);
                    revert_write_blob(&repository, &repository_root, &path, id, mode)?;
                    revert_upsert_index(&mut index, &path, id, mode);
                }
            }
        }
    }

    index.sort_entries();
    index
        .write(gix::index::write::Options::default())
        .map_err(|error| format!("写入 Git 索引失败：{error}"))?;

    let repository = open_repository_from_root(&payload.repository_root_path)?;
    super::status::build_git_repository_status_payload(&repository)
}

fn revert_change_order(change: &gix::diff::tree_with_rewrites::Change) -> u8 {
    use gix::diff::tree_with_rewrites::Change;
    match change {
        Change::Deletion { .. } => 0,
        Change::Rewrite { .. } => 1,
        _ => 2,
    }
}

fn revert_resolve_mode(entry_mode: gix::objs::tree::EntryMode) -> gix::index::entry::Mode {
    use gix::index::entry::Mode;
    if entry_mode.is_link() {
        Mode::SYMLINK
    } else if entry_mode.is_executable() {
        Mode::FILE_EXECUTABLE
    } else {
        Mode::FILE
    }
}

/// blob 写入工作区（兼容符号链接与可执行位）。
fn revert_write_blob(
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
    let target = repository_root.join(Path::new(relative_path));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    if mode == Mode::SYMLINK {
        let link_target = String::from_utf8_lossy(bytes).into_owned();
        let _ = fs::remove_file(&target);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&link_target, &target)
            .map_err(|error| format!("创建符号链接失败：{error}"))?;
        #[cfg(windows)]
        fs::write(&target, link_target.as_bytes())
            .map_err(|error| format!("写入符号链接占位失败：{error}"))?;
    } else {
        let _ = fs::remove_file(&target);
        fs::write(&target, bytes).map_err(|error| format!("写入工作区文件失败：{error}"))?;
        #[cfg(unix)]
        if mode == Mode::FILE_EXECUTABLE {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
        }
    }
    Ok(())
}

/// 从工作区删除指定路径（忽略不存在的情况）。
fn revert_remove_worktree(repository_root: &Path, relative_path: &str) {
    let target = repository_root.join(Path::new(relative_path));
    if fs::symlink_metadata(&target).is_ok() {
        let _ = fs::remove_file(&target);
    }
}

/// 插入或替换 stage-0 索引条目。
fn revert_upsert_index(
    index: &mut gix::index::File,
    relative_path: &str,
    object_id: gix::ObjectId,
    mode: gix::index::entry::Mode,
) {
    use gix::index::entry::{Flags, Stat};
    revert_remove_index(index, relative_path);
    let path = gix::bstr::BStr::new(relative_path.as_bytes());
    let flags = Flags::from_bits_retain(relative_path.len().min(0xFFF) as _);
    index.dangerously_push_entry(Stat::default(), object_id, flags, mode, path);
}

/// 从索引中移除指定路径的所有条目（含冲突阶段）。
fn revert_remove_index(index: &mut gix::index::File, relative_path: &str) {
    index.remove_entries(|_, entry_path, _| entry_path.to_str_lossy().as_ref() == relative_path);
}
