use super::super::decode_script_bytes;
use super::util::count_to_u32;
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
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
    let watcher_root = root.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        // 搜索缓存只关心「会进入搜索索引」的源文件变更。构建产物、依赖目录、
        // VCS 内部文件等高频噪音即使被底层递归 watcher 上报，也不应把缓存标脏，
        // 否则 npm install / cargo build / git 操作会让下一次搜索反复重建索引。
        if event
            .paths
            .iter()
            .any(|path| !is_unsearchable_event_path(&watcher_root, path))
        {
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
                let path_component = path_components.next()?;
                if !os_str_eq(root_component.as_os_str(), path_component.as_os_str()) {
                    return None;
                }
            }
        }
    }
}

#[cfg(windows)]
fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(not(windows))]
fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left == right
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

    fn p(value: &str) -> PathBuf {
        PathBuf::from(value)
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
    fn collect_symbols_walks_named_nodes_in_dfs_preorder() {
        let source =
            "#!/bin/bash\nouter() {\n  inner() {\n    echo hi\n  }\n  inner\n}\nsibling() {\n  echo bye\n}\n";
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
}
