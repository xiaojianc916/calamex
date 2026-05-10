<template>
  <section class="search-sidebar" aria-label="搜索">
    <header class="search-panel-header">
      <span class="search-panel-title">搜索</span>

      <button
type="button" class="search-panel-icon-btn" :disabled="!canApplyReplacement" aria-label="应用替换内容"
        title="应用替换内容" @click="applyReplacementToSearch">
        <LoaderCircle v-if="replaceRunning" class="search-panel-spin" aria-hidden="true" />
        <Replace v-else aria-hidden="true" />
      </button>
    </header>

    <div class="search-panel-query-stack">
      <div class="search-panel-input-shell">
        <span class="search-panel-input-icon" aria-hidden="true">
          <Search />
        </span>

        <Input
v-model="searchQuery" class="search-panel-input" type="text" aria-label="搜索关键字"
          placeholder="输入关键字搜索…" autocomplete="off" spellcheck="false" />

        <button
v-if="hasSearchQuery" type="button" class="search-panel-clear-btn" aria-label="清空搜索" title="清空搜索"
          @click.stop="searchQuery = ''">
          <X aria-hidden="true" />
        </button>
      </div>

      <div class="search-panel-input-shell search-panel-replace-shell">
        <span class="search-panel-input-icon" aria-hidden="true">
          <Replace />
        </span>

        <Input
v-model="replacementQuery" class="search-panel-input" type="text" aria-label="替换内容"
          placeholder="输入替换内容…" autocomplete="off" spellcheck="false"
          @keydown.enter="applyReplacementToSearch" />

        <button
type="button" class="search-panel-apply-btn" :disabled="!canApplyReplacement" aria-label="应用替换内容"
          title="应用替换内容" @click.stop="applyReplacementToSearch">
          <LoaderCircle v-if="replaceRunning" class="search-panel-spin" aria-hidden="true" />
          <Check v-else aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="search-panel-chip-row">
      <button
v-for="chip in scopeChips" :key="chip.key" type="button" class="search-panel-chip"
        :class="{ 'is-active': activeScope === chip.key }" :aria-pressed="activeScope === chip.key"
        @click="activeScope = chip.key">
        <span>{{ chip.label }}</span>
        <span class="search-panel-chip-count">{{ chip.count }}</span>
      </button>
    </div>

    <div class="search-panel-option-row" aria-label="搜索选项">
      <button
type="button" class="search-panel-option-btn" :class="{ 'is-active': matchCase }"
        :aria-pressed="matchCase" title="区分大小写" @click="matchCase = !matchCase">
        <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
          stroke-linejoin="round">
          <path d="M4 18 8 6l4 12" />
          <path d="M5.5 14h5" />
          <path d="M14 12a3 3 0 1 1 5 2v2" />
        </svg>
      </button>

      <button
type="button" class="search-panel-option-btn" :class="{ 'is-active': wholeWord }"
        :aria-pressed="wholeWord" title="全字匹配" @click="wholeWord = !wholeWord">
        <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
          stroke-linejoin="round">
          <rect x="3" y="7" width="18" height="10" rx="1.5" />
          <path d="M3 10v4" />
          <path d="M21 10v4" />
          <path d="M7 14V10" />
          <path d="M11 14V10" />
          <path d="M15 14V10" />
        </svg>
      </button>

      <button
type="button" class="search-panel-option-btn" :class="{ 'is-active': useRegex }" :aria-pressed="useRegex"
        title="正则表达式" @click="useRegex = !useRegex">
        <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
          stroke-linejoin="round">
          <path d="M12 4v10" />
          <path d="M7.3 6.5 16.7 11.5" />
          <path d="M16.7 6.5 7.3 11.5" />
          <circle cx="7" cy="19" r="1.4" />
        </svg>
      </button>

      <button
