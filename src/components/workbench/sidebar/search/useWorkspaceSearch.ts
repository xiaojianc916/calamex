import { type Ref, computed, ref, watch } from 'vue';
import { tauriService } from '@/services/tauri';
import type { IWorkbenchOpenFileRequest } from '@/types/editor';
import type { IWorkspaceSearchResult, TWorkspaceSearchScope } from '@/types/search';
import { toErrorMessage } from '@/utils/error';
import { areFileSystemPathsEqual } from '@/utils/path';
import type {
  IFlatSearchRow,
  IHighlightedSegment,
  ISearchResultGroup,
  ISearchResultItem,
  TSearchToggleOption,
} from './search-sidebar.types';
import {
  buildCompactHighlightedSegments,
  createSearchMatcher,
  getFileName,
  getParentPath,
  splitPatternList,
  toggleReadonlySetValue,
  trimBoundaryWhitespace,
  trimBoundaryWhitespaceWithRange,
} from './search-sidebar-text';

const SEARCH_SCOPE_LABELS: Record<TWorkspaceSearchScope, string> = {
  all: '全部',
  'file-name': '文件名',
  symbol: '符号',
  content: '内容',
};

const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_RESULT_LIMIT = 50000;
const SEARCH_RESULT_CONTEXT_CHARS = 28;

type TSearchLifecycle = {
  requestId: number;
  workspaceRootPath: string | null;
  query: string;
  signal: AbortSignal;
};

export interface IUseWorkspaceSearchOptions {
  isDesktopRuntime: Ref<boolean>;
  workspaceRootPath: Ref<string | null>;
  emitOpenFile: (payload: IWorkbenchOpenFileRequest) => void;
}

