<template>
  <section class="search-sidebar" aria-label="搜索">
    <div class="search-panel-query-stack">
      <div class="search-panel-input-shell">
        <span class="search-panel-input-icon" aria-hidden="true">
          <Search />
        </span>

        <Input v-model="searchQuery" class="search-panel-input" type="text" aria-label="搜索关键字"
          :placeholder="useStructural ? '输入 ast-grep 模式…' : '输入关键字搜索…'" autocomplete="off" spellcheck="false" />

        <button v-if="hasSearchQuery" type="button" class="search-panel-clear-btn" aria-label="清空搜索" title="清空搜索"
          @click.stop="searchQuery = ''">
          <X aria-hidden="true" />
        </button>
      </div>

      <div class="search-panel-input-shell search-panel-replace-shell">
        <span class="search-panel-input-icon" aria-hidden="true">
          <Replace />
        </span>

        <Input v-model="replacementQuery" class="search-panel-input" type="text" aria-label="替换内容"
          :placeholder="useStructural ? '输入 ast-grep 替换…' : '输入替换内容…'" autocomplete="off" spellcheck="false"
          @keydown.enter="handleReplacementAction" />

        <button type="button" class="search-panel-apply-btn" :disabled="!canApplyReplacement" aria-label="全部替换"
          title="全部替换" @click.stop="handleReplacementAction">
          <LoaderCircle class="search-panel-spin" v-if="replaceRunning" aria-hidden="true" />
          <Check v-else aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="search-panel-chip-row">
      <button v-for="chip in scopeChips" :key="chip.key" type="button" class="search-panel-chip"
        :class="{ 'is-active': activeScope === chip.key }" :aria-pressed="activeScope === chip.key"
        @click="activeScope = chip.key">
        <span v-text="chip.label" />
        <span class="search-panel-chip-count" v-text="chip.count" />
      </button>
    </div>

    <div class="search-panel-option-row" aria-label="搜索选项">
      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': matchCase }"
        :aria-pressed="matchCase" title="区分大小写" @click="toggleSearchOption('matchCase')">
        <CaseSensitive aria-hidden="true" />
      </button>

      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': wholeWord }"
        :aria-pressed="wholeWord" title="全字匹配" @click="toggleSearchOption('wholeWord')">
        <WholeWord aria-hidden="true" />
      </button>

      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': useRegex }" :aria-pressed="useRegex"
        title="正则表达式" @click="toggleSearchOption('useRegex')">
        <Regex aria-hidden="true" />
      </button>

      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': contentFuzzy }"
        :aria-pressed="contentFuzzy" title="内容模糊匹配" @click="toggleSearchOption('contentFuzzy')">
        <Waves aria-hidden="true" />
      </button>

      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': showPathFilters }"
        :aria-pressed="showPathFilters" title="包含 / 排除路径" @click="toggleSearchOption('showPathFilters')">
        <ListFilter aria-hidden="true" />
      </button>

      <button type="button" class="search-panel-option-btn search-panel-option-structural"
        :class="{ 'is-active': useStructural }" :aria-pressed="useStructural" title="结构化搜索与替换"
        @click="toggleStructuralSearch">
        <Braces aria-hidden="true" />
      </button>
    </div>

    <div v-if="showPathFilters && !useStructural" class="search-panel-path-filter-row">
      <PathFilterInput
        v-model="includePattern"
        label="包含"
        aria-label="包含的路径或文件"
        :workspace-root-path="props.workspaceRootPath"
        :is-desktop-runtime="props.isDesktopRuntime"
        :match-case="matchCase"
      />

      <PathFilterInput
        v-model="excludePattern"
        label="排除"
        aria-label="排除的路径或文件"
        :workspace-root-path="props.workspaceRootPath"
        :is-desktop-runtime="props.isDesktopRuntime"
        :match-case="matchCase"
      />
    </div>

    <div ref="resultsScrollRef" class="search-panel-results" role="listbox">
      <div v-if="replacementPreviewOpen" class="search-replace-inline">
        <div v-if="replaceRunning && !replacementPreview" class="search-replace-inline-empty">
          <LoaderCircle class="search-panel-spin" aria-hidden="true" />
          <span>正在生成替换预览…</span>
        </div>

        <div v-else-if="visibleReplacementFiles.length === 0" class="search-panel-empty-state">
          <p class="search-panel-empty-title">没有待替换项</p>
          <p class="search-panel-empty-text">当前预览中的命中项已全部跳过。</p>
        </div>

        <template v-else>
          <article v-for="file in visibleReplacementFiles" :key="file.path" class="search-replace-inline-file">
            <header class="search-replace-inline-file-header">
              <button type="button" class="search-replace-inline-file-open"
                :aria-expanded="!isReplacementFileCollapsed(file.path)" @click="toggleReplacementFile(file.path)">
                <span class="search-replace-inline-chevron" aria-hidden="true"
                  :class="isReplacementFileCollapsed(file.path) ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'" />
                <span class="search-replace-inline-file-icon" aria-hidden="true">
                  <ExplorerEntryIcon kind="file" :path="file.path" />
                </span>
                <span class="search-replace-inline-file-name" v-text="file.name" />
                <span class="search-replace-inline-file-path" v-text="file.parentPath" />
              </button>
              <span class="search-replace-inline-count" v-text="file.visibleReplacementCount" />
            </header>

            <template v-if="!isReplacementFileCollapsed(file.path)">
              <div v-for="line in file.visibleLinePreviews" :key="line.id" class="search-replace-inline-line"
                role="option" tabindex="0" @click="handleReplacementLineOpen(file.path, line.lineNumber)"
                @keydown.enter="handleReplacementLineOpen(file.path, line.lineNumber)"
                @keydown.space.prevent="handleReplacementLineOpen(file.path, line.lineNumber)">
                <span class="search-replace-inline-line-number" v-text="line.lineNumber" />
                <span class="search-replace-inline-code">
                  <template v-for="(segment, segmentIndex) in line.segments" :key="`${line.id}-${segmentIndex}`">
                    <span v-if="segment.kind !== 'empty'" class="search-replace-inline-segment"
                      :class="[`is-${segment.kind}`, `is-${segment.part}`]" v-text="segment.text" />
                  </template>
                </span>

                <span class="search-replace-inline-line-actions">
                  <button type="button" class="search-replace-inline-icon-btn" :disabled="replacementApplying"
                    aria-label="替换此处" title="替换此处" @click.stop="replaceReplacementLine(file, line)">
                    <LoaderCircle class="search-panel-spin" v-if="replacementApplyingLineId === line.id" aria-hidden="true" />
                    <Replace v-else aria-hidden="true" />
                  </button>
                  <button type="button" class="search-replace-inline-icon-btn" :disabled="replacementApplying"
                    aria-label="跳过此处" title="跳过此处" @click.stop="skipReplacementLine(line.id)">
                    <X aria-hidden="true" />
                  </button>
                </span>
              </div>
            </template>
          </article>
        </template>
      </div>

      <div v-else-if="!props.isDesktopRuntime" class="search-panel-empty-state">
        <p class="search-panel-empty-title">浏览器预览不提供本地搜索</p>
        <p class="search-panel-empty-text">请在 Tauri 桌面端打开工作区后使用搜索面板。</p>
      </div>

      <div v-else-if="!props.workspaceRootPath" class="search-panel-empty-state">
        <p class="search-panel-empty-title">尚未打开工作区</p>
        <p class="search-panel-empty-text">先打开一个目录，再在这里按文件名或路径快速定位。</p>
      </div>

      <div v-else-if="searchIndexing && scannedFileCount === 0" class="search-panel-empty-state">
        <LoaderCircle class="search-panel-spin" aria-hidden="true" />
        <p class="search-panel-empty-text">正在搜索工作区…</p>
      </div>

      <div v-else-if="searchError" class="search-panel-empty-state">
        <InlineError title="无法完成搜索" :message="searchError" />
      </div>

      <div v-else-if="matcherError" class="search-panel-empty-state">
        <InlineError title="正则表达式无效" :message="matcherError" severity="warning" />
      </div>
      <template v-else-if="!hasSearchQuery" />
      <div v-else-if="hasSearchQuery && activeResults.length === 0" class="search-panel-empty-state">
        <p class="search-panel-empty-title">没有匹配结果</p>
        <p class="search-panel-empty-text">试试更短的关键字，或调整大小写、正则和路径过滤条件。</p>
      </div>

      <template v-else>
        <div v-if="shouldVirtualizeSearch" class="search-panel-virtual-spacer"
          :style="{ height: `${searchTotalSize}px` }">
          <template v-for="entry in windowedSearchRows" :key="entry.key">
            <header v-if="entry.row.kind === 'group'" class="search-panel-result-group-header search-panel-virtual-row"
              :style="{ transform: `translateY(${entry.start}px)` }">
              <button type="button" class="search-panel-result-group-open"
                :aria-expanded="!isSearchResultGroupCollapsed(entry.row.group.path)"
                @click="toggleSearchResultGroup(entry.row.group.path)">
                <span class="search-panel-result-group-chevron" aria-hidden="true"
                  :class="isSearchResultGroupCollapsed(entry.row.group.path) ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'" />
                <span class="search-panel-result-group-icon" aria-hidden="true">
                  <ExplorerEntryIcon kind="file" :path="entry.row.group.path" />
                </span>
                <span class="search-panel-result-group-name" v-text="entry.row.group.name" />
                <span class="search-panel-result-group-path" v-text="entry.row.group.parentPath" />
              </button>
              <span class="search-panel-result-group-count" v-text="entry.row.group.results.length" />
            </header>

            <button v-else type="button" class="search-panel-result-line search-panel-virtual-row"
              :class="{ 'is-selected': selectedResultKey === entry.row.result?.resultKey }" role="option"
              :aria-selected="selectedResultKey === entry.row.result?.resultKey"
              :style="{ transform: `translateY(${entry.start}px)` }"
              @click="entry.row.result && handleSearchResultOpen(entry.row.result)">
              <span class="search-panel-result-line-number" v-text="entry.row.result?.lineNumber" />
              <span class="search-panel-result-line-body">
                <span class="search-panel-result-snippet">
                  <template v-for="(segment, index) in entry.row.result?.snippetSegments ?? []"
                    :key="`${entry.row.result?.resultKey}-snippet-${index}`">
                    <mark v-if="segment.matched" class="search-panel-result-snippet-match" v-text="segment.text" />
                    <span v-else class="search-panel-result-snippet-context" v-text="segment.text" />
                  </template>
                </span>
              </span>
            </button>
          </template>
        </div>

        <template v-else>
          <article v-for="group in searchResultGroups" :key="group.path" class="search-panel-result-group">

            <header class="search-panel-result-group-header">
              <button type="button" class="search-panel-result-group-open"
                :aria-expanded="!isSearchResultGroupCollapsed(group.path)" @click="toggleSearchResultGroup(group.path)">
                <span class="search-panel-result-group-chevron" aria-hidden="true"
                  :class="isSearchResultGroupCollapsed(group.path) ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'" />
                <span class="search-panel-result-group-icon" aria-hidden="true">
                  <ExplorerEntryIcon kind="file" :path="group.path" />
                </span>
                <span class="search-panel-result-group-name" v-text="group.name" />
                <span class="search-panel-result-group-path" v-text="group.parentPath" />
              </button>
              <span class="search-panel-result-group-count" v-text="group.results.length" />
            </header>

            <template v-if="!isSearchResultGroupCollapsed(group.path)">
              <button v-for="result in group.results" :key="result.resultKey" type="button"
                class="search-panel-result-line" :class="{ 'is-selected': selectedResultKey === result.resultKey }"
                role="option" :aria-selected="selectedResultKey === result.resultKey"
                @click="handleSearchResultOpen(result)">
                <span class="search-panel-result-line-number" v-text="result.lineNumber" />

                <span class="search-panel-result-line-body">
                  <span class="search-panel-result-snippet">
                    <template v-for="(segment, index) in result.snippetSegments"
                      :key="`${result.resultKey}-snippet-${index}`">
                      <mark v-if="segment.matched" class="search-panel-result-snippet-match" v-text="segment.text" />
                      <span v-else class="search-panel-result-snippet-context" v-text="segment.text" />
                    </template>
                  </span>
                </span>
              </button>
            </template>
          </article>
        </template>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  Braces,
  CaseSensitive,
  Check,
  ListFilter,
  LoaderCircle,
  Regex,
  Replace,
  Search,
  Waves,
  WholeWord,
  X,
} from '@lucide/vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, onScopeDispose, ref, watch } from 'vue';
import InlineError from '@/components/common/InlineError.vue';
import { Input } from '@/components/ui/input';
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import PathFilterInput from '@/components/workbench/PathFilterInput.vue';
import { useMessage } from '@/composables/useMessage';
import {
  type IRefreshSidecarChangedDocumentsResult,
  useSidecarChangedDocumentRefresh,
} from '@/composables/useSidecarChangedDocumentRefresh';
import { tauriService } from '@/services/tauri';
import { isAppError } from '@/types/app-error';
import type { IWorkbenchOpenFileRequest, IWorkspaceDirectoryPayload } from '@/types/editor';
import type {
  IWorkspaceReplacementFilePreview,
  IWorkspaceReplacementLinePreview,
  IWorkspaceReplacementPreviewPayload,
  IWorkspaceReplacementRequest,
  IWorkspaceSearchResult,
  TWorkspaceSearchScope,
} from '@/types/search';
import { toErrorMessage } from '@/utils/error';
import { areFileSystemPathsEqual } from '@/utils/path';
import type {
  IFlatSearchRow,
  IReplacementFileView,
  IReplacementLineView,
  ISearchResultGroup,
  ISearchResultItem,
  TSearchToggleOption,
} from './search-sidebar.types';
import {
  buildCompactHighlightedSegments,
  buildReplacementLineSegments,
  createSearchMatcher,
  getFileName,
  getParentPath,
  splitPatternList,
  toggleReadonlySetValue,
  trimBoundaryWhitespace,
  trimBoundaryWhitespaceWithRange,
} from './search-sidebar-text';

