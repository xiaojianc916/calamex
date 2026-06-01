use super::{decode_script_bytes, encode_script_content, resolve_workspace_root, DocumentEncoding};
use ast_grep_core::Pattern as AstPattern;
use ast_grep_language::{LanguageExt, SupportLang};
use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher as GrepMatcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::Lossy, BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use nucleo_matcher::{
    pattern::{CaseMatching, Normalization, Pattern as NucleoPattern},
    Config, Matcher as NucleoMatcher, Utf32Str,
};
use serde::{Deserialize, Serialize};
use similar::TextDiff;
use specta::Type;
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    ops::Range,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tree_sitter::{Node, Parser};

const DEFAULT_SEARCH_LIMIT: usize = 200;
const MAX_SEARCH_LIMIT: usize = 500;
const DEFAULT_REPLACEMENT_FILE_LIMIT: usize = 100;
const MAX_REPLACEMENT_FILE_LIMIT: usize = 500;
const MAX_DIFF_CHARS: usize = 8_000;
const REPLACEMENT_PREVIEW_CONTEXT_CHARS: usize = 32;
const COMPACT_PREVIEW_ELLIPSIS: &str = "…";
const SKIPPED_SEARCH_DIR_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".nuxt",
    ".parcel-cache",
    ".pnpm-store",
    ".turbo",
    ".vite",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
];
const SKIPPED_SEARCH_FILE_NAMES: &[&str] = &[".ds_store", "desktop.ini", "thumbs.db"];
const SKIPPED_SEARCH_EXTENSIONS: &[&str] = &[
    "7z", "a", "app", "avi", "avif", "bin", "bmp", "bz2", "class", "cur", "dat", "dll", "dmg",
    "doc", "docx", "dylib", "eot", "exe", "flac", "gif", "gz", "heic", "icns", "ico", "iso", "jar",
    "jpeg", "jpg", "lib", "lz", "m4a", "mkv", "mov", "mp3", "mp4", "o", "obj", "ogg", "otf", "pdf",
    "pdb", "png", "ppt", "pptx", "pyc", "pyo", "rar", "rlib", "so", "sqlite", "sqlite3", "tar",
    "tgz", "tif", "tiff", "ttf", "wasm", "wav", "webm", "webp", "woff", "woff2", "xls", "xlsx",
    "xz", "zip", "zst",
];

#[derive(Debug, Clone, Deserialize, Type)]
pub enum WorkspaceSearchScope {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "file-name")]
    FileName,
    #[serde(rename = "symbol")]
    Symbol,
    #[serde(rename = "content")]
    Content,
}

impl WorkspaceSearchScope {
    fn includes_file_name(&self) -> bool {
        matches!(self, Self::All | Self::FileName)
    }

    fn includes_content(&self) -> bool {
        matches!(self, Self::All | Self::Content)
    }

    fn includes_symbol(&self) -> bool {
        matches!(self, Self::All | Self::Symbol)
    }

