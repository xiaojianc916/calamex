use super::preview::line_range_at_byte_offset;
use super::replace::build_structural_pattern;
use super::scan::{
    PathFilters, ScannedFile, is_shell_like_file, passes_path_filters, workspace_cache_symbols,
};
use super::stream::ContentBatchSink;
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
use rayon::prelude::*;
use std::{io, path::Path};

/// 内容模糊搜索的轻量预过滤器。
///
/// 只检查不会造成误杀的必要条件：行长度至少能容纳 query 的非空白字符，
/// query 中出现过的 ASCII 字母/数字必须也出现在候选行里，且 query 中无大小写之分的
/// 非 ASCII 字符（如 CJK）也必须出现在候选行里。真正的排序与子序列匹配仍交给 nucleo；
/// 这里仅在进入较贵 matcher 前剪掉明显不可能命中的行。
#[derive(Clone)]
struct FuzzyLinePrefilter {
    min_chars: usize,
    required_ascii: Vec<u8>,
    required_non_ascii: Vec<char>,
    match_case: bool,
}

impl FuzzyLinePrefilter {
    fn new(query: &str, match_case: bool) -> Option<Self> {
        let min_chars = query.chars().filter(|ch| !ch.is_whitespace()).count();
        let mut required_ascii = Vec::new();
        let mut required_non_ascii = Vec::new();

        for ch in query.chars() {
            if ch.is_whitespace() {
                continue;
            }
            if ch.is_ascii() {
                let byte = ch as u8;
                if !byte.is_ascii_alphanumeric() {
                    continue;
                }
                let normalized = normalize_prefilter_ascii(byte, match_case);
                if !required_ascii.contains(&normalized) {
                    required_ascii.push(normalized);
                }
                continue;
            }
            // 非 ASCII：仅在区分大小写、或该字符本身无大小写之分（如 CJK）时要求其出现，
            // 避免在不区分大小写时对有大小写的脚本（希腊 / 西里尔等）造成误杀。
            if !match_case && (ch.is_uppercase() || ch.is_lowercase()) {
                continue;
            }
            if !required_non_ascii.contains(&ch) {
                required_non_ascii.push(ch);
            }
        }

        if min_chars == 0 && required_ascii.is_empty() && required_non_ascii.is_empty() {
            return None;
        }

        Some(Self {
            min_chars,
            required_ascii,
            required_non_ascii,
            match_case,
        })
    }

    /// 在给定字节序列中检查 query 要求的全部 ASCII 字符是否都出现（按 match_case 归一大小写）。
    /// 非 ASCII 字节跳过；调用方需保证 required_ascii 非空时调用才有意义。
    fn all_required_ascii_present(&self, bytes: impl Iterator<Item = u8>) -> bool {
        let mut missing = self.required_ascii.clone();
        for byte in bytes {
            if !byte.is_ascii() {
                continue;
            }
            let normalized = normalize_prefilter_ascii(byte, self.match_case);
            if let Some(index) = missing
                .iter()
                .position(|candidate| *candidate == normalized)
            {
                missing.swap_remove(index);
                if missing.is_empty() {
                    return true;
                }
            }
        }
        false
    }

    /// 在已解码的行文本上检查 query 要求的全部非 ASCII（无大小写之分，如 CJK）字符是否都出现。
    /// 仅对解码后的文本调用；文件级原始字节阶段不做此检查，以免对非 UTF-8 编码误杀。
    fn all_required_non_ascii_present(&self, line: &str) -> bool {
        let mut missing = self.required_non_ascii.clone();
        for ch in line.chars() {
            if let Some(index) = missing.iter().position(|candidate| *candidate == ch) {
                missing.swap_remove(index);
                if missing.is_empty() {
                    return true;
                }
            }
        }
        missing.is_empty()
    }

    fn may_match(&self, line: &str) -> bool {
        if line.chars().count() < self.min_chars {
            return false;
        }
        if !self.required_ascii.is_empty() && !self.all_required_ascii_present(line.bytes()) {
            return false;
        }
        if !self.required_non_ascii.is_empty() && !self.all_required_non_ascii_present(line) {
            return false;
        }
        true
    }

