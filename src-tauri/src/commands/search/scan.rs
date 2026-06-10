use super::super::decode_script_bytes;
use super::util::count_to_u32;
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rayon::prelude::*;
use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    ffi::OsStr,
    fs,
    hash::{Hash, Hasher},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::UNIX_EPOCH,
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
const MAX_INCREMENTAL_SEARCH_EVENT_PATHS: usize = 512;

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

impl PathFilters {
    /// 是否完全没有 include/exclude 规则。无规则时调用方可直接复用缓存的文件清单，
    /// 跳过对整份 ScannedFile 列表的深拷贝。
    fn is_empty(&self) -> bool {
        self.include.is_none() && self.exclude.is_none()
    }
}

pub(super) struct WorkspaceFileCache {
    files: Arc<Vec<ScannedFile>>,
    symbols: Option<Arc<Vec<SymbolEntry>>>,
    symbol_files: HashMap<String, CachedSymbolFile>,
    dirty: Arc<AtomicBool>,
    changed_paths: Arc<Mutex<Vec<PathBuf>>>,
    _watcher: RecommendedWatcher,
}

#[derive(Clone)]
pub(super) struct SymbolEntry {
    pub(super) path: PathBuf,
    pub(super) relative_path: String,
    pub(super) name: String,
    pub(super) line_number: u32,
}

#[derive(Clone, PartialEq, Eq)]
struct SymbolFileFingerprint {
    len: u64,
    modified_nanos: Option<u128>,
    content_hash: Option<u64>,
}

#[derive(Clone)]
struct CachedSymbolFile {
    fingerprint: SymbolFileFingerprint,
    symbols: Vec<SymbolEntry>,
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
) -> Result<Arc<Vec<ScannedFile>>, String> {
    let files = workspace_cache_files(root)?;
    // 无路径过滤（最常见路径）时直接复用缓存的 Arc，避免每次按键搜索都深拷贝整份文件清单
    // （每个 ScannedFile 含 PathBuf + 2×String，大仓下一次搜索可产生十几万次堆分配）。
    if filters.is_empty() {
        return Ok(files);
    }
    Ok(Arc::new(
        files
            .iter()
            .filter(|file| passes_path_filters(&file.relative_path, filters))
            .cloned()
            .collect(),
    ))
}

