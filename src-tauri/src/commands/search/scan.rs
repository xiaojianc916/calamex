use super::super::decode_script_bytes;
use super::super::path_util::{os_str_eq, relativize};
use super::util::count_to_u32;
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rayon::prelude::*;
use rustc_hash::FxHasher;
use std::{
    collections::HashMap,
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
    pub(super) search_text: String,
    pub(super) name: String,
    pub(super) line_number: u32,
    // 命中所在的真实源码行（已去掉行尾换行）：搜索结果直接展示该行内容，
    // 而不是合成的「函数 X」标签。
    pub(super) line_text: String,
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

pub(super) fn workspace_cached_files_for_index(
    root: &Path,
) -> Result<Arc<Vec<ScannedFile>>, String> {
    workspace_cache_files(root)
}

fn workspace_cache_files(root: &Path) -> Result<Arc<Vec<ScannedFile>>, String> {
    let cache_key = root.to_string_lossy().to_string();
    let caches = WORKSPACE_FILE_CACHES.get_or_init(|| Mutex::new(HashMap::new()));

    // 持锁只做轻量判断：命中且未脏直接返回缓存；命中但脏则取出增量刷新所需的数据后立即
    // 释放锁，把可能很重的目录遍历放到锁外执行，避免单个全局锁在整目录 walk 期间阻塞其它
    // （乃至其它工作区的）搜索。
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
                super::content_index::invalidate_workspace_content_index(root);
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

    // changed path 经 canonicalize 归一（解析 .. / 符号链接，Windows 上还会带上 \\?\
    // verbatim 前缀），因此必须用同样 canonicalize 后的 root 做相对化；否则前缀形态不一致
    // （如 root 为 C:\… 而 path 为 \\?\C:\…）会让 relativize 始终返回 None，增量刷新被迫
    // 每次退化为全量重扫。root 无法 canonicalize（如已被删除）时回退到原始 root。
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());

    // current 始终按 relative_path 升序（缓存不变量）。在其副本上按二分查找做增量增删，
    // 避免每次文件变更都重建整张 HashMap 并对全量文件列表重新排序。
    let mut files = current.to_vec();

    for path in changed_paths {
        let path = path.canonicalize().unwrap_or(path);
        let Some(relative) = relativize(&canonical_root, &path) else {
            return scan_workspace_files_uncached(root);
        };
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        if relative_path.is_empty() {
            return scan_workspace_files_uncached(root);
        }

        let position = files.binary_search_by(|file| file.relative_path.cmp(&relative_path));

        if !path.exists() {
            // 命中则删除；若被删路径是某条目的目录前缀（其下仍有子文件），回退全量重扫。
            if let Ok(index) = position {
                files.remove(index);
            }
            let prefix = format!("{relative_path}/");
            let insertion = position.unwrap_or_else(|index| index);
            if files
                .get(insertion)
                .is_some_and(|file| file.relative_path.starts_with(&prefix))
            {
                return scan_workspace_files_uncached(root);
            }
            continue;
        }

        if path.is_dir() {
            return scan_workspace_files_uncached(root);
        }

        if is_unsearchable_workspace_path(root, &path, false) || !path.is_file() {
            if let Ok(index) = position {
                files.remove(index);
            }
            continue;
        }

        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        let scanned = ScannedFile {
            path,
            relative_path,
            name,
        };
        match position {
            Ok(index) => files[index] = scanned,
            Err(index) => files.insert(index, scanned),
        }
    }

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

fn collect_workspace_symbols(
    files: &[ScannedFile],
    cached_files: &HashMap<String, CachedSymbolFile>,
) -> Result<(Vec<SymbolEntry>, HashMap<String, CachedSymbolFile>), String> {
    let per_file_symbols = files
        .par_iter()
        .enumerate()
        .filter(|(_, file)| is_shell_like_file(file))
        .map(|(index, file)| {
            let cached = cached_files.get(&file.relative_path);
            collect_symbols_from_file(file, cached)
                .map(|symbols| (index, file.relative_path.clone(), symbols))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let flattened = flatten_symbol_batches(
        per_file_symbols
            .iter()
            .map(|(index, _relative_path, cached_file)| (*index, cached_file.symbols.clone()))
            .collect(),
    );
    let refreshed_cache = per_file_symbols
        .into_iter()
        .map(|(_index, relative_path, cached_file)| (relative_path, cached_file))
        .collect();

    Ok((flattened, refreshed_cache))
}

fn flatten_symbol_batches(
    mut per_file_symbols: Vec<(usize, Vec<SymbolEntry>)>,
) -> Vec<SymbolEntry> {
    per_file_symbols.sort_by_key(|(index, _)| *index);
    per_file_symbols
        .into_iter()
        .flat_map(|(_, symbols)| symbols)
        .collect()
}

fn collect_symbols_from_file(
    file: &ScannedFile,
    cached: Option<&CachedSymbolFile>,
) -> Result<CachedSymbolFile, String> {
    let metadata = match fs::metadata(&file.path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Ok(CachedSymbolFile {
                fingerprint: SymbolFileFingerprint {
                    len: 0,
                    modified_nanos: None,
                    content_hash: None,
                },
                symbols: Vec::new(),
            });
        }
    };
    let len = metadata.len();
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());

    if let Some(cached) = cached
        && cached.fingerprint.content_hash.is_some()
        && cached.fingerprint.len == len
        && cached.fingerprint.modified_nanos == modified_nanos
    {
        return Ok(cached.clone());
    }

    let bytes = match fs::read(&file.path) {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(CachedSymbolFile {
                fingerprint: SymbolFileFingerprint {
                    len,
                    modified_nanos,
                    content_hash: None,
                },
                symbols: Vec::new(),
            });
        }
    };
    let content_hash = hash_symbol_file_bytes(&bytes);
    let fingerprint = SymbolFileFingerprint {
        len,
        modified_nanos,
        content_hash: Some(content_hash),
    };

    if let Some(cached) = cached
        && cached.fingerprint.content_hash == Some(content_hash)
    {
        return Ok(CachedSymbolFile {
            fingerprint,
            symbols: cached.symbols.clone(),
        });
    }

    Ok(CachedSymbolFile {
        fingerprint,
        symbols: parse_symbols_from_file_bytes(file, &bytes)?,
    })
}