    /// 文件级候选筛除（第 4 点两阶段检索的「candidate generation」轻量版）：
    /// 直接在原始字节上检查 query 要求的 ASCII 字符是否全部出现；缺任意一个，
    /// 则整文件不可能有命中行，可在更贵的解码 / 逐行 nucleo 之前整文件跳过。
    ///
    /// 只看 ASCII 字节，且 ASCII 在 UTF-8 / Latin1 等超集编码里编码一致，故无需先解码，
    /// 也不会误杀（required_ascii 为空时返回 true，交回逐行阶段处理）。非 ASCII（如 CJK）
    /// 字符的存在性检查只放在解码后的逐行阶段，避免对非 UTF-8 编码的文件误杀。
    fn bytes_may_match(&self, bytes: &[u8]) -> bool {
        if self.required_ascii.is_empty() {
            return true;
        }
        self.all_required_ascii_present(bytes.iter().copied())
    }
}

fn normalize_prefilter_ascii(byte: u8, match_case: bool) -> u8 {
    if match_case {
        byte
    } else {
        byte.to_ascii_lowercase()
    }
}

/// 按 `(score, relative_path)` 升序排序后截断到 `limit`。
///
/// 分数越小越优先（文件名/符号命中为负分），并列时按 relative_path 字典序稳定排序，
/// 与旧的有界堆 into_sorted_results 输出顺序完全一致。
fn sort_and_truncate_results(results: &mut Vec<WorkspaceSearchResult>, limit: usize) {
    results.sort_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    results.truncate(limit);
}

/// 将各文件的命中合并到全局 `limit`。
///
/// 总命中不超过 `limit` 时按文件顺序直接展开，保持与串行扫描一致的稳定顺序；一旦超过
/// `limit`，改为按文件轮转取数（round-robin），让每个文件都能贡献一部分命中，避免单个
/// 超大文件（如 Cargo.lock 等锁文件 / 生成文件）凭扫描顺序占满全部名额、把其它文件整体
/// 挤出结果。最终顺序仍由上层 sort_ranked_search_results 决定，这里只负责“留下哪些”。
fn merge_per_file_results(
    per_file: Vec<Vec<WorkspaceSearchResult>>,
    limit: usize,
) -> Vec<WorkspaceSearchResult> {
    if limit == 0 {
        return Vec::new();
    }

    let total: usize = per_file.iter().map(|file_results| file_results.len()).sum();
    if total <= limit {
        return per_file.into_iter().flatten().collect();
    }

    let mut iterators: Vec<_> = per_file
        .into_iter()
        .map(|file_results| file_results.into_iter())
        .collect();
    let mut results = Vec::with_capacity(limit);
    let mut progressed = true;
    while progressed && results.len() < limit {
        progressed = false;
        for iterator in iterators.iter_mut() {
            let Some(result) = iterator.next() else {
                continue;
            };
            results.push(result);
            progressed = true;
            if results.len() >= limit {
                break;
            }
        }
    }

    results
}