type="button" class="search-panel-option-btn" :class="{ 'is-active': showPathFilters }"
        :aria-pressed="showPathFilters" title="包含 / 排除路径" @click="showPathFilters = !showPathFilters">
        <svg
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
          stroke-linejoin="round">
          <path d="M4 7h10" />
          <path d="M4 12h10" />
          <path d="M4 17h6" />
          <path d="M20 14v6" />
          <path d="M17 17h6" />
        </svg>
      </button>
    </div>

    <div v-if="showPathFilters" class="search-panel-path-filter-row">
      <label class="search-panel-path-filter">
        <span>包含</span>
        <input
v-model="includePattern" type="text" placeholder="例如 src/**/*.vue" autocomplete="off"
          spellcheck="false" />
      </label>

      <label class="search-panel-path-filter">
        <span>排除</span>
        <input v-model="excludePattern" type="text" placeholder="例如 target/**" autocomplete="off" spellcheck="false" />
      </label>
    </div>

    <div class="search-panel-results" role="listbox">
      <div v-if="hasSearchQuery && !searchError && !activeScopeIsPending" class="search-panel-summary">
        <b>{{ activeResults.length }}</b> 条结果 · 来自 <b>{{ matchedFileCount }}</b> 个文件
      </div>

      <div v-if="!props.isDesktopRuntime" class="search-panel-empty-state">
        <p class="search-panel-empty-title">浏览器预览不提供本地搜索</p>
        <p class="search-panel-empty-text">请在 Tauri 桌面端打开工作区后使用搜索面板。</p>
      </div>

      <div v-else-if="!props.workspaceRootPath" class="search-panel-empty-state">
        <p class="search-panel-empty-title">尚未打开工作区</p>
        <p class="search-panel-empty-text">先打开一个目录，再在这里按文件名或路径快速定位。</p>
      </div>

      <div v-else-if="searchIndexing && indexedFileCount === 0" class="search-panel-empty-state">
        <p class="search-panel-empty-title"></p>
        <p class="search-panel-empty-text"></p>
      </div>

      <div v-else-if="searchError" class="search-panel-empty-state">
        <p class="search-panel-empty-title">无法完成搜索</p>
        <p class="search-panel-empty-text">{{ searchError }}</p>
      </div>

      <div v-else-if="matcherError" class="search-panel-empty-state">
        <p class="search-panel-empty-title">正则表达式无效</p>
        <p class="search-panel-empty-text">{{ matcherError }}</p>
      </div>

      <div v-else-if="activeScopeIsPending" class="search-panel-empty-state">
        <p class="search-panel-empty-title">该类别待接入</p>
        <p class="search-panel-empty-text">当前已接入文件名与路径搜索，符号与内容结果稍后补齐。</p>
      </div>

      <div v-else-if="hasSearchQuery && activeResults.length === 0" class="search-panel-empty-state">
        <p class="search-panel-empty-title">没有匹配结果</p>
        <p class="search-panel-empty-text">试试更短的关键字，或调整大小写、正则和路径过滤条件。</p>
      </div>

      <button
v-for="result in activeResults" :key="result.resultKey" type="button" class="search-panel-result"
        :class="{ 'is-selected': selectedResultPath === result.path }" role="option"
        :aria-selected="selectedResultPath === result.path" @click="handleResultClick(result.path)">
        <span class="search-panel-result-icon" aria-hidden="true">
          <ExplorerEntryIcon kind="file" :path="result.path" />
        </span>

        <span class="search-panel-result-body">
          <span class="search-panel-result-snippet">
            <template v-for="(segment, index) in result.snippetSegments" :key="`${result.resultKey}-snippet-${index}`">
              <mark v-if="segment.matched">{{ segment.text }}</mark>
              <span v-else>{{ segment.text }}</span>
            </template>
          </span>

          <span class="search-panel-result-loc">
            <template
