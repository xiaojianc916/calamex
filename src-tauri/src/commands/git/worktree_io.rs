use super::*;
use gix::bstr::ByteSlice;

// git 子模块共享的 gix 工作区 / 索引 / 树辅助函数。
// 此前 status / stash / revision / history 各自维护了一份逐字相同的副本
//（并自承认"修改时需同步更新"），现集中于此，避免重复与同步漂移。

/// 中性的树间文件变更条目，供各命令映射为各自的 payload（提交明细 / 贮藏明细等）。
pub(super) struct TreeFileChange {
    pub relative_path: String,
    pub file_name: String,
    pub previous_relative_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

/// 计算两棵树之间的文件级差异并逐文件统计增删行数（纯 gix，不依赖系统 git）。
pub(super) fn collect_tree_file_changes(
    repository: &Repository,
    old_tree_id: gix::ObjectId,
    new_tree_id: gix::ObjectId,
) -> Result<Vec<TreeFileChange>, String> {
    let old_tree = repository
        .find_tree(old_tree_id)
        .map_err(|error| format!("读取基线树失败：{error}"))?;
    let new_tree = repository
        .find_tree(new_tree_id)
        .map_err(|error| format!("读取目标树失败：{error}"))?;
    let changes = repository
        .diff_tree_to_tree(Some(&old_tree), Some(&new_tree), None)
        .map_err(|error| format!("计算树间差异失败：{error}"))?;

    let mut files = Vec::new();
    use gix::diff::tree_with_rewrites::Change;
    for change in changes {
        let (location, previous_location, old_id, new_id, base_status, entry_mode) = match change {
            Change::Addition {
                location,
                id,
                entry_mode,
                ..
            } => (location, None, None, Some(id), "added", entry_mode),
            Change::Deletion {
                location,
                id,
                entry_mode,
                ..
            } => (location, None, Some(id), None, "deleted", entry_mode),
            Change::Modification {
                location,
                previous_id,
                id,
                entry_mode,
                ..
            } => (
                location,
                None,
                Some(previous_id),
                Some(id),
                "modified",
                entry_mode,
            ),
            Change::Rewrite {
                source_location,
                location,
                source_id,
                id,
                entry_mode,
                ..
            } => (
                location,
                Some(source_location),
                Some(source_id),
                Some(id),
                "renamed",
                entry_mode,
            ),
        };

        if entry_mode.is_tree() || entry_mode.is_commit() {
            continue;
        }

        let old_bytes = old_id.and_then(|id| blob_bytes(repository, id));
        let new_bytes = new_id.and_then(|id| blob_bytes(repository, id));
        let (additions, deletions, is_binary) =
            count_blob_line_changes(old_bytes.as_deref(), new_bytes.as_deref());
        let status = if is_binary { "binary" } else { base_status }.to_string();

        let path_string = location.to_str_lossy().into_owned();
        let relative_path = Path::new(&path_string);
        let file_name = relative_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
            .unwrap_or_else(|| path_string.clone());
        let previous_relative_path = previous_location.map(|source| {
            let source = source.to_str_lossy().into_owned();
            path_to_forward_slashes(Path::new(&source))
        });

        files.push(TreeFileChange {
            relative_path: path_to_forward_slashes(relative_path),
            file_name,
            previous_relative_path,
            status,
            additions,
            deletions,
        });
    }
    Ok(files)
}

/// 读取对象库中某 blob 的原始字节。
pub(super) fn blob_bytes(repository: &Repository, object_id: gix::ObjectId) -> Option<Vec<u8>> {
    repository
        .find_object(object_id)
        .ok()
        .map(|object| object.data.clone())
}

/// 逐行统计两份内容的增删；任一侧含 NUL 字节则视为二进制（返回 0,0,true）。
fn count_blob_line_changes(old: Option<&[u8]>, new: Option<&[u8]>) -> (u32, u32, bool) {
    let is_binary =
        old.is_some_and(|bytes| bytes.contains(&0)) || new.is_some_and(|bytes| bytes.contains(&0));
    if is_binary {
        return (0, 0, true);
    }
    let old_text = old
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default();
    let new_text = new
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default();
    let diff = similar::TextDiff::from_lines(&old_text, &new_text);
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => additions = additions.saturating_add(1),
            similar::ChangeTag::Delete => deletions = deletions.saturating_add(1),
            similar::ChangeTag::Equal => {}
        }
    }
    (additions, deletions, false)
}

/// 工作区中是否存在该路径（含损坏的符号链接）。
pub(super) fn path_exists_in_worktree(absolute_path: &Path) -> bool {
    fs::symlink_metadata(absolute_path).is_ok()
}

