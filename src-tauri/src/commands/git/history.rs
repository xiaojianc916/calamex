use super::*;
use super::worktree_io::collect_tree_file_changes;
use gix::bstr::ByteSlice;
use std::collections::HashMap;

// 提交历史改用 gix 遍历实现，不再依赖系统 git。
// 通过 `rev_walk` + `Sorting::ByCommitTime(NewestFirst)` 按提交时间倒序遍历，
// 等价于 `git log`（最新在前）。时间取自 Info.commit_time（提交时间，秒）。

/// 空字符串回退为占位标签，否则原样转为 String。
fn or_label(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

#[tauri::command]
#[specta::specta]
pub fn list_git_commit_history(
    payload: GitCommitHistoryRequest,
) -> Result<GitCommitHistoryPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    if resolve_head_commit(&repository)?.is_none() {
        return Ok(GitCommitHistoryPayload {
            entries: Vec::new(),
            has_more: false,
            next_offset: None,
        });
    }

    let offset = payload.offset.unwrap_or(0);
    let limit = payload
        .limit
        .unwrap_or(DEFAULT_GIT_HISTORY_LIMIT)
        .clamp(1, MAX_GIT_HISTORY_LIMIT);

    let head_id = repository
        .head_id()
        .map_err(|error| format!("读取 HEAD 失败：{error}"))?
        .detach();

    let walk = repository
        .rev_walk(Some(head_id))
        .sorting(gix::revision::walk::Sorting::ByCommitTime(
            gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
        ))
        .all()
        .map_err(|error| format!("遍历提交历史失败：{error}"))?;

    // 预先聚合分支 / 远程分支引用装饰，按提交 ID 标注（如 main、origin/main）。
    let decorations = build_ref_decorations(&repository);

    let mut entries = Vec::new();
    let mut has_more = false;

    for (index, item) in walk.enumerate() {
        if index < offset {
            continue;
        }
        if entries.len() >= limit {
            has_more = true;
            break;
        }

        let info = item.map_err(|error| format!("读取提交失败：{error}"))?;
        let commit = repository
            .find_commit(info.id)
            .map_err(|error| format!("读取提交对象失败：{error}"))?;

        let full_id = info.id.to_string();
        let short_id = commit
            .short_id()
            .map(|prefix| prefix.to_string())
            .unwrap_or_else(|_| full_id.chars().take(7).collect());

        let summary_raw = commit
            .message()
            .map_err(|error| format!("解析提交信息失败：{error}"))?
            .title
            .to_string();
        let summary = summary_raw.trim();

        let (author_name_raw, author_email) = commit
            .author()
            .map(|author| (author.name.to_string(), author.email.to_string()))
            .unwrap_or_default();
        let author_name = author_name_raw.trim();

        let authored_at = info
            .commit_time
            .and_then(|seconds| jiff::Timestamp::from_second(seconds).ok())
            .map(|timestamp| timestamp.to_string())
            .unwrap_or_default();

        let parent_ids = commit
            .parent_ids()
            .map(|id| id.detach().to_string())
            .collect::<Vec<_>>();
        let refs = decorations.get(&full_id).cloned().unwrap_or_default();

        entries.push(GitCommitSummaryPayload {
            id: full_id,
            short_id,
            summary: or_label(summary, "无提交说明"),
            author_name: or_label(author_name, "未知作者"),
            author_email,
            authored_at,
            parent_ids,
            refs,
        });
    }

    Ok(GitCommitHistoryPayload {
        entries,
        has_more,
        next_offset: has_more.then_some(offset + limit),
    })
}