v-for="(segment, index) in result.locationSegments"
              :key="`${result.resultKey}-location-${index}`">
              <mark v-if="segment.matched">{{ segment.text }}</mark>
              <span v-else>{{ segment.text }}</span>
            </template>
            <span class="search-panel-result-sep">·</span>
            <span class="search-panel-result-kind">{{ result.reasonLabel }}</span>
          </span>
        </span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Input } from '@/components/ui/input';
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import { useMessage } from '@/composables/useMessage';
import { useSidecarChangedDocumentRefresh } from '@/composables/useSidecarChangedDocumentRefresh';
import { aiService } from '@/services/modules/ai';
import { tauriService } from '@/services/tauri';
import type { IWorkspaceDirectoryPayload } from '@/types/editor';
import type {
  IWorkspaceSearchResult,
  TWorkspaceSearchResultKind,
  TWorkspaceSearchScope,
} from '@/types/search';
import { toErrorMessage } from '@/utils/error';
import { Check, LoaderCircle, Replace, Search, X } from 'lucide-vue-next';
import { computed, onScopeDispose, ref, watch } from 'vue';

type TSearchReason = TWorkspaceSearchResultKind;

interface IHighlightedSegment {
  text: string;
  matched: boolean;
}

interface ISearchResultItem {
  path: string;
  relativePath: string;
  resultKey: string;
  reason: TSearchReason;
  reasonLabel: string;
  snippetSegments: IHighlightedSegment[];
  locationSegments: IHighlightedSegment[];
  score: number;
  lineNumber: number | null;
}

interface ISearchMatcher {
  hasQuery: boolean;
  errorMessage: string;
  highlight: (value: string) => IHighlightedSegment[];
}

const props = defineProps<{
  documentPath: string | null;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
}>();

const emit = defineEmits<{
  'open-file': [path: string];
}>();

const SEARCH_SCOPE_LABELS: Record<TWorkspaceSearchScope, string> = {
  all: '全部',
  'file-name': '文件名',
  symbol: '符号',
  content: '内容',
};

const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_RESULT_LIMIT = 200;

const searchQuery = ref('');
const replacementQuery = ref('');
const includePattern = ref('');
const excludePattern = ref('');
const activeScope = ref<TWorkspaceSearchScope>('all');
const matchCase = ref(false);
const wholeWord = ref(false);
const useRegex = ref(false);
const showPathFilters = ref(false);
const searchIndexing = ref(false);
const searchError = ref('');
const replaceRunning = ref(false);
const selectedResultPath = ref<string | null>(null);
const scannedFileCount = ref(0);
const backendResults = ref<IWorkspaceSearchResult[]>([]);
let searchRequestId = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let activeAbortController: AbortController | null = null;
const message = useMessage();
const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();

const isWordCharacter = (value: string | undefined): boolean =>
  Boolean(value) && /[A-Za-z0-9_\-\u4E00-\u9FFF]/u.test(value);

const splitPatternList = (value: string): string[] =>
  value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);

const collectPlainMatchRanges = (
  value: string,
  query: string,
  caseSensitive: boolean,
  fullWord: boolean,
): Array<[number, number]> => {
  const source = caseSensitive ? value : value.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const ranges: Array<[number, number]> = [];

  if (!needle) {
    return ranges;
  }

  let searchIndex = 0;
  while (searchIndex < source.length) {
    const nextMatchIndex = source.indexOf(needle, searchIndex);
    if (nextMatchIndex === -1) {
      break;
    }

    const matchEndIndex = nextMatchIndex + needle.length;
    const beforeCharacter = value[nextMatchIndex - 1];
    const afterCharacter = value[matchEndIndex];
    const passesWordBoundary =
      !fullWord || (!isWordCharacter(beforeCharacter) && !isWordCharacter(afterCharacter));

    if (passesWordBoundary) {
      ranges.push([nextMatchIndex, matchEndIndex]);
    }

    searchIndex = nextMatchIndex + Math.max(needle.length, 1);
  }

  return ranges;
};

