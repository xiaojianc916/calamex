#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const read = (file) => readFileSync(join(root, file), 'utf8');
const write = (file, content) => writeFileSync(join(root, file), content, 'utf8');
const lines = (items) => `${items.join('\n')}\n`;

const normalizeNewlines = (value) => value.replace(/\r\n/g, '\n');

const replaceOnce = (file, source, target, label) => {
  const original = read(file);
  const content = normalizeNewlines(original);

  const count = content.split(source).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: ${label} expected 1 match, got ${count}`);
  }

  write(file, content.replace(source, target));
  console.log(`updated ${file}: ${label}`);
};

const writeNewFile = (file, content) => {
  const path = join(root, file);

  // 前一次失败时可能已经创建了新文件；这里跳过，保证脚本可重跑。
  if (existsSync(path)) {
    console.log(`skipped ${file}: already exists`);
    return;
  }

  write(file, content);
  console.log(`created ${file}`);
};

// ============================================================================
// 1) Rust backend ultimate search path: literal content search candidate index.
//    This adds a workspace-level trigram index that only narrows candidates for
//    safe ASCII literal content queries. grep_searcher still verifies matches,
//    so correctness is preserved; regex/fuzzy/structural/non-ASCII falls back.
// ============================================================================

writeNewFile(
  'src-tauri/src/commands/search/content_index.rs',
  String.raw`use super::super::decode_script_bytes;
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
`,
);

replaceOnce(
  'src-tauri/src/commands/search/mod.rs',
  'mod find;\n',
  'mod content_index;\nmod find;\n',
  'register content index module',
);

replaceOnce(
  'src-tauri/src/commands/search/mod.rs',
  'use find::{search_file_contents, search_file_names, search_structural_contents, search_symbols};\n',
  'use content_index::{filter_literal_content_candidates, prewarm_workspace_content_index};\nuse find::{search_file_contents, search_file_names, search_structural_contents, search_symbols};\n',
  'import content index helpers',
);

replaceOnce(
  'src-tauri/src/commands/search/mod.rs',
  lines([
    '            results.extend(search_file_contents(',
    '                &files,',
    '                &query,',
    '                &payload,',
    '                content_limit,',
    '                sink.as_ref().map(|sink| sink as &dyn ContentBatchSink),',
    '            )?);',
  ]),
  lines([
    '            let indexed_content_candidates = filter_literal_content_candidates(',
    '                &workspace_root,',
    '                files.as_ref(),',
    '                &query,',
    '                &payload,',
    '            )?;',
    '            let content_files = indexed_content_candidates',
    '                .as_deref()',
    '                .unwrap_or_else(|| files.as_ref());',
    '',
    '            results.extend(search_file_contents(',
    '                content_files,',
    '                &query,',
    '                &payload,',
    '                content_limit,',
    '                sink.as_ref().map(|sink| sink as &dyn ContentBatchSink),',
    '            )?);',
  ]),
  'narrow literal content searches with trigram candidates',
);

replaceOnce(
  'src-tauri/src/commands/search/mod.rs',
  '            let _ = scan::workspace_cache_symbols(&workspace_root);\n',
  '            let _ = scan::workspace_cache_symbols(&workspace_root);\n            prewarm_workspace_content_index(&workspace_root);\n',
  'prewarm content trigram index',
);

replaceOnce(
  'src-tauri/src/commands/search/scan.rs',
  lines([
    'pub(super) fn scan_workspace_files(',
    '    root: &Path,',
    '    filters: &PathFilters,',
    ') -> Result<Arc<Vec<ScannedFile>>, String> {',
    '    let files = workspace_cache_files(root)?;',
    '    // 无路径过滤（最常见路径）时直接复用缓存的 Arc，避免每次按键搜索都深拷贝整份文件清单',
    '    // （每个 ScannedFile 含 PathBuf + 2×String，大仓下一次搜索可产生十几万次堆分配）。',
    '    if filters.is_empty() {',
    '        return Ok(files);',
    '    }',
    '    Ok(Arc::new(',
    '        files',
    '            .iter()',
    '            .filter(|file| passes_path_filters(&file.relative_path, filters))',
    '            .cloned()',
    '            .collect(),',
    '    ))',
    '}',
  ]),
  lines([
    'pub(super) fn scan_workspace_files(',
    '    root: &Path,',
    '    filters: &PathFilters,',
    ') -> Result<Arc<Vec<ScannedFile>>, String> {',
    '    let files = workspace_cache_files(root)?;',
    '    // 无路径过滤（最常见路径）时直接复用缓存的 Arc，避免每次按键搜索都深拷贝整份文件清单',
    '    // （每个 ScannedFile 含 PathBuf + 2×String，大仓下一次搜索可产生十几万次堆分配）。',
    '    if filters.is_empty() {',
    '        return Ok(files);',
    '    }',
    '    Ok(Arc::new(',
    '        files',
    '            .iter()',
    '            .filter(|file| passes_path_filters(&file.relative_path, filters))',
    '            .cloned()',
    '            .collect(),',
    '    ))',
    '}',
    '',
    'pub(super) fn workspace_cached_files_for_index(root: &Path) -> Result<Arc<Vec<ScannedFile>>, String> {',
    '    workspace_cache_files(root)',
    '}',
  ]),
  'expose cached file list to content index',
);

replaceOnce(
  'src-tauri/src/commands/search/scan.rs',
  '                cache.symbols = None;\n',
  '                cache.symbols = None;\n                super::content_index::invalidate_workspace_content_index(root);\n',
  'invalidate content index when file cache refreshes',
);

// ============================================================================
// 2) Frontend ultimate search result path: chunked stream ingestion + incremental
//    grouped result index. This prevents every streamed batch from rebuilding
//    all mapped result items/groups from scratch.
// ============================================================================

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  "import { computed, onScopeDispose, type Ref, ref, watch } from 'vue';\n",
  "import { computed, onScopeDispose, type Ref, ref, shallowRef, watch } from 'vue';\n",
  'import shallowRef for chunked search state',
);

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  lines([
    'const SEARCH_DEBOUNCE_MS = 180;',
    'const SEARCH_RESULT_LIMIT = 50000;',
  ]),
  lines([
    'const SEARCH_DEBOUNCE_MS = 180;',
    'const SEARCH_RESULT_LIMIT = 50000;',
    'const SEARCH_STREAM_FLUSH_INTERVAL_MS = 48;',
  ]),
  'add frontend streamed-result flush window',
);

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  lines([
    '  let searchRequestId = 0;',
    '  let searchTimer: ReturnType<typeof setTimeout> | null = null;',
    '  let activeAbortController: AbortController | null = null;',
    '  // 当前接受流式事件的关联标识：与传给后端的 streamToken 一致，过期搜索的残留事件据此忽略。',
    '  let streamingSearchId = 0;',
    '  let disposeSearchStream: (() => void) | null = null;',
  ]),
  lines([
    '  let searchRequestId = 0;',
    '  let searchTimer: ReturnType<typeof setTimeout> | null = null;',
    '  let activeAbortController: AbortController | null = null;',
    '  // 当前接受流式事件的关联标识：与传给后端的 streamToken 一致，过期搜索的残留事件据此忽略。',
    '  let streamingSearchId = 0;',
    '  let disposeSearchStream: (() => void) | null = null;',
    '  let pendingStreamResults: IWorkspaceSearchResult[] = [];',
    '  let streamResultsFlushTimer: ReturnType<typeof setTimeout> | null = null;',
  ]),
  'add frontend pending streamed-result buffer',
);

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  lines([
    '  const backendResults = ref<IWorkspaceSearchResult[]>([]);',
    '  const resultsScrollRef = ref<HTMLElement | null>(null);',
  ]),
  lines([
    '  const resultsScrollRef = ref<HTMLElement | null>(null);',
    '  const searchResultsRevision = ref(0);',
    '  const searchGroupsRevision = ref(0);',
    '  const resultChunks = shallowRef<ReadonlyArray<ReadonlyArray<IWorkspaceSearchResult>>>([]);',
  ]),
  'replace flat backend result ref with chunk metadata',
);

const oldSearchMappingBlock = lines([
  '  const toResultItem = (result: IWorkspaceSearchResult): ISearchResultItem => {',
  '    let cachedSegments: ISnippetSegment[] | null = null;',
  '    return {',
  '      path: result.path,',
  '      relativePath: result.relativePath,',
  "      resultKey: `${result.kind}:${result.path}:${result.lineNumber ?? 0}:${result.matchStart ?? -1}:${result.matchEnd ?? -1}`,",
  '      reason: result.kind,',
  '      get snippetSegments(): ISnippetSegment[] {',
  '        if (cachedSegments) return cachedSegments;',
  '        const rawSnippetText = result.lineText ?? result.name;',
  '        const rawMatchRange =',
  '          result.matchStart !== null && result.matchEnd !== null',
  '            ? ([result.matchStart, result.matchEnd] as [number, number])',
  '            : null;',
  '        const preview =',
  '          result.lineText === null',
  '            ? { text: rawSnippetText, range: rawMatchRange }',
  '            : trimBoundaryWhitespaceWithRange(rawSnippetText, rawMatchRange);',
  '        cachedSegments =',
  "          result.kind === 'content' && preview.range",
  '            ? toAnchoredSnippetSegments(buildMatchSegments(preview.text, preview.range))',
  '            : toAnchoredSnippetSegments(',
  '                matcher.value.highlight(trimBoundaryWhitespace(preview.text)),',
  '              );',
  '        return cachedSegments;',
  '      },',
  '      score: result.score,',
  '      lineNumber: result.lineNumber,',
  '      matchStart: result.matchStart,',
  '      matchEnd: result.matchEnd,',
  '    };',
  '  };',
  '',
  '  const allResults = computed(() => backendResults.value.map(toResultItem));',
  "  const searchResultsByScope = computed<Record<TWorkspaceSearchScope, ISearchResultItem[]>>(() => ({",
  '    all: allResults.value,',
  "    'file-name': allResults.value.filter((result) => result.reason === 'file-name'),",
  "    symbol: allResults.value.filter((result) => result.reason === 'symbol'),",
  "    content: allResults.value.filter((result) => result.reason === 'content'),",
  '  }));',
  '',
  '  const scopeChips = computed(() =>',
  '    (Object.keys(SEARCH_SCOPE_LABELS) as TWorkspaceSearchScope[]).map((scopeKey) => ({',
  '      key: scopeKey,',
  '      label: SEARCH_SCOPE_LABELS[scopeKey],',
  '      count: searchResultsByScope.value[scopeKey].length,',
  '    })),',
  '  );',
  '',
  '  const activeResults = computed(() => searchResultsByScope.value[activeScope.value]);',
  '  const searchResultGroups = computed<ISearchResultGroup[]>(() => {',
  '    const groups = new Map<string, ISearchResultGroup>();',
  '    for (const result of activeResults.value) {',
  '      const existing = groups.get(result.path);',
  '      if (existing) {',
  '        existing.results.push(result);',
  '        continue;',
  '      }',
  '      groups.set(result.path, {',
  '        path: result.path,',
  '        name: getFileName(result.relativePath),',
  '        parentPath: getParentPath(result.relativePath),',
  '        results: [result],',
  '      });',
  '    }',
  '    return Array.from(groups.values());',
  '  });',
  '',
  '  const isSearchResultGroupCollapsed = (path: string): boolean =>',
  '    collapsedSearchResultPaths.value.has(path);',
  '  const toggleSearchResultGroup = (path: string): void => {',
  '    collapsedSearchResultPaths.value = toggleReadonlySetValue(',
  '      collapsedSearchResultPaths.value,',
  '      path,',
  '    );',
  '  };',
  '',
  '  const flatSearchRows = computed<IFlatSearchRow[]>(() => {',
  '    const rows: IFlatSearchRow[] = [];',
  '    for (const group of searchResultGroups.value) {',
  "      rows.push({ kind: 'group', key: `group:${group.path}`, group, result: null });",
  '      if (!isSearchResultGroupCollapsed(group.path)) {',
  '        for (const result of group.results) {',
  "          rows.push({ kind: 'line', key: result.resultKey, group, result });",
  '        }',
  '      }',
  '    }',
  '    return rows;',
  '  });',
]);

const newSearchMappingBlock = lines([
  '  const createEmptyResultsByScope = (): Record<TWorkspaceSearchScope, ISearchResultItem[]> => ({',
  '    all: [],',
  "    'file-name': [],",
  '    symbol: [],',
  '    content: [],',
  '  });',
  '',
  '  const createEmptyGroupsByScope = (): Record<TWorkspaceSearchScope, Map<string, ISearchResultGroup>> => ({',
  '    all: new Map(),',
  "    'file-name': new Map(),",
  '    symbol: new Map(),',
  '    content: new Map(),',
  '  });',
  '',
  '  let searchResultsByScopeState = createEmptyResultsByScope();',
  '  let searchGroupsByScopeState = createEmptyGroupsByScope();',
  '',
  '  const toResultItem = (result: IWorkspaceSearchResult): ISearchResultItem => {',
  '    let cachedSegments: ISnippetSegment[] | null = null;',
  '    return {',
  '      path: result.path,',
  '      relativePath: result.relativePath,',
  "      resultKey: `${result.kind}:${result.path}:${result.lineNumber ?? 0}:${result.matchStart ?? -1}:${result.matchEnd ?? -1}`,",
  '      reason: result.kind,',
  '      get snippetSegments(): ISnippetSegment[] {',
  '        if (cachedSegments) return cachedSegments;',
  '        const rawSnippetText = result.lineText ?? result.name;',
  '        const rawMatchRange =',
  '          result.matchStart !== null && result.matchEnd !== null',
  '            ? ([result.matchStart, result.matchEnd] as [number, number])',
  '            : null;',
  '        const preview =',
  '          result.lineText === null',
  '            ? { text: rawSnippetText, range: rawMatchRange }',
  '            : trimBoundaryWhitespaceWithRange(rawSnippetText, rawMatchRange);',
  '        cachedSegments =',
  "          result.kind === 'content' && preview.range",
  '            ? toAnchoredSnippetSegments(buildMatchSegments(preview.text, preview.range))',
  '            : toAnchoredSnippetSegments(',
  '                matcher.value.highlight(trimBoundaryWhitespace(preview.text)),',
  '              );',
  '        return cachedSegments;',
  '      },',
  '      score: result.score,',
  '      lineNumber: result.lineNumber,',
  '      matchStart: result.matchStart,',
  '      matchEnd: result.matchEnd,',
  '    };',
  '  };',
  '',
  '  const appendResultToScope = (scope: TWorkspaceSearchScope, item: ISearchResultItem): void => {',
  '    searchResultsByScopeState[scope].push(item);',
  '    const groups = searchGroupsByScopeState[scope];',
  '    const existing = groups.get(item.path);',
  '    if (existing) {',
  '      existing.results.push(item);',
  '      return;',
  '    }',
  '    groups.set(item.path, {',
  '      path: item.path,',
  '      name: getFileName(item.relativePath),',
  '      parentPath: getParentPath(item.relativePath),',
  '      results: [item],',
  '    });',
  '  };',
  '',
  '  const appendBackendResults = (results: readonly IWorkspaceSearchResult[]): void => {',
  '    if (results.length === 0) {',
  '      return;',
  '    }',
  '    resultChunks.value = [...resultChunks.value, results];',
  '    for (const result of results) {',
  '      const item = toResultItem(result);',
  "      appendResultToScope('all', item);",
  '      appendResultToScope(item.reason, item);',
  '    }',
  '    searchResultsRevision.value += 1;',
  '    searchGroupsRevision.value += 1;',
  '  };',
  '',
  '  const replaceBackendResults = (results: readonly IWorkspaceSearchResult[]): void => {',
  '    resultChunks.value = [];',
  '    searchResultsByScopeState = createEmptyResultsByScope();',
  '    searchGroupsByScopeState = createEmptyGroupsByScope();',
  '    appendBackendResults(results);',
  '    if (results.length === 0) {',
  '      searchResultsRevision.value += 1;',
  '      searchGroupsRevision.value += 1;',
  '    }',
  '  };',
  '',
  '  const scopeChips = computed(() => {',
  '    searchResultsRevision.value;',
  '    return (Object.keys(SEARCH_SCOPE_LABELS) as TWorkspaceSearchScope[]).map((scopeKey) => ({',
  '      key: scopeKey,',
  '      label: SEARCH_SCOPE_LABELS[scopeKey],',
  '      count: searchResultsByScopeState[scopeKey].length,',
  '    }));',
  '  });',
  '',
  '  const activeResults = computed(() => {',
  '    searchResultsRevision.value;',
  '    return searchResultsByScopeState[activeScope.value];',
  '  });',
  '',
  '  const searchResultGroups = computed<ISearchResultGroup[]>(() => {',
  '    searchGroupsRevision.value;',
  '    return Array.from(searchGroupsByScopeState[activeScope.value].values());',
  '  });',
  '',
  '  const isSearchResultGroupCollapsed = (path: string): boolean =>',
  '    collapsedSearchResultPaths.value.has(path);',
  '  const toggleSearchResultGroup = (path: string): void => {',
  '    collapsedSearchResultPaths.value = toggleReadonlySetValue(',
  '      collapsedSearchResultPaths.value,',
  '      path,',
  '    );',
  '  };',
  '',
  '  const flatSearchRows = computed<IFlatSearchRow[]>(() => {',
  '    const rows: IFlatSearchRow[] = [];',
  '    for (const group of searchResultGroups.value) {',
  "      rows.push({ kind: 'group', key: `group:${group.path}`, group, result: null });",
  '      if (!isSearchResultGroupCollapsed(group.path)) {',
  '        for (const result of group.results) {',
  "          rows.push({ kind: 'line', key: result.resultKey, group, result });",
  '        }',
  '      }',
  '    }',
  '    return rows;',
  '  });',
]);

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  oldSearchMappingBlock,
  newSearchMappingBlock,
  'incrementally index frontend search results by scope and group',
);

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  lines([
    '  const invalidateInFlightSearch = (): void => {',
    '    searchRequestId += 1;',
    '    activeAbortController?.abort();',
    '    activeAbortController = null;',
    '    streamingSearchId = 0;',
    '  };',
    '',
    '  const clearSearchResults = (): void => {',
    '    scannedFileCount.value = 0;',
    '    backendResults.value = [];',
    '    searchIndexing.value = false;',
    "    searchError.value = '';",
    '  };',
    '',
    '  const handleSearchStreamEvent = (event: IWorkspaceSearchStreamEvent): void => {',
    '    // 仅接收当前搜索（streamToken 匹配）按发现顺序分批推送的内容命中，逐批追加形成渐进式结果。',
    '    if (event.searchId !== streamingSearchId || event.results.length === 0) return;',
    '    backendResults.value = [...backendResults.value, ...event.results];',
    '  };',
  ]),
  lines([
    '  const clearPendingStreamResults = (): void => {',
    '    if (streamResultsFlushTimer) {',
    '      clearTimeout(streamResultsFlushTimer);',
    '      streamResultsFlushTimer = null;',
    '    }',
    '    pendingStreamResults = [];',
    '  };',
    '',
    '  const flushPendingStreamResults = (): void => {',
    '    if (streamResultsFlushTimer) {',
    '      clearTimeout(streamResultsFlushTimer);',
    '      streamResultsFlushTimer = null;',
    '    }',
    '    if (pendingStreamResults.length === 0) {',
    '      return;',
    '    }',
    '    const nextResults = pendingStreamResults;',
    '    pendingStreamResults = [];',
    '    appendBackendResults(nextResults);',
    '  };',
    '',
    '  const scheduleStreamResultsFlush = (): void => {',
    '    if (streamResultsFlushTimer) {',
    '      return;',
    '    }',
    '    streamResultsFlushTimer = setTimeout(() => {',
    '      streamResultsFlushTimer = null;',
    '      flushPendingStreamResults();',
    '    }, SEARCH_STREAM_FLUSH_INTERVAL_MS);',
    '  };',
    '',
    '  const invalidateInFlightSearch = (): void => {',
    '    searchRequestId += 1;',
    '    activeAbortController?.abort();',
    '    activeAbortController = null;',
    '    streamingSearchId = 0;',
    '    clearPendingStreamResults();',
    '  };',
    '',
    '  const clearSearchResults = (): void => {',
    '    clearPendingStreamResults();',
    '    scannedFileCount.value = 0;',
    '    replaceBackendResults([]);',
    '    searchIndexing.value = false;',
    "    searchError.value = '';",
    '  };',
    '',
    '  const handleSearchStreamEvent = (event: IWorkspaceSearchStreamEvent): void => {',
    '    // 仅接收当前搜索（streamToken 匹配）按发现顺序分批推送的内容命中，逐批追加形成渐进式结果。',
    '    if (event.searchId !== streamingSearchId || event.results.length === 0) return;',
    '    pendingStreamResults.push(...event.results);',
    '    scheduleStreamResultsFlush();',
    '  };',
  ]),
  'batch stream events into incremental frontend result index',
);

for (const [source, target, label] of [
  ['    streamingSearchId = lifecycle.requestId;\n    scannedFileCount.value = 0;\n    backendResults.value = [];\n', '    streamingSearchId = lifecycle.requestId;\n    clearPendingStreamResults();\n    scannedFileCount.value = 0;\n    replaceBackendResults([]);\n', 'reset chunked results before search'],
  ['      streamingSearchId = 0;\n      scannedFileCount.value = payload.scannedFileCount;\n      backendResults.value = payload.results;\n', '      streamingSearchId = 0;\n      clearPendingStreamResults();\n      scannedFileCount.value = payload.scannedFileCount;\n      replaceBackendResults(payload.results);\n', 'replace chunked results with authoritative payload'],
  ['      streamingSearchId = 0;\n      backendResults.value = [];\n      searchError.value = toErrorMessage(error, \'搜索失败。\');\n', '      streamingSearchId = 0;\n      clearPendingStreamResults();\n      replaceBackendResults([]);\n      searchError.value = toErrorMessage(error, \'搜索失败。\');\n', 'clear chunked results on search error'],
]) {
  replaceOnce('src/components/workbench/sidebar/search/useWorkspaceSearch.ts', source, target, label);
}

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  lines([
    '  const cancelPendingSearch = (): void => {',
    '    if (searchTimer) {',
    '      clearTimeout(searchTimer);',
    '      searchTimer = null;',
    '    }',
    '    activeAbortController?.abort();',
    '    activeAbortController = null;',
    '  };',
  ]),
  lines([
    '  const cancelPendingSearch = (): void => {',
    '    searchRequestId += 1;',
    '    streamingSearchId = 0;',
    '    clearPendingStreamResults();',
    '    if (searchTimer) {',
    '      clearTimeout(searchTimer);',
    '      searchTimer = null;',
    '    }',
    '    activeAbortController?.abort();',
    '    activeAbortController = null;',
    '  };',
  ]),
  'fully invalidate frontend search stream on cancel',
);

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  lines([
    '  watch(activeResults, (results) => {',
    '    const availableKeys = new Set(results.map((result) => result.resultKey));',
    '    if (selectedResultKey.value && !availableKeys.has(selectedResultKey.value))',
    '      selectedResultKey.value = null;',
    '  });',
  ]),
  lines([
    '  watch(activeResults, (results) => {',
    '    const selectedKey = selectedResultKey.value;',
    '    if (!selectedKey) {',
    '      return;',
    '    }',
    '    if (!results.some((result) => result.resultKey === selectedKey)) {',
    '      selectedResultKey.value = null;',
    '    }',
    '  });',
  ]),
  'avoid selected result Set allocation on each update',
);

replaceOnce(
  'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
  lines([
    '  onScopeDispose(() => {',
    '    disposeSearchStream?.();',
    '    disposeSearchStream = null;',
    '  });',
  ]),
  lines([
    '  onScopeDispose(() => {',
    '    clearPendingStreamResults();',
    '    disposeSearchStream?.();',
    '    disposeSearchStream = null;',
    '  });',
  ]),
  'clear pending stream chunks on dispose',
);

console.log('\nUltimate search performance patch completed. No backup files were created.');