/// 读取单个提交的详细信息（用于历史悬浮卡片）：提交元数据 + 相对首个父提交的
/// 文件/行变更聚合（文件数、插入、删除）。根提交对空树取差异。
#[tauri::command]
#[specta::specta]
pub fn get_git_commit_detail(
    payload: GitCommitDetailRequest,
) -> Result<GitCommitDetailPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;

    let object_id: gix::ObjectId = payload
        .commit_id
        .trim()
        .parse()
        .map_err(|_| "无效的提交 ID。".to_string())?;
    let commit = repository
        .find_commit(object_id)
        .map_err(|error| format!("读取提交对象失败：{error}"))?;

    let full_id = commit.id().to_string();
    let short_id = commit
        .short_id()
        .map(|prefix| prefix.to_string())
        .unwrap_or_else(|_| full_id.chars().take(7).collect());

    let message = commit
        .message()
        .map_err(|error| format!("解析提交信息失败：{error}"))?;
    let summary_raw = message.title.to_string();
    let summary = summary_raw.trim();
    let body = message
        .body
        .map(|body| body.to_string().trim().to_string())
        .unwrap_or_default();

    let (author_name_raw, author_email) = commit
        .author()
        .map(|author| (author.name.to_string(), author.email.to_string()))
        .unwrap_or_default();
    let author_name = author_name_raw.trim();

    let authored_at = commit
        .time()
        .ok()
        .and_then(|time| jiff::Timestamp::from_second(time.seconds).ok())
        .map(|timestamp| timestamp.to_string())
        .unwrap_or_default();

    let parent_ids = commit
        .parent_ids()
        .map(|id| id.detach().to_string())
        .collect::<Vec<_>>();

    let decorations = build_ref_decorations(&repository);
    let refs = decorations.get(&full_id).cloned().unwrap_or_default();

    let new_tree_id = commit
        .tree_id()
        .map_err(|error| format!("读取提交树失败：{error}"))?
        .detach();
    let old_tree_id = match commit.parent_ids().next() {
        Some(parent) => repository
            .find_commit(parent.detach())
            .map_err(|error| format!("读取父提交失败：{error}"))?
            .tree_id()
            .map_err(|error| format!("读取父提交树失败：{error}"))?
            .detach(),
        None => repository.empty_tree().id().detach(),
    };

    let files: Vec<GitCommitFileChangePayload> =
        collect_tree_file_changes(&repository, old_tree_id, new_tree_id)?
            .into_iter()
            .map(|change| GitCommitFileChangePayload {
                relative_path: change.relative_path,
                file_name: change.file_name,
                previous_relative_path: change.previous_relative_path,
                status: change.status,
                additions: change.additions,
                deletions: change.deletions,
            })
            .collect();
    let file_count = files.len();
    let additions = files
        .iter()
        .fold(0u32, |acc, file| acc.saturating_add(file.additions));
    let deletions = files
        .iter()
        .fold(0u32, |acc, file| acc.saturating_add(file.deletions));

    Ok(GitCommitDetailPayload {
        id: full_id,
        short_id,
        summary: or_label(summary, "无提交说明"),
        body,
        author_name: or_label(author_name, "未知作者"),
        author_email,
        authored_at,
        parent_ids,
        refs,
        file_count,
        additions,
        deletions,
        files,
    })
}

/// 枚举本地分支与远程分支引用，按其指向的提交 ID 聚合装饰标签。
/// 用于在提交历史中标注 `main`、`origin/main` 等引用，等价于 `git log --decorate` 的分支部分。
fn build_ref_decorations(repository: &Repository) -> HashMap<String, Vec<GitCommitRefPayload>> {
    let mut decorations: HashMap<String, Vec<GitCommitRefPayload>> = HashMap::new();

    // 当前 HEAD 指向的引用全名（如 "refs/heads/main"），用于标注 is_head。
    let head_ref_name = repository
        .head_ref()
        .ok()
        .flatten()
        .map(|head_ref| head_ref.name().as_bstr().to_str_lossy().into_owned());

    let Ok(platform) = repository.references() else {
        return decorations;
    };
    let Ok(references) = platform.all() else {
        return decorations;
    };

    for reference in references {
        let Ok(reference) = reference else {
            continue;
        };
        let full_ref_name = reference.name().as_bstr().to_str_lossy().into_owned();
        let (kind, shorthand) = match reference.name().category_and_short_name() {
            Some((gix::refs::Category::LocalBranch, short)) => {
                ("localBranch", short.to_str_lossy().into_owned())
            }
            Some((gix::refs::Category::RemoteBranch, short)) => {
                ("remoteBranch", short.to_str_lossy().into_owned())
            }
            _ => continue,
        };

        // 跳过远程符号 HEAD（如 origin/HEAD），它只是默认分支的别名。
        if kind == "remoteBranch" && shorthand.ends_with("/HEAD") {
            continue;
        }

        let is_head = head_ref_name.as_deref() == Some(full_ref_name.as_str());
        let commit_id = reference.id().detach().to_string();

        decorations
            .entry(commit_id)
            .or_default()
            .push(GitCommitRefPayload {
                name: shorthand,
                kind: kind.to_string(),
                is_head,
            });
    }

    decorations
}
