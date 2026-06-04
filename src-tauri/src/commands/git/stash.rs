use super::cli;
use super::*;
use gix::bstr::ByteSlice;

#[tauri::command]
#[specta::specta]
pub fn list_git_stashes(payload: GitRepositoryRootRequest) -> Result<GitStashListPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;

    // 直接读取贮藏栈的 reflog（.git/logs/refs/stash），避免依赖系统安装的 git。
    // 该文件按追加顺序记录（最旧在前），stash@索引 0 为最新，因此倒序枚举。
    let reflog_path = repository.git_dir().join("logs").join("refs").join("stash");
    if !reflog_path.exists() {
        return Ok(GitStashListPayload {
            entries: Vec::new(),
        });
    }
    let content = fs::read_to_string(&reflog_path)
        .map_err(|error| format!("读取贮藏 reflog 失败：{error}"))?;

    let lines: Vec<&str> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let mut entries = Vec::new();
    for (index, line) in lines.iter().rev().enumerate() {
        let line = *line;
        // 每行格式：<old> <new> <name> <email> <ts> <tz>\t<message>
        let (meta, message) = match line.split_once('\t') {
            Some(pair) => pair,
            None => continue,
        };
        let mut tokens = meta.split(' ');
        let _old = tokens.next();
        let new_oid = match tokens.next() {
            Some(value) => value,
            None => continue,
        };
        let oid: gix::ObjectId = match new_oid.parse() {
            Ok(value) => value,
            Err(_) => continue,
        };
        entries.push(build_git_stash_entry_payload(
            &repository,
            index,
            message.trim(),
            oid,
        )?);
    }
    Ok(GitStashListPayload { entries })
}

#[tauri::command]
#[specta::specta]
pub fn save_git_stash(payload: GitStashSaveRequest) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let status = super::status::build_git_repository_status_payload(&repository)?;
    if status.is_clean {
        return Err("当前没有可贮藏的改动。".into());
    }
    if status.conflicted_count > 0 {
        return Err("存在冲突文件，解决冲突后再执行贮藏。".into());
    }

    let mut args = vec!["stash", "push"];
    if payload.include_untracked {
        args.push("--include-untracked");
    }
    if let Some(ref message) = payload.message {
        let msg = message.trim();
        if !msg.is_empty() {
            args.push("--message");
            args.push(msg);
        }
    }
    cli::run_git_ok(&repository_root, &args, "保存贮藏")?;
    super::status::build_git_repository_status_payload(&repository)
}

#[tauri::command]
#[specta::specta]
pub fn apply_git_stash(
    payload: GitStashApplyRequest,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let label = if payload.pop {
        "应用并移除贮藏"
    } else {
        "应用贮藏"
    };
    super::branches::assert_repository_is_clean_for_switch(&repository, label)?;

    // stash@{N}：用字符串拼接构造字面花括号。
    let stash_ref = ["stash@{", &payload.stash_index.to_string(), "}"].concat();
    let args = if payload.pop {
        vec!["stash", "pop", &stash_ref]
    } else {
        vec!["stash", "apply", &stash_ref]
    };
    cli::run_git_ok(&repository_root, &args, label)?;

    super::status::build_git_repository_status_payload(&repository)
}

#[tauri::command]
#[specta::specta]
pub fn drop_git_stash(payload: GitStashDropRequest) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    drop_stash_by_index(&repository, payload.stash_index)?;
    super::status::build_git_repository_status_payload(&repository)
}

/// 删除贮藏栈中第 `target_index` 条（stash@{N}，0 = 最新）。
/// 直接改写 .git/logs/refs/stash（reflog）与 .git/refs/stash，避免依赖系统安装的 git。
fn drop_stash_by_index(repository: &Repository, target_index: usize) -> Result<(), String> {
    let git_dir = repository.git_dir();
    let reflog_path = git_dir.join("logs").join("refs").join("stash");
    let content = fs::read_to_string(&reflog_path).map_err(|_| "指定的贮藏不存在。".to_string())?;

    let mut lines: Vec<String> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect();

    // reflog 按追加顺序记录（最旧在前），stash@{0} 为最新（最后一行）。
    if target_index >= lines.len() {
        return Err("指定的贮藏不存在。".into());
    }
    let remove_position = lines.len() - 1 - target_index;
    let removed_line = lines.remove(remove_position);

    // 维持 reflog 链：被删行的后继行（现位于 remove_position）的 old-oid
    // 应承接被删行的 old-oid，保证 line[i].old == line[i-1].new。
    if remove_position < lines.len() {
        let removed_old = removed_line.split(' ').next().unwrap_or("");
        if !removed_old.is_empty() {
            let successor = lines[remove_position].clone();
            if let Some((_, rest)) = successor.split_once(' ') {
                lines[remove_position] = [removed_old, " ", rest].concat();
            }
        }
    }

    let stash_ref_path = git_dir.join("refs").join("stash");
    if lines.is_empty() {
        // 贮藏栈清空：移除 ref 与 reflog。
        let _ = fs::remove_file(&stash_ref_path);
        let _ = fs::remove_file(&reflog_path);
        return Ok(());
    }

    // refs/stash 指向最新一条（最后一行）的 new-oid。
    let newest = lines.last().unwrap();
    let new_oid = newest
        .split('\t')
        .next()
        .and_then(|meta| meta.split(' ').nth(1))
        .ok_or_else(|| "贮藏 reflog 格式异常。".to_string())?;
    fs::write(&stash_ref_path, [new_oid, "\n"].concat())
        .map_err(|error| format!("写入 refs/stash 失败：{error}"))?;

    let mut rebuilt = lines.join("\n");
    rebuilt.push('\n');
    fs::write(&reflog_path, rebuilt).map_err(|error| format!("写入贮藏 reflog 失败：{error}"))?;
    Ok(())
}

