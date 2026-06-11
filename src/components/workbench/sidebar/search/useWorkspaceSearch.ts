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