const props = defineProps<{
  documentPath: string | null;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
}>();

const emit = defineEmits<{
  'open-file': [payload: IWorkbenchOpenFileRequest];
}>();

const SEARCH_SCOPE_LABELS: Record<TWorkspaceSearchScope, string> = {
  all: '全部',
  'file-name': '文件名',
  symbol: '符号',
  content: '内容',
};

const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_RESULT_LIMIT = 2000;
const SEARCH_RESULT_CONTEXT_CHARS = 28;
const REPLACEMENT_FILE_LIMIT = 200;
const SEARCH_VIRTUALIZE_THRESHOLD = 100;
const SEARCH_GROUP_ROW_HEIGHT = 28;
const SEARCH_LINE_ROW_HEIGHT = 24;

type TSearchLifecycle = {
  requestId: number;
  workspaceRootPath: string | null;
  query: string;
  signal: AbortSignal;
};

type TReplacementApplyLifecycle = {
  requestId: number;
  workspaceRootPath: string | null;
  signal: AbortSignal;
};

type TCancelableApplyWorkspaceReplacement = (
  payload: Parameters<typeof tauriService.applyWorkspaceReplacement>[0],
  options?: { signal?: AbortSignal },
) => ReturnType<typeof tauriService.applyWorkspaceReplacement>;

