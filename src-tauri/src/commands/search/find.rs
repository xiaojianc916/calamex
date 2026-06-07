use super::super::decode_script_bytes;
use super::preview::line_range_at_byte_offset;
use super::replace::build_structural_pattern;
use super::scan::{
    PathFilters, ScannedFile, is_shell_like_file, passes_path_filters, workspace_cache_symbols,
};
use super::types::{WorkspaceSearchRequest, WorkspaceSearchResult, WorkspaceSearchResultKind};
use super::util::{byte_to_char_offset, count_to_u32, i64_to_i32, trim_line, u64_to_u32};
use ast_grep_language::{LanguageExt, SupportLang};
use grep_matcher::Matcher as GrepMatcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, SearcherBuilder, sinks::Lossy};
use nucleo_matcher::{
    Config, Matcher as NucleoMatcher, Utf32Str,
    pattern::{CaseMatching, Normalization, Pattern as NucleoPattern},
};
use std::{cmp::Ordering, collections::BinaryHeap, fs, io, path::Path};

/// 包装搜索结果以便放入有界最大堆。
///
/// 排序键为 `(score, relative_path)`：分数越小越靠前（与最终升序排序一致），
/// 因此最大堆堆顶始终是“最不优先”的元素，超出容量时弹出堆顶即可保留 top-k。
struct RankedResult(WorkspaceSearchResult);

impl RankedResult {
    fn sort_key(&self) -> (i32, &str) {
        (self.0.score, self.0.relative_path.as_str())
    }
}

impl PartialEq for RankedResult {
    fn eq(&self, other: &Self) -> bool {
        self.sort_key() == other.sort_key()
    }
}

impl Eq for RankedResult {}

impl PartialOrd for RankedResult {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for RankedResult {
    fn cmp(&self, other: &Self) -> Ordering {
        self.sort_key().cmp(&other.sort_key())
    }
}

/// 将结果推入有界堆，仅保留分数最低（最优）的 `limit` 个。
fn push_bounded_result(
    heap: &mut BinaryHeap<RankedResult>,
    result: WorkspaceSearchResult,
    limit: usize,
) {
    if limit == 0 {
        return;
    }
    heap.push(RankedResult(result));
    if heap.len() > limit {
        heap.pop();
    }
}

/// 取出堆中结果并按 `(score, relative_path)` 升序排序后返回。
fn into_sorted_results(heap: BinaryHeap<RankedResult>) -> Vec<WorkspaceSearchResult> {
    let mut results: Vec<WorkspaceSearchResult> =
        heap.into_iter().map(|ranked| ranked.0).collect();
    results.sort_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    results
}

pub(super) fn search_file_names(
    files: &[ScannedFile],
    query: &str,
    match_case: bool,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let case_matching = if match_case {
        CaseMatching::Respect
    } else {
        CaseMatching::Ignore
    };
    let pattern = NucleoPattern::parse(query, case_matching, Normalization::Smart);
    let mut matcher = NucleoMatcher::new(Config::DEFAULT.match_paths());
    let mut utf32_buffer = Vec::new();
    let mut heap: BinaryHeap<RankedResult> = BinaryHeap::new();

    for file in files {
        let haystack = Utf32Str::new(&file.relative_path, &mut utf32_buffer);
        if let Some(score) = pattern.score(haystack, &mut matcher) {
            push_bounded_result(
                &mut heap,
                WorkspaceSearchResult {
                    path: file.path.to_string_lossy().to_string(),
                    relative_path: file.relative_path.clone(),
                    name: file.name.clone(),
                    kind: WorkspaceSearchResultKind::FileName,
                    line_number: None,
                    line_text: None,
                    match_start: None,
                    match_end: None,
                    score: i64_to_i32(-(score as i64), "搜索评分")?,
                },
                limit,
            );
        }
    }

    Ok(into_sorted_results(heap))
}

pub(super) fn search_file_contents(
    files: &[ScannedFile],
    query: &str,
    payload: &WorkspaceSearchRequest,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let pattern = if payload.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!payload.match_case)
        .word(payload.whole_word)
        .build(&pattern)
        .map_err(|error| format!("内容搜索表达式无效：{error}"))?;