pub(super) fn search_file_names(
    files: &[ScannedFile],
    query: &str,
    match_case: bool,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let case_matching = if match_case {
        CaseMatching::Respect
    } else {
        CaseMatching::Ignore
    };
    let pattern = NucleoPattern::parse(query, case_matching, Normalization::Smart);

    // 并行打分：每个 rayon 工作线程通过 map_init 维护自己的 NucleoMatcher 与 Utf32 缓冲，
    // matcher 始终线程本地、不跨线程，因此无需 NucleoMatcher: Send。先收集全部命中再统一
    // 排序截断到 limit；候选量等于命中文件数，远小于内容命中，全量收集成本可忽略。
    let mut scored = files
        .par_iter()
        .map_init(
            || {
                (
                    NucleoMatcher::new(Config::DEFAULT.match_paths()),
                    Vec::<char>::new(),
                )
            },
            |(matcher, utf32_buffer), file| -> Result<Option<WorkspaceSearchResult>, String> {
                let haystack = Utf32Str::new(&file.relative_path, utf32_buffer);
                let Some(score) = pattern.score(haystack, matcher) else {
                    return Ok(None);
                };
                Ok(Some(WorkspaceSearchResult {
                    path: file.path.to_string_lossy().to_string(),
                    relative_path: file.relative_path.clone(),
                    name: file.name.clone(),
                    kind: WorkspaceSearchResultKind::FileName,
                    line_number: None,
                    line_text: None,
                    match_start: None,
                    match_end: None,
                    score: i64_to_i32(-(score as i64), "搜索评分")?,
                }))
            },
        )
        .filter_map(|result| result.transpose())
        .collect::<Result<Vec<WorkspaceSearchResult>, String>>()?;

    sort_and_truncate_results(&mut scored, limit);
    Ok(scored)
}

pub(super) fn search_file_contents(
    root: &Path,
    files: &[ScannedFile],
    query: &str,
    payload: &WorkspaceSearchRequest,
    limit: usize,
    sink: Option<&dyn ContentBatchSink>,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    if payload.content_fuzzy {
        return search_fuzzy_file_contents(root, files, query, payload.match_case, limit, sink);
    }

    let pattern = if payload.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    // 复用同一个不可变 matcher：grep 的 RegexMatcher 是 Sync，可在 rayon 工作线程间共享。
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!payload.match_case)
        .word(payload.whole_word)
        .build(&pattern)
        .map_err(|error| format!("内容搜索表达式无效：{error}"))?;

    // 并行扫描各文件：每个文件最多收集 limit 条，避免单文件无界扫描；collect 保持与
    // files 相同的顺序，随后按文件轮转合并并截断到全局 limit，避免单个文件（如锁文件）
    // 凭扫描顺序占满名额而挤掉其它文件。
    let per_file = files
        .par_iter()
        .map(|file| {
            let mut local = Vec::new();
            search_one_file_content(file, &matcher, limit, &mut local)?;
            // 流式推送：每个文件命中一旦产生即按发现顺序交给 sink（sink 内部按条数/时间节流，
            // 且对空切片为 no-op）。命令仍返回经全局排序的最终结果。
            if let Some(sink) = sink {
                sink.push(&local);
            }
            Ok(local)
        })
        .collect::<Result<Vec<Vec<WorkspaceSearchResult>>, String>>()?;

    Ok(merge_per_file_results(per_file, limit))
}

/// 内容模糊搜索：逐文件、逐行用 nucleo 做子序列模糊匹配。与精确/正则路径一样
/// 并行化，但这是“功能”而非“性能”路径：逐行模糊比 ripgrep 更贵，仅在用户显式开启时生效。
fn search_fuzzy_file_contents(
    root: &Path,
    files: &[ScannedFile],
    query: &str,
    match_case: bool,
    limit: usize,
    sink: Option<&dyn ContentBatchSink>,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let case_matching = if match_case {
        CaseMatching::Respect
    } else {
        CaseMatching::Ignore
    };
    let pattern = NucleoPattern::parse(query, case_matching, Normalization::Smart);
    let prefilter = FuzzyLinePrefilter::new(query, match_case);

    let per_file = files
        .par_iter()
        .map(|file| {
            let local = search_one_file_fuzzy(root, file, &pattern, prefilter.as_ref(), limit)?;
            // 流式推送：与精确/正则路径一致，按文件发现顺序把命中交给 sink。
            if let Some(sink) = sink {
                sink.push(&local);
            }
            Ok(local)
        })
        .collect::<Result<Vec<Vec<WorkspaceSearchResult>>, String>>()?;

    Ok(merge_per_file_results(per_file, limit))
}