const collectRegExpMatchRanges = (value: string, pattern: RegExp): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  pattern.lastIndex = 0;

  let nextMatch = pattern.exec(value);
  while (nextMatch) {
    const matchedValue = nextMatch[0] ?? '';
    if (!matchedValue) {
      pattern.lastIndex += 1;
      nextMatch = pattern.exec(value);
      continue;
    }

    ranges.push([nextMatch.index, nextMatch.index + matchedValue.length]);
    nextMatch = pattern.exec(value);
  }

  pattern.lastIndex = 0;
  return ranges;
};

const buildHighlightedSegments = (
  value: string,
  ranges: Array<[number, number]>,
): IHighlightedSegment[] => {
  if (ranges.length === 0) {
    return [{ text: value, matched: false }];
  }

  const segments: IHighlightedSegment[] = [];
  let previousIndex = 0;

  for (const [startIndex, endIndex] of ranges) {
    if (startIndex > previousIndex) {
      segments.push({ text: value.slice(previousIndex, startIndex), matched: false });
    }

    segments.push({ text: value.slice(startIndex, endIndex), matched: true });
    previousIndex = endIndex;
  }

  if (previousIndex < value.length) {
    segments.push({ text: value.slice(previousIndex), matched: false });
  }

  return segments.filter((segment) => segment.text.length > 0);
};

const resolveMatcher = (): ISearchMatcher => {
  const query = searchQuery.value.trim();
  if (!query) {
    return {
      hasQuery: false,
      errorMessage: '',
      highlight: (value) => [{ text: value, matched: false }],
    };
  }

  if (useRegex.value) {
    try {
      const baseFlags = matchCase.value ? 'gu' : 'giu';
      const highlightPattern = new RegExp(query, baseFlags);
      return {
        hasQuery: true,
        errorMessage: '',
        highlight: (value: string) =>
          buildHighlightedSegments(value, collectRegExpMatchRanges(value, highlightPattern)),
      };
    } catch (error) {
      return {
        hasQuery: true,
        errorMessage: toErrorMessage(error, '请输入有效的正则表达式。'),
        highlight: (value) => [{ text: value, matched: false }],
      };
    }
  }

  return {
    hasQuery: true,
    errorMessage: '',
    highlight: (value: string) =>
      buildHighlightedSegments(
        value,
        collectPlainMatchRanges(value, query, matchCase.value, wholeWord.value),
      ),
  };
};

const matcher = computed(resolveMatcher);
const matcherError = computed(() => matcher.value.errorMessage);
const hasSearchQuery = computed(() => searchQuery.value.trim().length > 0);
const indexedFileCount = computed(() => scannedFileCount.value);
const includePatterns = computed(() => splitPatternList(includePattern.value));
const excludePatterns = computed(() => splitPatternList(excludePattern.value));

const toResultItem = (result: IWorkspaceSearchResult): ISearchResultItem => {
  const lineSuffix = result.lineNumber ? `:${result.lineNumber}` : '';
  const locationText = `${result.relativePath}${lineSuffix}`;
  const reasonLabels: Record<TSearchReason, string> = {
    'file-name': '文件名匹配',
    content: '内容匹配',
    symbol: '符号匹配',
  };

  return {
    path: result.path,
    relativePath: result.relativePath,
    resultKey: `${result.kind}:${result.path}:${result.lineNumber ?? 0}`,
    reason: result.kind,
    reasonLabel: reasonLabels[result.kind],
    snippetSegments: matcher.value.highlight(result.lineText ?? result.name),
    locationSegments: matcher.value.highlight(locationText),
    score: result.score,
    lineNumber: result.lineNumber,
  };
};

const allResults = computed(() => backendResults.value.map(toResultItem));
const searchResultsByScope = computed<Record<TWorkspaceSearchScope, ISearchResultItem[]>>(() => {
  const nextResults: Record<TWorkspaceSearchScope, ISearchResultItem[]> = {
    all: allResults.value,
    'file-name': allResults.value.filter((result) => result.reason === 'file-name'),
    symbol: allResults.value.filter((result) => result.reason === 'symbol'),
    content: allResults.value.filter((result) => result.reason === 'content'),
  };

  return nextResults;
});

