use super::super::decode_script_bytes;
use super::util::count_to_u32;
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tree_sitter::{Node, Parser};

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

#[derive(Clone)]
pub(super) struct ScannedFile {
    pub(super) path: PathBuf,
    pub(super) relative_path: String,
    pub(super) name: String,
}

pub(super) struct PathFilters {
    include: Option<GlobSet>,
    exclude: Option<GlobSet>,
}

pub(super) struct WorkspaceFileCache {
    files: Arc<Vec<ScannedFile>>,
    symbols: Option<Arc<Vec<SymbolEntry>>>,
    dirty: Arc<AtomicBool>,
    _watcher: RecommendedWatcher,
}

pub(super) struct SymbolEntry {
    pub(super) path: PathBuf,
    pub(super) relative_path: String,
    pub(super) name: String,
    pub(super) line_number: u32,
}

pub(super) static WORKSPACE_FILE_CACHES: OnceLock<Mutex<HashMap<String, WorkspaceFileCache>>> =
    OnceLock::new();

pub(super) fn build_path_filters(
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

pub(super) fn scan_workspace_files(
    root: &Path,
    filters: &PathFilters,
) -> Result<Vec<ScannedFile>, String> {
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
pub(super) fn workspace_cache_symbols(root: &Path) -> Result<Arc<Vec<SymbolEntry>>, String> {
    let cache_key = root.to_string_lossy().to_string();
    let caches = WORKSPACE_FILE_CACHES.get_or_init(|| Mutex::new(HashMap::new()));

    {
        let guard = caches
            .lock()
            .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;
        if let Some(cache) = guard.get(&cache_key)
            && let Some(symbols) = &cache.symbols
        {
            return Ok(Arc::clone(symbols));
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

pub(super) fn passes_path_filters(relative_path: &str, filters: &PathFilters) -> bool {
    if let Some(include) = &filters.include
        && !include.is_match(relative_path)
    {
        return false;
    }

    if let Some(exclude) = &filters.exclude
        && exclude.is_match(relative_path)
    {
        return false;
    }

    true
}

pub(super) fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(super) fn scanned_file_from_path(
    workspace_root: &Path,
    path: PathBuf,
) -> Result<ScannedFile, String> {
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

pub(super) fn resolve_existing_workspace_file(
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

pub(super) fn is_shell_like_file(file: &ScannedFile) -> bool {
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
    if node.kind() == "function_definition"
        && let Some(name_node) = node.child_by_field_name("name")
        && let Ok(name) = name_node.utf8_text(source)
        && let Ok(line_number) = count_to_u32(name_node.start_position().row + 1, "行号")
    {
        symbols.push(SymbolEntry {
            path: file.path.clone(),
            relative_path: file.relative_path.clone(),
            name: name.to_string(),
            line_number,
        });
    }

    for child_index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(child_index as u32) {
            collect_symbols_from_node(child, source, file, symbols);
        }
    }
}