    fn is_all(&self) -> bool {
        matches!(self, Self::All)
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub enum WorkspaceSearchResultKind {
    #[serde(rename = "file-name")]
    FileName,
    #[serde(rename = "content")]
    Content,
    #[serde(rename = "symbol")]
    Symbol,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchRequest {
    pub(crate) workspace_root_path: String,
    pub(crate) query: String,
    pub(crate) scope: WorkspaceSearchScope,
    pub(crate) match_case: bool,
    pub(crate) whole_word: bool,
    pub(crate) use_regex: bool,
    #[serde(default)]
    pub(crate) use_structural: bool,
    #[serde(default)]
    pub(crate) include_patterns: Vec<String>,
    #[serde(default)]
    pub(crate) exclude_patterns: Vec<String>,
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchPayload {
    pub(crate) root_path: String,
    pub(crate) scanned_file_count: u32,
    pub(crate) results: Vec<WorkspaceSearchResult>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) name: String,
    pub(crate) kind: WorkspaceSearchResultKind,
    pub(crate) line_number: Option<u32>,
    pub(crate) line_text: Option<String>,
    pub(crate) match_start: Option<u32>,
    pub(crate) match_end: Option<u32>,
    pub(crate) score: i32,
}

#[derive(Debug, Deserialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementRequest {
    pub(crate) workspace_root_path: String,
    pub(crate) query: String,
    pub(crate) replacement: String,
    pub(crate) match_case: bool,
    pub(crate) whole_word: bool,
    pub(crate) use_regex: bool,
    #[serde(default)]
    pub(crate) use_structural: bool,
    #[serde(default)]
    pub(crate) include_patterns: Vec<String>,
    #[serde(default)]
    pub(crate) exclude_patterns: Vec<String>,
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementExpectedFile {
    pub(crate) path: String,
    pub(crate) before_hash: String,
    #[serde(default)]
    pub(crate) included_match_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementApplyRequest {
    pub(crate) request: WorkspaceReplacementRequest,
    pub(crate) expected_files: Vec<WorkspaceReplacementExpectedFile>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementPreviewPayload {
    pub(crate) root_path: String,
    pub(crate) file_count: u32,
    pub(crate) replacement_count: u32,
    pub(crate) files: Vec<WorkspaceReplacementFilePreview>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementFilePreview {
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) replacement_count: u32,
    pub(crate) before_hash: String,
    pub(crate) after_hash: String,
    pub(crate) diff: String,
    pub(crate) diff_truncated: bool,
    pub(crate) line_previews: Vec<WorkspaceReplacementLinePreview>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementLinePreview {
    pub(crate) id: String,
    pub(crate) line_number: u32,
    pub(crate) before_line: String,
    pub(crate) after_line: String,
    pub(crate) replacement_count: u32,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementApplyPayload {
    pub(crate) root_path: String,
    pub(crate) changed_file_count: u32,
    pub(crate) replacement_count: u32,
    pub(crate) files: Vec<WorkspaceReplacementAppliedFile>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementAppliedFile {
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) replacement_count: u32,
    pub(crate) byte_size: u32,
}

#[derive(Clone)]
struct ScannedFile {
    path: PathBuf,
    relative_path: String,
    name: String,
}

struct PathFilters {
    include: Option<GlobSet>,
    exclude: Option<GlobSet>,
}

struct FileReplacementPreview {
    path: PathBuf,
    relative_path: String,
    replacement_count: usize,
    before_hash: String,
    after_hash: String,
    before_content: String,
    encoding: DocumentEncoding,
    diff: String,
    diff_truncated: bool,
    edits: Vec<ReplacementEdit>,
    line_previews: Vec<WorkspaceReplacementLinePreview>,
}

struct WorkspaceFileCache {
    files: Arc<Vec<ScannedFile>>,
    symbols: Option<Arc<Vec<SymbolEntry>>>,
    dirty: Arc<AtomicBool>,
    _watcher: RecommendedWatcher,
}

struct SymbolEntry {
    path: PathBuf,
    relative_path: String,
    name: String,
    line_number: u32,
}

struct RegexReplacement {
    regex: regex::Regex,
    replacement: String,
}

enum ReplacementPlan {
    Regex(RegexReplacement),
    Structural(AstPattern),
}

#[derive(Clone)]
struct ReplacementEdit {
    range: Range<usize>,
    inserted_text: String,
}

static WORKSPACE_FILE_CACHES: OnceLock<Mutex<HashMap<String, WorkspaceFileCache>>> =
    OnceLock::new();

#[tauri::command]
#[specta::specta]
pub fn search_workspace(payload: WorkspaceSearchRequest) -> Result<WorkspaceSearchPayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.workspace_root_path.clone()))?;
    let query = payload.query.trim().to_string();
    let limit = payload
        .limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .min(MAX_SEARCH_LIMIT);
    let filters = build_path_filters(&payload.include_patterns, &payload.exclude_patterns)?;
    let files = scan_workspace_files(&workspace_root, &filters)?;

    if query.is_empty() {
        return Ok(WorkspaceSearchPayload {
            root_path: workspace_root.to_string_lossy().to_string(),
            scanned_file_count: count_to_u32(files.len(), "扫描文件数")?,
            results: Vec::new(),
        });
    }

    let mut results = Vec::new();
    let include_file_results = !payload.use_structural && payload.scope.includes_file_name();
    let include_content_results = payload.scope.includes_content();
    let include_symbol_results = !payload.use_structural && payload.scope.includes_symbol();

    if include_file_results {
        results.extend(search_file_names(
            &files,
            &query,
            payload.match_case,
            limit,
        )?);
    }

    if include_content_results && (payload.scope.is_all() || results.len() < limit) {
        let content_limit = if payload.scope.is_all() {
            limit
        } else {
            limit - results.len()
        };
        if payload.use_structural {
            results.extend(search_structural_contents(&files, &query, content_limit)?);
        } else {
            results.extend(search_file_contents(
                &files,
                &query,
                &payload,
                content_limit,
            )?);
        }
    }

    if include_symbol_results && (payload.scope.is_all() || results.len() < limit) {
        let symbol_limit = if payload.scope.is_all() {
            limit
        } else {
            limit - results.len()
        };
        results.extend(search_symbols(
            &workspace_root,
            &filters,
            &query,
            payload.match_case,
            symbol_limit,
        )?);
    }

    // 按分数排序以便“全部”视图呈现稳定顺序。注意：all 范围下每个类别已各自限额为
    // limit，这里不再跨类别截断到单个 limit，以免文件名命中（分数恒为大负数）占满名额后，
    // 内容/符号结果被整体挤掉。
    results.sort_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });

    Ok(WorkspaceSearchPayload {
        root_path: workspace_root.to_string_lossy().to_string(),
        scanned_file_count: count_to_u32(files.len(), "扫描文件数")?,
        results,
    })
}

#[tauri::command]
#[specta::specta]
pub fn preview_workspace_replacement(
    payload: WorkspaceReplacementRequest,
) -> Result<WorkspaceReplacementPreviewPayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.workspace_root_path.clone()))?;
    let query = require_replacement_query(&payload.query)?;
    let limit = payload
        .limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_REPLACEMENT_FILE_LIMIT)
        .min(MAX_REPLACEMENT_FILE_LIMIT);
    let filters = build_path_filters(&payload.include_patterns, &payload.exclude_patterns)?;
    let files = scan_workspace_files(&workspace_root, &filters)?;

    let plan = build_replacement_plan(&payload, &query)?;
    let previews = build_replacement_previews(&workspace_root, &files, &payload, &plan, limit)?;
    build_replacement_preview_payload(workspace_root, previews)
}