const searchQuery = ref('');
const replacementQuery = ref('');
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
const replaceRunning = ref(false);
const replacementApplying = ref(false);
const replacementApplyingLineId = ref<string | null>(null);
const replacementPreviewOpen = ref(false);
const replacementPreview = ref<IWorkspaceReplacementPreviewPayload | null>(null);
const replacementPreviewRequest = ref<IWorkspaceReplacementRequest | null>(null);
const skippedReplacementLineIds = ref<ReadonlySet<string>>(new Set<string>());
const collapsedSearchResultPaths = ref<ReadonlySet<string>>(new Set<string>());
const collapsedReplacementFilePaths = ref<ReadonlySet<string>>(new Set<string>());
const selectedResultKey = ref<string | null>(null);
const scannedFileCount = ref(0);
const backendResults = ref<IWorkspaceSearchResult[]>([]);
let searchRequestId = 0;
let replacementPreviewRequestId = 0;
let replacementApplyRequestId = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let replacementPreviewTimer: ReturnType<typeof setTimeout> | null = null;
let activeAbortController: AbortController | null = null;
let activeReplacementPreviewAbortController: AbortController | null = null;
let activeReplacementApplyAbortController: AbortController | null = null;
const message = useMessage();
const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();
const applyWorkspaceReplacementWithOptions =
  tauriService.applyWorkspaceReplacement as TCancelableApplyWorkspaceReplacement;

