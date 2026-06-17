use super::scan::{ScannedFile, workspace_cached_files_for_index};
use super::types::WorkspaceSearchRequest;
use rustc_hash::{FxHashMap, FxHashSet};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};

/// Content files larger than this are not inserted into the trigram index.
/// They are always included in the candidate set, so the index never causes false negatives.
const MAX_TRIGRAM_INDEXED_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// If trigram filtering keeps most files, skip the narrowed path and use the existing full scan.
const MIN_FILTER_REDUCTION_PERCENT: usize = 20;

type Trigram = u32;

#[derive(Clone)]
struct WorkspaceContentIndex {
    /// 所有可被检索的相对路径；倒排表与未索引集合都用其下标（u32）引用，
    /// 避免在大量 trigram 列表里重复存整条路径字符串。
    paths: Vec<String>,
    trigram_to_files: FxHashMap<Trigram, Vec<u32>>,
    unindexed_files: Vec<u32>,
}

static WORKSPACE_CONTENT_INDEXES: OnceLock<Mutex<HashMap<String, Arc<WorkspaceContentIndex>>>> =
    OnceLock::new();

pub(super) fn invalidate_workspace_content_index(root: &Path) {
    let Some(indexes) = WORKSPACE_CONTENT_INDEXES.get() else {
        return;
    };
    if let Ok(mut guard) = indexes.lock() {
        guard.remove(&root.to_string_lossy().to_string());
    }
}

pub(super) fn prewarm_workspace_content_index(root: &Path) {
    let _ = workspace_content_index(root);
}

pub(super) fn filter_literal_content_candidates(
    root: &Path,
    files: &[ScannedFile],
    query: &str,
    payload: &WorkspaceSearchRequest,
) -> Result<Option<Vec<ScannedFile>>, String> {
    if !can_use_literal_trigram_index(query, payload) {
        return Ok(None);
    }

    let query_trigrams = query_trigram_keys(query);
    if query_trigrams.is_empty() {
        return Ok(None);
    }

    let index = workspace_content_index(root)?;
    let Some(candidate_files) = intersect_candidate_files(&index, &query_trigrams) else {
        return Ok(Some(Vec::new()));
    };

    // 把命中的文件下标（含始终入选的未索引大文件）映射回相对路径；用 &str 借用 index.paths，
    // 避免克隆路径字符串。
    let mut candidate_paths: FxHashSet<&str> = FxHashSet::default();
    for file_index in candidate_files.iter().chain(index.unindexed_files.iter()) {
        if let Some(path) = index.paths.get(*file_index as usize) {
            candidate_paths.insert(path.as_str());
        }
    }

    let narrowed = files
        .iter()
        .filter(|file| candidate_paths.contains(file.relative_path.as_str()))
        .cloned()
        .collect::<Vec<_>>();

    if narrowed.len()
        >= files
            .len()
            .saturating_mul(100 - MIN_FILTER_REDUCTION_PERCENT)
            / 100
    {
        return Ok(None);
    }

    Ok(Some(narrowed))
}

/// 字面量内容搜索才可用 trigram 预筛：排除正则 / 结构化 / 模糊，且查询字节数 >= 3
/// （单个 CJK 字符为 3 字节，故 CJK 查询同样满足）。
///
/// 不再要求 ASCII 或不区分大小写：索引建立在「ASCII 折叠小写」的 UTF-8 字节上，
/// 折叠只会合并大小写、不会拆分，因此用折叠后的查询去探测，对区分大小写查询而言
/// 得到的候选集必为真实命中的超集（多出的误报由 grep 精确剔除），绝不漏命中；
/// CJK 字节 >127，折叠时原样保留，字节三元组天然覆盖。
fn can_use_literal_trigram_index(query: &str, payload: &WorkspaceSearchRequest) -> bool {
    !payload.use_regex && !payload.use_structural && !payload.content_fuzzy && query.len() >= 3
}

