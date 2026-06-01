use super::*;
use super::cli;

// TODO(gix-history): gix 0.83 的 `CommitTimeOrder` 为 private，
// `rev_walk` 无法按提交时间排序。当前回退 CLI `git log`。
// 跟踪：https://github.com/Byron/gitoxide/issues（开 issue 后替换为具体链接）

#[tauri::command]
pub fn list_git_commit_history(
    payload: GitCommitHistoryRequest,
) -> Result<GitCommitHistoryPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
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

    let max_count = limit + 1;
    let mut args = vec!["log".to_string(), "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at".to_string(), format!("-n{max_count}")];
    if offset > 0 {
        args.push("--skip".to_string());
        args.push(offset.to_string());
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = cli::run_git_text(&repository_root, &arg_refs, "读取提交历史")?;

    let mut entries = Vec::new();
    let mut has_more = false;

    for line in output.lines() {
        if line.trim().is_empty() { continue; }
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 5 { continue; }

        if entries.len() >= limit {
            has_more = true;
            break;
        }

        let timestamp_str = parts[4].trim();
        let authored_at = timestamp_str
            .parse::<i64>()
            .ok()
            .and_then(|ts| jiff::Timestamp::from_second(ts).ok())
            .map(|ts| ts.to_string())
            .unwrap_or_default();

        entries.push(GitCommitSummaryPayload {
            id: parts[0].trim().to_string(),
            short_id: parts[1].trim().to_string(),
            summary: if parts[2].trim().is_empty() { "无提交说明".to_string() } else { parts[2].trim().to_string() },
            author_name: if parts[3].trim().is_empty() { "未知作者".to_string() } else { parts[3].trim().to_string() },
            authored_at,
        });
    }

    Ok(GitCommitHistoryPayload {
        entries,
        has_more,
        next_offset: has_more.then_some(offset + limit),
    })
}