const isCanceledIpcError = (error: unknown): boolean =>
  isAppError(error) && error.code === 'ipc.canceled';

const isWorkspaceRootCurrent = (workspaceRootPath: string | null | undefined): boolean =>
  !workspaceRootPath || areFileSystemPathsEqual(workspaceRootPath, props.workspaceRootPath);

const beginSearchLifecycle = (query: string): TSearchLifecycle => {
  searchRequestId += 1;
  activeAbortController?.abort();
  const controller = new AbortController();
  activeAbortController = controller;
  return {
    requestId: searchRequestId,
    workspaceRootPath: props.workspaceRootPath,
    query,
    signal: controller.signal,
  };
};

const isSearchLifecycleCurrent = (lifecycle: TSearchLifecycle): boolean =>
  lifecycle.requestId === searchRequestId &&
  !lifecycle.signal.aborted &&
  isWorkspaceRootCurrent(lifecycle.workspaceRootPath) &&
  searchQuery.value.trim() === lifecycle.query;

const beginReplacementApplyLifecycle = (): TReplacementApplyLifecycle => {
  replacementApplyRequestId += 1;
  activeReplacementApplyAbortController?.abort();
  const controller = new AbortController();
  activeReplacementApplyAbortController = controller;
  return {
    requestId: replacementApplyRequestId,
    workspaceRootPath: props.workspaceRootPath,
    signal: controller.signal,
  };
};

const isReplacementApplyLifecycleCurrent = (lifecycle: TReplacementApplyLifecycle): boolean =>
  lifecycle.requestId === replacementApplyRequestId &&
  !lifecycle.signal.aborted &&
  isWorkspaceRootCurrent(lifecycle.workspaceRootPath);