fn build_git_stash_entry_payload(
    repository: &Repository,
    index: usize,
    summary: &str,
    oid: gix::ObjectId,
) -> Result<GitStashEntryPayload, String> {
    let details = build_git_stash_details(repository, oid)?;
    let (branch_name, commit_short_id) = parse_git_stash_name(summary);
    Ok(GitStashEntryPayload {
        index,
        // stash@{N}：用字符串拼接构造字面花括号。
        stash_id: ["stash@{", &index.to_string(), "}"].concat(),
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

/// 通过 gix 解析贮藏提交的差异，构建明细（增删行数 + 文件列表），避免依赖系统安装的 git。
///
/// 贮藏提交 W 的父结构：parent1 = 贮藏时的基线提交、parent2 = 索引快照、
/// parent3 = 未跟踪文件快照（仅 --include-untracked 时存在）。明细等价于
/// `git stash show --include-untracked`：基线树 → 工作区树 的跟踪改动，
/// 外加未跟踪树中的全部文件（视为新增）。
fn build_git_stash_details(
    repository: &Repository,
    oid: gix::ObjectId,
) -> Result<GitStashDetails, String> {
    let created_at = repository
        .find_commit(oid)
        .ok()
        .and_then(|commit| commit.time().ok())
        .and_then(|time| jiff::Timestamp::from_second(time.seconds).ok())
        .unwrap_or_else(jiff::Timestamp::now)
        .to_string();

    let stash = oid.to_string();
    // peel 到 tree 的修订语法需要字面花括号 "^{tree}"，用字符串拼接构造。
    let worktree_tree_id = repository
        .rev_parse_single([stash.as_str(), "^{tree}"].concat().as_str())
        .map_err(|error| format!("解析贮藏树失败：{error}"))?
        .detach();
    let base_tree_id = repository
        .rev_parse_single([stash.as_str(), "^1^{tree}"].concat().as_str())
        .ok()
        .map(|id| id.detach());
    let untracked_tree_id = repository
        .rev_parse_single([stash.as_str(), "^3^{tree}"].concat().as_str())
        .ok()
        .map(|id| id.detach());

    let mut files = Vec::new();
    // 跟踪改动：基线树 → 工作区树。
    if let Some(base_id) = base_tree_id {
        collect_stash_tree_changes(repository, base_id, worktree_tree_id, &mut files)?;
    }
    // 未跟踪文件：空树 → 未跟踪树（全部视为新增）。
    if let Some(untracked_id) = untracked_tree_id {
        let empty_tree_id = repository.empty_tree().id().detach();
        collect_stash_tree_changes(repository, empty_tree_id, untracked_id, &mut files)?;
    }

    let file_count = files.len();
    let additions = files
        .iter()
        .fold(0u32, |acc, file| acc.saturating_add(file.additions));
    let deletions = files
        .iter()
        .fold(0u32, |acc, file| acc.saturating_add(file.deletions));

    Ok(GitStashDetails {
        created_at,
        file_count,
        additions,
        deletions,
        files,
    })
}

/// 计算两棵树之间的文件级差异，逐个文件统计增删行数后追加到 `files`。
fn collect_stash_tree_changes(
    repository: &Repository,
    old_tree_id: gix::ObjectId,
    new_tree_id: gix::ObjectId,
    files: &mut Vec<GitStashFilePayload>,
) -> Result<(), String> {
    let old_tree = repository
        .find_tree(old_tree_id)
        .map_err(|error| format!("读取贮藏基线树失败：{error}"))?;
    let new_tree = repository
        .find_tree(new_tree_id)
        .map_err(|error| format!("读取贮藏目标树失败：{error}"))?;
    let changes = repository
        .diff_tree_to_tree(Some(&old_tree), Some(&new_tree), None)
        .map_err(|error| format!("计算贮藏差异失败：{error}"))?;

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

        // 目录 / 子模块项不计入文件改动。
        if entry_mode.is_tree() || entry_mode.is_commit() {
            continue;
        }

        let old_bytes = old_id.and_then(|id| stash_blob_bytes(repository, id));
        let new_bytes = new_id.and_then(|id| stash_blob_bytes(repository, id));
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

        files.push(GitStashFilePayload {
            relative_path: path_to_forward_slashes(relative_path),
            file_name,
            previous_relative_path,
            status,
            additions,
            deletions,
        });
    }
    Ok(())
}

/// 读取 blob 对象的原始字节；对象缺失时返回 None。
fn stash_blob_bytes(repository: &Repository, object_id: gix::ObjectId) -> Option<Vec<u8>> {
    repository
        .find_object(object_id)
        .ok()
        .map(|object| object.data.clone())
}

/// 统计两段 blob 内容之间的增删行数；任一侧含 NUL 字节则视为二进制（返回 0/0 + true）。
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

struct GitStashDetails {
    created_at: String,
    file_count: usize,
    additions: u32,
    deletions: u32,
    files: Vec<GitStashFilePayload>,
}

fn parse_git_stash_name(name: &str) -> (Option<String>, Option<String>) {
    let trimmed = name.trim();
    if let Some(rest) = trimmed.strip_prefix("WIP on ")
        && let Some((branch_name, remainder)) = rest.split_once(':')
    {
        let commit_short_id = remainder
            .split_whitespace()
            .next()
            .filter(|value| is_short_git_commit_id(value))
            .map(str::to_string);
        return (Some(branch_name.trim().to_string()), commit_short_id);
    }
    if let Some(rest) = trimmed.strip_prefix("On ")
        && let Some((branch_name, _)) = rest.split_once(':')
    {
        return (Some(branch_name.trim().to_string()), None);
    }
    (None, None)
}

fn is_short_git_commit_id(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}
