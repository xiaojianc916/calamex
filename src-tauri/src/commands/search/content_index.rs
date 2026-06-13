use super::super::decode_script_bytes;
use super::scan::{ScannedFile, workspace_cached_files_for_index};
use super::types::WorkspaceSearchRequest;
use std::{
    collections::{HashMap, HashSet},
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
    trigram_to_files: HashMap<Trigram, Vec<String>>,
    unindexed_files: Vec<String>,
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

    let query_trigrams = query_trigram_keys(query, payload.match_case);
    if query_trigrams.is_empty() {
        return Ok(None);
    }

    let index = workspace_content_index(root)?;
    let Some(mut candidate_paths) = intersect_candidate_paths(&index, &query_trigrams) else {
        return Ok(Some(Vec::new()));
    };

    for path in &index.unindexed_files {
        candidate_paths.insert(path.clone());
    }

    let narrowed = files
        .iter()
        .filter(|file| candidate_paths.contains(&file.relative_path))
        .cloned()
        .collect::<Vec<_>>();

    if narrowed.len() >= files.len().saturating_mul(100 - MIN_FILTER_REDUCTION_PERCENT) / 100 {
        return Ok(None);
    }

    Ok(Some(narrowed))
}

fn can_use_literal_trigram_index(query: &str, payload: &WorkspaceSearchRequest) -> bool {
    !payload.use_regex
        && !payload.use_structural
        && !payload.content_fuzzy
        && !payload.match_case
        && query.len() >= 3
        && query.is_ascii()
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
    let index = Arc::new(build_workspace_content_index(files.as_slice()));

    let mut guard = indexes
        .lock()
        .map_err(|_| "内容搜索索引状态已损坏，请重启应用后重试。".to_string())?;
    if let Some(existing) = guard.get(&cache_key) {
        return Ok(Arc::clone(existing));
    }
    guard.insert(cache_key, Arc::clone(&index));
    Ok(index)
}

fn build_workspace_content_index(files: &[ScannedFile]) -> WorkspaceContentIndex {
    let mut trigram_to_files: HashMap<Trigram, Vec<String>> = HashMap::new();
    let mut unindexed_files = Vec::new();

    for file in files {
        match collect_file_trigrams(file) {
            Some(trigrams) => {
                for trigram in trigrams {
                    trigram_to_files
                        .entry(trigram)
                        .or_default()
                        .push(file.relative_path.clone());
                }
            }
            None => unindexed_files.push(file.relative_path.clone()),
        }
    }

    for paths in trigram_to_files.values_mut() {
        paths.sort();
        paths.dedup();
    }
    unindexed_files.sort();
    unindexed_files.dedup();

    WorkspaceContentIndex {
        trigram_to_files,
        unindexed_files,
    }
}

fn collect_file_trigrams(file: &ScannedFile) -> Option<HashSet<Trigram>> {
    let metadata = fs::metadata(&file.path).ok()?;
    if metadata.len() > MAX_TRIGRAM_INDEXED_FILE_BYTES {
        return None;
    }

    let bytes = fs::read(&file.path).ok()?;
    let (content, _encoding) = decode_script_bytes(&bytes).ok()?;
    Some(trigram_keys_from_ascii_bytes(
        normalize_ascii_bytes(&content, false).as_slice(),
    ))
}

fn query_trigram_keys(query: &str, match_case: bool) -> Vec<Trigram> {
    let normalized = normalize_ascii_bytes(query, match_case);
    let mut trigrams = trigram_keys_from_ascii_bytes(&normalized)
        .into_iter()
        .collect::<Vec<_>>();
    trigrams.sort_unstable();
    trigrams.dedup();
    trigrams
}

fn normalize_ascii_bytes(value: &str, match_case: bool) -> Vec<u8> {
    if match_case {
        value.as_bytes().to_vec()
    } else {
        value.bytes().map(|byte| byte.to_ascii_lowercase()).collect()
    }
}

fn trigram_keys_from_ascii_bytes(bytes: &[u8]) -> HashSet<Trigram> {
    let mut keys = HashSet::new();
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

fn intersect_candidate_paths(
    index: &WorkspaceContentIndex,
    query_trigrams: &[Trigram],
) -> Option<HashSet<String>> {
    let mut lists = query_trigrams
        .iter()
        .filter_map(|trigram| index.trigram_to_files.get(trigram))
        .collect::<Vec<_>>();

    if lists.len() != query_trigrams.len() {
        return Some(HashSet::new());
    }

    lists.sort_by_key(|paths| paths.len());
    let mut candidates = lists
        .first()
        .map(|paths| paths.iter().cloned().collect::<HashSet<_>>())?;

    for paths in lists.iter().skip(1) {
        let lookup = paths.iter().collect::<HashSet<_>>();
        candidates.retain(|path| lookup.contains(path));
        if candidates.is_empty() {
            break;
        }
    }

    Some(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{WorkspaceSearchRequest, WorkspaceSearchScope};

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

    #[test]
    fn packs_distinct_ascii_trigrams() {
        let keys = trigram_keys_from_ascii_bytes(b"hello");
        assert!(keys.contains(&pack_trigram(b"hel")));
        assert!(keys.contains(&pack_trigram(b"ell")));
        assert!(keys.contains(&pack_trigram(b"llo")));
    }

    #[test]
    fn only_uses_safe_literal_ascii_queries() {
        assert!(can_use_literal_trigram_index("needle", &request("needle")));
        let mut regex = request("needle");
        regex.use_regex = true;
        assert!(!can_use_literal_trigram_index("needle", &regex));
        assert!(!can_use_literal_trigram_index("中", &request("中")));
    }
}
