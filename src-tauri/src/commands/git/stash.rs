use super::worktree_io::*;
use super::*;
use atomic_write_file::AtomicWriteFile;
use gix::bstr::ByteSlice;
use std::io::Write;

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

    // 基线提交（HEAD）。空仓库尚无提交时无法贮藏（与 git 行为一致）。
    let head_commit = resolve_head_commit(&repository)?
        .ok_or_else(|| "当前仓库尚无提交，无法贮藏改动。".to_string())?;
    let base_commit_id = head_commit.id().detach();
    let base_tree_id = head_commit
        .tree_id()
        .map_err(|error| format!("读取 HEAD 树失败：{error}"))?
        .detach();

    let branch_label = status
        .head_short_name
        .clone()
        .unwrap_or_else(|| "(no branch)".to_string());
    let base_short = short_commit_oid(&repository, base_commit_id);
    let raw_message = head_commit.message_raw_sloppy().to_str_lossy().into_owned();
    let base_subject = raw_message
        .lines()
        .next()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .unwrap_or("无提交说明")
        .to_string();

    // 贮藏说明：沿用 git 习惯，便于 list 解析分支名与短哈希。
    let stash_message = match payload.message.as_deref().map(str::trim) {
        Some(message) if !message.is_empty() => format!("On {branch_label}: {message}"),
        _ => format!("WIP on {branch_label}: {base_short} {base_subject}"),
    };

    // 构建工作区树（含已折叠的未跟踪文件，若启用）。
    let worktree_tree_id = build_worktree_tree(
        &repository,
        &repository_root,
        &status,
        payload.include_untracked,
    )?;
    if worktree_tree_id == base_tree_id {
        return Err("当前没有可贮藏的改动。".into());
    }

    // 提交者身份（用于贮藏提交与 reflog）。
    let committer = repository
        .committer()
        .ok_or_else(|| "尚未配置 Git 用户名与邮箱，无法创建贮藏。".to_string())?
        .map_err(|error| format!("读取提交者身份失败：{error}"))?;
    let seconds = jiff::Timestamp::now().as_second();
    let signature = gix::actor::Signature {
        name: committer.name.to_owned(),
        email: committer.email.to_owned(),
        time: gix::date::Time::new(seconds, 0),
    };

    // 仅以 HEAD 为父创建贮藏提交：本应用的明细/应用逻辑只依赖 ^1（基线）与提交树。
    let commit = gix::objs::Commit {
        tree: worktree_tree_id,
        parents: std::iter::once(base_commit_id).collect(),
        author: signature.clone(),
        committer: signature.clone(),
        encoding: None,
        message: stash_message.clone().into_bytes().into(),
        extra_headers: Vec::new(),
    };
    let stash_commit_id = repository
        .write_object(&commit)
        .map_err(|error| format!("写入贮藏提交失败：{error}"))?
        .detach();

    // 手动更新 refs/stash 与 logs/refs/stash（gix 默认不会为 refs/stash 建 reflog，
    // 而 list/drop 依赖该 reflog，故手动写入，且与现有 drop 的手改方式保持一致）。
    store_new_stash(
        &repository,
        stash_commit_id,
        &signature,
        seconds,
        &stash_message,
    )?;

    // 将工作区与索引恢复到 HEAD（等价 reset --hard + 清理已贮藏的未跟踪文件）。
    reset_worktree_to_head(
        &repository,
        &repository_root,
        &status,
        payload.include_untracked,
    )?;

    let repository = open_repository_from_root(&payload.repository_root_path)?;
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
    // 要求工作区干净，从而 ours 等于 HEAD 树，三方合并的 ours 端可直接取 HEAD。
    super::branches::assert_repository_is_clean_for_switch(&repository, label)?;

    let stash_oid = resolve_stash_oid(&repository, payload.stash_index)?;
    let stash = stash_oid.to_string();

    // 三方合并的三棵树：base = 贮藏基线(^1)，theirs = 贮藏树，ours = 当前 HEAD 树。
    let base_tree_id = repository
        .rev_parse_single([stash.as_str(), "^1^{tree}"].concat().as_str())
        .map(|id| id.detach())
        .map_err(|error| format!("解析贮藏基线树失败：{error}"))?;
    let theirs_tree_id = repository
        .rev_parse_single([stash.as_str(), "^{tree}"].concat().as_str())
        .map(|id| id.detach())
        .map_err(|error| format!("解析贮藏树失败：{error}"))?;
    let ours_tree_id = repository
        .head_tree()
        .map_err(|error| format!("读取 HEAD 树失败：{error}"))?
        .id()
        .detach();

    let conflicted = apply_stash_changes(
        &repository,
        &repository_root,
        base_tree_id,
        ours_tree_id,
        theirs_tree_id,
    )?;

    // pop 且无冲突时移除该贮藏；有冲突则保留（与 git pop 行为一致）。
    if payload.pop && !conflicted {
        drop_stash_by_index(&repository, payload.stash_index)?;
    }

    let repository = open_repository_from_root(&payload.repository_root_path)?;
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
        // 同步清理 packed-refs 中可能存在的 refs/stash，避免打包条目让贮藏“复活”。
        prune_packed_stash_ref(git_dir)?;
        return Ok(());
    }

    // refs/stash 指向最新一条（最后一行）的 new-oid。
    let newest = lines.last().unwrap();
    let new_oid = newest
        .split('\t')
        .next()
        .and_then(|meta| meta.split(' ').nth(1))
        .ok_or_else(|| "贮藏 reflog 格式异常。".to_string())?;
    write_stash_ref_atomically(&stash_ref_path, &[new_oid, "\n"].concat())?;

    let mut rebuilt = lines.join("\n");
    rebuilt.push('\n');
    rewrite_file_atomically(&reflog_path, &rebuilt, "写入贮藏 reflog 失败")?;
    // 松散 refs/stash 已更新；若该引用曾被打包进 packed-refs，移除打包条目避免其继续生效。
    prune_packed_stash_ref(git_dir)?;
    Ok(())
}