export const useWorkspaceSearch = (options: IUseWorkspaceSearchOptions) => {
  const { isDesktopRuntime, workspaceRootPath, emitOpenFile } = options;

  const searchQuery = ref('');
  const includePattern = ref('');
  const excludePattern = ref('');
  const activeScope = ref<TWorkspaceSearchScope>('all');
  const matchCase = ref(false);
  const wholeWord = ref(false);
  const useRegex = ref(false);
  const contentFuzzy = ref(false);
  const useStructural = ref(false);
  const showPathFilters = ref(false);
  const searchIndexing = ref(false);
  const searchError = ref('');
  const collapsedSearchResultPaths = ref<ReadonlySet<string>>(new Set<string>());
  const selectedResultKey = ref<string | null>(null);
  const scannedFileCount = ref(0);
  const backendResults = ref<IWorkspaceSearchResult[]>([]);
  const resultsScrollRef = ref<HTMLElement | null>(null);

  let searchRequestId = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAbortController: AbortController | null = null;

  const isWorkspaceRootCurrent = (candidate: string | null | undefined): boolean =>
    !candidate || areFileSystemPathsEqual(candidate, workspaceRootPath.value);

  const beginSearchLifecycle = (query: string): TSearchLifecycle => {
    searchRequestId += 1;
    activeAbortController?.abort();
    const controller = new AbortController();
    activeAbortController = controller;
    return {
      requestId: searchRequestId,
      workspaceRootPath: workspaceRootPath.value,
      query,
      signal: controller.signal,
    };
  };

  const isSearchLifecycleCurrent = (lifecycle: TSearchLifecycle): boolean =>
    lifecycle.requestId === searchRequestId &&
    !lifecycle.signal.aborted &&
    isWorkspaceRootCurrent(lifecycle.workspaceRootPath) &&
    searchQuery.value.trim() === lifecycle.query;

  const matcher = computed(() =>
    createSearchMatcher({
      query: searchQuery.value,
      matchCase: matchCase.value,
      wholeWord: wholeWord.value,
      useRegex: useRegex.value,
      useStructural: useStructural.value,
    }),
  );
  const matcherError = computed(() => matcher.value.errorMessage);
  const hasSearchQuery = computed(() => searchQuery.value.trim().length > 0);
  const includePatterns = computed(() => splitPatternList(includePattern.value));
  const excludePatterns = computed(() => splitPatternList(excludePattern.value));
  const effectiveIncludePatterns = computed(() =>
    showPathFilters.value && !useStructural.value ? includePatterns.value : [],
  );
  const effectiveExcludePatterns = computed(() =>
    showPathFilters.value && !useStructural.value ? excludePatterns.value : [],
  );

  const toResultItem = (result: IWorkspaceSearchResult): ISearchResultItem => {
    let cachedSegments: IHighlightedSegment[] | null = null;
    return {
      path: result.path,
      relativePath: result.relativePath,
      resultKey: `${result.kind}:${result.path}:${result.lineNumber ?? 0}:${result.matchStart ?? -1}:${result.matchEnd ?? -1}`,
      reason: result.kind,
      get snippetSegments(): IHighlightedSegment[] {
        if (cachedSegments) return cachedSegments;
        const rawSnippetText = result.lineText ?? result.name;
        const rawMatchRange =
          result.matchStart !== null && result.matchEnd !== null
            ? ([result.matchStart, result.matchEnd] as [number, number])
            : null;
        const preview =
          result.lineText === null
            ? { text: rawSnippetText, range: rawMatchRange }
            : trimBoundaryWhitespaceWithRange(rawSnippetText, rawMatchRange);
        cachedSegments =
          result.kind === 'content' && preview.range
            ? buildCompactHighlightedSegments(preview.text, preview.range, SEARCH_RESULT_CONTEXT_CHARS)
            : matcher.value.highlight(trimBoundaryWhitespace(preview.text));
        return cachedSegments;
      },
      score: result.score,
      lineNumber: result.lineNumber,
      matchStart: result.matchStart,
      matchEnd: result.matchEnd,
    };
  };

  const allResults = computed(() => backendResults.value.map(toResultItem));
  const searchResultsByScope = computed<Record<TWorkspaceSearchScope, ISearchResultItem[]>>(() => ({
    all: allResults.value,
    'file-name': allResults.value.filter((result) => result.reason === 'file-name'),
    symbol: allResults.value.filter((result) => result.reason === 'symbol'),
    content: allResults.value.filter((result) => result.reason === 'content'),
  }));

  const scopeChips = computed(() =>
    (Object.keys(SEARCH_SCOPE_LABELS) as TWorkspaceSearchScope[]).map((scopeKey) => ({
      key: scopeKey,
      label: SEARCH_SCOPE_LABELS[scopeKey],
      count: searchResultsByScope.value[scopeKey].length,
    })),
  );

  const activeResults = computed(() => searchResultsByScope.value[activeScope.value]);
  const searchResultGroups = computed<ISearchResultGroup[]>(() => {
    const groups = new Map<string, ISearchResultGroup>();
    for (const result of activeResults.value) {
      const existing = groups.get(result.path);
      if (existing) {
        existing.results.push(result);
        continue;
      }
      groups.set(result.path, {
        path: result.path,
        name: getFileName(result.relativePath),
        parentPath: getParentPath(result.relativePath),
        results: [result],
      });
    }
    return Array.from(groups.values());
  });

  const isSearchResultGroupCollapsed = (path: string): boolean =>
    collapsedSearchResultPaths.value.has(path);
  const toggleSearchResultGroup = (path: string): void => {
    collapsedSearchResultPaths.value = toggleReadonlySetValue(collapsedSearchResultPaths.value, path);
  };

  const flatSearchRows = computed<IFlatSearchRow[]>(() => {
    const rows: IFlatSearchRow[] = [];
    for (const group of searchResultGroups.value) {
      rows.push({ kind: 'group', key: `group:${group.path}`, group, result: null });
      if (!isSearchResultGroupCollapsed(group.path)) {
        for (const result of group.results) {
          rows.push({ kind: 'line', key: result.resultKey, group, result });
        }
      }
    }
    return rows;
  });

  const toggleSearchOption = (option: TSearchToggleOption): void => {
    if (useStructural.value) useStructural.value = false;
    if (option === 'matchCase') {
      matchCase.value = !matchCase.value;
      return;
    }
    if (option === 'wholeWord') {
      wholeWord.value = !wholeWord.value;
      return;
    }
    if (option === 'useRegex') {
      useRegex.value = !useRegex.value;
      if (useRegex.value) contentFuzzy.value = false;
      return;
    }
    if (option === 'contentFuzzy') {
      contentFuzzy.value = !contentFuzzy.value;
      if (contentFuzzy.value) useRegex.value = false;
      return;
    }
    showPathFilters.value = !showPathFilters.value;
  };

  const toggleStructuralSearch = (): void => {
    const nextStructural = !useStructural.value;
    useStructural.value = nextStructural;
    if (nextStructural) {
      matchCase.value = false;
      wholeWord.value = false;
      useRegex.value = false;
      contentFuzzy.value = false;
      showPathFilters.value = false;
      activeScope.value = 'content';
    }
  };

  const invalidateInFlightSearch = (): void => {
    searchRequestId += 1;
    activeAbortController?.abort();
    activeAbortController = null;
  };

  const clearSearchResults = (): void => {
    scannedFileCount.value = 0;
    backendResults.value = [];
    searchIndexing.value = false;
    searchError.value = '';
  };

  const runSearch = async (): Promise<void> => {
    const query = searchQuery.value.trim();
    if (!isDesktopRuntime.value || !workspaceRootPath.value || matcherError.value || query.length === 0) {
      invalidateInFlightSearch();
      clearSearchResults();
      return;
    }
    const lifecycle = beginSearchLifecycle(query);
    searchIndexing.value = true;
    searchError.value = '';
    try {
      const payload = await tauriService.searchWorkspace(
        {
          workspaceRootPath: lifecycle.workspaceRootPath!,
          query: lifecycle.query,
          scope: 'all',
          matchCase: matchCase.value,
          wholeWord: wholeWord.value,
          useRegex: useRegex.value,
          useStructural: useStructural.value,
          contentFuzzy: contentFuzzy.value,
          includePatterns: effectiveIncludePatterns.value,
          excludePatterns: effectiveExcludePatterns.value,
          limit: SEARCH_RESULT_LIMIT,
        },
        { signal: lifecycle.signal },
      );
      if (!isSearchLifecycleCurrent(lifecycle)) return;
      scannedFileCount.value = payload.scannedFileCount;
      backendResults.value = payload.results;
    } catch (error) {
      if (lifecycle.signal.aborted || !isSearchLifecycleCurrent(lifecycle)) return;
      backendResults.value = [];
      searchError.value = toErrorMessage(error, '搜索失败。');
    } finally {
      if (lifecycle.requestId === searchRequestId) {
        searchIndexing.value = false;
        activeAbortController = null;
      }
    }
  };

  const scheduleSearch = (): void => {
    invalidateInFlightSearch();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch();
    }, SEARCH_DEBOUNCE_MS);
  };

  const cancelPendingSearch = (): void => {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    activeAbortController?.abort();
    activeAbortController = null;
  };

  const handleSearchResultOpen = (result: ISearchResultItem): void => {
    selectedResultKey.value = result.resultKey;
    emitOpenFile({
      path: result.path,
      lineNumber: result.lineNumber,
      column: result.matchStart === null ? 1 : result.matchStart + 1,
    });
  };

  const resetSearchState = (): void => {
    searchQuery.value = '';
    includePattern.value = '';
    excludePattern.value = '';
    activeScope.value = 'all';
    matchCase.value = false;
    wholeWord.value = false;
    useRegex.value = false;
    contentFuzzy.value = false;
    useStructural.value = false;
    showPathFilters.value = false;
    selectedResultKey.value = null;
  };

  watch(activeResults, (results) => {
    const availableKeys = new Set(results.map((result) => result.resultKey));
    if (selectedResultKey.value && !availableKeys.has(selectedResultKey.value))
      selectedResultKey.value = null;
  });

  return {
    searchQuery,
    includePattern,
    excludePattern,
    activeScope,
    matchCase,
    wholeWord,
    useRegex,
    contentFuzzy,
    useStructural,
    showPathFilters,
    searchIndexing,
    searchError,
    selectedResultKey,
    scannedFileCount,
    resultsScrollRef,
    isWorkspaceRootCurrent,
    matcherError,
    hasSearchQuery,
    effectiveIncludePatterns,
    effectiveExcludePatterns,
    scopeChips,
    activeResults,
    searchResultGroups,
    flatSearchRows,
    isSearchResultGroupCollapsed,
    toggleSearchResultGroup,
    collapsedSearchResultPaths,
    toggleSearchOption,
    toggleStructuralSearch,
    runSearch,
    scheduleSearch,
    cancelPendingSearch,
    handleSearchResultOpen,
    resetSearchState,
  };
};