fn search_one_file_fuzzy(
    root: &Path,
    file: &ScannedFile,
    pattern: &NucleoPattern,
    prefilter: Option<&FuzzyLinePrefilter>,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let mut local = Vec::new();
    // 复用按 (len, mtime) 缓存的已解码文本：避免同一文件在多次模糊搜索中重复读盘 + 解码。
    let Some(content) =
        super::content_cache::workspace_file_text(root, &file.relative_path, &file.path)
    else {
        return Ok(local);
    };
    // 文件级候选筛除：在已解码文本的字节上检查 query 要求的 ASCII 字符是否整文件存在
    // （ASCII 字节在解码前后一致，等价于原先对原始字节的判断）；缺任意一个则整文件不可能
    // 命中，在更贵的逐行 nucleo 之前整文件跳过。非 ASCII（如 CJK）的存在性仍只在下方逐行阶段判断。
    if prefilter.is_some_and(|prefilter| !prefilter.bytes_may_match(content.as_bytes())) {
        return Ok(local);
    }

    // 路径字符串每文件只转换一次：避免对每条命中重复做 to_string_lossy 的全路径扫描。
    let path_display = file.path.to_string_lossy().into_owned();

    let mut matcher = NucleoMatcher::new(Config::DEFAULT);
    let mut utf32_buffer = Vec::new();
    let mut indices: Vec<u32> = Vec::new();

    for (line_index, line) in content.lines().enumerate() {
        if local.len() >= limit {
            break;
        }
        if line.is_empty() {
            continue;
        }
        if prefilter.is_some_and(|prefilter| !prefilter.may_match(line)) {
            continue;
        }

        let haystack = Utf32Str::new(line, &mut utf32_buffer);
        indices.clear();
        if pattern
            .indices(haystack, &mut matcher, &mut indices)
            .is_none()
        {
            continue;
        }
        if indices.is_empty() {
            continue;
        }

        // nucleo 返回的是非连续的字符（码点）下标；用 [首, 尾+1] 作为单一覆盖区间，
        // 适配现有单区间高亮 schema（与 byte_to_char_offset 同为码点偏移，前端按码点切片）。
        let first = indices.iter().copied().min().unwrap_or(0);
        let last = indices.iter().copied().max().unwrap_or(first);
        let line_number = count_to_u32(line_index + 1, "行号")?;

        local.push(WorkspaceSearchResult {
            path: path_display.clone(),
            relative_path: file.relative_path.clone(),
            name: file.name.clone(),
            kind: WorkspaceSearchResultKind::Content,
            line_number: Some(line_number),
            line_text: Some(trim_line(line)),
            match_start: Some(first),
            match_end: Some(last + 1),
            // 与精确内容命中保持一致的评分量级（line*4 + 列），确保 all 范围下
            // 文件名命中（负分）仍排在内容命中之前，且内容内部按位置排序。
            score: i64_to_i32((line_number as i64 * 4) + first as i64, "搜索评分")?,
        });
    }

    Ok(local)
}