const invalidateReplacementApplyLifecycle = (): void => {
  replacementApplyRequestId += 1;
  activeReplacementApplyAbortController?.abort();
  activeReplacementApplyAbortController = null;
  replacementApplying.value = false;
  replacementApplyingLineId.value = null;
};

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
  const rawSnippetText = result.lineText ?? result.name;
  const rawMatchRange =
    result.matchStart !== null && result.matchEnd !== null
      ? ([result.matchStart, result.matchEnd] as [number, number])
      : null;
  const preview =
    result.lineText === null
      ? { text: rawSnippetText, range: rawMatchRange }
      : trimBoundaryWhitespaceWithRange(rawSnippetText, rawMatchRange);

  return {
    path: result.path,
    relativePath: result.relativePath,
    resultKey: `${result.kind}:${result.path}:${result.lineNumber ?? 0}:${result.matchStart ?? -1}:${result.matchEnd ?? -1}`,
    reason: result.kind,
    snippetSegments:
      result.kind === 'content' && preview.range
        ? buildCompactHighlightedSegments(preview.text, preview.range, SEARCH_RESULT_CONTEXT_CHARS)
        : matcher.value.highlight(trimBoundaryWhitespace(preview.text)),
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

const resultsScrollRef = ref<HTMLElement | null>(null);

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

const shouldVirtualizeSearch = computed(
  () => flatSearchRows.value.length > SEARCH_VIRTUALIZE_THRESHOLD,
);

const searchVirtualizer = useVirtualizer<HTMLElement, HTMLElement>(
  computed(() => ({
    count: shouldVirtualizeSearch.value ? flatSearchRows.value.length : 0,
    getScrollElement: () => resultsScrollRef.value,
    estimateSize: (index: number) =>
      flatSearchRows.value[index]?.kind === 'group'
        ? SEARCH_GROUP_ROW_HEIGHT
        : SEARCH_LINE_ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index: number) => flatSearchRows.value[index]?.key ?? index,
  })),
);

const searchTotalSize = computed(() =>
  shouldVirtualizeSearch.value ? searchVirtualizer.value.getTotalSize() : 0,
);

const windowedSearchRows = computed(() =>
  (shouldVirtualizeSearch.value ? searchVirtualizer.value.getVirtualItems() : [])
    .map((item) => ({
      key: String(item.key),
      start: item.start,
      row: flatSearchRows.value[item.index],
    }))
    .filter((entry): entry is { key: string; start: number; row: IFlatSearchRow } =>
      Boolean(entry.row),
    ),
);

watch(flatSearchRows, () => {
  searchVirtualizer.value.measure();
});

const canApplyReplacement = computed(
  () =>
    !replaceRunning.value &&
    hasSearchQuery.value &&
    props.isDesktopRuntime &&
    Boolean(props.workspaceRootPath),
);

const toReplacementLineView = (line: IWorkspaceReplacementLinePreview): IReplacementLineView => {
  const beforeLine = trimBoundaryWhitespace(line.beforeLine);
  const afterLine = trimBoundaryWhitespace(line.afterLine);
  return {
    ...line,
    beforeLine,
    afterLine,
    segments: buildReplacementLineSegments(beforeLine, afterLine),
  };
};

const toReplacementFileView = (
  file: IWorkspaceReplacementFilePreview,
): IReplacementFileView | null => {
  const visibleLinePreviews = file.linePreviews
    .filter((line) => !skippedReplacementLineIds.value.has(line.id))
    .map(toReplacementLineView);
  if (visibleLinePreviews.length === 0) return null;
  return {
    ...file,
    name: getFileName(file.relativePath),
    parentPath: getParentPath(file.relativePath),
    visibleLinePreviews,
    visibleReplacementCount: visibleLinePreviews.reduce(
      (total, line) => total + line.replacementCount,
      0,
    ),
  };
};

const visibleReplacementFiles = computed<IReplacementFileView[]>(() => {
  const preview = replacementPreview.value;
  if (!preview) return [];
  return preview.files
    .map(toReplacementFileView)
    .filter((file): file is IReplacementFileView => Boolean(file));
});

const isSearchResultGroupCollapsed = (path: string): boolean =>
  collapsedSearchResultPaths.value.has(path);
const toggleSearchResultGroup = (path: string): void => {
  collapsedSearchResultPaths.value = toggleReadonlySetValue(collapsedSearchResultPaths.value, path);
};
const isReplacementFileCollapsed = (path: string): boolean =>
  collapsedReplacementFilePaths.value.has(path);
const toggleReplacementFile = (path: string): void => {
  collapsedReplacementFilePaths.value = toggleReadonlySetValue(
    collapsedReplacementFilePaths.value,
    path,
  );
};

