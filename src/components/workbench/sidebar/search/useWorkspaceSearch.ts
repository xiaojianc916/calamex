import { computed, onScopeDispose, type Ref, ref, shallowRef, watch } from 'vue';
import { tauriService } from '@/services/tauri';
import type { IWorkbenchOpenFileRequest } from '@/types/editor';
import type {
  IWorkspaceSearchResult,
  IWorkspaceSearchStreamEvent,
  TWorkspaceSearchScope,
} from '@/types/search';
import { toErrorMessage } from '@/utils/error/error';
import { areFileSystemPathsEqual } from '@/utils/file/path';
import type {
  IFlatSearchRow,
  ISearchResultGroup,
  ISearchResultItem,
  ISnippetSegment,
  TSearchToggleOption,
} from './search-sidebar.types';
import {
  buildMatchSegments,
  createSearchMatcher,
  getFileName,
  getParentPath,
  splitPatternList,
  toAnchoredSnippetSegments,
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
const SEARCH_STREAM_FLUSH_INTERVAL_MS = 48;

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
  const resultsScrollRef = ref<HTMLElement | null>(null);
  const searchResultsRevision = ref(0);
  const searchGroupsRevision = ref(0);
  const resultChunks = shallowRef<ReadonlyArray<ReadonlyArray<IWorkspaceSearchResult>>>([]);

  let searchRequestId = 0;
  let activeAbortController: AbortController | null = null;
  // 当前接受流式事件的关联标识：与传给后端的 streamToken 一致，过期搜索的残留事件据此忽略。
  let streamingSearchId = 0;
  let disposeSearchStream: (() => void) | null = null;
  let pendingStreamResults: IWorkspaceSearchResult[] = [];
  let streamResultsFlushTimer: ReturnType<typeof setTimeout> | null = null;

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

  const createEmptyResultsByScope = (): Record<TWorkspaceSearchScope, ISearchResultItem[]> => ({
    all: [],
    'file-name': [],
    symbol: [],
    content: [],
  });

  const createEmptyGroupsByScope = (): Record<
    TWorkspaceSearchScope,
    Map<string, ISearchResultGroup>
  > => ({
    all: new Map(),
    'file-name': new Map(),
    symbol: new Map(),
    content: new Map(),
  });

  let searchResultsByScopeState = createEmptyResultsByScope();
  let searchGroupsByScopeState = createEmptyGroupsByScope();

  const toResultItem = (result: IWorkspaceSearchResult): ISearchResultItem => {
    let cachedSegments: ISnippetSegment[] | null = null;
    return {
      path: result.path,
      relativePath: result.relativePath,
      resultKey: `${result.kind}:${result.path}:${result.lineNumber ?? 0}:${result.matchStart ?? -1}:${result.matchEnd ?? -1}`,
      reason: result.kind,
      get snippetSegments(): ISnippetSegment[] {
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
            ? toAnchoredSnippetSegments(buildMatchSegments(preview.text, preview.range))
            : toAnchoredSnippetSegments(
                matcher.value.highlight(trimBoundaryWhitespace(preview.text)),
              );
        return cachedSegments;
      },
      score: result.score,
      lineNumber: result.lineNumber,
      matchStart: result.matchStart,
      matchEnd: result.matchEnd,
    };
  };

  const appendResultToScope = (scope: TWorkspaceSearchScope, item: ISearchResultItem): void => {
    searchResultsByScopeState[scope].push(item);
    const groups = searchGroupsByScopeState[scope];
    const existing = groups.get(item.path);
    if (existing) {
      existing.results.push(item);
      return;
    }
    groups.set(item.path, {
      path: item.path,
      name: getFileName(item.relativePath),
      parentPath: getParentPath(item.relativePath),
      results: [item],
    });
  };

  const appendBackendResults = (results: readonly IWorkspaceSearchResult[]): void => {
    if (results.length === 0) {
      return;
    }
    resultChunks.value = [...resultChunks.value, results];
    for (const result of results) {
      const item = toResultItem(result);
      appendResultToScope('all', item);
      appendResultToScope(item.reason, item);
    }
    searchResultsRevision.value += 1;
    searchGroupsRevision.value += 1;
  };

  const replaceBackendResults = (results: readonly IWorkspaceSearchResult[]): void => {
    resultChunks.value = [];
    searchResultsByScopeState = createEmptyResultsByScope();
    searchGroupsByScopeState = createEmptyGroupsByScope();
    appendBackendResults(results);
    if (results.length === 0) {
      searchResultsRevision.value += 1;
      searchGroupsRevision.value += 1;
    }
  };

  const scopeChips = computed(() => {
    searchResultsRevision.value;
    return (Object.keys(SEARCH_SCOPE_LABELS) as TWorkspaceSearchScope[]).map((scopeKey) => ({
      key: scopeKey,
      label: SEARCH_SCOPE_LABELS[scopeKey],
      count: searchResultsByScopeState[scopeKey].length,
    }));
  });

  const activeResults = computed(() => {
    searchResultsRevision.value;
    return searchResultsByScopeState[activeScope.value];
  });

  const searchResultGroups = computed<ISearchResultGroup[]>(() => {
    searchGroupsRevision.value;
    return Array.from(searchGroupsByScopeState[activeScope.value].values());
  });

  const isSearchResultGroupCollapsed = (path: string): boolean =>
    collapsedSearchResultPaths.value.has(path);
  const toggleSearchResultGroup = (path: string): void => {
    collapsedSearchResultPaths.value = toggleReadonlySetValue(
      collapsedSearchResultPaths.value,
      path,
    );
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

  const clearPendingStreamResults = (): void => {
    if (streamResultsFlushTimer) {
      clearTimeout(streamResultsFlushTimer);
      streamResultsFlushTimer = null;
    }
    pendingStreamResults = [];
  };

  const flushPendingStreamResults = (): void => {
    if (streamResultsFlushTimer) {
      clearTimeout(streamResultsFlushTimer);
      streamResultsFlushTimer = null;
    }
    if (pendingStreamResults.length === 0) {
      return;
    }
    const nextResults = pendingStreamResults;
    pendingStreamResults = [];
    appendBackendResults(nextResults);
  };

  const scheduleStreamResultsFlush = (): void => {
    if (streamResultsFlushTimer) {
      return;
    }
    streamResultsFlushTimer = setTimeout(() => {
      streamResultsFlushTimer = null;
      flushPendingStreamResults();
    }, SEARCH_STREAM_FLUSH_INTERVAL_MS);
  };

  const invalidateInFlightSearch = (): void => {
    searchRequestId += 1;
    activeAbortController?.abort();
    activeAbortController = null;
    streamingSearchId = 0;
    clearPendingStreamResults();
  };

  const clearSearchResults = (): void => {
    clearPendingStreamResults();
    scannedFileCount.value = 0;
    replaceBackendResults([]);
    searchIndexing.value = false;
    searchError.value = '';
  };

  const handleSearchStreamEvent = (event: IWorkspaceSearchStreamEvent): void => {
    // 仅接收当前搜索（streamToken 匹配）按发现顺序分批推送的内容命中，逐批追加形成渐进式结果。
    if (event.searchId !== streamingSearchId || event.results.length === 0) return;
    pendingStreamResults.push(...event.results);
    scheduleStreamResultsFlush();
  };

  const runSearch = async (): Promise<void> => {
    const query = searchQuery.value.trim();
    if (
      !isDesktopRuntime.value ||
      !workspaceRootPath.value ||
      matcherError.value ||
      query.length === 0
    ) {
      invalidateInFlightSearch();
      clearSearchResults();
      return;
    }
    const lifecycle = beginSearchLifecycle(query);
    // 关联本次搜索的流式事件：后端按文件发现顺序分批回推内容命中，事件回带同一 streamToken。
    streamingSearchId = lifecycle.requestId;
    clearPendingStreamResults();
    scannedFileCount.value = 0;
    replaceBackendResults([]);
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
          streamToken: lifecycle.requestId,
        },
        { signal: lifecycle.signal },
      );
      if (!isSearchLifecycleCurrent(lifecycle)) return;
      // 一次性返回的权威结果（已排序、含文件名/符号命中）覆盖流式累积的预览。
      streamingSearchId = 0;
      clearPendingStreamResults();
      scannedFileCount.value = payload.scannedFileCount;
      replaceBackendResults(payload.results);
    } catch (error) {
      if (lifecycle.signal.aborted || !isSearchLifecycleCurrent(lifecycle)) return;
      streamingSearchId = 0;
      clearPendingStreamResults();
      replaceBackendResults([]);
      searchError.value = toErrorMessage(error, '搜索失败。');
    } finally {
      if (lifecycle.requestId === searchRequestId) {
        searchIndexing.value = false;
        activeAbortController = null;
      }
    }
  };

  // 自实现的 trailing debounce：高频触发只执行最后一次，并显式暴露 cancel()。
  // 此前用 @vueuse/core 的 useDebounceFn，但它的返回值并没有 .cancel() 方法（旧注释
  // “vueuse 自动 onScopeDispose 取消”是错误假设）。cancelPendingSearch() 里调用
  // debouncedRunSearch.cancel() 会必抛 “debouncedRunSearch.cancel is not a function”，
  // 而该调用又发生在 SearchSidebarPanel 挂载时的 immediate watch（!isActive 分支）中，
  // 于是异常发生在 setup 阶段 → app.config.errorHandler → setRuntimeError('Vue render
  // failed') → 升级到致命错误态。在 App.vue 覆盖层修复之前，这会拆掉整个工作台，
  // 表现为“切到搜索侧边栏、来回切几次后点击彻底卡死”。改为自带 cancel() 的最小 trailing
  // debounce 实现，从根上修复，并在 cancel / scope dispose 时正确清理待执行的定时器。
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedRunSearch: (() => void) & { cancel: () => void } = Object.assign(
    (): void => {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        void runSearch();
      }, SEARCH_DEBOUNCE_MS);
    },
    {
      cancel: (): void => {
        if (searchDebounceTimer) {
          clearTimeout(searchDebounceTimer);
          searchDebounceTimer = null;
        }
      },
    },
  );

  const scheduleSearch = (): void => {
    invalidateInFlightSearch();
    debouncedRunSearch();
  };

  const cancelPendingSearch = (): void => {
    searchRequestId += 1;
    streamingSearchId = 0;
    clearPendingStreamResults();
    debouncedRunSearch.cancel();
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

  const subscribeSearchStream = async (): Promise<void> => {
    try {
      disposeSearchStream = await tauriService.onWorkspaceSearchStream(handleSearchStreamEvent);
    } catch {
      // 浏览器预览或事件通道不可用时，静默降级为一次性返回。
      disposeSearchStream = null;
    }
  };

  if (isDesktopRuntime.value) {
    void subscribeSearchStream();
  }

  watch(activeResults, (results) => {
    const selectedKey = selectedResultKey.value;
    if (!selectedKey) {
      return;
    }
    if (!results.some((result) => result.resultKey === selectedKey)) {
      selectedResultKey.value = null;
    }
  });

  onScopeDispose(() => {
    cancelPendingSearch();
    disposeSearchStream?.();
    disposeSearchStream = null;
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
