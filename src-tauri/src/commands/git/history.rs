use super::*;

// 提交历史改用 gix 遍历实现，不再依赖系统 git。
// 通过 `rev_walk` + `Sorting::ByCommitTime(NewestFirst)` 按提交时间倒序遍历，
// 等价于 `git log`（最新在前）。时间取自 Info.commit_time（提交时间，秒）。

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

        let author_name = commit
            .author()
            .map(|author| author.name.to_string())
            .unwrap_or_default();
        let author_name = author_name.trim();

        let authored_at = info
            .commit_time
            .and_then(|seconds| jiff::Timestamp::from_second(seconds).ok())
            .map(|timestamp| timestamp.to_string())
            .unwrap_or_default();

        entries.push(GitCommitSummaryPayload {
            id: full_id,
            short_id,
            summary: if summary.is_empty() {
                "无提交说明".to_string()
            } else {
                summary.to_string()
            },
            author_name: if author_name.is_empty() {
                "未知作者".to_string()
            } else {
                author_name.to_string()
            },
            authored_at,
        });
    }

    Ok(GitCommitHistoryPayload {
        entries,
        has_more,
        next_offset: has_more.then_some(offset + limit),
    })
}
