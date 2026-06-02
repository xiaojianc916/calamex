use super::super::decode_script_bytes;
use super::preview::line_range_at_byte_offset;
use super::replace::build_structural_pattern;
use super::scan::{
    is_shell_like_file, passes_path_filters, workspace_cache_symbols, PathFilters, ScannedFile,
};
use super::types::{WorkspaceSearchRequest, WorkspaceSearchResult, WorkspaceSearchResultKind};
use super::util::{byte_to_char_offset, count_to_u32, i64_to_i32, trim_line, u64_to_u32};
use ast_grep_language::{LanguageExt, SupportLang};
use grep_matcher::Matcher as GrepMatcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::Lossy, BinaryDetection, SearcherBuilder};
use nucleo_matcher::{
    pattern::{CaseMatching, Normalization, Pattern as NucleoPattern},
    Config, Matcher as NucleoMatcher, Utf32Str,
};
use std::{fs, io, path::Path};

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
    let mut results = Vec::new();

    for file in files {
        let haystack = Utf32Str::new(&file.relative_path, &mut utf32_buffer);
        if let Some(score) = pattern.score(haystack, &mut matcher) {
            results.push(WorkspaceSearchResult {
                path: file.path.to_string_lossy().to_string(),
                relative_path: file.relative_path.clone(),
                name: file.name.clone(),
                kind: WorkspaceSearchResultKind::FileName,
                line_number: None,
                line_text: None,
                match_start: None,
                match_end: None,
                score: i64_to_i32(-(score as i64), "搜索评分")?,
            });
        }
    }

    results.sort_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    results.truncate(limit);
    Ok(results)
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
    let mut results = Vec::new();

    for symbol in symbols.iter() {
        if !passes_path_filters(&symbol.relative_path, filters) {
            continue;
        }
        let candidate = format!("{} {}", symbol.name, symbol.relative_path);
        let haystack = Utf32Str::new(&candidate, &mut utf32_buffer);
        if let Some(score) = pattern.score(haystack, &mut matcher) {
            results.push(WorkspaceSearchResult {
                path: symbol.path.to_string_lossy().to_string(),
                relative_path: symbol.relative_path.clone(),
                name: symbol.name.clone(),
                kind: WorkspaceSearchResultKind::Symbol,
                line_number: Some(symbol.line_number),
                line_text: Some(format!("函数 {}", symbol.name)),
                match_start: None,
                match_end: None,
                score: i64_to_i32(-(score as i64) + symbol.line_number as i64, "搜索评分")?,
            });
        }
    }

    results.sort_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    results.truncate(limit);
    Ok(results)
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