/// 原子改写整个文件：由 atomic-write-file 在同目录创建唯一临时文件并 commit 覆盖目标，
/// 避免写到一半导致文件损坏，也避免固定临时名在并发 / 重入时互相覆盖（与 branches / skills 一致）。
fn rewrite_file_atomically(path: &Path, content: &str, error_context: &str) -> Result<(), String> {
    let mut file = AtomicWriteFile::options()
        .open(path)
        .map_err(|error| format!("{error_context}：{error}"))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("{error_context}：{error}"))?;
    file.commit()
        .map_err(|error| format!("{error_context}：{error}"))
}

/// 原子写入 refs/stash（与 branches / skills 的原子写入惯例一致）。
fn write_stash_ref_atomically(stash_ref_path: &Path, content: &str) -> Result<(), String> {
    rewrite_file_atomically(stash_ref_path, content, "写入 refs/stash 失败")
}

/// 从 .git/packed-refs 中移除 refs/stash 行（若存在）。
/// drop/clear 仅改写松散引用 .git/refs/stash 与 reflog；若 refs/stash 曾被打包进
/// packed-refs，仅删除松散引用会让打包条目继续生效，导致已删除的贮藏“复活”。
/// 此处同步清理 packed-refs 中的 refs/stash 行（紧跟其后的 peeled "^" 行一并移除）。
fn prune_packed_stash_ref(git_dir: &Path) -> Result<(), String> {
    let packed_path = git_dir.join("packed-refs");
    let content = match fs::read_to_string(&packed_path) {
        Ok(content) => content,
        // 无 packed-refs 文件，无需处理。
        Err(_) => return Ok(()),
    };

    let mut changed = false;
    let mut output = String::with_capacity(content.len());
    let mut skip_peeled = false;
    for line in content.lines() {
        // peeled 值行以 '^' 开头，紧跟在其对应的 ref 行之后。
        if skip_peeled && line.starts_with('^') {
            skip_peeled = false;
            changed = true;
            continue;
        }
        skip_peeled = false;
        // 引用行格式：<oid> <refname>。
        let is_stash = line
            .split_once(' ')
            .map(|(_, name)| name.trim() == "refs/stash")
            .unwrap_or(false);
        if is_stash {
            changed = true;
            // 若下一行是该 ref 的 peeled 值，一并跳过。
            skip_peeled = true;
            continue;
        }
        output.push_str(line);
        output.push('\n');
    }

    if changed {
        rewrite_file_atomically(&packed_path, &output, "写入 packed-refs 失败")?;
    }
    Ok(())
}