const resetReplacementPreview = (): void => {
  if (replacementPreviewTimer) {
    clearTimeout(replacementPreviewTimer);
    replacementPreviewTimer = null;
  }
  replacementPreviewRequestId += 1;
  activeReplacementPreviewAbortController?.abort();
  activeReplacementPreviewAbortController = null;
  invalidateReplacementApplyLifecycle();
  replaceRunning.value = false;
  replacementPreviewOpen.value = false;
  replacementPreview.value = null;
  replacementPreviewRequest.value = null;
  skippedReplacementLineIds.value = new Set<string>();
  collapsedReplacementFilePaths.value = new Set<string>();
};

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

const cancelPendingSearch = (): void => {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  if (replacementPreviewTimer) {
    clearTimeout(replacementPreviewTimer);
    replacementPreviewTimer = null;
  }
  activeAbortController?.abort();
  activeAbortController = null;
  activeReplacementPreviewAbortController?.abort();
  activeReplacementPreviewAbortController = null;
  invalidateReplacementApplyLifecycle();
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
  if (
    !props.isDesktopRuntime ||
    !props.workspaceRootPath ||
    matcherError.value ||
    query.length === 0
  ) {
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
  // 新输入/过滤条件一到达就取消旧 IPC，而不是等下一次 debounce 触发后再取消。
  // 这让高频输入下的搜索调度变成 last-write-wins：旧请求既不继续占用前端等待预算，也不会短暂回写旧结果。
  invalidateInFlightSearch();
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void runSearch();
  }, SEARCH_DEBOUNCE_MS);
};

const buildReplacementRequest = (): IWorkspaceReplacementRequest | null => {
  if (!props.workspaceRootPath) return null;
  return {
    workspaceRootPath: props.workspaceRootPath,
    query: searchQuery.value.trim(),
    replacement: replacementQuery.value,
    matchCase: matchCase.value,
    wholeWord: wholeWord.value,
    useRegex: useRegex.value,
    useStructural: useStructural.value,
    includePatterns: effectiveIncludePatterns.value,
    excludePatterns: effectiveExcludePatterns.value,
    limit: REPLACEMENT_FILE_LIMIT,
  };
};

const previewReplacementToSearch = async (source: 'manual' | 'auto'): Promise<boolean> => {
  if (replaceRunning.value) return false;
  const query = searchQuery.value.trim();
  if (!hasSearchQuery.value) {
    if (source === 'manual') message.warning('请先输入搜索内容。');
    return false;
  }
  if (!useRegex.value && !useStructural.value && query === replacementQuery.value) {
    if (source === 'manual') message.warning('替换内容与搜索内容相同，无需替换。');
    else resetReplacementPreview();
    return false;
  }
  if (!props.isDesktopRuntime) {
    if (source === 'manual')
      message.warning('浏览器预览不支持写入文件，请在 Tauri 桌面端使用替换。');
    return false;
  }
  if (!props.workspaceRootPath) {
    if (source === 'manual') message.warning('请先打开工作区后再替换。');
    return false;
  }

  const request = buildReplacementRequest();
  if (!request) return false;
  const requestId = replacementPreviewRequestId + 1;
  replacementPreviewRequestId = requestId;
  activeReplacementPreviewAbortController?.abort();
  const abortController = new AbortController();
  activeReplacementPreviewAbortController = abortController;

  replaceRunning.value = true;
  replacementPreviewOpen.value = true;
  replacementPreview.value = null;
  replacementPreviewRequest.value = null;
  skippedReplacementLineIds.value = new Set<string>();

  try {
    const preview = await tauriService.previewWorkspaceReplacement(request, {
      signal: abortController.signal,
    });
    if (
      requestId !== replacementPreviewRequestId ||
      !isWorkspaceRootCurrent(request.workspaceRootPath)
    )
      return false;
    if (preview.fileCount === 0) {
      replacementPreviewOpen.value = false;
      if (source === 'manual') message.warning('当前没有可替换的内容匹配结果。');
      return false;
    }
    replacementPreview.value = preview;
    replacementPreviewRequest.value = request;
    return true;
  } catch (error) {
    if (abortController.signal.aborted || requestId !== replacementPreviewRequestId) return false;
    replacementPreviewOpen.value = false;
    if (source === 'manual') message.error(toErrorMessage(error, '替换失败。'));
    else searchError.value = toErrorMessage(error, '替换预览失败。');
    return false;
  } finally {
    if (requestId === replacementPreviewRequestId) {
      replaceRunning.value = false;
      activeReplacementPreviewAbortController = null;
    }
  }
};

const handleReplacementAction = async (): Promise<void> => {
  if (replacementPreviewOpen.value && replacementPreview.value) {
    await confirmReplacementPreview();
    return;
  }
  const hasPreview = await previewReplacementToSearch('manual');
  if (hasPreview) await confirmReplacementPreview();
};