/// 删除工作区中的文件（含损坏的符号链接）。
pub(super) fn remove_worktree_path(repository_root: &Path, relative_path: &str) {
    let target_path = repository_root.join(Path::new(relative_path));
    if fs::symlink_metadata(&target_path).is_ok() {
        let _ = fs::remove_file(&target_path);
    }
}

/// 将工作区文件内容写入对象库，返回 blob 的对象 ID。
pub(super) fn write_worktree_blob(
    repository: &Repository,
    absolute_path: &Path,
) -> Result<gix::ObjectId, String> {
    let metadata = fs::symlink_metadata(absolute_path)
        .map_err(|error| format!("读取文件元数据失败：{error}"))?;
    let bytes = if metadata.file_type().is_symlink() {
        // 符号链接：blob 内容即链接目标（使用正斜杠，匹配 Git 存储约定）。
        let target =
            fs::read_link(absolute_path).map_err(|error| format!("读取符号链接失败：{error}"))?;
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
pub(super) fn index_mode_for_worktree_file(
    absolute_path: &Path,
) -> Result<gix::index::entry::Mode, String> {
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

/// 将树条目模式映射为索引条目模式。
pub(super) fn index_mode_from_tree_mode(
    entry_mode: gix::objs::tree::EntryMode,
) -> gix::index::entry::Mode {
    use gix::index::entry::Mode;
    if entry_mode.is_link() {
        Mode::SYMLINK
    } else if entry_mode.is_executable() {
        Mode::FILE_EXECUTABLE
    } else {
        Mode::FILE
    }
}

/// 从索引移除某路径的所有条目（含各冲突阶段）。
pub(super) fn remove_index_path(index: &mut gix::index::File, relative_path: &str) {
    index.remove_entries(|_, entry_path, _| entry_path.to_str_lossy().as_ref() == relative_path);
}

/// 索引中是否存在该精确路径。
pub(super) fn index_has_path(index: &gix::index::File, relative_path: &str) -> bool {
    let path = gix::bstr::BStr::new(relative_path.as_bytes());
    index.entry_by_path(path).is_some()
}

/// 插入或替换 stage-0 的索引条目（先移除同路径旧条目）。
pub(super) fn upsert_index_entry(
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
pub(super) fn restore_worktree_from_index_blob(
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
        recreate_symlink(&target_path, &link_target)?;
    } else {
        if fs::symlink_metadata(&target_path).is_ok() {
            // 先移除既有文件 / 链接，避免写入时跟随旧符号链接。
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

#[cfg(unix)]
pub(super) fn recreate_symlink(target_path: &Path, link_target: &str) -> Result<(), String> {
    let _ = fs::remove_file(target_path);
    std::os::unix::fs::symlink(link_target, target_path)
        .map_err(|error| format!("创建符号链接失败：{error}"))
}

#[cfg(windows)]
pub(super) fn recreate_symlink(target_path: &Path, link_target: &str) -> Result<(), String> {
    // Windows 下退化为写入链接目标文本，避免符号链接权限问题。
    let _ = fs::remove_file(target_path);
    fs::write(target_path, link_target.as_bytes())
        .map_err(|error| format!("写入符号链接占位失败：{error}"))
}

/// 将整个索引内容构建为一棵树，返回树对象 ID（等价 `git write-tree`）。
pub(super) fn build_tree_from_full_index(
    repository: &Repository,
    index: &gix::index::File,
) -> Result<gix::ObjectId, String> {
    let empty_tree = repository.empty_tree();
    let mut editor = gix::object::tree::Editor::new(&empty_tree)
        .map_err(|error| format!("创建树编辑器失败：{error}"))?;

    for entry in index.entries() {
        let path = entry.path(index).to_str_lossy().into_owned();
        editor
            .upsert(
                path.as_str(),
                tree_entry_kind_from_index_mode(entry.mode),
                entry.id,
            )
            .map_err(|error| format!("写入树条目失败：{error}"))?;
    }

    editor
        .write()
        .map(|id| id.detach())
        .map_err(|error| format!("写入树失败：{error}"))
}

/// 将索引条目的文件模式映射为树条目类型。
pub(super) fn tree_entry_kind_from_index_mode(
    mode: gix::index::entry::Mode,
) -> gix::object::tree::EntryKind {
    use gix::index::entry::Mode;
    use gix::object::tree::EntryKind;
    if mode == Mode::SYMLINK {
        EntryKind::Link
    } else if mode == Mode::FILE_EXECUTABLE {
        EntryKind::BlobExecutable
    } else {
        EntryKind::Blob
    }
}