fn hash_symbol_file_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = FxHasher::default();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn parse_symbols_from_file_bytes(
    file: &ScannedFile,
    bytes: &[u8],
) -> Result<Vec<SymbolEntry>, String> {
    let Ok((content, _encoding)) = decode_script_bytes(bytes) else {
        return Ok(Vec::new());
    };

    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .map_err(|error| format!("初始化 Bash 符号解析器失败：{error}"))?;
    let Some(tree) = parser.parse(&content, None) else {
        return Ok(Vec::new());
    };

    let mut symbols = Vec::new();
    collect_symbols_from_node(tree.root_node(), content.as_bytes(), file, &mut symbols);
    Ok(symbols)
}

/// 提取 byte_offset 所在的源码行文本（不含行尾换行）。换行符为 ASCII，按字节定位
/// 行边界不会切断多字节 UTF-8 字符；非法字节用 from_utf8_lossy 兜底，保证始终返回可显示文本。
fn line_text_at_byte(source: &[u8], byte_offset: usize) -> String {
    let offset = byte_offset.min(source.len());
    let start = source[..offset]
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let end = source[offset..]
        .iter()
        .position(|&byte| byte == b'\n')
        .map(|index| offset + index)
        .unwrap_or(source.len());
    String::from_utf8_lossy(&source[start..end])
        .trim_end_matches(['\r', '\n'])
        .to_string()
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
            search_text: format!("{} {}", name, file.relative_path),
            name: name.to_string(),
            line_number,
            // 取函数定义所在的真实源码行文本，供搜索结果按真实内容展示。
            line_text: line_text_at_byte(source, node.start_byte()),
        });
    }

    // 用 TreeCursor 线性遍历命名子节点：goto_first_child/goto_next_sibling 每步均为
    // O(1)，整层 O(k)。相比 named_child(i) 每次从头数到第 i 个孩子的 O(i)（整层累计
    // O(k^2)），整棵树从 O(n^2) 量级降到 O(n)。仅下降到命名子节点，DFS 前序顺序与上面的
    // 函数识别逻辑保持完全一致。
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            if child.is_named() {
                collect_symbols_from_node(child, source, file, symbols);
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn p(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应可用")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "calamex-search-scan-test-{}-{suffix}",
            std::process::id()
        ))
    }

    #[test]
    fn search_watcher_ignores_noisy_dependency_and_build_events() {
        let root = p("/workspace/app");
        assert!(is_unsearchable_event_path(
            &root,
            &p("/workspace/app/node_modules/pkg/index.js")
        ));
        assert!(is_unsearchable_event_path(
            &root,
            &p("/workspace/app/src-tauri/target/debug/app")
        ));
        assert!(is_unsearchable_event_path(
            &root,
            &p("/workspace/app/.git/objects/aa/hash")
        ));
        assert!(!is_unsearchable_event_path(
            &root,
            &p("/workspace/app/src/main.sh")
        ));
    }

    #[test]
    fn search_watcher_does_not_ignore_root_named_like_dependency_dir() {
        let root = p("/workspace/node_modules/project");
        assert!(!is_unsearchable_event_path(
            &root,
            &p("/workspace/node_modules/project/src/main.sh")
        ));
        assert!(is_unsearchable_event_path(
            &root,
            &p("/workspace/node_modules/project/node_modules/pkg/index.js")
        ));
    }

    #[test]
    fn refresh_workspace_files_incrementally_adds_and_removes_files() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("应创建临时目录");
        let file = root.join("script.sh");
        fs::write(&file, "echo hi\n").expect("应写入测试文件");

        let files =
            refresh_workspace_files(&root, &[], vec![file.clone()]).expect("应增量添加文件");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path, "script.sh");

        fs::remove_file(&file).expect("应删除测试文件");
        let files = refresh_workspace_files(&root, &files, vec![file]).expect("应增量删除文件");
        assert!(files.is_empty());

        fs::remove_dir_all(&root).expect("应清理临时目录");
    }

    #[test]
    fn refresh_workspace_files_falls_back_when_deleted_dir_had_children() {
        let root = temp_root();
        fs::create_dir_all(root.join("scripts")).expect("应创建临时目录");
        let child = ScannedFile {
            path: root.join("scripts/a.sh"),
            relative_path: "scripts/a.sh".to_string(),
            name: "a.sh".to_string(),
        };
        fs::remove_dir_all(&root).expect("应删除临时目录");

        let files = refresh_workspace_files(&root, &[child], vec![root.join("scripts")])
            .expect("应安全回退到全量扫描");
        assert!(files.is_empty());
    }

    #[test]
    fn refresh_workspace_files_keeps_sorted_order_on_incremental_add() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("应创建临时目录");
        let m = root.join("m.sh");
        fs::write(&m, "echo hi\n").expect("应写入测试文件");

        // 已排序列表中增量插入中间项 m.sh，结果应保持 relative_path 字典序。
        let current = vec![
            ScannedFile {
                path: root.join("a.sh"),
                relative_path: "a.sh".to_string(),
                name: "a.sh".to_string(),
            },
            ScannedFile {
                path: root.join("z.sh"),
                relative_path: "z.sh".to_string(),
                name: "z.sh".to_string(),
            },
        ];
        let files = refresh_workspace_files(&root, &current, vec![m]).expect("应增量插入文件");
        let order: Vec<String> = files.into_iter().map(|file| file.relative_path).collect();
        assert_eq!(
            order,
            vec!["a.sh".to_string(), "m.sh".to_string(), "z.sh".to_string()]
        );

        fs::remove_dir_all(&root).expect("应清理临时目录");
    }

    #[test]
    fn collect_symbols_walks_named_nodes_in_dfs_preorder() {
        let source = "#!/bin/bash\nouter() {\n  inner() {\n    echo hi\n  }\n  inner\n}\nsibling() {\n  echo bye\n}\n";
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .expect("加载 Bash 语法失败");
        let tree = parser.parse(source, None).expect("解析 Bash 失败");

        let file = ScannedFile {
            path: p("/workspace/app/script.sh"),
            relative_path: "script.sh".to_string(),
            name: "script.sh".to_string(),
        };

        let mut symbols = Vec::new();
        collect_symbols_from_node(tree.root_node(), source.as_bytes(), &file, &mut symbols);

        let collected: Vec<(String, u32)> = symbols
            .iter()
            .map(|symbol| (symbol.name.clone(), symbol.line_number))
            .collect();
        assert_eq!(
            collected,
            vec![
                ("outer".to_string(), 2),
                ("inner".to_string(), 3),
                ("sibling".to_string(), 8),
            ]
        );
    }

    #[test]
    fn collect_symbols_from_file_reuses_cached_symbols_when_metadata_matches() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("应创建临时目录");
        let path = root.join("script.sh");
        fs::write(&path, "cached_name() {\n  echo cached\n}\n").expect("应写入测试文件");

        let file = ScannedFile {
            path: path.clone(),
            relative_path: "script.sh".to_string(),
            name: "script.sh".to_string(),
        };
        let first = collect_symbols_from_file(&file, None).expect("应解析初始符号");
        let cached = CachedSymbolFile {
            fingerprint: first.fingerprint.clone(),
            symbols: vec![symbol("script.sh", "sentinel", 99)],
        };

        let reused = collect_symbols_from_file(&file, Some(&cached)).expect("应复用缓存符号");
        let collected: Vec<String> = reused
            .symbols
            .into_iter()
            .map(|symbol| symbol.name)
            .collect();
        assert_eq!(collected, vec!["sentinel".to_string()]);

        fs::remove_dir_all(&root).expect("应清理临时目录");
    }

    #[test]
    fn collect_symbols_from_file_reuses_cached_symbols_when_hash_matches_after_mtime_change() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("应创建临时目录");
        let path = root.join("script.sh");
        let content = "same_body() {\n  echo same\n}\n";
        fs::write(&path, content).expect("应写入测试文件");

        let file = ScannedFile {
            path: path.clone(),
            relative_path: "script.sh".to_string(),
            name: "script.sh".to_string(),
        };
        let mut cached = collect_symbols_from_file(&file, None).expect("应解析初始符号");
        cached.fingerprint.modified_nanos = cached
            .fingerprint
            .modified_nanos
            .map(|modified| modified.saturating_sub(1));
        cached.symbols = vec![symbol("script.sh", "hash_reused", 7)];

        let reused = collect_symbols_from_file(&file, Some(&cached)).expect("应按 hash 复用缓存");
        let collected: Vec<String> = reused
            .symbols
            .into_iter()
            .map(|symbol| symbol.name)
            .collect();
        assert_eq!(collected, vec!["hash_reused".to_string()]);

        fs::remove_dir_all(&root).expect("应清理临时目录");
    }

    #[test]
    fn flatten_symbol_batches_preserves_file_and_dfs_order() {
        let collected: Vec<String> = flatten_symbol_batches(vec![
            (2usize, vec![symbol("c.sh", "third", 1)]),
            (
                0usize,
                vec![symbol("a.sh", "first", 1), symbol("a.sh", "second", 2)],
            ),
        ])
        .into_iter()
        .map(|symbol| symbol.name)
        .collect();

        assert_eq!(collected, vec!["first", "second", "third"]);
    }

    fn symbol(relative_path: &str, name: &str, line_number: u32) -> SymbolEntry {
        SymbolEntry {
            path: p(relative_path),
            relative_path: relative_path.to_string(),
            search_text: format!("{name} {relative_path}"),
            name: name.to_string(),
            line_number,
            line_text: String::new(),
        }
    }
}
