use super::types::{WorkspaceSearchResult, WorkspaceSearchResultKind};
use std::cmp::Ordering;

const KIND_FILE_NAME_BONUS: i64 = 3_000;
const KIND_SYMBOL_BONUS: i64 = 2_200;
const EXACT_NAME_BONUS: i64 = 6_000;
const PREFIX_NAME_BONUS: i64 = 3_000;
const CONTAINS_NAME_BONUS: i64 = 1_200;
const PATH_PREFIX_BONUS: i64 = 800;
const PATH_DEPTH_PENALTY: i64 = 32;

/// 最终搜索结果排序的轻量混合排序层。
///
/// 各搜索器仍负责自己的 candidate generation（nucleo / ripgrep / ast-grep / top-k heap），
/// 这里只在最终合并处加入实用的 IDE 排序特征：结果类型、文件名精确度、路径深度和原始 matcher
/// 分数。这样不会引入索引数据库或语义向量的复杂度，却能让“直接打开文件/函数”的命中稳定排在
/// 深层内容命中前。
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
    hybrid_score(left, query, match_case)
        .cmp(&hybrid_score(right, query, match_case))
        .then_with(|| left.relative_path.cmp(&right.relative_path))
        .then_with(|| left.name.cmp(&right.name))
        .then_with(|| left.line_number.cmp(&right.line_number))
        .then_with(|| left.match_start.cmp(&right.match_start))
}

fn hybrid_score(result: &WorkspaceSearchResult, query: &str, match_case: bool) -> i64 {
    let mut score = result.score as i64 * 16;
    score += path_depth(&result.relative_path) * PATH_DEPTH_PENALTY;

    match result.kind {
        WorkspaceSearchResultKind::FileName => {
            score -= KIND_FILE_NAME_BONUS;
            score -= text_match_bonus(&result.name, query, match_case);
            score -= path_match_bonus(&result.relative_path, query, match_case);
        }
        WorkspaceSearchResultKind::Symbol => {
            score -= KIND_SYMBOL_BONUS;
            score -= text_match_bonus(&result.name, query, match_case);
            score -= path_match_bonus(&result.relative_path, query, match_case) / 2;
        }
        WorkspaceSearchResultKind::Content => {
            score -= path_match_bonus(&result.relative_path, query, match_case) / 4;
        }
    }

    score
}

fn path_depth(relative_path: &str) -> i64 {
    relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .count()
        .saturating_sub(1) as i64
}

fn text_match_bonus(value: &str, query: &str, match_case: bool) -> i64 {
    let normalized_value = normalize(value, match_case);
    let normalized_query = normalize(query.trim(), match_case);
    if normalized_query.is_empty() {
        return 0;
    }

    if normalized_value == normalized_query {
        return EXACT_NAME_BONUS;
    }
    if normalized_value.starts_with(&normalized_query) {
        return PREFIX_NAME_BONUS;
    }
    if normalized_value.contains(&normalized_query) {
        return CONTAINS_NAME_BONUS;
    }
    0
}

fn path_match_bonus(relative_path: &str, query: &str, match_case: bool) -> i64 {
    let normalized_path = normalize(relative_path, match_case);
    let normalized_query = normalize(query.trim(), match_case);
    if normalized_query.is_empty() {
        return 0;
    }

    if normalized_path.starts_with(&normalized_query) {
        return PATH_PREFIX_BONUS;
    }
    0
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