#[tauri::command]
#[specta::specta]
pub fn apply_workspace_replacement(
    payload: WorkspaceReplacementApplyRequest,
) -> Result<WorkspaceReplacementApplyPayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.request.workspace_root_path.clone()))?;
    let query = require_replacement_query(&payload.request.query)?;
    if payload.expected_files.is_empty() {
        return Err("替换预览已失效，请重新生成预览后再应用。".to_string());
    }

    let mut expected_paths = HashSet::new();
    let mut expected_hashes = HashMap::new();
    let mut expected_included_match_ids = HashMap::new();
    for expected_file in payload.expected_files {
        let file_path = resolve_existing_workspace_file(&workspace_root, &expected_file.path)?;
        if !expected_paths.insert(file_path.clone()) {
            continue;
        }
        expected_included_match_ids.insert(file_path.clone(), expected_file.included_match_ids);
        expected_hashes.insert(file_path, expected_file.before_hash);
    }

    let plan = build_replacement_plan(&payload.request, &query)?;
    let mut applied_files = Vec::new();
    let mut replacement_count = 0usize;
    for file_path in expected_paths {
        let file = scanned_file_from_path(&workspace_root, file_path)?;
        let Some(replacement) =
            build_file_replacement_preview(&workspace_root, &file, &payload.request, &plan)?
        else {
            return Err(format!(
                "文件 {} 已不再命中当前替换规则，请重新生成预览。",
                file.relative_path
            ));
        };

        let expected_hash = expected_hashes
            .get(&file.path)
            .ok_or_else(|| "替换预览状态不完整，请重新生成预览后再应用。".to_string())?;
        if replacement.before_hash != *expected_hash {
            return Err(format!(
                "文件 {} 在预览后已变更，请重新生成预览。",
                replacement.relative_path
            ));
        }

        let included_match_ids = expected_included_match_ids
            .get(&file.path)
            .ok_or_else(|| "替换预览状态不完整，请重新生成预览后再应用。".to_string())?;
        let selected_edits = select_replacement_edits(&replacement, included_match_ids)?;
        if selected_edits.is_empty() {
            continue;
        }
        let after_content = apply_replacement_edits(&replacement.before_content, &selected_edits);
        let selected_replacement_count = selected_edits.len();

        let bytes = encode_script_content(&after_content, &replacement.encoding)
            .map_err(|error| format!("编码替换结果失败({}): {error}", replacement.relative_path))?;
        fs::write(&replacement.path, bytes)
            .map_err(|error| format!("写入替换结果失败({}): {error}", replacement.relative_path))?;
        let byte_size = fs::metadata(&replacement.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        replacement_count += selected_replacement_count;
        applied_files.push(WorkspaceReplacementAppliedFile {
            path: replacement.path.to_string_lossy().to_string(),
            relative_path: replacement.relative_path,
            replacement_count: count_to_u32(selected_replacement_count, "替换数量")?,
            byte_size: u64_to_u32(byte_size, "文件字节数")?,
        });
    }

    applied_files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(WorkspaceReplacementApplyPayload {
        root_path: workspace_root.to_string_lossy().to_string(),
        changed_file_count: count_to_u32(applied_files.len(), "变更文件数")?,
        replacement_count: count_to_u32(replacement_count, "替换数量")?,
        files: applied_files,
    })
}

fn build_path_filters(
    include_patterns: &[String],
    exclude_patterns: &[String],
) -> Result<PathFilters, String> {
    Ok(PathFilters {
        include: build_glob_set(include_patterns)?,
        exclude: build_glob_set(exclude_patterns)?,
    })
}

fn build_glob_set(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    let cleaned_patterns: Vec<&str> = patterns
        .iter()
        .map(|pattern| pattern.trim())
        .filter(|pattern| !pattern.is_empty())
        .collect();

    if cleaned_patterns.is_empty() {
        return Ok(None);
    }

    let mut builder = GlobSetBuilder::new();
    for pattern in cleaned_patterns {
        builder.add(Glob::new(pattern).map_err(|error| format!("路径过滤规则无效：{error}"))?);
    }
    builder
        .build()
        .map(Some)
        .map_err(|error| format!("路径过滤规则无效：{error}"))
}

fn require_replacement_query(query: &str) -> Result<String, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("替换前请先输入搜索内容。".to_string());
    }
    Ok(query)
}

fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