fn build_git_stash_entry_payload(
    repository: &Repository,
    index: usize,
    summary: &str,
    oid: gix::ObjectId,
) -> Result<GitStashEntryPayload, String> {
    let (branch_name, commit_short_id) = parse_git_stash_name(summary);
    // 列表项只取廉价的提交时间。原先对每条 stash 都跑 rev_parse 三棵树 + 逐文件行级 diff
    // 统计增删/文件列表，但前端 stash 面板从不消费这些字段，纯属死计算（stash 多/改动大时
    // 拖慢面板首屏首次渲染），故移除；created_at 仅读提交时间，不含任何 diff。
    let created_at = repository
        .find_commit(oid)
        .ok()
        .and_then(|commit| commit.time().ok())
        .and_then(|time| jiff::Timestamp::from_second(time.seconds).ok())
        .unwrap_or_else(jiff::Timestamp::now)
        .to_string();
    Ok(GitStashEntryPayload {
        index,
        // stash@{N}：用字符串拼接构造字面花括号。
        stash_id: ["stash@{", &index.to_string(), "}"].concat(),
        summary: summary.to_string(),
        branch_name,
        commit_short_id: commit_short_id.or_else(|| Some(short_commit_oid(repository, oid))),
        created_at,
    })
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

// ---------------------------------------------------------------------------
// 纯 gix 贮藏保存 / 应用的辅助函数。
// ---------------------------------------------------------------------------

/// 解析第 `stash_index` 条贮藏（stash@{N}，0 = 最新）对应的提交 oid。
fn resolve_stash_oid(repository: &Repository, stash_index: usize) -> Result<gix::ObjectId, String> {
    let reflog_path = repository.git_dir().join("logs").join("refs").join("stash");
    let content = fs::read_to_string(&reflog_path).map_err(|_| "指定的贮藏不存在。".to_string())?;
    let lines: Vec<&str> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if stash_index >= lines.len() {
        return Err("指定的贮藏不存在。".into());
    }
    let line = lines[lines.len() - 1 - stash_index];
    let meta = line.split('\t').next().unwrap_or("");
    let new_oid = meta
        .split(' ')
        .nth(1)
        .ok_or_else(|| "贮藏 reflog 格式异常。".to_string())?;
    new_oid
        .parse()
        .map_err(|_| "贮藏 reflog 格式异常。".to_string())
}

/// 以当前索引为基底，叠加工作区实际内容，构建用于贮藏的「工作区树」。
/// 仅在内存中修改索引副本，不写回磁盘索引。
fn build_worktree_tree(
    repository: &Repository,
    repository_root: &Path,
    status: &GitRepositoryStatusPayload,
    include_untracked: bool,
) -> Result<gix::ObjectId, String> {
    let mut index = repository
        .open_index()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;

    for file in &status.files {
        let rel = file.relative_path.as_str();
        if file.is_untracked {
            if include_untracked {
                let absolute_path = repository_root.join(Path::new(rel));
                if path_exists_in_worktree(&absolute_path) {
                    let object_id = write_worktree_blob(repository, &absolute_path)?;
                    let mode = index_mode_for_worktree_file(&absolute_path)?;
                    upsert_index_entry(&mut index, rel, object_id, mode);
                }
            }
            continue;
        }
        match file.worktree_status.as_deref() {
            None => {}
            Some("deleted") => {
                remove_index_path(&mut index, rel);
            }
            Some(_) => {
                let absolute_path = repository_root.join(Path::new(rel));
                if path_exists_in_worktree(&absolute_path) {
                    let object_id = write_worktree_blob(repository, &absolute_path)?;
                    let mode = index_mode_for_worktree_file(&absolute_path)?;
                    upsert_index_entry(&mut index, rel, object_id, mode);
                } else {
                    remove_index_path(&mut index, rel);
                }
            }
        }
    }

    build_tree_from_full_index(repository, &index)
}

/// 将工作区与索引恢复到 HEAD（限定在贮藏涉及的路径），并删除已贮藏的未跟踪文件。
fn reset_worktree_to_head(
    repository: &Repository,
    repository_root: &Path,
    status: &GitRepositoryStatusPayload,
    include_untracked: bool,
) -> Result<(), String> {
    if include_untracked {
        for file in &status.files {
            if file.is_untracked {
                remove_worktree_path(repository_root, &file.relative_path);
            }
        }
    }

    let head_tree = repository
        .head_tree()
        .map_err(|error| format!("读取 HEAD 树失败：{error}"))?;
    let mut index = repository
        .open_index()
        .map_err(|error| format!("读取 Git 索引失败：{error}"))?;

    for file in &status.files {
        if file.is_untracked {
            continue;
        }
        let rel = file.relative_path.as_str();
        let head_entry = {
            let mut tree = head_tree.clone();
            tree.peel_to_entry_by_path(Path::new(rel)).ok().flatten()
        };
        match head_entry {
            Some(entry) => {
                let entry_mode = entry.mode();
                if entry_mode.is_tree() || entry_mode.is_commit() {
                    continue;
                }
                let object_id = entry.id().detach();
                let mode = index_mode_from_tree_mode(entry_mode);
                restore_worktree_from_index_blob(
                    repository,
                    repository_root,
                    rel,
                    object_id,
                    mode,
                )?;
                upsert_index_entry(&mut index, rel, object_id, mode);
            }
            None => {
                remove_worktree_path(repository_root, rel);
                remove_index_path(&mut index, rel);
            }
        }
    }

    index.sort_entries();
    index
        .write(gix::index::write::Options::default())
        .map_err(|error| format!("写入 Git 索引失败：{error}"))?;
    Ok(())
}

/// 手动写入 refs/stash 与 logs/refs/stash（gix 默认不会为 refs/stash 创建 reflog）。
fn store_new_stash(
    repository: &Repository,
    new_oid: gix::ObjectId,
    signature: &gix::actor::Signature,
    seconds: i64,
    message: &str,
) -> Result<(), String> {
    let git_dir = repository.git_dir();

    let refs_dir = git_dir.join("refs");
    fs::create_dir_all(&refs_dir).map_err(|error| format!("创建 refs 目录失败：{error}"))?;
    let stash_ref_path = refs_dir.join("stash");

    let old_oid = fs::read_to_string(&stash_ref_path)
        .ok()
        .map(|content| content.trim().to_string())
        .filter(|value| value.len() == 40 && value.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or_else(|| "0".repeat(40));

    let logs_dir = git_dir.join("logs").join("refs");
    fs::create_dir_all(&logs_dir).map_err(|error| format!("创建 reflog 目录失败：{error}"))?;
    let reflog_path = logs_dir.join("stash");
    let name = signature.name.to_str_lossy();
    let email = signature.email.to_str_lossy();
    // reflog 行格式：<old> <new> <name> <email> <ts> <tz>\t<message>
    let line = format!("{old_oid} {new_oid} {name} <{email}> {seconds} +0000\t{message}\n");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&reflog_path)
        .map_err(|error| format!("写入贮藏 reflog 失败：{error}"))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("写入贮藏 reflog 失败：{error}"))?;

    write_stash_ref_atomically(&stash_ref_path, &format!("{new_oid}\n"))?;
    Ok(())
}