const scheduleReplacementPreview = (): void => {
  if (replacementPreviewTimer) clearTimeout(replacementPreviewTimer);
  replacementPreviewTimer = setTimeout(() => {
    replacementPreviewTimer = null;
    void previewReplacementToSearch('auto');
  }, SEARCH_DEBOUNCE_MS);
};

const retainVisibleSkippedReplacementLines = (
  preview: IWorkspaceReplacementPreviewPayload,
): void => {
  const visibleLineIds = new Set(
    preview.files.flatMap((file) => file.linePreviews.map((line) => line.id)),
  );
  skippedReplacementLineIds.value = new Set(
    [...skippedReplacementLineIds.value].filter((lineId) => visibleLineIds.has(lineId)),
  );
};

const refreshReplacementPreviewAfterLineApply = async (
  request: IWorkspaceReplacementRequest,
  lifecycle: TReplacementApplyLifecycle,
): Promise<void> => {
  const requestId = replacementPreviewRequestId + 1;
  replacementPreviewRequestId = requestId;
  activeReplacementPreviewAbortController?.abort();
  const abortController = new AbortController();
  activeReplacementPreviewAbortController = abortController;
  replacementPreviewOpen.value = true;

  try {
    const preview = await tauriService.previewWorkspaceReplacement(request, {
      signal: abortController.signal,
    });
    if (requestId !== replacementPreviewRequestId || !isReplacementApplyLifecycleCurrent(lifecycle))
      return;
    if (preview.fileCount === 0) {
      replacementPreview.value = null;
      replacementPreviewRequest.value = request;
      skippedReplacementLineIds.value = new Set<string>();
      return;
    }
    replacementPreview.value = preview;
    replacementPreviewRequest.value = request;
    retainVisibleSkippedReplacementLines(preview);
  } catch (error) {
    if (
      abortController.signal.aborted ||
      requestId !== replacementPreviewRequestId ||
      !isReplacementApplyLifecycleCurrent(lifecycle)
    )
      return;
    message.error(toErrorMessage(error, '刷新替换预览失败。'));
  } finally {
    if (requestId === replacementPreviewRequestId) activeReplacementPreviewAbortController = null;
  }
};

const reportReplacementRefreshOutcome = (
  refreshResult: IRefreshSidecarChangedDocumentsResult,
  replacementCount: number,
  successMessage: string,
): void => {
  const issues: string[] = [];
  if (refreshResult.skippedDirtyNames.length > 0)
    issues.push(`${refreshResult.skippedDirtyNames.join('、')} 有未保存改动，已跳过自动刷新`);
  if (refreshResult.failedNames.length > 0)
    issues.push(`${refreshResult.failedNames.join('、')} 刷新失败，请手动重新打开`);
  if (issues.length > 0) {
    message.warning(`已替换 ${replacementCount} 处内容，但 ${issues.join('；')}。`);
    return;
  }
  message.success(successMessage);
};

const applyReplacementAndRefresh = async (
  request: IWorkspaceReplacementRequest,
  expectedFiles: Array<{ path: string; beforeHash: string; includedMatchIds: string[] }>,
  lifecycle: TReplacementApplyLifecycle,
) => {
  const payload = await applyWorkspaceReplacementWithOptions(
    { request, expectedFiles },
    { signal: lifecycle.signal },
  );
  if (!isReplacementApplyLifecycleCurrent(lifecycle)) return null;
  const refreshResult = await refreshSidecarChangedDocuments({
    changedFilePaths: payload.files.map((changedFile: { path: string }) => changedFile.path),
    hasFileMutations: true,
    workspaceRootPath: payload.rootPath,
  });
  if (!isReplacementApplyLifecycleCurrent(lifecycle)) return null;
  return { payload, refreshResult };
};

const confirmReplacementPreview = async (): Promise<void> => {
  const request = replacementPreviewRequest.value;
  const files = visibleReplacementFiles.value;
  if (!request || replacementApplying.value) return;
  if (files.length === 0) {
    message.warning('当前没有待替换项。');
    return;
  }

  const lifecycle = beginReplacementApplyLifecycle();
  replacementApplying.value = true;
  replaceRunning.value = true;

  try {
    const result = await applyReplacementAndRefresh(
      request,
      files.map((file) => ({
        path: file.path,
        beforeHash: file.beforeHash,
        includedMatchIds: file.visibleLinePreviews.map((line) => line.id),
      })),
      lifecycle,
    );
    if (!result || !isReplacementApplyLifecycleCurrent(lifecycle)) return;
    const { payload, refreshResult } = result;
    replacementPreviewOpen.value = false;
    replacementPreview.value = null;
    replacementPreviewRequest.value = null;
    replacementPreviewRequestId += 1;
    reportReplacementRefreshOutcome(
      refreshResult,
      payload.replacementCount,
      `已替换 ${payload.changedFileCount} 个文件中的 ${payload.replacementCount} 处内容。`,
    );
    void runSearch();
  } catch (error) {
    if (
      lifecycle.signal.aborted ||
      !isReplacementApplyLifecycleCurrent(lifecycle) ||
      isCanceledIpcError(error)
    )
      return;
    message.error(toErrorMessage(error, '替换失败。'));
  } finally {
    if (lifecycle.requestId === replacementApplyRequestId) {
      replacementApplying.value = false;
      replaceRunning.value = false;
      replacementApplyingLineId.value = null;
      activeReplacementApplyAbortController = null;
    }
  }
};