pub(super) fn search_structural_contents(
    root: &Path,
    files: &[ScannedFile],
    query: &str,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let pattern = build_structural_pattern(query)?;
    let lang = SupportLang::Bash;

    // AST 解析/匹配是 CPU 型工作。按文件并行解析，但每个文件只保留至多 limit 条，
    // 再按原文件顺序归并并截断，保证输出与串行版的稳定顺序一致。
    let mut per_file = files
        .par_iter()
        .enumerate()
        .filter(|(_, file)| is_shell_like_file(file))
        .map(|(index, file)| {
            let mut local = Vec::new();
            // 复用按 (len, mtime) 缓存的已解码文本：避免同一文件在多次结构化搜索中重复读盘 + 解码。
            let Some(content) =
                super::content_cache::workspace_file_text(root, &file.relative_path, &file.path)
            else {
                return Ok((index, local));
            };
            // 路径字符串每文件只转换一次：避免对每条命中重复做 to_string_lossy 的全路径扫描。
            let path_display = file.path.to_string_lossy().into_owned();
            let ast_root = lang.ast_grep(&content);

            for node_match in ast_root.root().find_all(&pattern) {
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
                local.push(WorkspaceSearchResult {
                    path: path_display.clone(),
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

                if local.len() >= limit {
                    break;
                }
            }

            Ok((index, local))
        })
        .collect::<Result<Vec<(usize, Vec<WorkspaceSearchResult>)>, String>>()?;

    per_file.sort_by_key(|(index, _)| *index);

    let ordered: Vec<Vec<WorkspaceSearchResult>> = per_file
        .into_iter()
        .map(|(_, file_results)| file_results)
        .collect();

    Ok(merge_per_file_results(ordered, limit))
}

pub(super) fn search_symbols(
    root: &Path,
    filters: &PathFilters,
    query: &str,
    match_case: bool,
    limit: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let symbols = workspace_cache_symbols(root)?;
    let case_matching = if match_case {
        CaseMatching::Respect
    } else {
        CaseMatching::Ignore
    };
    let pattern = NucleoPattern::parse(query, case_matching, Normalization::Smart);

    // 与文件名搜索一致：先按路径过滤，再用 map_init 在各线程本地 matcher 上并行打分，
    // 最后统一排序截断。symbols 为 Arc<Vec<SymbolEntry>>，par_iter 经 Deref 解析。
    let mut scored = symbols
        .par_iter()
        .filter(|symbol| passes_path_filters(&symbol.relative_path, filters))
        .map_init(
            || {
                (
                    NucleoMatcher::new(Config::DEFAULT.match_paths()),
                    Vec::<char>::new(),
                )
            },
            |(matcher, utf32_buffer), symbol| -> Result<Option<WorkspaceSearchResult>, String> {
                let haystack = Utf32Str::new(symbol.search_text.as_str(), utf32_buffer);
                let Some(score) = pattern.score(haystack, matcher) else {
                    return Ok(None);
                };
                Ok(Some(WorkspaceSearchResult {
                    path: symbol.path.to_string_lossy().to_string(),
                    relative_path: symbol.relative_path.clone(),
                    name: symbol.name.clone(),
                    kind: WorkspaceSearchResultKind::Symbol,
                    line_number: Some(symbol.line_number),
                    line_text: Some(format!("函数 {}", symbol.name)),
                    match_start: None,
                    match_end: None,
                    score: i64_to_i32(-(score as i64) + symbol.line_number as i64, "搜索评分")?,
                }))
            },
        )
        .filter_map(|result| result.transpose())
        .collect::<Result<Vec<WorkspaceSearchResult>, String>>()?;

    sort_and_truncate_results(&mut scored, limit);
    Ok(scored)
}

fn search_one_file_content(
    file: &ScannedFile,
    matcher: &grep_regex::RegexMatcher,
    limit: usize,
    results: &mut Vec<WorkspaceSearchResult>,
) -> Result<(), String> {
    let mut matched_in_file = 0usize;
    let mut conversion_error: Option<String> = None;
    // 路径字符串每文件只转换一次：单个文件可能产生大量命中，避免对每条命中重复执行
    // to_string_lossy 的全路径扫描与转换。
    let path_display = file.path.to_string_lossy().into_owned();
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
                            path: path_display.clone(),
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
    fn sort_and_truncate_results_orders_by_score_then_path_and_caps() {
        let mut results = vec![
            make_result(40, "d"),
            make_result(10, "a"),
            make_result(30, "c"),
            make_result(20, "b"),
        ];
        sort_and_truncate_results(&mut results, 2);
        let observed: Vec<(i32, String)> = results
            .into_iter()
            .map(|result| (result.score, result.relative_path))
            .collect();
        assert_eq!(observed, vec![(10, "a".to_string()), (20, "b".to_string())]);
    }

    #[test]
    fn sort_and_truncate_results_breaks_ties_by_relative_path() {
        let mut results = vec![
            make_result(10, "y"),
            make_result(10, "x"),
            make_result(10, "z"),
        ];
        sort_and_truncate_results(&mut results, 2);
        let observed: Vec<String> = results
            .into_iter()
            .map(|result| result.relative_path)
            .collect();
        assert_eq!(observed, vec!["x".to_string(), "y".to_string()]);
    }

    #[test]
    fn merge_per_file_results_flattens_in_file_order_within_limit() {
        let per_file = vec![
            vec![make_result(1, "a"), make_result(2, "a")],
            vec![make_result(3, "b")],
        ];
        let observed: Vec<(i32, String)> = merge_per_file_results(per_file, 10)
            .into_iter()
            .map(|result| (result.score, result.relative_path))
            .collect();
        assert_eq!(
            observed,
            vec![
                (1, "a".to_string()),
                (2, "a".to_string()),
                (3, "b".to_string()),
            ]
        );
    }

    #[test]
    fn merge_per_file_results_round_robins_when_over_limit() {
        // 第一个文件命中很多、第二个文件只有一条；超出 limit 时仍应给小文件留出名额，
        // 而不是被大文件按顺序占满后整体挤掉。
        let big_file: Vec<WorkspaceSearchResult> = (0..10).map(|_| make_result(1, "big")).collect();
        let small_file = vec![make_result(1, "small")];
        let merged = merge_per_file_results(vec![big_file, small_file], 3);
        assert_eq!(merged.len(), 3);
        assert!(
            merged.iter().any(|result| result.relative_path == "small"),
            "轮转合并应保证小文件也能进入结果"
        );
    }

    #[test]
    fn merge_per_file_results_with_zero_limit_is_empty() {
        let per_file = vec![vec![make_result(1, "a")]];
        assert!(merge_per_file_results(per_file, 0).is_empty());
    }

    #[test]
    fn fuzzy_prefilter_rejects_lines_missing_required_ascii() {
        let prefilter = FuzzyLinePrefilter::new("dapnow", false).expect("应创建预过滤器");
        assert!(prefilter.may_match("deploy_app_now"));
        assert!(!prefilter.may_match("deploy_app"));
    }

    #[test]
    fn fuzzy_prefilter_respects_case_sensitive_queries() {
        let prefilter = FuzzyLinePrefilter::new("API", true).expect("应创建预过滤器");
        assert!(prefilter.may_match("call API now"));
        assert!(!prefilter.may_match("call api now"));
    }

    #[test]
    fn fuzzy_prefilter_requires_cjk_chars_at_line_level() {
        let prefilter = FuzzyLinePrefilter::new("部署a", false).expect("应创建预过滤器");
        // 行内需同时含 CJK「部」「署」与 ASCII「a」。
        assert!(prefilter.may_match("调用部署模块 a"));
        assert!(!prefilter.may_match("xxa")); // 缺 CJK
        assert!(!prefilter.may_match("部署模块")); // 缺 a
        // 文件级仍只看 ASCII：含 a 即不跳过，避免对非 UTF-8 编码的 CJK 内容误杀。
        assert!(prefilter.bytes_may_match("plain ascii a".as_bytes()));
    }

    #[test]
    fn fuzzy_prefilter_handles_pure_cjk_queries() {
        let prefilter = FuzzyLinePrefilter::new("部署", false).expect("应创建预过滤器");
        assert!(prefilter.may_match("开始部署流程"));
        assert!(!prefilter.may_match("开始流程"));
        // 文件级无 ASCII 要求 -> 不跳过，留待逐行精筛。
        assert!(prefilter.bytes_may_match("任意内容".as_bytes()));
    }

    #[test]
    fn fuzzy_prefilter_rejects_whole_file_missing_required_ascii() {
        let prefilter = FuzzyLinePrefilter::new("dapnow", false).expect("应创建预过滤器");
        // 整文件含全部要求字符 -> 不跳过（交给逐行精筛）
        assert!(prefilter.bytes_may_match(b"deploy_app_now run"));
        // 整文件缺少字符 w -> 直接整文件跳过
        assert!(!prefilter.bytes_may_match(b"deploy app on prod"));
    }
}