fn u64_to_u32(value: u64, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

fn i64_to_i32(value: i64, label: &str) -> Result<i32, String> {
    i32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

fn build_replacement_previews(
    workspace_root: &Path,
    files: &[ScannedFile],
    payload: &WorkspaceReplacementRequest,
    plan: &ReplacementPlan,
    limit: usize,
) -> Result<Vec<FileReplacementPreview>, String> {
    let mut previews = Vec::new();
    for file in files {
        if let Some(preview) = build_file_replacement_preview(workspace_root, file, payload, plan)?
        {
            if previews.len() >= limit {
                return Err(format!(
                    "替换范围超过 {limit} 个文件，请缩小搜索词或路径过滤后重试。"
                ));
            }
            previews.push(preview);
        }
    }

    previews.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(previews)
}

fn build_file_replacement_preview(
    workspace_root: &Path,
    file: &ScannedFile,
    payload: &WorkspaceReplacementRequest,
    plan: &ReplacementPlan,
) -> Result<Option<FileReplacementPreview>, String> {
    let bytes = match fs::read(&file.path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let (content, encoding) = match decode_script_bytes(&bytes) {
        Ok(decoded) => decoded,
        Err(_) => return Ok(None),
    };

    let edits = match plan {
        ReplacementPlan::Structural(pattern) => {
            collect_structural_replacement_edits(file, &content, pattern, &payload.replacement)?
        }
        ReplacementPlan::Regex(regex_replacement) => {
            collect_regex_replacement_edits(&content, regex_replacement)?
        }
    };

    let Some(edits) = edits else {
        return Ok(None);
    };
    let after_content = apply_replacement_edits(&content, &edits);
    if after_content == content {
        return Ok(None);
    }
    let line_previews = build_line_previews(&content, &edits)?;
    let replacement_count = edits.len();

    let before_hash = hash_text(&content);
    let after_hash = hash_text(&after_content);
    let (diff, diff_truncated) =
        build_replacement_diff(&file.relative_path, &content, &after_content);

    Ok(Some(FileReplacementPreview {
        path: file.path.clone(),
        relative_path: relative_path(workspace_root, &file.path),
        replacement_count,
        before_hash,
        after_hash,
        before_content: content,
        encoding,
        diff,
        diff_truncated,
        edits,
        line_previews,
    }))
}

fn build_replacement_preview_payload(
    workspace_root: PathBuf,
    previews: Vec<FileReplacementPreview>,
) -> Result<WorkspaceReplacementPreviewPayload, String> {
    let replacement_count = previews
        .iter()
        .try_fold(0usize, |total, file| {
            total.checked_add(file.replacement_count)
        })
        .ok_or_else(|| "替换数量超出支持范围。".to_string())?;
    let files = previews
        .into_iter()
        .map(|file| {
            Ok(WorkspaceReplacementFilePreview {
                path: file.path.to_string_lossy().to_string(),
                relative_path: file.relative_path,
                replacement_count: count_to_u32(file.replacement_count, "替换数量")?,
                before_hash: file.before_hash,
                after_hash: file.after_hash,
                diff: file.diff,
                diff_truncated: file.diff_truncated,
                line_previews: file.line_previews,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(WorkspaceReplacementPreviewPayload {
        root_path: workspace_root.to_string_lossy().to_string(),
        file_count: count_to_u32(files.len(), "文件数量")?,
        replacement_count: count_to_u32(replacement_count, "替换数量")?,
        files,
    })
}

fn build_replacement_plan(
    payload: &WorkspaceReplacementRequest,
    query: &str,
) -> Result<ReplacementPlan, String> {
    if payload.use_structural {
        return Ok(ReplacementPlan::Structural(build_structural_pattern(
            query,
        )?));
    }

    build_regex_replacement(payload, query).map(ReplacementPlan::Regex)
}

fn build_regex_replacement(
    payload: &WorkspaceReplacementRequest,
    query: &str,
) -> Result<RegexReplacement, String> {
    let pattern = build_regex_pattern(query, payload.use_regex, payload.whole_word);
    let regex = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!payload.match_case)
        .unicode(true)
        .build()
        .map_err(|error| format!("替换表达式无效：{error}"))?;
    let replacement = if payload.use_regex {
        payload.replacement.clone()
    } else {
        payload.replacement.replace('$', "$$")
    };

    Ok(RegexReplacement { regex, replacement })
}

fn build_regex_pattern(query: &str, use_regex: bool, whole_word: bool) -> String {
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    if whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    }
}

fn collect_regex_replacement_edits(
    content: &str,
    replacement: &RegexReplacement,
) -> Result<Option<Vec<ReplacementEdit>>, String> {
    let mut edits = Vec::new();
    for captures in replacement.regex.captures_iter(content) {
        let Some(found) = captures.get(0) else {
            continue;
        };
        if found.start() == found.end() {
            return Err("替换表达式不能匹配空字符串。".to_string());
        }

        let mut inserted_text = String::new();
        captures.expand(replacement.replacement.as_str(), &mut inserted_text);
        edits.push(ReplacementEdit {
            range: found.start()..found.end(),
            inserted_text,
        });
    }

    if edits.is_empty() {
        return Ok(None);
    }

    Ok(Some(edits))
}

fn build_structural_pattern(query: &str) -> Result<AstPattern, String> {
    AstPattern::try_new(query, SupportLang::Bash)
        .map_err(|error| format!("结构化搜索模式无效：{error}"))
}

fn collect_structural_replacement_edits(
    file: &ScannedFile,
    content: &str,
    pattern: &AstPattern,
    replacement: &str,
) -> Result<Option<Vec<ReplacementEdit>>, String> {
    if !is_shell_like_file(file) {
        return Ok(None);
    }

    let lang = SupportLang::Bash;
    let root = lang.ast_grep(content);
    let mut edits = root
        .root()
        .find_all(pattern)
        .map(|node_match| {
            let edit = node_match.make_edit(pattern, &replacement);
            let inserted_text = String::from_utf8(edit.inserted_text)
                .map_err(|error| format!("结构化替换模板生成失败：{error}"))?;
            Ok(ReplacementEdit {
                range: edit.position..edit.position + edit.deleted_length,
                inserted_text,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    edits = retain_non_overlapping_edits(edits);
    if edits.is_empty() {
        return Ok(None);
    }

    Ok(Some(edits))
}

fn apply_replacement_edits(content: &str, edits: &[ReplacementEdit]) -> String {
    let mut after_content = content.to_string();
    for edit in edits.iter().rev() {
        after_content.replace_range(edit.range.clone(), &edit.inserted_text);
    }
    after_content
}

fn retain_non_overlapping_edits(mut edits: Vec<ReplacementEdit>) -> Vec<ReplacementEdit> {
    edits.sort_by(|left, right| {
        left.range
            .start
            .cmp(&right.range.start)
            .then_with(|| right.range.end.cmp(&left.range.end))
    });

    let mut retained = Vec::new();
    let mut previous_end = 0usize;
    for edit in edits {
        if edit.range.start < previous_end {
            continue;
        }

        previous_end = edit.range.end;
        retained.push(edit);
    }

    retained
}

fn select_replacement_edits(
    replacement: &FileReplacementPreview,
    included_match_ids: &[String],
) -> Result<Vec<ReplacementEdit>, String> {
    if included_match_ids.is_empty() {
        return Ok(replacement.edits.clone());
    }

    let included = included_match_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let line_starts = compute_line_start_offsets(&replacement.before_content);
    let selected = replacement
        .edits
        .iter()
        .map(|edit| {
            let line_number = line_number_from_starts(&line_starts, edit.range.start)?;
            let id = replacement_edit_preview_id(line_number, edit);
            Ok(included.contains(id.as_str()).then(|| edit.clone()))
        })
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    Ok(selected)
}

fn build_line_previews(
    before_content: &str,
    edits: &[ReplacementEdit],
) -> Result<Vec<WorkspaceReplacementLinePreview>, String> {
    let line_starts = compute_line_start_offsets(before_content);
    edits
        .iter()
        .map(|edit| {
            let line_number = line_number_from_starts(&line_starts, edit.range.start)?;
            let line_range =
                line_bounds_from_starts(&line_starts, before_content, edit.range.start);
            let line = &before_content[line_range.clone()];
            let match_start = edit.range.start.saturating_sub(line_range.start);
            let match_end = edit
                .range
                .end
                .saturating_sub(line_range.start)
                .min(line.len());
            let (before_line, after_line) =
                build_single_match_preview(line, match_start, match_end, &edit.inserted_text)
                    .ok_or_else(|| "构建替换预览失败。".to_string())?;
            Ok(WorkspaceReplacementLinePreview {
                id: replacement_edit_preview_id(line_number, edit),
                line_number,
                before_line,
                after_line,
                replacement_count: 1,
            })
        })
        .collect()
}

/// 预计算每一行起始字节偏移（含首行 0），便于用二分查找将字节偏移映射到行号/行范围，
/// 避免对每个编辑都从头扫描换行符。
fn compute_line_start_offsets(content: &str) -> Vec<usize> {
    let mut starts = Vec::with_capacity(16);
    starts.push(0);
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(index + 1);
        }
    }
    starts
}

fn line_number_from_starts(line_starts: &[usize], byte_offset: usize) -> Result<u32, String> {
    let line_number = line_starts
        .partition_point(|&start| start <= byte_offset)
        .max(1);
    count_to_u32(line_number, "行号")
}

fn line_bounds_from_starts(
    line_starts: &[usize],
    content: &str,
    byte_offset: usize,
) -> Range<usize> {
    if content.is_empty() {
        return 0..0;
    }

    let safe_offset = byte_offset.min(content.len());
    let line_index = line_starts
        .partition_point(|&start| start <= safe_offset)
        .saturating_sub(1);
    let start = line_starts.get(line_index).copied().unwrap_or(0);
    let end = line_starts
        .get(line_index + 1)
        .map(|&next_start| next_start.saturating_sub(1))
        .unwrap_or(content.len());
    start..end
}

fn line_range_at_byte_offset(content: &str, byte_offset: usize) -> Range<usize> {
    if content.is_empty() {
        return 0..0;
    }

    let safe_offset = byte_offset.min(content.len());
    let start = content[..safe_offset]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let end = content[safe_offset..]
        .find('\n')
        .map(|index| safe_offset + index)
        .unwrap_or(content.len());
    start..end
}

fn build_single_match_preview(
    line: &str,
    match_start: usize,
    match_end: usize,
    inserted_text: &str,
) -> Option<(String, String)> {
    if match_start > match_end || match_end > line.len() {
        return None;
    }

    let prefix = &line[..match_start];
    let matched = &line[match_start..match_end];
    let suffix = &line[match_end..];
    let prefix_preview = trailing_chars(prefix, REPLACEMENT_PREVIEW_CONTEXT_CHARS);
    let suffix_preview = leading_chars(suffix, REPLACEMENT_PREVIEW_CONTEXT_CHARS);
    let before_ellipsis = if prefix.chars().count() > REPLACEMENT_PREVIEW_CONTEXT_CHARS {
        COMPACT_PREVIEW_ELLIPSIS
    } else {
        ""
    };
    let after_ellipsis = if suffix.chars().count() > REPLACEMENT_PREVIEW_CONTEXT_CHARS {
        COMPACT_PREVIEW_ELLIPSIS
    } else {
        ""
    };
    let before_line = format!(
        "{before_ellipsis}{prefix_preview}{}{suffix_preview}{after_ellipsis}",
        single_line_preview_text(matched)
    );
    let after_line = format!(
        "{before_ellipsis}{prefix_preview}{}{suffix_preview}{after_ellipsis}",
        single_line_preview_text(inserted_text)
    );

    if before_line == after_line {
        return None;
    }

    Some((before_line, after_line))
}

fn leading_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn trailing_chars(value: &str, limit: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    chars
        .iter()
        .skip(chars.len().saturating_sub(limit))
        .copied()
        .collect()
}

fn single_line_preview_text(value: &str) -> String {
    value.replace('\r', "").replace('\n', "\\n")
}

fn replacement_edit_preview_id(line_number: u32, edit: &ReplacementEdit) -> String {
    format!(
        "match:{line_number}:{}:{}:{}",
        edit.range.start,
        edit.range.end,
        hash_text(&edit.inserted_text)
    )
}

fn build_replacement_diff(
    relative_path: &str,
    before_content: &str,
    after_content: &str,
) -> (String, bool) {
    let before_label = format!("a/{relative_path}");
    let after_label = format!("b/{relative_path}");
    let diff = TextDiff::from_lines(before_content, after_content)
        .unified_diff()
        .context_radius(2)
        .header(&before_label, &after_label)
        .to_string();
    truncate_diff(diff)
}

fn truncate_diff(diff: String) -> (String, bool) {
    if diff.chars().count() <= MAX_DIFF_CHARS {
        return (diff, false);
    }

    let mut truncated = diff.chars().take(MAX_DIFF_CHARS).collect::<String>();
    truncated.push_str("\n... Diff 已截断，请缩小替换范围查看完整上下文 ...");
    (truncated, true)
}

fn resolve_existing_workspace_file(
    workspace_root: &Path,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw_path)
        .canonicalize()
        .map_err(|error| format!("解析替换文件失败：{error}"))?;
    if !path.starts_with(workspace_root) {
        return Err("仅允许替换当前工作区内的文件。".to_string());
    }
    if !path.is_file() {
        return Err("替换目标不是有效文件。".to_string());
    }
    Ok(path)
}

fn scanned_file_from_path(workspace_root: &Path, path: PathBuf) -> Result<ScannedFile, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法解析替换文件名。".to_string())?
        .to_string();
    Ok(ScannedFile {
        relative_path: relative_path(workspace_root, &path),
        path,
        name,
    })
}

fn scan_workspace_files(root: &Path, filters: &PathFilters) -> Result<Vec<ScannedFile>, String> {
    let files = workspace_cache_files(root)?;
    Ok(files
        .iter()
        .filter(|file| passes_path_filters(&file.relative_path, filters))
        .cloned()
        .collect())
}

fn workspace_cache_files(root: &Path) -> Result<Arc<Vec<ScannedFile>>, String> {
    let cache_key = root.to_string_lossy().to_string();
    let caches = WORKSPACE_FILE_CACHES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = caches
        .lock()
        .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;

    if let Some(cache) = guard.get_mut(&cache_key) {
        if cache.dirty.swap(false, Ordering::AcqRel) {
            cache.files = Arc::new(scan_workspace_files_uncached(root)?);
            cache.symbols = None;
        }
        return Ok(Arc::clone(&cache.files));
    }

    let dirty = Arc::new(AtomicBool::new(false));
    let watcher_dirty = Arc::clone(&dirty);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok() {
            watcher_dirty.store(true, Ordering::Release);
        }
    })
    .map_err(|error| format!("启动工作区文件监听失败：{error}"))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|error| format!("监听工作区文件变化失败：{error}"))?;

    let files = Arc::new(scan_workspace_files_uncached(root)?);
    guard.insert(
        cache_key,
        WorkspaceFileCache {
            files: Arc::clone(&files),
            symbols: None,
            dirty,
            _watcher: watcher,
        },
    );
    Ok(files)
}

/// 返回当前工作区的 Bash 符号索引，复用文件列表的 dirty 失效机制缓存解析结果，
/// 避免每次搜索都重新跑 tree-sitter 全量解析。解析在不持锁的情况下进行。
fn workspace_cache_symbols(root: &Path) -> Result<Arc<Vec<SymbolEntry>>, String> {
    let cache_key = root.to_string_lossy().to_string();
    let caches = WORKSPACE_FILE_CACHES.get_or_init(|| Mutex::new(HashMap::new()));

    {
        let guard = caches
            .lock()
            .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;
        if let Some(cache) = guard.get(&cache_key) {
            if let Some(symbols) = &cache.symbols {
                return Ok(Arc::clone(symbols));
            }
        }
    }

    // 确保文件列表已建立；dirty 时这里会刷新文件列表并清空旧的符号缓存。
    let files = workspace_cache_files(root)?;
    let symbols = Arc::new(collect_workspace_symbols(files.as_slice())?);

    let mut guard = caches
        .lock()
        .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;
    if let Some(cache) = guard.get_mut(&cache_key) {
        cache.symbols = Some(Arc::clone(&symbols));
    }
    Ok(symbols)
}

fn scan_workspace_files_uncached(root: &Path) -> Result<Vec<ScannedFile>, String> {
    let filter_root = root.to_path_buf();
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(true)
        .hidden(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            let is_dir = entry
                .file_type()
                .is_some_and(|file_type| file_type.is_dir());
            !is_unsearchable_workspace_path(&filter_root, entry.path(), is_dir)
        });

    let mut files = Vec::new();
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }

        let path = entry.into_path();
        let relative_path = relative_path(root, &path);

        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();

        files.push(ScannedFile {
            path,
            relative_path,
            name,
        });
    }

    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