const scopeChips = computed(() =>
  (Object.keys(SEARCH_SCOPE_LABELS) as TWorkspaceSearchScope[]).map((scopeKey) => ({
    key: scopeKey,
    label: SEARCH_SCOPE_LABELS[scopeKey],
    count: searchResultsByScope.value[scopeKey].length,
  })),
);

const activeScopeIsPending = computed(() => false);
const activeResults = computed(() => searchResultsByScope.value[activeScope.value]);
const matchedFileCount = computed(
  () => new Set(activeResults.value.map((result) => result.path)).size,
);
const contentReplacementTargets = computed(() => {
  const paths = new Map<string, { path: string; relativePath: string }>();

  for (const result of searchResultsByScope.value.content) {
    if (!paths.has(result.path)) {
      paths.set(result.path, {
        path: result.path,
        relativePath: result.relativePath,
      });
    }
  }

  return Array.from(paths.values());
});
const canApplyReplacement = computed(
  () => !replaceRunning.value,
);

const cancelPendingSearch = (): void => {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
};

const runSearch = async (): Promise<void> => {
  if (!props.isDesktopRuntime || !props.workspaceRootPath) {
    scannedFileCount.value = 0;
    backendResults.value = [];
    searchIndexing.value = false;
    searchError.value = '';
    return;
  }

  if (matcherError.value) {
    backendResults.value = [];
    searchIndexing.value = false;
    searchError.value = '';
    return;
  }

  const requestId = searchRequestId + 1;
  searchRequestId = requestId;
  activeAbortController?.abort();
  const abortController = new AbortController();
  activeAbortController = abortController;
  searchIndexing.value = true;
  searchError.value = '';

  try {
    const payload = await tauriService.searchWorkspace({
      workspaceRootPath: props.workspaceRootPath,
      query: searchQuery.value.trim(),
      scope: activeScope.value,
      matchCase: matchCase.value,
      wholeWord: wholeWord.value,
      useRegex: useRegex.value,
      includePatterns: showPathFilters.value ? includePatterns.value : [],
      excludePatterns: showPathFilters.value ? excludePatterns.value : [],
      limit: SEARCH_RESULT_LIMIT,
    });

    if (requestId !== searchRequestId) {
      return;
    }

    scannedFileCount.value = payload.scannedFileCount;
    backendResults.value = payload.results;
  } catch (error) {
    if (abortController.signal.aborted || requestId !== searchRequestId) {
      return;
    }

    backendResults.value = [];
    searchError.value = toErrorMessage(error, '搜索失败。');
  } finally {
    if (requestId === searchRequestId) {
      searchIndexing.value = false;
      activeAbortController = null;
    }
  }
};

const scheduleSearch = (): void => {
  if (searchTimer) {
    clearTimeout(searchTimer);
  }

  searchTimer = setTimeout(() => {
    searchTimer = null;
    void runSearch();
  }, SEARCH_DEBOUNCE_MS);
};

const buildReplacementGoal = (
  targets: Array<{ relativePath: string }>,
  oldString: string,
  newString: string,
): string => {
  const fileList = targets.map((target) => `- ${target.relativePath}`).join('\n');

  return [
    '在当前工作区执行一次搜索替换。',
    '必须只使用 Mastra Workspace 工具 string_replace_lsp，不要使用 shell 命令，不要手写文件 IO。',
    '每个文件调用一次 string_replace_lsp，参数固定为 replace_all: true。',
    `old_string: ${JSON.stringify(oldString)}`,
    `new_string: ${JSON.stringify(newString)}`,
    '只处理以下文件：',
    fileList,
    '完成后用一句中文总结实际替换结果。',
  ].join('\n');
};

