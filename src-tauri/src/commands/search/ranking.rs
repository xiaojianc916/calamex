use super::types::{WorkspaceSearchResult, WorkspaceSearchResultKind};
use std::cmp::Ordering;

/// 名称匹配档位（数值越小越优先）：精确 > 前缀 > 包含 > 无。
const NAME_MATCH_EXACT: u8 = 0;
const NAME_MATCH_PREFIX: u8 = 1;
const NAME_MATCH_CONTAINS: u8 = 2;
const NAME_MATCH_NONE: u8 = 3;

/// 结果类型档位（数值越小越优先）：文件名 > 符号 > 内容。
const KIND_RANK_FILE_NAME: u8 = 0;
const KIND_RANK_SYMBOL: u8 = 1;
const KIND_RANK_CONTENT: u8 = 2;

/// 最终搜索结果排序的轻量混合排序层。
///
/// 各搜索器仍负责自己的 candidate generation（nucleo / ripgrep / ast-grep / top-k heap），
/// 这里只在最终合并处加入实用的 IDE 排序特征：结果类型、文件名精确度、路径深度和原始 matcher
/// 分数。这样不会引入索引数据库或语义向量的复杂度，却能让“直接打开文件/函数”的命中稳定排在
/// 深层内容命中前。
///
/// 采用字典序分层比较而非加权求和：语义信号（类型、名称匹配档位、路径前缀）依次比较，
/// 原始 matcher 分数只在同一语义档位内作为决胜项，避免“精确文件名命中”等强信号被分数幅值压过。
pub(super) fn sort_ranked_search_results(
    results: &mut [WorkspaceSearchResult],
    query: &str,
    match_case: bool,
) {
    results.sort_by(|left, right| compare_search_results(left, right, query, match_case));
}

fn compare_search_results(
    left: &WorkspaceSearchResult,
    right: &WorkspaceSearchResult,
    query: &str,
    match_case: bool,
) -> Ordering {
    sort_key(left, query, match_case)
        .cmp(&sort_key(right, query, match_case))
        .then_with(|| left.relative_path.cmp(&right.relative_path))
        .then_with(|| left.name.cmp(&right.name))
        .then_with(|| left.line_number.cmp(&right.line_number))
        .then_with(|| left.match_start.cmp(&right.match_start))
}

/// 排序键：元组按字段先后逐项比较，数值越小越靠前。
///
/// 顺序：结果类型 → 名称匹配档位 → 路径前缀是否命中 → 原始 matcher 分数 → 路径深度。
fn sort_key(
    result: &WorkspaceSearchResult,
    query: &str,
    match_case: bool,
) -> (u8, u8, u8, i64, i64) {
    let kind_rank = match result.kind {
        WorkspaceSearchResultKind::FileName => KIND_RANK_FILE_NAME,
        WorkspaceSearchResultKind::Symbol => KIND_RANK_SYMBOL,
        WorkspaceSearchResultKind::Content => KIND_RANK_CONTENT,
    };

    // 名称匹配档位仅对“文件名 / 符号”命中有意义；内容命中保持中性档位，
    // 仅由路径前缀、原始分数与路径深度决定其内部次序。
    let name_match_rank = match result.kind {
        WorkspaceSearchResultKind::FileName | WorkspaceSearchResultKind::Symbol => {
            name_match_rank(&result.name, query, match_case)
        }
        WorkspaceSearchResultKind::Content => NAME_MATCH_NONE,
    };

    let path_prefix_rank = if path_starts_with_query(&result.relative_path, query, match_case) {
        0
    } else {
        1
    };

    (
        kind_rank,
        name_match_rank,
        path_prefix_rank,
        result.score as i64,
        path_depth(&result.relative_path),
    )
}

fn path_depth(relative_path: &str) -> i64 {
    relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .count()
        .saturating_sub(1) as i64
}

fn name_match_rank(value: &str, query: &str, match_case: bool) -> u8 {
    let normalized_value = normalize(value, match_case);
    let normalized_query = normalize(query.trim(), match_case);
    if normalized_query.is_empty() {
        return NAME_MATCH_NONE;
    }

    if normalized_value == normalized_query {
        NAME_MATCH_EXACT
    } else if normalized_value.starts_with(&normalized_query) {
        NAME_MATCH_PREFIX
    } else if normalized_value.contains(&normalized_query) {
        NAME_MATCH_CONTAINS
    } else {
        NAME_MATCH_NONE
    }
}

fn path_starts_with_query(relative_path: &str, query: &str, match_case: bool) -> bool {
    let normalized_path = normalize(relative_path, match_case);
    let normalized_query = normalize(query.trim(), match_case);
    if normalized_query.is_empty() {
        return false;
    }

    normalized_path.starts_with(&normalized_query)
}

fn normalize(value: &str, match_case: bool) -> String {
    if match_case {
        value.to_string()
    } else {
        value.to_ascii_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    
fn result(
    kind: WorkspaceSearchResultKind,
    relative_path: &str,
    name: &str,
    score: i32,
) -> WorkspaceSearchResult {
    WorkspaceSearchResult {
        path: relative_path.to_string(),
        relative_path: relative_path.to_string(),
        name: name.to_string(),
        kind,
        line_number: None,
        line_text: None,
        match_start: None,
        match_end: None,
        window_start: None,
        truncated_left: false,
        truncated_right: false,
        score,
    }
}

    #[test]
    fn hybrid_ranking_prefers_exact_file_name_over_deep_path_match() {
        let mut results = vec![
            result(
                WorkspaceSearchResultKind::FileName,
                "packages/deep/scripts/deploy-prod.sh",
                "deploy-prod.sh",
                -800,
            ),
            result(
                WorkspaceSearchResultKind::FileName,
                "deploy.sh",
                "deploy.sh",
                -200,
            ),
        ];

        sort_ranked_search_results(&mut results, "deploy.sh", false);

        assert_eq!(results[0].relative_path, "deploy.sh");
    }

    #[test]
    fn hybrid_ranking_prefers_symbols_over_equal_content_hits() {
        let mut results = vec![
            result(
                WorkspaceSearchResultKind::Content,
                "src/scripts/deploy.sh",
                "deploy.sh",
                12,
            ),
            result(
                WorkspaceSearchResultKind::Symbol,
                "src/scripts/deploy.sh",
                "deploy_app",
                12,
            ),
        ];

        sort_ranked_search_results(&mut results, "deploy", false);

        assert!(matches!(results[0].kind, WorkspaceSearchResultKind::Symbol));
    }

    #[test]
    fn hybrid_ranking_respects_case_sensitive_name_bonus() {
        let mut results = vec![
            result(WorkspaceSearchResultKind::FileName, "api.sh", "api.sh", -10),
            result(WorkspaceSearchResultKind::FileName, "API.sh", "API.sh", -10),
        ];

        sort_ranked_search_results(&mut results, "API.sh", true);

        assert_eq!(results[0].relative_path, "API.sh");
    }
}
