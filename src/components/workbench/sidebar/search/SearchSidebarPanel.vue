<template>
  <section class="search-sidebar" aria-label="搜索">
    <SearchQueryControls
      v-model:search-query="searchQuery"
      v-model:replacement-query="replacementQuery"
      v-model:active-scope="activeScope"
      :use-structural="useStructural"
      :has-search-query="hasSearchQuery"
      :can-apply-replacement="canApplyReplacement"
      :replace-running="replaceRunning"
      :scope-chips="scopeChips"
      :match-case="matchCase"
      :whole-word="wholeWord"
      :use-regex="useRegex"
      :content-fuzzy="contentFuzzy"
      :show-path-filters="showPathFilters"
      @replacement-action="handleReplacementAction"
      @toggle-option="toggleSearchOption"
      @toggle-structural="toggleStructuralSearch"
    />

    <SearchPathFilters
      v-if="showPathFilters && !useStructural"
      v-model:include-pattern="includePattern"
      v-model:exclude-pattern="excludePattern"
      :workspace-root-path="props.workspaceRootPath"
      :is-desktop-runtime="props.isDesktopRuntime"
      :match-case="matchCase"
    />

    <div ref="resultsScrollRef" class="search-panel-results" role="listbox">
      <ReplacementPreviewList
        v-if="replacementPreviewOpen"
        :loading="replaceRunning && !replacementPreview"
        :files="visibleReplacementFiles"
        :collapsed-paths="collapsedReplacementFilePaths"
        :applying="replacementApplying"
        :applying-line-id="replacementApplyingLineId"
        @toggle="toggleReplacementFile"
        @open="handleReplacementLineOpen($event.path, $event.lineNumber)"
        @replace="replaceReplacementLine($event.file, $event.line)"
        @skip="skipReplacementLine"
      />

      <div v-else-if="!props.isDesktopRuntime" class="search-panel-empty-state">
        <p class="search-panel-empty-title">浏览器预览不提供本地搜索</p>
        <p class="search-panel-empty-text">请在 Tauri 桌面端打开工作区后使用搜索面板。</p>
      </div>

      <div v-else-if="!props.workspaceRootPath" class="search-panel-empty-state">
        <p class="search-panel-empty-title">尚未打开工作区</p>
        <p class="search-panel-empty-text">先打开一个目录，再在这里按文件名或路径快速定位。</p>
      </div>

      <div v-else-if="searchIndexing && activeResults.length === 0" class="search-panel-empty-state">
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

      <div
        v-else-if="hasSearchQuery && activeResults.length === 0"
        class="search-panel-empty-state"
      >
        <p class="search-panel-empty-title">没有匹配结果</p>
        <p class="search-panel-empty-text">试试更短的关键字，或调整大小写、正则和路径过滤条件。</p>
      </div>

      <SearchResultsList
        v-else
        :should-virtualize="shouldVirtualizeSearch"
        :windowed-rows="windowedSearchRows"
        :total-size="searchTotalSize"
        :groups="searchResultGroups"
        :collapsed-paths="collapsedSearchResultPaths"
        :selected-result-key="selectedResultKey"
        @toggle-group="toggleSearchResultGroup"
        @open-result="handleSearchResultOpen"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import { onScopeDispose, toRef, watch } from 'vue';
import InlineError from '@/components/common/InlineError.vue';
import type { IWorkbenchOpenFileRequest, IWorkspaceDirectoryPayload } from '@/types/editor';
import ReplacementPreviewList from './ReplacementPreviewList.vue';
import SearchPathFilters from './SearchPathFilters.vue';
import SearchQueryControls from './SearchQueryControls.vue';
import SearchResultsList from './SearchResultsList.vue';
import { useSearchResultVirtualizer } from './useSearchResultVirtualizer';
import { useWorkspaceReplacement } from './useWorkspaceReplacement';
import { useWorkspaceSearch } from './useWorkspaceSearch';

const props = withDefaults(
  defineProps<{
    isActive?: boolean;
    documentPath: string | null;
    isDesktopRuntime: boolean;
    workspaceRootPath: string | null;
    preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
  }>(),
  {
    isActive: true,
  },
);

const emit = defineEmits<{
  'open-file': [payload: IWorkbenchOpenFileRequest];
}>();

const emitOpenFile = (payload: IWorkbenchOpenFileRequest): void => emit('open-file', payload);
const isDesktopRuntimeRef = toRef(props, 'isDesktopRuntime');
const workspaceRootPathRef = toRef(props, 'workspaceRootPath');

const search = useWorkspaceSearch({
  isDesktopRuntime: isDesktopRuntimeRef,
  workspaceRootPath: workspaceRootPathRef,
  emitOpenFile,
});
const {
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
  resultsScrollRef,
  matcherError,
  hasSearchQuery,
  effectiveIncludePatterns,
  effectiveExcludePatterns,
  scopeChips,
  activeResults,
  searchResultGroups,
  flatSearchRows,
  toggleSearchResultGroup,
  collapsedSearchResultPaths,
  toggleSearchOption,
  toggleStructuralSearch,
  runSearch,
  scheduleSearch,
  cancelPendingSearch,
  handleSearchResultOpen,
  resetSearchState,
} = search;

const replacement = useWorkspaceReplacement({
  isDesktopRuntime: isDesktopRuntimeRef,
  workspaceRootPath: workspaceRootPathRef,
  searchQuery,
  matchCase,
  wholeWord,
  useRegex,
  useStructural,
  effectiveIncludePatterns,
  effectiveExcludePatterns,
  hasSearchQuery,
  searchError,
  isWorkspaceRootCurrent: search.isWorkspaceRootCurrent,
  runSearch,
  emitOpenFile,
  clearSelectedResult: () => {
    selectedResultKey.value = null;
  },
});
const {
  replacementQuery,
  replaceRunning,
  replacementApplying,
  replacementApplyingLineId,
  replacementPreviewOpen,
  replacementPreview,
  collapsedReplacementFilePaths,
  canApplyReplacement,
  visibleReplacementFiles,
  toggleReplacementFile,
  resetReplacementPreview,
  resetReplacementQuery,
  scheduleReplacementPreview,
  handleReplacementAction,
  replaceReplacementLine,
  skipReplacementLine,
  handleReplacementLineOpen,
  cancelPendingReplacement,
} = replacement;

const { shouldVirtualizeSearch, searchTotalSize, windowedSearchRows } = useSearchResultVirtualizer({
  flatSearchRows,
  scrollRef: resultsScrollRef,
});

watch(
  [
    () => props.isActive,
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
  () => {
    if (!props.isActive) {
      cancelPendingSearch();
      return;
    }

    scheduleSearch();
  },
  { immediate: true },
);

watch(
  () => props.workspaceRootPath,
  () => {
    resetSearchState();
    resetReplacementQuery();
    resetReplacementPreview();
  },
);

watch(
  [
    () => props.isActive,
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
    if (!props.isActive) {
      cancelPendingReplacement();
      return;
    }

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

onScopeDispose(() => {
  cancelPendingSearch();
  cancelPendingReplacement();
});
</script>
