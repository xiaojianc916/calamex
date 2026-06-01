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

    // 按分数排序以便“全部”视图呈现稳定顺序。注意：all 范围下每个类别已
    // 各自限额为 limit，这里故意不再跨类别截断到单个 limit，以免文件名命中
    // （分数恒为大负数）占满名额后，内容/符号结果被整体挤掉。
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
            .map_err(|error| format!("写入替换结果失败({}): {error}