/// 把贮藏（base→theirs）应用到当前工作区（ours == HEAD，已确认干净）。返回是否产生冲突。
fn apply_stash_changes(
    repository: &Repository,
    repository_root: &Path,
    base_tree_id: gix::ObjectId,
    ours_tree_id: gix::ObjectId,
    theirs_tree_id: gix::ObjectId,
) -> Result<bool, String> {
    let base_tree = repository
        .find_tree(base_tree_id)
        .map_err(|error| format!("读取贮藏基线树失败：{error}"))?;
    let theirs_tree = repository
        .find_tree(theirs_tree_id)
        .map_err(|error| format!("读取贮藏树失败：{error}"))?;
    let ours_tree = repository
        .find_tree(ours_tree_id)
        .map_err(|error| format!("读取 HEAD 树失败：{error}"))?;

    let changes = repository
        .diff_tree_to_tree(Some(&base_tree), Some(&theirs_tree), None)
        .map_err(|error| format!("计算贮藏差异失败：{error}"))?;

    let mut conflicted = false;
    let mut conflict_index: Option<gix::index::File> = None;

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
                match tree_entry_at(&ours_tree, &path) {
                    None => {
                        write_blob_to_worktree(repository, repository_root, &path, id, entry_mode)?;
                    }
                    Some((ours_id, _)) if ours_id == id => {}
                    Some((ours_id, ours_mode)) => {
                        record_conflict(
                            repository,
                            &mut conflict_index,
                            &path,
                            None,
                            Some((ours_id, ours_mode)),
                            Some((id, entry_mode)),
                        )?;
                        conflicted = true;
                    }
                }
            }
            Change::Deletion {
                location,
                id,
                entry_mode,
                ..
            } => {
                if entry_mode.is_tree() || entry_mode.is_commit() {
                    continue;
                }
                let path = location.to_str_lossy().into_owned();
                match tree_entry_at(&ours_tree, &path) {
                    None => {}
                    Some((ours_id, _)) if ours_id == id => {
                        remove_worktree_path(repository_root, &path);
                    }
                    Some((ours_id, ours_mode)) => {
                        record_conflict(
                            repository,
                            &mut conflict_index,
                            &path,
                            Some((id, entry_mode)),
                            Some((ours_id, ours_mode)),
                            None,
                        )?;
                        conflicted = true;
                    }
                }
            }
            Change::Modification {
                location,
                previous_id,
                id,
                entry_mode,
                ..
            } => {
                if entry_mode.is_tree() || entry_mode.is_commit() {
                    continue;
                }
                let path = location.to_str_lossy().into_owned();
                match tree_entry_at(&ours_tree, &path) {
                    None => {
                        write_blob_to_worktree(repository, repository_root, &path, id, entry_mode)?;
                        record_conflict(
                            repository,
                            &mut conflict_index,
                            &path,
                            Some((previous_id, entry_mode)),
                            None,
                            Some((id, entry_mode)),
                        )?;
                        conflicted = true;
                    }
                    Some((ours_id, _)) if ours_id == previous_id => {
                        write_blob_to_worktree(repository, repository_root, &path, id, entry_mode)?;
                    }
                    Some((ours_id, _)) if ours_id == id => {}
                    Some((ours_id, ours_mode)) => {
                        match try_text_merge(repository, previous_id, ours_id, id) {
                            TextMerge::Clean(bytes) => {
                                write_bytes_to_worktree(
                                    repository_root,
                                    &path,
                                    &bytes,
                                    entry_mode,
                                )?;
                            }
                            TextMerge::Conflicted(bytes) => {
                                write_bytes_to_worktree(
                                    repository_root,
                                    &path,
                                    &bytes,
                                    entry_mode,
                                )?;
                                record_conflict(
                                    repository,
                                    &mut conflict_index,
                                    &path,
                                    Some((previous_id, entry_mode)),
                                    Some((ours_id, ours_mode)),
                                    Some((id, entry_mode)),
                                )?;
                                conflicted = true;
                            }
                            TextMerge::Binary => {
                                record_conflict(
                                    repository,
                                    &mut conflict_index,
                                    &path,
                                    Some((previous_id, entry_mode)),
                                    Some((ours_id, ours_mode)),
                                    Some((id, entry_mode)),
                                )?;
                                conflicted = true;
                            }
                        }
                    }
                }
            }
            // base→theirs 的重命名：贮藏基于工作区快照，通常不会产生重命名检测；
            // 保守起见标记为冲突，提示用户手动处理。
            Change::Rewrite { .. } => {
                conflicted = true;
            }
        }
    }

    if let Some(mut index) = conflict_index {
        index.sort_entries();
        index
            .write(gix::index::write::Options::default())
            .map_err(|error| format!("写入 Git 索引失败：{error}"))?;
    }

    Ok(conflicted)
}