fn workspace_content_index(root: &Path) -> Result<Arc<WorkspaceContentIndex>, String> {
    let cache_key = root.to_string_lossy().to_string();
    let indexes = WORKSPACE_CONTENT_INDEXES.get_or_init(|| Mutex::new(HashMap::new()));

    {
        let guard = indexes
            .lock()
            .map_err(|_| "内容搜索索引状态已损坏，请重启应用后重试。".to_string())?;
        if let Some(index) = guard.get(&cache_key) {
            return Ok(Arc::clone(index));
        }
    }

    let files = workspace_cached_files_for_index(root)?;
    let index = Arc::new(build_workspace_content_index(root, files.as_slice()));

    let mut guard = indexes
        .lock()
        .map_err(|_| "内容搜索索引状态已损坏，请重启应用后重试。".to_string())?;
    if let Some(existing) = guard.get(&cache_key) {
        return Ok(Arc::clone(existing));
    }
    guard.insert(cache_key, Arc::clone(&index));
    Ok(index)
}

fn build_workspace_content_index(root: &Path, files: &[ScannedFile]) -> WorkspaceContentIndex {
    let mut paths: Vec<String> = Vec::new();
    let mut trigram_to_files: FxHashMap<Trigram, Vec<u32>> = FxHashMap::default();
    let mut unindexed_files = Vec::new();

    for file in files {
        // 用文件下标（u32）替代在每个 trigram 倒排列表里重复存整条路径字符串。
        let Ok(file_index) = u32::try_from(paths.len()) else {
            // 文件数超过 u32::MAX（实际不可能）时停止扩充索引；已建部分仍是真实命中的超集。
            break;
        };

        match collect_file_trigrams(root, file) {
            Some(trigrams) => {
                for trigram in trigrams {
                    trigram_to_files.entry(trigram).or_default().push(file_index);
                }
            }
            None => unindexed_files.push(file_index),
        }
        paths.push(file.relative_path.clone());
    }

    for indices in trigram_to_files.values_mut() {
        indices.sort_unstable();
        indices.dedup();
    }
    unindexed_files.sort_unstable();
    unindexed_files.dedup();

    WorkspaceContentIndex {
        paths,
        trigram_to_files,
        unindexed_files,
    }
}

fn collect_file_trigrams(root: &Path, file: &ScannedFile) -> Option<FxHashSet<Trigram>> {
    let metadata = fs::metadata(&file.path).ok()?;
    if metadata.len() > MAX_TRIGRAM_INDEXED_FILE_BYTES {
        return None;
    }

    // 复用按 (len, mtime) 缓存的已解码文本：索引构建与结构化/模糊搜索共用同一份解码结果。
    let content = super::content_cache::workspace_file_text(root, &file.relative_path, &file.path)?;
    Some(trigram_keys_from_bytes(
        fold_ascii_case_bytes(&content).as_slice(),
    ))
}

/// 查询的 trigram 始终用「折叠小写」形式生成，与索引一致；区分大小写的最终判定交给 grep。
fn query_trigram_keys(query: &str) -> Vec<Trigram> {
    let folded = fold_ascii_case_bytes(query);
    let mut trigrams = trigram_keys_from_bytes(&folded)
        .into_iter()
        .collect::<Vec<_>>();
    trigrams.sort_unstable();
    trigrams.dedup();
    trigrams
}

/// 仅折叠 ASCII 大小写；非 ASCII 字节（含 CJK 的 UTF-8 编码）原样保留，
/// 使索引与查询落在同一字节空间。
fn fold_ascii_case_bytes(value: &str) -> Vec<u8> {
    value
        .bytes()
        .map(|byte| byte.to_ascii_lowercase())
        .collect()
}

fn trigram_keys_from_bytes(bytes: &[u8]) -> FxHashSet<Trigram> {
    let mut keys = FxHashSet::default();
    if bytes.len() < 3 {
        return keys;
    }
    for window in bytes.windows(3) {
        keys.insert(pack_trigram(window));
    }
    keys
}

fn pack_trigram(bytes: &[u8]) -> Trigram {
    ((bytes[0] as Trigram) << 16) | ((bytes[1] as Trigram) << 8) | bytes[2] as Trigram
}

fn intersect_candidate_files(
    index: &WorkspaceContentIndex,
    query_trigrams: &[Trigram],
) -> Option<Vec<u32>> {
    let mut lists = query_trigrams
        .iter()
        .filter_map(|trigram| index.trigram_to_files.get(trigram))
        .collect::<Vec<_>>();

    if lists.len() != query_trigrams.len() {
        return Some(Vec::new());
    }

    // 从最短倒排列表出发，逐表用二分查找求交集（各列表已排序去重），
    // 避免为每个 trigram 重建 HashSet 并克隆其内容。
    lists.sort_by_key(|indices| indices.len());
    let mut candidates = lists.first().map(|indices| indices.to_vec())?;

    for indices in lists.iter().skip(1) {
        candidates.retain(|candidate| indices.binary_search(candidate).is_ok());
        if candidates.is_empty() {
            break;
        }
    }

    Some(candidates)
}