    let mut results = Vec::new();

    for file in files {
        if results.len() >= limit {
            break;
        }

        let remaining = limit - results.len();
        search_one_file_content(file, &matcher, remaining, &mut results)?;
    }

    Ok(results)
}

pub(super) fn search_structural_contents(
    files: &[ScannedFile],
    query: &str,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let pattern = build_structural_pattern(query)?;
    let lang = SupportLang::Bash;
    let mut results = Vec::new();

    for file in files.iter().filter(|file| is_shell_like_file(file)) {
        if results.len() >= limit {
            break;
        }

        let bytes = match fs::read(&file.path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let Ok((content, _encoding)) = decode_script_bytes(&bytes) else {
            continue;
        };
        let root = lang.ast_grep(&content);

        for node_match in root.root().find_all(&pattern) {
            let start = node_match.start_pos();
            let line_range = line_range_at_byte_offset(&content, node_match.range().start);
            let line = &content[line_range.clone()];
            let match_start = node_match
                .range()
                .start
                .saturating_sub(line_range.start)
                .min(line.len());
            let match_end = node_match
                .range()
                .end
                .saturating_sub(line_range.start)
                .min(line.len())
                .max(match_start);
            results.push(WorkspaceSearchResult {
                path: file.path.to_string_lossy().to_string(),
                relative_path: file.relative_path.clone(),
                name: file.name.clone(),
                kind: WorkspaceSearchResultKind::Content,
                line_number: Some(count_to_u32(start.line() + 1, "行号")?),
                line_text: Some(trim_line(line)),
                match_start: Some(count_to_u32(
                    byte_to_char_offset(line, match_start),
                    "匹配起始列",
                )?),
                match_end: Some(count_to_u32(
                    byte_to_char_offset(line, match_end),
                    "匹配结束列",
                )?),
                score: i64_to_i32(
                    ((start.line() + 1) as i64 * 4) + start.byte_point().1 as i64,
                    "搜索评分",
                )?,
            });

            if results.len() >= limit {
                break;
            }
        }
    }

    Ok(results)
}

pub(super) fn search_symbols(
    root: &Path,
    filters: &PathFilters,
    query: &str,
    match_case: bool,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let symbols = workspace_cache_symbols(root)?;
    let case_matching = if match_case {
        CaseMatching::Respect
    } else {
        CaseMatching::Ignore
    };
    let pattern = NucleoPattern::parse(query, case_matching, Normalization::Smart);
    let mut matcher = NucleoMatcher::new(Config::DEFAULT.match_paths());
    let mut utf32_buffer = Vec::new();
    let mut heap: BinaryHeap<RankedResult> = BinaryHeap::new();

    for symbol in symbols.iter() {
        if !passes_path_filters(&symbol.relative_path, filters) {
            continue;
        }
        let candidate = format!("{} {}", symbol.name, symbol.relative_path);
        let haystack = Utf32Str::new(&candidate, &mut utf32_buffer);
        if let Some(score) = pattern.score(haystack, &mut matcher) {
            push_bounded_result(
                &mut heap,
                WorkspaceSearchResult {
                    path: symbol.path.to_string_lossy().to_string(),
                    relative_path: symbol.relative_path.clone(),
                    name: symbol.name.clone(),
                    kind: WorkspaceSearchResultKind::Symbol,
                    line_number: Some(symbol.line_number),
                    line_text: Some(format!("函数 {}", symbol.name)),
                    match_start: None,
                    match_end: None,
                    score: i64_to_i32(-(score as i64) + symbol.line_number as i64, "搜索评分")?,
                },
                limit,
            );
        }
    }

    Ok(into_sorted_results(heap))
}

fn search_one_file_content(
    file: &ScannedFile,
    matcher: &grep_regex::RegexMatcher,
    limit: usize,
    results: &mut Vec<WorkspaceSearchResult>,
) -> Result<(), String> {
    let mut matched_in_file = 0usize;
    let mut conversion_error: Option<String> = None;
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .build();

    searcher
        .search_path(
            matcher,
            &file.path,
            Lossy(|line_number, line| {
                let line_text = trim_line(line);
                let mut keep_going = true;
                matcher
                    .find_iter(line.as_bytes(), |found| {
                        let column = found.start() as i64;
                        let line_number = match u64_to_u32(line_number, "行号") {
                            Ok(value) => value,
                            Err(error) => {
                                conversion_error = Some(error);
                                return false;
                            }
                        };
                        let match_start = match count_to_u32(
                            byte_to_char_offset(line, found.start()),
                            "匹配起始列",
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                conversion_error = Some(error);
                                return false;
                            }
                        };
                        let match_end = match count_to_u32(
                            byte_to_char_offset(line, found.end()),
                            "匹配结束列",
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                conversion_error = Some(error);
                                return false;
                            }
                        };
                        let score = match i64_to_i32((line_number as i64 * 4) + column, "搜索评分")
                        {
                            Ok(value) => value,
                            Err(error) => {
                                conversion_error = Some(error);
                                return false;
                            }
                        };
                        results.push(WorkspaceSearchResult {
                            path: file.path.to_string_lossy().to_string(),
                            relative_path: file.relative_path.clone(),
                            name: file.name.clone(),
                            kind: WorkspaceSearchResultKind::Content,
                            line_number: Some(line_number),
                            line_text: Some(line_text.clone()),
                            match_start: Some(match_start),
                            match_end: Some(match_end),
                            score,
                        });
                        matched_in_file += 1;
                        keep_going = matched_in_file < limit;
                        keep_going
                    })
                    .map_err(io::Error::other)?;
                Ok(keep_going)
            }),
        )
        .map_err(|error| format!("内容搜索失败：{error}"))?;

    if let Some(error) = conversion_error {
        return Err(error);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_result(score: i32, relative_path: &str) -> WorkspaceSearchResult {
        WorkspaceSearchResult {
            path: relative_path.to_string(),
            relative_path: relative_path.to_string(),
            name: relative_path.to_string(),
            kind: WorkspaceSearchResultKind::FileName,
            line_number: None,
            line_text: None,
            match_start: None,
            match_end: None,
            score,
        }
    }

    #[test]
    fn bounded_top_k_keeps_lowest_scores_in_order() {
        let mut heap: BinaryHeap<RankedResult> = BinaryHeap::new();
        push_bounded_result(&mut heap, make_result(40, "d"), 2);
        push_bounded_result(&mut heap, make_result(10, "a"), 2);
        push_bounded_result(&mut heap, make_result(30, "c"), 2);
        push_bounded_result(&mut heap, make_result(20, "b"), 2);

        let observed: Vec<(i32, String)> = into_sorted_results(heap)
            .into_iter()
            .map(|result| (result.score, result.relative_path))
            .collect();
        assert_eq!(observed, vec![(10, "a".to_string()), (20, "b".to_string())]);
    }

    #[test]
    fn bounded_top_k_breaks_ties_by_relative_path() {
        let mut heap: BinaryHeap<RankedResult> = BinaryHeap::new();
        push_bounded_result(&mut heap, make_result(10, "y"), 2);
        push_bounded_result(&mut heap, make_result(10, "x"), 2);
        push_bounded_result(&mut heap, make_result(10, "z"), 2);

        let observed: Vec<String> = into_sorted_results(heap)
            .into_iter()
            .map(|result| result.relative_path)
            .collect();
        assert_eq!(observed, vec!["x".to_string(), "y".to_string()]);
    }

    #[test]
    fn bounded_top_k_with_zero_limit_is_empty() {
        let mut heap: BinaryHeap<RankedResult> = BinaryHeap::new();
        push_bounded_result(&mut heap, make_result(10, "a"), 0);
        assert!(into_sorted_results(heap).is_empty());
    }
}