const assertReplacementOptionsSupported = (): boolean => {
  if (useRegex.value) {
    message.warning('替换暂不支持正则表达式，请关闭正则后重试。');
    return false;
  }

  if (wholeWord.value) {
    message.warning('替换暂不支持全字匹配，请关闭全字匹配后重试。');
    return false;
  }

  return true;
};

const applyReplacementToSearch = async (): Promise<void> => {
  if (replaceRunning.value) {
    return;
  }

  if (!hasSearchQuery.value) {
    message.warning('请先输入搜索内容。');
    return;
  }

  if (searchQuery.value === replacementQuery.value) {
    message.warning('替换内容与搜索内容相同，无需替换。');
    return;
  }

  if (!props.isDesktopRuntime) {
    message.warning('浏览器预览不支持写入文件，请在 Tauri 桌面端使用替换。');
    return;
  }

  if (!props.workspaceRootPath) {
    message.warning('请先打开工作区后再替换。');
    return;
  }

  if (!assertReplacementOptionsSupported()) {
    return;
  }

  const targets = contentReplacementTargets.value;
  if (targets.length === 0) {
    message.warning('当前没有可替换的内容匹配结果。');
    return;
  }

  const workspaceRootPath = props.workspaceRootPath;

  replaceRunning.value = true;
  try {
    const oldString = searchQuery.value.trim();
    const goal = buildReplacementGoal(targets, oldString, replacementQuery.value);
    const payload = await aiService.sidecarExecute({
      sessionId: `search-replace:${Date.now().toString(36)}`,
      goal,
      messages: [
        {
          role: 'user',
          content: goal,
        },
      ],
      workspaceRootPath,
      context: [],
    });
    const failedEvent = payload.events.find(
      (event) =>
        event.type === 'agent.run.error' ||
        (event.type === 'agent.tool.completed' && !event.ok),
    );

    if (failedEvent) {
      const errorMessage =
        failedEvent.type === 'agent.run.error'
          ? failedEvent.errorMessage
          : failedEvent.errorMessage ?? '替换工具执行失败。';
      throw new Error(errorMessage);
    }

    const refreshResult = await refreshSidecarChangedDocuments({
      changedFilePaths: targets.map((target) => target.path),
      hasFileMutations: true,
      workspaceRootPath,
    });

    if (refreshResult.skippedDirtyNames.length > 0) {
      message.warning(
        `已完成替换，但 ${refreshResult.skippedDirtyNames.join('、')} 有未保存改动，已跳过自动刷新。`,
      );
    } else if (refreshResult.failedNames.length > 0) {
      message.warning(
        `已完成替换，但 ${refreshResult.failedNames.join('、')} 刷新失败，请手动重新打开。`,
      );
    } else {
      message.success(`已提交 ${targets.length} 个文件的替换。`);
    }

    void runSearch();
  } catch (error) {
    message.error(toErrorMessage(error, '替换失败。'));
  } finally {
    replaceRunning.value = false;
  }
};

const handleResultClick = (path: string): void => {
  selectedResultPath.value = path;
  emit('open-file', path);
};

watch(
  [
    () => props.isDesktopRuntime,
    () => props.workspaceRootPath,
    () => props.preloadedWorkspaceRoot,
    searchQuery,
    activeScope,
    matchCase,
    wholeWord,
    useRegex,
    showPathFilters,
    includePattern,
    excludePattern,
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
    selectedResultPath.value = null;
  },
);

watch(
  [activeResults, () => props.documentPath],
  ([results, documentPath]) => {
    const availablePaths = results.map((result) => result.path);

    if (documentPath && availablePaths.includes(documentPath)) {
      selectedResultPath.value = documentPath;
      return;
    }

    if (selectedResultPath.value && availablePaths.includes(selectedResultPath.value)) {
      return;
    }

    selectedResultPath.value = availablePaths[0] ?? null;
  },
  { immediate: true },
);

onScopeDispose(cancelPendingSearch);
</script>