fn is_unsearchable_workspace_path(root: &Path, path: &Path, is_dir: bool) -> bool {
    if path == root {
        return false;
    }

    let Some(file_name) = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
    else {
        return true;
    };

    if is_dir {
        return SKIPPED_SEARCH_DIR_NAMES.contains(&file_name.as_str());
    }

    if SKIPPED_SEARCH_FILE_NAMES.contains(&file_name.as_str()) {
        return true;
    }

    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            SKIPPED_SEARCH_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
        .unwrap_or(false)
}

fn passes_path_filters(relative_path: &str, filters: &PathFilters) -> bool {
    if let Some(include) = &filters.include {
        if !include.is_match(relative_path) {
            return false;
        }
    }

    if let Some(exclude) = &filters.exclude {
        if exclude.is_match(relative_path) {
            return false;
        }
    }

    true
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn hash_text(value: &str) -> String {
    format!("blake3:{}", blake3::hash(value.as_bytes()).to_hex())
}

fn search_file_names(
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

fn search_file_contents(
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

fn search_structural_contents(
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

fn search_symbols(
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

fn collect_workspace_symbols(files: &[ScannedFile]) -> Result<Vec<SymbolEntry>, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .map_err(|error| format!("初始化 Bash 符号解析器失败：{error}"))?;

    let mut symbols = Vec::new();
    for file in files.iter().filter(|file| is_shell_like_file(file)) {
        let bytes = match fs::read(&file.path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let Ok((content, _encoding)) = decode_script_bytes(&bytes) else {
            continue;
        };
        let Some(tree) = parser.parse(&content, None) else {
            continue;
        };

        collect_symbols_from_node(tree.root_node(), content.as_bytes(), file, &mut symbols);
    }

    Ok(symbols)
}

fn collect_symbols_from_node(
    node: Node<'_>,
    source: &[u8],
    file: &ScannedFile,
    symbols: &mut Vec<SymbolEntry>,
) {
    if node.kind() == "function_definition" {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(source) {
                if let Ok(line_number) = count_to_u32(name_node.start_position().row + 1, "行号")
                {
                    symbols.push(SymbolEntry {
                        path: file.path.clone(),
                        relative_path: file.relative_path.clone(),
                        name: name.to_string(),
                        line_number,
                    });
                }
            }
        }
    }

    for child_index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(child_index as u32) {
            collect_symbols_from_node(child, source, file, symbols);
        }
    }
}

fn is_shell_like_file(file: &ScannedFile) -> bool {
    let extension = file
        .path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    matches!(
        extension.as_deref(),
        Some("sh" | "bash" | "zsh" | "ksh" | "bats")
    ) || file.name.eq_ignore_ascii_case("bashrc")
        || file.name.eq_ignore_ascii_case(".bashrc")
        || file.name.eq_ignore_ascii_case(".profile")
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

fn trim_line(line: &str) -> String {
    line.trim_end_matches(['\r', '\n']).to_string()
}

fn byte_to_char_offset(value: &str, byte_offset: usize) -> usize {
    value[..byte_offset.min(value.len())].chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, process,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_workspace(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root =
            env::temp_dir().join(format!("calamex-search-{name}-{}-{suffix}", process::id()));
        fs::create_dir_all(&root).expect("应能创建测试工作区");
        root.canonicalize().expect("应能解析测试工作区")
    }

    fn write_workspace_file(root: &Path, relative_path: &str, content: &str) -> PathBuf {
        let path = root.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("应能创建测试目录");
        }
        fs::write(&path, content.as_bytes()).expect("应能写入测试文件");
        path.canonicalize().expect("应能解析测试文件")
    }

    fn replacement_request(
        root: &Path,
        query: &str,
        replacement: &str,
        use_regex: bool,
        use_structural: bool,
    ) -> WorkspaceReplacementRequest {
        WorkspaceReplacementRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: query.to_string(),
            replacement: replacement.to_string(),
            match_case: true,
            whole_word: false,
            use_regex,
            use_structural,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        }
    }

    fn expected_files(
        preview: &WorkspaceReplacementPreviewPayload,
    ) -> Vec<WorkspaceReplacementExpectedFile> {
        preview
            .files
            .iter()
            .map(|file| WorkspaceReplacementExpectedFile {
                path: file.path.clone(),
                before_hash: file.before_hash.clone(),
                included_match_ids: Vec::new(),
            })
            .collect()
    }

    fn cleanup_workspace(root: PathBuf) {
        if let Some(caches) = WORKSPACE_FILE_CACHES.get() {
            if let Ok(mut guard) = caches.lock() {
                guard.remove(&root.to_string_lossy().to_string());
            }
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plain_replacement_keeps_dollar_literal() {
        let root = temp_workspace("plain");
        let file = write_workspace_file(&root, "script.sh", "echo \"$HOME\"\necho \"$HOME\"\n");
        let request = replacement_request(&root, "$HOME", "$PATH", false, false);

        let preview = preview_workspace_replacement(request.clone()).expect("应能生成替换预览");
        assert_eq!(preview.file_count, 1);
        assert_eq!(preview.replacement_count, 2);
        assert!(preview.files[0].diff.contains("$PATH"));

        let expected_files = expected_files(&preview);
        let applied = apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files,
        })
        .expect("应能应用替换");
        assert_eq!(applied.changed_file_count, 1);
        assert_eq!(applied.replacement_count, 2);
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "echo \"$PATH\"\necho \"$PATH\"\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn regex_replacement_expands_capture_groups() {
        let root = temp_workspace("regex");
        let file = write_workspace_file(&root, "script.sh", "echo foo-12\necho foo-34\n");
        let request = replacement_request(&root, r"foo-(\d+)", "bar-$1", true, false);

        let preview = preview_workspace_replacement(request.clone()).expect("应能生成正则替换预览");
        assert_eq!(preview.file_count, 1);
        assert_eq!(preview.replacement_count, 2);
        assert_eq!(preview.files[0].line_previews.len(), 2);
        assert_eq!(preview.files[0].line_previews[0].before_line, "echo foo-12");
        assert_eq!(preview.files[0].line_previews[0].after_line, "echo bar-12");

        let expected_files = expected_files(&preview);
        apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files,
        })
        .expect("应能应用正则替换");
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "echo bar-12\necho bar-34\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn replacement_preview_keeps_matches_on_same_line_separate() {
        let root = temp_workspace("same-line-preview");
        let file = write_workspace_file(&root, "script.sh", "echo old old\n");
        let request = replacement_request(&root, "old", "new", false, false);

        let preview = preview_workspace_replacement(request.clone()).expect("应能生成替换预览");
        let line_previews = &preview.files[0].line_previews;
        assert_eq!(preview.replacement_count, 2);
        assert_eq!(line_previews.len(), 2);
        assert_eq!(line_previews[0].replacement_count, 1);
        assert_eq!(line_previews[1].replacement_count, 1);
        assert_ne!(line_previews[0].id, line_previews[1].id);
        assert_eq!(line_previews[0].before_line, "echo old old");
        assert_eq!(line_previews[0].after_line, "echo new old");
        assert_eq!(line_previews[1].before_line, "echo old old");
        assert_eq!(line_previews[1].after_line, "echo old new");

        apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files: vec![WorkspaceReplacementExpectedFile {
                path: preview.files[0].path.clone(),
                before_hash: preview.files[0].before_hash.clone(),
                included_match_ids: vec![line_previews[0].id.clone()],
            }],
        })
        .expect("应能只替换同一行中的单个命中");
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "echo new old\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn replacement_can_apply_single_preview_line() {
        let root = temp_workspace("single-line");
        let file = write_workspace_file(&root, "script.sh", "echo old\necho old\n");
        let request = replacement_request(&root, "old", "new", false, false);

        let preview = preview_workspace_replacement(request.clone()).expect("应能生成替换预览");
        let first_line = preview.files[0].line_previews[0].id.clone();
        apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files: vec![WorkspaceReplacementExpectedFile {
                path: preview.files[0].path.clone(),
                before_hash: preview.files[0].before_hash.clone(),
                included_match_ids: vec![first_line],
            }],
        })
        .expect("应能只应用单行替换");
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "echo new\necho old\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn content_search_returns_each_match_on_same_line() {
        let root = temp_workspace("same-line-search");
        write_workspace_file(&root, "script.sh", "echo needle needle\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "needle".to_string(),
            scope: WorkspaceSearchScope::Content,
            match_case: true,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        })
        .expect("应能搜索工作区");

        assert_eq!(payload.results.len(), 2);
        assert_eq!(payload.results[0].line_number, Some(1));
        assert_eq!(payload.results[0].match_start, Some(5));
        assert_eq!(payload.results[0].match_end, Some(11));
        assert_eq!(payload.results[1].line_number, Some(1));
        assert_eq!(payload.results[1].match_start, Some(12));
        assert_eq!(payload.results[1].match_end, Some(18));

        cleanup_workspace(root);
    }

    #[test]
    fn structural_search_returns_match_range_for_compact_preview() {
        let root = temp_workspace("structural-range");
        write_workspace_file(&root, "script.sh", "prefix\nfoo 123\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "foo $A".to_string(),
            scope: WorkspaceSearchScope::Content,
            match_case: true,
            whole_word: false,
            use_regex: false,
            use_structural: true,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        })
        .expect("应能执行结构化搜索");

        assert_eq!(payload.results.len(), 1);
        assert_eq!(payload.results[0].line_number, Some(2));
        assert_eq!(payload.results[0].line_text.as_deref(), Some("foo 123"));
        assert_eq!(payload.results[0].match_start, Some(0));
        assert_eq!(payload.results[0].match_end, Some(7));

        cleanup_workspace(root);
    }

    #[test]
    fn search_skips_git_objects_and_binary_assets_from_source() {
        let root = temp_workspace("skip-binary");
        write_workspace_file(&root, ".git/objects/16/hash", "needle\n");
        write_workspace_file(&root, "asset.png", "needle\n");
        let script = write_workspace_file(&root, "script.sh", "needle\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "needle".to_string(),
            scope: WorkspaceSearchScope::All,
            match_case: true,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        })
        .expect("应能搜索工作区");

        assert!(payload
            .results
            .iter()
            .any(|result| result.path == script.to_string_lossy()));
        assert!(!payload
            .results
            .iter()
            .any(|result| result.relative_path.starts_with(".git/")));
        assert!(!payload
            .results
            .iter()
            .any(|result| result.relative_path == "asset.png"));

        cleanup_workspace(root);
    }

    #[test]
    fn structural_replacement_uses_bash_ast_grep() {
        let root = temp_workspace("structural");
        let file = write_workspace_file(&root, "script.sh", "foo 1\nfoo 2\nbar 3\n");
        let request = replacement_request(&root, "foo $A", "baz $A", false, true);

        let preview =
            preview_workspace_replacement(request.clone()).expect("应能生成结构化替换预览");
        assert_eq!(preview.file_count, 1);
                assert_eq!(preview.replacement_count, 2);

        let expected_files = expected_files(&preview);
        apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files,
        })
        .expect("应能应用结构化替换");
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "baz 1\nbaz 2\nbar 3\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn apply_replacement_rejects_changed_file_after_preview() {
        let root = temp_workspace("hash");
        let file = write_workspace_file(&root, "script.sh", "echo old\n");
        let request = replacement_request(&root, "old", "new", false, false);
        let preview = preview_workspace_replacement(request.clone()).expect("应能生成替换预览");
        let expected_files = expected_files(&preview);

        fs::write(&file, b"echo old\n# changed\n").expect("应能模拟预览后的文件变更");
        let error = match apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files,
        }) {
            Ok(_) => panic!("文件变更后应拒绝应用旧预览"),
            Err(error) => error,
        };
        assert!(error.contains("已变更"));

        cleanup_workspace(root);
    }

    #[test]
    fn symbol_search_returns_function_definitions() {
        let root = temp_workspace("symbol");
        write_workspace_file(&root, "script.sh", "deploy_app() {\n    echo deploy\n}\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "deploy_app".to_string(),
            scope: WorkspaceSearchScope::Symbol,
            match_case: false,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        })
        .expect("应能执行符号搜索");

        assert!(payload.results.iter().any(|result| {
            matches!(result.kind, WorkspaceSearchResultKind::Symbol)
                && result.name == "deploy_app"
                && result.line_number == Some(1)
        }));

        cleanup_workspace(root);
    }

    #[test]
    fn all_scope_keeps_content_results_when_file_name_matches_fill_limit() {
        let root = temp_workspace("all-scope-limit");
        write_workspace_file(&root, "needle_a.txt", "alpha\n");
        write_workspace_file(&root, "needle_b.txt", "beta\n");
        write_workspace_file(&root, "needle_c.txt", "gamma\n");
        let content_file = write_workspace_file(&root, "content.sh", "echo needle\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "needle".to_string(),
            scope: WorkspaceSearchScope::All,
            match_case: false,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(2),
        })
        .expect("应能执行全部范围搜索");

        // 文件名命中已占满 limit=2，但 all 范围下内容结果仍应保留（修复前会被整体截断丢掉）。
        assert!(payload.results.iter().any(|result| {
            matches!(result.kind, WorkspaceSearchResultKind::Content)
                && result.path == content_file.to_string_lossy()
        }));

        cleanup_workspace(root);
    }
}