#[cfg(test)]
mod tests {
    use super::super::types::{WorkspaceSearchRequest, WorkspaceSearchScope};
    use super::*;
    use rustc_hash::{FxHashMap, FxHashSet};

    fn request(query: &str) -> WorkspaceSearchRequest {
        WorkspaceSearchRequest {
            workspace_root_path: String::new(),
            query: query.to_string(),
            scope: WorkspaceSearchScope::Content,
            match_case: false,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            content_fuzzy: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
            stream_token: None,
        }
    }

    /// 用与生产一致的折叠规则，从 (路径, 内容) 列表构建一个内存内容索引，便于在不触盘的
    /// 情况下断言「候选集筛除」的不漏命中性质。
    fn index_from(files: &[(&str, &str)]) -> WorkspaceContentIndex {
        let mut paths: Vec<String> = Vec::new();
        let mut trigram_to_files: FxHashMap<Trigram, Vec<u32>> = FxHashMap::default();
        for (path, content) in files {
            let file_index = u32::try_from(paths.len()).expect("测试文件数应在 u32 范围内");
            for trigram in trigram_keys_from_bytes(fold_ascii_case_bytes(content).as_slice()) {
                trigram_to_files.entry(trigram).or_default().push(file_index);
            }
            paths.push((*path).to_string());
        }
        for indices in trigram_to_files.values_mut() {
            indices.sort_unstable();
            indices.dedup();
        }
        WorkspaceContentIndex {
            paths,
            trigram_to_files,
            unindexed_files: Vec::new(),
        }
    }

    fn candidates(index: &WorkspaceContentIndex, query: &str) -> FxHashSet<String> {
        let Some(indices) = intersect_candidate_files(index, &query_trigram_keys(query)) else {
            return FxHashSet::default();
        };
        indices
            .iter()
            .chain(index.unindexed_files.iter())
            .filter_map(|file_index| index.paths.get(*file_index as usize).cloned())
            .collect()
    }

    #[test]
    fn packs_distinct_trigrams() {
        let keys = trigram_keys_from_bytes(b"hello");
        assert!(keys.contains(&pack_trigram(b"hel")));
        assert!(keys.contains(&pack_trigram(b"ell")));
        assert!(keys.contains(&pack_trigram(b"llo")));
    }

    #[test]
    fn allows_literal_cjk_and_case_sensitive_queries() {
        // 字面量且足够长的查询都应走索引，包括 CJK 与区分大小写。
        assert!(can_use_literal_trigram_index("needle", &request("needle")));
        assert!(can_use_literal_trigram_index("中文检索", &request("中文检索")));
        let mut case_sensitive = request("Needle");
        case_sensitive.match_case = true;
        assert!(can_use_literal_trigram_index("Needle", &case_sensitive));
        // 仍排除：正则 / 结构化 / 过短查询。
        let mut regex = request("needle");
        regex.use_regex = true;
        assert!(!can_use_literal_trigram_index("needle", &regex));
        assert!(!can_use_literal_trigram_index("ab", &request("ab")));
    }

    #[test]
    fn cjk_query_keeps_only_files_containing_it() {
        let index = index_from(&[("a.sh", "echo 部署完成"), ("b.sh", "echo done")]);
        let hits = candidates(&index, "部署");
        assert!(hits.contains("a.sh"));
        assert!(!hits.contains("b.sh"));
    }

    #[test]
    fn case_sensitive_query_never_drops_matching_file() {
        // 区分大小写查询用「折叠小写」索引��预筛：候选必为超集，绝不漏命中。
        let index = index_from(&[("up.sh", "value = CONFIG_PATH")]);
        assert!(candidates(&index, "CONFIG").contains("up.sh"));
    }

    #[test]
    fn case_insensitive_query_matches_regardless_of_file_case() {
        let index = index_from(&[("mix.sh", "Export NEEDLE here")]);
        assert!(candidates(&index, "needle").contains("mix.sh"));
    }

    #[test]
    fn query_absent_from_corpus_is_filtered_out() {
        let index = index_from(&[("a.sh", "alpha beta")]);
        assert!(candidates(&index, "zzz").is_empty());
    }
}