/// 在树中查找指定路径的条目，返回（对象 ID，文件模式）。
fn tree_entry_at(
    tree: &gix::Tree<'_>,
    relative_path: &str,
) -> Option<(gix::ObjectId, gix::objs::tree::EntryMode)> {
    let mut tree = tree.clone();
    tree.peel_to_entry_by_path(Path::new(relative_path))
        .ok()
        .flatten()
        .map(|entry| (entry.id().detach(), entry.mode()))
}

/// 将对象库中的 blob 写回工作区（按树条目模式）。
fn write_blob_to_worktree(
    repository: &Repository,
    repository_root: &Path,
    relative_path: &str,
    object_id: gix::ObjectId,
    entry_mode: gix::objs::tree::EntryMode,
) -> Result<(), String> {
    let mode = index_mode_from_tree_mode(entry_mode);
    restore_worktree_from_index_blob(repository, repository_root, relative_path, object_id, mode)
}

/// 将合并后的原始字节写入工作区文件。
fn write_bytes_to_worktree(
    repository_root: &Path,
    relative_path: &str,
    bytes: &[u8],
    entry_mode: gix::objs::tree::EntryMode,
) -> Result<(), String> {
    let target_path = repository_root.join(Path::new(relative_path));
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    if fs::symlink_metadata(&target_path).is_ok() {
        let _ = fs::remove_file(&target_path);
    }
    fs::write(&target_path, bytes).map_err(|error| format!("写入工作区文件失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if entry_mode.is_executable() {
            let _ = fs::set_permissions(&target_path, fs::Permissions::from_mode(0o755));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = entry_mode;
    }
    Ok(())
}

/// 向索引写入指定阶段（stage 1/2/3）的冲突条目。
fn push_stage_entry(
    index: &mut gix::index::File,
    relative_path: &str,
    object_id: gix::ObjectId,
    mode: gix::index::entry::Mode,
    stage: u32,
) {
    use gix::index::entry::{Flags, Stat};
    let path = gix::bstr::BStr::new(relative_path.as_bytes());
    // 低 12 位为 path-length（上限 0xFFF），stage 占 12–13 位。
    let raw = (relative_path.len().min(0xFFF) as u32) | (stage << 12);
    let flags = Flags::from_bits_retain(raw as _);
    index.dangerously_push_entry(Stat::default(), object_id, flags, mode, path);
}

/// 记录一个路径的冲突：移除 stage-0 后写入 base/ours/theirs 各阶段。
fn record_conflict(
    repository: &Repository,
    conflict_index: &mut Option<gix::index::File>,
    relative_path: &str,
    base: Option<(gix::ObjectId, gix::objs::tree::EntryMode)>,
    ours: Option<(gix::ObjectId, gix::objs::tree::EntryMode)>,
    theirs: Option<(gix::ObjectId, gix::objs::tree::EntryMode)>,
) -> Result<(), String> {
    if conflict_index.is_none() {
        let index = repository
            .open_index()
            .map_err(|error| format!("读取 Git 索引失败：{error}"))?;
        *conflict_index = Some(index);
    }
    let index = conflict_index.as_mut().unwrap();
    remove_index_path(index, relative_path);
    if let Some((id, mode)) = base {
        push_stage_entry(index, relative_path, id, index_mode_from_tree_mode(mode), 1);
    }
    if let Some((id, mode)) = ours {
        push_stage_entry(index, relative_path, id, index_mode_from_tree_mode(mode), 2);
    }
    if let Some((id, mode)) = theirs {
        push_stage_entry(index, relative_path, id, index_mode_from_tree_mode(mode), 3);
    }
    Ok(())
}

enum TextMerge {
    Clean(Vec<u8>),
    Conflicted(Vec<u8>),
    Binary,
}

/// 尝试对三个 blob 做文本三方合并；任一侧含 NUL 字节则视为二进制。
fn try_text_merge(
    repository: &Repository,
    base_id: gix::ObjectId,
    ours_id: gix::ObjectId,
    theirs_id: gix::ObjectId,
) -> TextMerge {
    let base = blob_bytes(repository, base_id).unwrap_or_default();
    let ours = blob_bytes(repository, ours_id).unwrap_or_default();
    let theirs = blob_bytes(repository, theirs_id).unwrap_or_default();
    if base.contains(&0) || ours.contains(&0) || theirs.contains(&0) {
        return TextMerge::Binary;
    }
    let base_text = String::from_utf8_lossy(&base).into_owned();
    let ours_text = String::from_utf8_lossy(&ours).into_owned();
    let theirs_text = String::from_utf8_lossy(&theirs).into_owned();
    match diffy_imara::merge(&base_text, &ours_text, &theirs_text) {
        Ok(merged) => TextMerge::Clean(merged.into_bytes()),
        Err(conflicted) => TextMerge::Conflicted(conflicted.into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 创建一个唯一的临时目录充当 .git 目录（纯 std，不引入额外依赖）。
    fn make_temp_git_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "calamex-stash-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp git dir");
        path
    }

    #[test]
    fn prune_packed_stash_ref_removes_stash_entry_and_peeled_line() {
        let git_dir = make_temp_git_dir("prune-stash");
        let packed_path = git_dir.join("packed-refs");
        fs::write(
            &packed_path,
            "# pack-refs with: peeled fully-peeled sorted\n\
             1111111111111111111111111111111111111111 refs/heads/main\n\
             2222222222222222222222222222222222222222 refs/stash\n\
             ^3333333333333333333333333333333333333333\n\
             4444444444444444444444444444444444444444 refs/tags/v1\n",
        )
        .expect("write packed-refs");

        prune_packed_stash_ref(&git_dir).expect("prune packed refs/stash");

        let rebuilt = fs::read_to_string(&packed_path).expect("read packed-refs");
        // refs/stash 行及其紧随的 peeled "^" 行都应被移除。
        assert!(!rebuilt.contains("refs/stash"));
        assert!(!rebuilt.contains('^'));
        // 其余引用应原样保留。
        assert!(rebuilt.contains("refs/heads/main"));
        assert!(rebuilt.contains("refs/tags/v1"));

        let _ = fs::remove_dir_all(&git_dir);
    }

    #[test]
    fn prune_packed_stash_ref_is_noop_when_packed_refs_absent() {
        let git_dir = make_temp_git_dir("prune-missing");
        // 没有 packed-refs 文件时应安全返回 Ok 而不报错。
        prune_packed_stash_ref(&git_dir).expect("prune without packed-refs");
        let _ = fs::remove_dir_all(&git_dir);
    }
}