const skipReplacementLine = (lineId: string): void => {
  skippedReplacementLineIds.value = new Set([...skippedReplacementLineIds.value, lineId]);
};

const replaceReplacementLine = async (
  file: IReplacementFileView,
  line: IReplacementLineView,
): Promise<void> => {
  const request = replacementPreviewRequest.value;
  if (!request || replacementApplying.value) return;

  const lifecycle = beginReplacementApplyLifecycle();
  replacementApplying.value = true;
  replaceRunning.value = true;
  replacementApplyingLineId.value = line.id;

  try {
    const result = await applyReplacementAndRefresh(
      request,
      [
        {
          path: file.path,
          beforeHash: file.beforeHash,
          includedMatchIds: [line.id],
        },
      ],
      lifecycle,
    );
    if (!result || !isReplacementApplyLifecycleCurrent(lifecycle)) return;
    const { payload, refreshResult } = result;
    await refreshReplacementPreviewAfterLineApply(request, lifecycle);
    if (!isReplacementApplyLifecycleCurrent(lifecycle)) return;
    reportReplacementRefreshOutcome(
      refreshResult,
      payload.replacementCount,
      `已替换 ${payload.replacementCount} 处内容。`,
    );
    void runSearch();
  } catch (error) {
    if (
      lifecycle.signal.aborted ||
      !isReplacementApplyLifecycleCurrent(lifecycle) ||
      isCanceledIpcError(error)
    )
      return;
    message.error(toErrorMessage(error, '替换失败。'));
  } finally {
    if (lifecycle.requestId === replacementApplyRequestId) {
      replacementApplying.value = false;
      replaceRunning.value = false;
      replacementApplyingLineId.value = null;
      activeReplacementApplyAbortController = null;
    }
  }
};

const emitOpenFile = (payload: IWorkbenchOpenFileRequest): void => emit('open-file', payload);
const handleReplacementLineOpen = (path: string, lineNumber: number): void => {
  selectedResultKey.value = null;
  emitOpenFile({ path, lineNumber, column: 1 });
};
const handleSearchResultOpen = (result: ISearchResultItem): void => {
  selectedResultKey.value = result.resultKey;
  emitOpenFile({
    path: result.path,
    lineNumber: result.lineNumber,
    column: result.matchStart === null ? 1 : result.matchStart + 1,
  });
};

watch(
  [
    () => props.isDesktopRuntime,
    () => props.workspaceRootPath,
    searchQuery,
    matchCase,
    wholeWord,
    useRegex,
    contentFuzzy,
    useStructural,
    () => effectiveIncludePatterns.value.join('\n'),
    () => effectiveExcludePatterns.value.join('\n'),
  ],
  scheduleSearch,
  { immediate: true },
);

watch(
  () => props.workspaceRootPath,
  () => {
    searchQuery.value = '';
    replacementQuery.value = '';
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
    resetReplacementPreview();
  },
);

watch(
  [
    searchQuery,
    replacementQuery,
    matchCase,
    wholeWord,
    useRegex,
    useStructural,
    () => effectiveIncludePatterns.value.join('\n'),
    () => effectiveExcludePatterns.value.join('\n'),
    () => props.workspaceRootPath,
  ],
  () => {
    if (replacementApplying.value) return;
    const shouldPreviewReplacement =
      replacementQuery.value.length > 0 &&
      hasSearchQuery.value &&
      props.isDesktopRuntime &&
      Boolean(props.workspaceRootPath) &&
      !matcherError.value;
    if (shouldPreviewReplacement) scheduleReplacementPreview();
    else resetReplacementPreview();
  },
);

watch(activeResults, (results) => {
  const availableKeys = new Set(results.map((result) => result.resultKey));
  if (selectedResultKey.value && !availableKeys.has(selectedResultKey.value))
    selectedResultKey.value = null;
});

onScopeDispose(cancelPendingSearch);
</script>