fn workspace_cache_files(root: &Path) -> Result<Arc<Vec<ScannedFile>>, String> {
    let cache_key = root.to_string_lossy().to_string();
    let caches = WORKSPACE_FILE_CACHES.get_or_init(|| Mutex::new(HashMap::new()));

    // 持锁只做轻量判断：命中且未脏直接返回缓存；命中但脏则取出增量刷新所需的数据后立即
    // 释放锁，把可能很重的目录遍历放到锁外执行，避免单个全局锁在整目录 walk 期间阻塞
    // 其它（乃至其它工作区的）搜索。
    enum CacheAction {
        Fresh(Arc<Vec<ScannedFile>>),
        Refresh {
            current: Arc<Vec<ScannedFile>>,
            changed_paths: Vec<PathBuf>,
        },
        Missing,
    }

    let action = {
        let mut guard = caches
            .lock()
            .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;
        match guard.get_mut(&cache_key) {
            Some(cache) => {
                if cache.dirty.swap(false, Ordering::AcqRel) {
                    let changed_paths = cache
                        .changed_paths
                        .lock()
                        .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?
                        .drain(..)
                        .collect::<Vec<_>>();
                    CacheAction::Refresh {
                        current: Arc::clone(&cache.files),
                        changed_paths,
                    }
                } else {
                    CacheAction::Fresh(Arc::clone(&cache.files))
                }
            }
            None => CacheAction::Missing,
        }
    };

    match action {
        CacheAction::Fresh(files) => Ok(files),
        CacheAction::Refresh {
            current,
            changed_paths,
        } => {
            // 锁外执行增量刷新（必要时回退为全量重扫）。
            let refreshed = Arc::new(refresh_workspace_files(
                root,
                current.as_slice(),
                changed_paths,
            )?);
            let mut guard = caches
                .lock()
                .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;
            if let Some(cache) = guard.get_mut(&cache_key) {
                cache.files = Arc::clone(&refreshed);
                // 文件列表变化只使聚合符号索引过期；per-file 符号缓存保留，后续按 mtime/hash 复用。
                cache.symbols = None;
            }
            Ok(refreshed)
        }
        CacheAction::Missing => {
            // 锁外建立 watcher 并执行首次全量扫描。
            let dirty = Arc::new(AtomicBool::new(false));
            let watcher_dirty = Arc::clone(&dirty);
            let changed_paths = Arc::new(Mutex::new(Vec::new()));
            let watcher_changed_paths = Arc::clone(&changed_paths);
            let watcher_root = root.to_path_buf();
            let mut watcher =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    let Ok(event) = event else {
                        return;
                    };
                    // 搜索缓存只关心「会进入搜索索引」的源文件变更。构建产物、依赖目录、
                    // VCS 内部文件等高频噪音即使被底层递归 watcher 上报，也不应把缓存标脏。
                    let changed = event
                        .paths
                        .iter()
                        .filter(|path| !is_unsearchable_event_path(&watcher_root, path))
                        .cloned()
                        .collect::<Vec<_>>();
                    if changed.is_empty() {
                        return;
                    }

                    if let Ok(mut paths) = watcher_changed_paths.lock() {
                        for path in changed {
                            if paths.len() >= MAX_INCREMENTAL_SEARCH_EVENT_PATHS {
                                // 事件风暴下放弃增量路径，下一次搜索走一次全量重扫，优先保证正确性。
                                paths.clear();
                                break;
                            }
                            paths.push(path);
                        }
                    }
                    watcher_dirty.store(true, Ordering::Release);
                })
                .map_err(|error| format!("启动工作区文件监听失败：{error}"))?;
            watcher
                .watch(root, RecursiveMode::Recursive)
                .map_err(|error| format!("监听工作区文件变化失败：{error}"))?;

            let files = Arc::new(scan_workspace_files_uncached(root)?);

            let mut guard = caches
                .lock()
                .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;
            // 双重检查：并发线程可能已在本线程锁外构建期间插入缓存；若已存在则复用它，
            // 丢弃本次新建的 watcher（随作用域结束停止监听），避免重复监听同一工作区。
            if let Some(existing) = guard.get(&cache_key) {
                return Ok(Arc::clone(&existing.files));
            }
            guard.insert(
                cache_key,
                WorkspaceFileCache {
                    files: Arc::clone(&files),
                    symbols: None,
                    symbol_files: HashMap::new(),
                    dirty,
                    changed_paths,
                    _watcher: watcher,
                },
            );
            Ok(files)
        }
    }
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

    // 确保文件列表已建立；dirty 时这里会刷新文件列表并使聚合符号索引过期。
    let files = workspace_cache_files(root)?;
    let cached_symbol_files = {
        let guard = caches
            .lock()
            .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;
        guard
            .get(&cache_key)
            .map(|cache| cache.symbol_files.clone())
            .unwrap_or_default()
    };

    let (symbols, refreshed_symbol_files) =
        collect_workspace_symbols(files.as_slice(), &cached_symbol_files)?;
    let symbols = Arc::new(symbols);

    let mut guard = caches
        .lock()
        .map_err(|_| "搜索索引状态已损坏，请重启应用后重试。".to_string())?;
    if let Some(cache) = guard.get_mut(&cache_key) {
        cache.symbol_files = refreshed_symbol_files;
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

fn refresh_workspace_files(
    root: &Path,
    current: &[ScannedFile],
    changed_paths: Vec<PathBuf>,
) -> Result<Vec<ScannedFile>, String> {
    if changed_paths.is_empty() {
        return scan_workspace_files_uncached(root);
    }

    let mut files = current
        .iter()
        .cloned()
        .map(|file| (file.relative_path.clone(), file))
        .collect::<HashMap<_, _>>();

    for path in changed_paths {
        let path = path.canonicalize().unwrap_or(path);
        let Some(relative) = relativize(root, &path) else {
            return scan_workspace_files_uncached(root);
        };
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        if relative_path.is_empty() {
            return scan_workspace_files_uncached(root);
        }

        if !path.exists() {
            files.remove(&relative_path);
            let prefix = format!("{relative_path}/");
            if files.keys().any(|key| key.starts_with(&prefix)) {
                return scan_workspace_files_uncached(root);
            }
            continue;
        }

        if path.is_dir() {
            return scan_workspace_files_uncached(root);
        }

        if is_unsearchable_workspace_path(root, &path, false) || !path.is_file() {
            files.remove(&relative_path);
            continue;
        }

        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        files.insert(
            relative_path.clone(),
            ScannedFile {
                path,
                relative_path,
                name,
            },
        );
    }

    let mut refreshed = files.into_values().collect::<Vec<_>>();
    refreshed.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(refreshed)
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

fn is_unsearchable_event_path(root: &Path, path: &Path) -> bool {
    let Some(relative) = relativize(root, path) else {
        // 前缀形态不一致时放行，避免漏掉真实源文件变更。
        return false;
    };

    if relative.components().any(|component| match component {
        Component::Normal(name) => SKIPPED_SEARCH_DIR_NAMES
            .iter()
            .any(|skipped| os_str_eq(name, OsStr::new(skipped))),
        _ => false,
    }) {
        return true;
    }

    is_unsearchable_workspace_path(root, path, false)
}

fn relativize(root: &Path, path: &Path) -> Option<PathBuf> {
    let mut root_components = root.components();
    let mut path_components = path.components();
    loop {
        match root_components.next() {
            None => return Some(path_components.as_path().to_path_buf()),
            Some(root_component) => {
                let path_component = path