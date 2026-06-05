<template>
  <section class="search-sidebar" aria-label="搜索">
    <div class="search-panel-query-stack">
      <div class="search-panel-input-shell">
        <span class="search-panel-input-icon" aria-hidden="true">
          <span class="icon-[lucide--search]" />
        </span>

        <Input v-model="searchQuery" class="search-panel-input" type="text" aria-label="搜索关键字"
          :placeholder="useStructural ? '输入 ast-grep 模式…' : '输入关键字搜索…'" autocomplete="off" spellcheck="false" />

        <button v-if="hasSearchQuery" type="button" class="search-panel-clear-btn" aria-label="清空搜索" title="清空搜索"
          @click.stop="searchQuery = ''">
          <span aria-hidden="true" class="icon-[lucide--x]" />
        </button>
      </div>

      <div class="search-panel-input-shell search-panel-replace-shell">
        <span class="search-panel-input-icon" aria-hidden="true">
          <span class="icon-[lucide--replace]" />
        </span>

        <Input v-model="replacementQuery" class="search-panel-input" type="text" aria-label="替换内容"
          :placeholder="useStructural ? '输入 ast-grep 替换…' : '输入替换内容…'" autocomplete="off" spellcheck="false"
          @keydown.enter="handleReplacementAction" />

        <button type="button" class="search-panel-apply-btn" :disabled="!canApplyReplacement" aria-label="全部替换"
          title="全部替换" @click.stop="handleReplacementAction">
          <span v-if="replaceRunning" class="icon-[lucide--loader-circle] search-panel-spin" aria-hidden="true" />
          <span v-else aria-hidden="true" class="icon-[lucide--check]" />
        </button>
      </div>
    </div>

    <div class="search-panel-chip-row">
      <button v-for="chip in scopeChips" :key="chip.key" type="button" class="search-panel-chip"
        :class="{ 'is-active': activeScope === chip.key }" :aria-pressed="activeScope === chip.key"
        @click="activeScope = chip.key">
        <span> {{ chip.label }} </span>
        <span class="search-panel-chip-count">{{ chip.count }}</span>
      </button>
    </div>

    <div class="search-panel-option-row" aria-label="搜索选项">
      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': matchCase }"
        :aria-pressed="matchCase" title="区分大小写" @click="toggleSearchOption('matchCase')">
        <span aria-hidden="true" class="icon-[lucide--case-sensitive]" />
      </button>

      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': wholeWord }"
        :aria-pressed="wholeWord" title="全字匹配" @click="toggleSearchOption('wholeWord')">
        <span aria-hidden="true" class="icon-[lucide--whole-word]" />
      </button>

      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': useRegex }" :aria-pressed="useRegex"
        title="正则表达式" @click="toggleSearchOption('useRegex')">
        <span aria-hidden="true" class="icon-[lucide--regex]" />
      </button>

      <button type="button" class="search-panel-option-btn" :class="{ 'is-active': showPathFilters }"
        :aria-pressed="showPathFilters" title="包含 / 排除路径" @click="toggleSearchOption('showPathFilters')">
        <span aria-hidden="true" class="icon-[lucide--list-filter]" />
      </button>

      <button type="button" class="search-panel-option-btn search-panel-option-structural"
        :class="{ 'is-active': useStructural }" :aria-pressed="useStructural" title="结构化搜索与替换"
        @click="toggleStructuralSearch">
        <span aria-hidden="true" class="icon-[lucide--braces]" />
      </button>
    </div>

    <div v-if="showPathFilters && !useStructural" class="search-panel-path-filter-row">
      <label class="search-panel-path-filter">
        <span>包含</span>
        <input v-model="includePattern" type="text" placeholder="" autocomplete="off" spellcheck="false" />
      </label>

      <label class="search-panel-path-filter">
        <span>排除</span>
        <input v-model="excludePattern" type="text" placeholder="" autocomplete="off" spellcheck="false" />
      </label>
    </div>

    <div ref="resultsScrollRef" class="search-panel-results" role="listbox">
      <div v-if="replacementPreviewOpen" class="search-replace-inline">
        <div v-if="replaceRunning && !replacementPreview" class="search-replace-inline-empty">
          <span class="icon-[lucide--loader-circle] search-panel-spin" aria-hidden="true" />
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
                <span class="search-replace-inline-chevron" aria-hidden="true">{{ isReplacementFileCollapsed(file.path)
                  ? '▸' : '▾' }}</span>
                <span class="search-replace-inline-file-icon" aria-hidden="true">
                  <ExplorerEntryIcon kind="file" :path="file.path" />
                </span>
                <span class="search-replace-inline-file-name">{{ file.name }}</span>
                <span class="search-replace-inline-file-path">{{ file.parentPath }}</span>
              </button>
              <span class="search-replace-inline-count">{{ file.visibleReplacementCount }}</span>
            </header>

            <template v-if="!isReplacementFileCollapsed(file.path)">
              <div v-for="line in file.visibleLinePreviews" :key="line.id" class="search-replace-inline-line"
                role="option" tabindex="0" @click="handleReplacementLineOpen(file.path, line.lineNumber)"
                @keydown.enter="handleReplacementLineOpen(file.path, line.lineNumber)"
                @keydown.space.prevent="handleReplacementLineOpen(file.path, line.lineNumber)">
                <span class="search-replace-inline-line-number">{{ line.lineNumber }}</span>
                <span class="search-replace-inline-code">
                  <template v-for="(segment, segmentIndex) in line.segments" :key="`${line.id}-${segmentIndex}`">
                    <span v-if="segment.kind !== 'empty'" class="search-replace-inline-segment"
                      :class="[`is-${segment.kind}`, `is-${segment.part}`]" v-text="segment.text" />
                  </template>
                </span>

                <span class="search-replace-inline-line-actions">
                  <button type="button" class="search-replace-inline-icon-btn" :disabled="replacementApplying"
                    aria-label="替换此处" title="替换此处" @click.stop="replaceReplacementLine(file, line)">
                    <span v-if="replacementApplyingLineId === line.id"
                      class="icon-[lucide--loader-circle] search-panel-spin" aria-hidden="true" />
                    <span v-else aria-hidden="true" class="icon-[lucide--replace]" />
                  </button>
                  <button type="button" class="search-replace-inline-icon-btn" :disabled="replacementApplying"
                    aria-label="跳过此处" title="跳过此处" @click.stop="skipReplacementLine(line.id)">
                    <span aria-hidden="true" class="icon-[lucide--x]" />
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
        <span class="icon-[lucide--loader-circle] search-panel-spin" aria-hidden="true" />
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
        <!-- ① 新增：结果多时走虚拟化 -->
        <div v-if="shouldVirtualizeSearch" class="search-panel-virtual-spacer"
          :style="{ height: `${searchTotalSize}px` }">
          <template v-for="entry in windowedSearchRows" :key="entry.key">
            <header v-if="entry.row.kind === 'group'" class="search-panel-result-group-header search-panel-virtual-row"
              :style="{ transform: `translateY(${entry.start}px)` }">
              <button type="button" class="search-panel-result-group-open"
                :aria-expanded="!isSearchResultGroupCollapsed(entry.row.group.path)"
                @click="toggleSearchResultGroup(entry.row.group.path)">
                <span class="search-panel-result-group-chevron" aria-hidden="true">{{
                  isSearchResultGroupCollapsed(entry.row.group.path) ? '▸' : '▾' }}</span>
                <span class="search-panel-result-group-icon" aria-hidden="true">
                  <ExplorerEntryIcon kind="file" :path="entry.row.group.path" />
                </span>
                <span class="search-panel-result-group-name"> {{ entry.row.group.name }} </span>
                <span class="search-panel-result-group-path"> {{ entry.row.group.parentPath }} </span>
              </button>
              <span class="search-panel-result-group-count"> {{ entry.row.group.results.length }} </span>
            </header>

            <button v-else type="button" class="search-panel-result-line search-panel-virtual-row"
              :class="{ 'is-selected': selectedResultKey === entry.row.result?.resultKey }" role="option"
              :aria-selected="selectedResultKey === entry.row.result?.resultKey"
              :style="{ transform: `translateY(${entry.start}px)` }"
              @click="entry.row.result && handleSearchResultOpen(entry.row.result)">
              <span class="search-panel-result-line-number"> {{ entry.row.result?.lineNumber }} </span>
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

        <!-- ② 原样保留：结果少时不虚拟化 -->
        <template v-else>
          <article v-for="group in searchResultGroups" :key="group.path" class="search-panel-result-group">

            <header class="search-panel-result-group-header">
              <button type="button" class="search-panel-result-group-open"
                :aria-expanded="!isSearchResultGroupCollapsed(group.path)" @click="toggleSearchResultGroup(group.path)">
                <span class="search-panel-result-group-chevron" aria-hidden="true">{{
                  isSearchResultGroupCollapsed(group.path) ? '▸' : '▾' }}</span>
                <span class="search-panel-result-group-icon" aria-hidden="true">
                  <ExplorerEntryIcon kind="file" :path="group.path" />
                </span>
                <span class="search-panel-result-group-name">{{ group.name }}</span>
                <span class="search-panel-result-group-path">{{ group.parentPath }}</span>
              </button>
              <span class="search-panel-result-group-count">{{ group.results.length }}</span>
            </header>

            <template v-if="!isSearchResultGroupCollapsed(group.path)">
              <button v-for="result in group.results" :key="result.resultKey" type="button"
                class="search-panel-result-line" :class="{ 'is-selected': selectedResultKey === result.resultKey }"
                role="option" :aria-selected="selectedResultKey === result.resultKey"
                @click="handleSearchResultOpen(result)">
                <span class="search-panel-result-line-number">{{ result.lineNumber }}</span>

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
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, onScopeDispose, ref, watch } from 'vue';
import InlineError from '@/components/common/InlineError.vue';
import { Input } from '@/components/ui/input';
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import { useMessage } from '@/composables/useMessage';
import {
  type IRefreshSidecarChangedDocumentsResult,
  useSidecarChangedDocumentRefresh,
} from '@/composables/useSidecarChangedDocumentRefresh';
import { tauriService } from '@/services/tauri';
import type { IWorkbenchOpenFileRequest, IWorkspaceDirectoryPayload } from '@/types/editor';
import type {
  IWorkspaceReplacementFilePreview,
  IWorkspaceReplacementLinePreview,
  IWorkspaceReplacementPreviewPayload,
  IWorkspaceReplacementRequest,
  IWorkspaceSearchResult,
  TWorkspaceSearchResultKind,
  TWorkspaceSearchScope,
} from '@/types/search';
import { toErrorMessage } from '@/utils/error';

type TSearchReason = TWorkspaceSearchResultKind;
type TSearchToggleOption = 'matchCase' | 'wholeWord' | 'useRegex' | 'showPathFilters';
type TReplacementSegmentKind = 'equal' | 'removed' | 'added' | 'empty';
type TReplacementSegmentPart = 'whole' | 'prefix' | 'removed' | 'added' | 'suffix';

interface IHighlightedSegment {
  text: string;
  matched: boolean;
}

interface ISearchResultItem {
  path: string;
  relativePath: string;
  resultKey: string;
  reason: TSearchReason;
  snippetSegments: IHighlightedSegment[];
  score: number;
  lineNumber: number | null;
  matchStart: number | null;
  matchEnd: number | null;
}

interface ISearchResultGroup {
  path: string;
  name: string;
  parentPath: string;
  results: ISearchResultItem[];
}

interface IFlatSearchRow {
  kind: 'group' | 'line';
  key: string;
  group: ISearchResultGroup;
  result: ISearchResultItem | null;
}

interface ISearchMatcher {
  hasQuery: boolean;
  errorMessage: string;
  highlight: (value: string) => IHighlightedSegment[];
}

interface IReplacementLineSegment {
  text: string;
  kind: TReplacementSegmentKind;
  part: TReplacementSegmentPart;
}

interface IReplacementLineView extends IWorkspaceReplacementLinePreview {
  segments: IReplacementLineSegment[];
}

interface IReplacementFileView extends IWorkspaceReplacementFilePreview {
  name: string;
  parentPath: string;
  visibleReplacementCount: number;
  visibleLinePreviews: IReplacementLineView[];
}

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
const COMPACT_PREVIEW_ELLIPSIS = '…';
const REPLACEMENT_FILE_LIMIT = 200;
const SEARCH_VIRTUALIZE_THRESHOLD = 100;
const SEARCH_GROUP_ROW_HEIGHT = 28;
const SEARCH_LINE_ROW_HEIGHT = 24;

const searchQuery = ref('');
const replacementQuery = ref('');
const includePattern = ref('');
const excludePattern = ref('');
const activeScope = ref<TWorkspaceSearchScope>('all');
const matchCase = ref(false);
const wholeWord = ref(false);
const useRegex = ref(false);
const useStructural = ref(false);
const showPathFilters = ref(false);
const searchIndexing = ref(false);
const searchError = ref('');
// replaceRunning：替换流程「整体忙碌」标志，覆盖「生成预览」与「写入磁盘」两个阶段，
//   用于禁用「全部替换」按钮并显示其加载态。
// replacementApplying：仅表示「正在把替换写入磁盘」（整页或单行），用于禁用单行的
//   替换/跳过按钮并防止 apply 重入。两者语义不同，不可合并。
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
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let replacementPreviewTimer: ReturnType<typeof setTimeout> | null = null;
let activeAbortController: AbortController | null = null;
let activeReplacementPreviewAbortController: AbortController | null = null;
const message = useMessage();
const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();

// 单词字符定义需与后端一致：后端 grep_regex 的 .word(true) 使用 Unicode \b（\w：
// 字母、数字、下划线，含 CJK 等表意文字），连字符属于「非单词字符」。早期把 '-'
// 当作单词字符，会让前端全字高亮边界与后端命中范围不一致（如 "foo-bar" 中的 "foo"
// 后端命中、前端却判为非边界而不高亮）。
const isWordCharacter = (value: string | undefined): boolean =>
  typeof value === 'string' && /[A-Za-z0-9_\u4E00-\u9FFF]/u.test(value);

const isBoundaryWhitespace = (value: string): boolean => /^\s$/u.test(value);

const trimBoundaryWhitespaceWithRange = (
  value: string,
  range: [number, number] | null,
): { text: string; range: [number, number] | null } => {
  const characters = Array.from(value);
  let startIndex = 0;
  let endIndex = characters.length;

  while (startIndex < endIndex && isBoundaryWhitespace(characters[startIndex] ?? '')) {
    startIndex += 1;
  }

  while (endIndex > startIndex && isBoundaryWhitespace(characters[endIndex - 1] ?? '')) {
    endIndex -= 1;
  }

  if (!range) {
    return {
      text: characters.slice(startIndex, endIndex).join(''),
      range: null,
    };
  }

  const [matchStart, matchEnd] = range;
  const safeStart = Math.max(0, Math.min(matchStart, characters.length));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, characters.length));
  const visibleStart = Math.max(safeStart, startIndex);
  const visibleEnd = Math.min(safeEnd, endIndex);

  return {
    text: characters.slice(startIndex, endIndex).join(''),
    range:
      visibleStart < visibleEnd
        ? ([visibleStart - startIndex, visibleEnd - startIndex] as [number, number])
        : null,
  };
};

const trimBoundaryWhitespace = (value: string): string =>
  trimBoundaryWhitespaceWithRange(value, null).text;

const splitPatternList = (value: string): string[] =>
  value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const collectPlainMatchRanges = (
  value: string,
  query: string,
  caseSensitive: boolean,
  fullWord: boolean,
): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];

  if (!query) {
    return ranges;
  }

  // 直接在原串上用大小写不敏感正则匹配，避免 toLocaleLowerCase()
  // 在某些语言环境下改变字符串长度，导致高亮区间相对原串发生偏移。
  let pattern: RegExp;
  try {
    pattern = new RegExp(escapeRegExp(query), caseSensitive ? 'gu' : 'giu');
  } catch {
    return ranges;
  }

  let nextMatch = pattern.exec(value);
  while (nextMatch) {
    const matchedValue = nextMatch[0] ?? '';
    if (!matchedValue) {
      pattern.lastIndex += 1;
      nextMatch = pattern.exec(value);
      continue;
    }

    const startIndex = nextMatch.index;
    const endIndex = startIndex + matchedValue.length;
    const beforeCharacter = value[startIndex - 1];
    const afterCharacter = value[endIndex];
    const passesWordBoundary =
      !fullWord || (!isWordCharacter(beforeCharacter) && !isWordCharacter(afterCharacter));

    if (passesWordBoundary) {
      ranges.push([startIndex, endIndex]);
    }

    nextMatch = pattern.exec(value);
  }

  pattern.lastIndex = 0;
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

const buildCompactHighlightedSegments = (
  value: string,
  range: [number, number] | null,
  contextSize: number,
): IHighlightedSegment[] => {
  if (!range) {
    return [{ text: value, matched: false }];
  }

  const characters = Array.from(value);
  const [matchStart, matchEnd] = range;
  const safeStart = Math.max(0, Math.min(matchStart, characters.length));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, characters.length));
  const previewStart = Math.max(0, safeStart - contextSize);
  const previewEnd = Math.min(characters.length, safeEnd + contextSize);
  const prefixText = `${previewStart > 0 ? COMPACT_PREVIEW_ELLIPSIS : ''}${characters
    .slice(previewStart, safeStart)
    .join('')}`;
  const matchText = characters.slice(safeStart, safeEnd).join('');
  const suffixText = `${characters.slice(safeEnd, previewEnd).join('')}${
    previewEnd < characters.length ? COMPACT_PREVIEW_ELLIPSIS : ''
  }`;
  const segments: IHighlightedSegment[] = [];

  if (prefixText) {
    segments.push({ text: prefixText, matched: false });
  }

  if (matchText) {
    segments.push({ text: matchText, matched: true });
  }

  if (suffixText) {
    segments.push({ text: suffixText, matched: false });
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

  if (useStructural.value) {
    return {
      hasQuery: true,
      errorMessage: '',
      highlight: (value) => [{ text: value, matched: false }],
    };
  }

  if (useRegex.value) {
    try {
      const baseFlags = matchCase.value ? 'gu' : 'giu';
      // 与后端正则构建保持一致：全字匹配时用单词边界包裹，避免前端高亮
      // 与后端命中范围不一致。
      const highlightSource = wholeWord.value ? `\\b(?:${query})\\b` : query;
      const highlightPattern = new RegExp(highlightSource, baseFlags);
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
const includePatterns = computed(() => splitPatternList(includePattern.value));
const excludePatterns = computed(() => splitPatternList(excludePattern.value));

// 仅在「展开路径过滤且非结构化搜索」时，过滤规则才真正下发后端。统一用这两个计算值
// 作为「生效的过滤规则」：当未启用过滤时，编辑包含/排除输入框不会进入依赖追踪，
// 从而避免触发结果完全相同的重复后端检索。
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
    // 内容命中：直接用后端返回的字符（码点）区间做紧凑高亮，与后端 byte_to_char_offset
    // 完全对齐。文件名/符号命中：后端用 nucleo 模糊匹配且不返回区间，这里退化为前端的
    // 精确/正则高亮——可能与后端模糊命中不完全一致（模糊命中时甚至无高亮）。属于已知取舍：
    // 仅作视觉提示，不影响定位与打开。
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

const getFileName = (relativePath: string): string => {
  const normalizedPath = relativePath.replace(/\\/gu, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments.at(-1) ?? relativePath;
};

const getParentPath = (relativePath: string): string => {
  const normalizedPath = relativePath.replace(/\\/gu, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return '';
  }

  return segments.slice(0, -1).join('/');
};

const buildReplacementLineSegments = (
  beforeLine: string,
  afterLine: string,
): IReplacementLineSegment[] => {
  if (beforeLine === afterLine) {
    return [{ text: beforeLine, kind: 'equal', part: 'whole' }];
  }

  const beforeCharacters = Array.from(beforeLine);
  const afterCharacters = Array.from(afterLine);
  let prefixLength = 0;

  while (
    prefixLength < beforeCharacters.length &&
    prefixLength < afterCharacters.length &&
    beforeCharacters[prefixLength] === afterCharacters[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < beforeCharacters.length - prefixLength &&
    suffixLength < afterCharacters.length - prefixLength &&
    beforeCharacters[beforeCharacters.length - 1 - suffixLength] ===
      afterCharacters[afterCharacters.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const prefixText = beforeCharacters.slice(0, prefixLength).join('');
  const removedText = beforeCharacters
    .slice(prefixLength, beforeCharacters.length - suffixLength)
    .join('');
  const addedText = afterCharacters
    .slice(prefixLength, afterCharacters.length - suffixLength)
    .join('');
  const suffixText = beforeCharacters.slice(beforeCharacters.length - suffixLength).join('');

  return [
    { text: prefixText, kind: prefixText ? 'equal' : 'empty', part: 'prefix' },
    { text: removedText, kind: removedText ? 'removed' : 'empty', part: 'removed' },
    { text: addedText, kind: addedText ? 'added' : 'empty', part: 'added' },
    { text: suffixText, kind: suffixText ? 'equal' : 'empty', part: 'suffix' },
  ];
};

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

  if (visibleLinePreviews.length === 0) {
    return null;
  }

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
  if (!preview) {
    return [];
  }

  return preview.files
    .map(toReplacementFileView)
    .filter((file): file is IReplacementFileView => Boolean(file));
});

const toggleReadonlySetValue = (
  values: ReadonlySet<string>,
  value: string,
): ReadonlySet<string> => {
  const nextValues = new Set(values);
  if (nextValues.has(value)) {
    nextValues.delete(value);
  } else {
    nextValues.add(value);
  }

  return nextValues;
};

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
  replacementPreviewOpen.value = false;
  replacementPreview.value = null;
  replacementPreviewRequest.value = null;
  replacementApplyingLineId.value = null;
  skippedReplacementLineIds.value = new Set<string>();
  collapsedReplacementFilePaths.value = new Set<string>();
};

const toggleSearchOption = (option: TSearchToggleOption): void => {
  if (useStructural.value) {
    useStructural.value = false;
  }

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

  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  if (activeReplacementPreviewAbortController) {
    activeReplacementPreviewAbortController.abort();
    activeReplacementPreviewAbortController = null;
  }
};

// 作废所有在途搜索请求：递增 requestId 让迟到的响应被丢弃，并中止已发出的请求。
// 否则在清空结果后，旧请求 resolve 时其 requestId 仍等于全局值，会把过期结果回灌
// （例如把合法查询改成非法正则后，旧的合法结果又被写回）。
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
  // 以下三种情况都不应发起后端检索，且都必须作废在途请求，防止之前发出的检索结果
  // 在清空后又被写回。
  if (!props.isDesktopRuntime || !props.workspaceRootPath) {
    invalidateInFlightSearch();
    clearSearchResults();
    return;
  }

  if (matcherError.value) {
    invalidateInFlightSearch();
    clearSearchResults();
    return;
  }

  // 空查询无需触发后端检索：直接清空结果，回到初始空状态。
  if (!hasSearchQuery.value) {
    invalidateInFlightSearch();
    clearSearchResults();
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
    const payload = await tauriService.searchWorkspace(
      {
        workspaceRootPath: props.workspaceRootPath,
        query: searchQuery.value.trim(),
        // 后端一次性返回全部范围（文件名/符号/内容）的命中，scope 分面切换完全由前端
        // searchResultsByScope 即时过滤，因此固定下发 'all'，避免切 chip 时重新请求后端。
        scope: 'all',
        matchCase: matchCase.value,
        wholeWord: wholeWord.value,
        useRegex: useRegex.value,
        useStructural: useStructural.value,
        includePatterns: effectiveIncludePatterns.value,
        excludePatterns: effectiveExcludePatterns.value,
        limit: SEARCH_RESULT_LIMIT,
      },
      {
        signal: abortController.signal,
      },
    );

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

const buildReplacementRequest = (): IWorkspaceReplacementRequest | null => {
  if (!props.workspaceRootPath) {
    return null;
  }

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
  if (replaceRunning.value) {
    return false;
  }

  const query = searchQuery.value.trim();
  if (!hasSearchQuery.value) {
    if (source === 'manual') {
      message.warning('请先输入搜索内容。');
    }
    return false;
  }

  if (!useRegex.value && !useStructural.value && query === replacementQuery.value) {
    if (source === 'manual') {
      message.warning('替换内容与搜索内容相同，无需替换。');
    } else {
      resetReplacementPreview();
    }
    return false;
  }

  if (!props.isDesktopRuntime) {
    if (source === 'manual') {
      message.warning('浏览器预览不支持写入文件，请在 Tauri 桌面端使用替换。');
    }
    return false;
  }

  if (!props.workspaceRootPath) {
    if (source === 'manual') {
      message.warning('请先打开工作区后再替换。');
    }
    return false;
  }

  const request = buildReplacementRequest();
  if (!request) {
    return false;
  }
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

    if (requestId !== replacementPreviewRequestId) {
      return false;
    }

    if (preview.fileCount === 0) {
      replacementPreviewOpen.value = false;
      if (source === 'manual') {
        message.warning('当前没有可替换的内容匹配结果。');
      }
      return false;
    }

    replacementPreview.value = preview;
    replacementPreviewRequest.value = request;
    return true;
  } catch (error) {
    // 中止属于正常的竞态取消（更新的请求已接管），不应弹错或污染搜索错误状态。
    if (abortController.signal.aborted || requestId !== replacementPreviewRequestId) {
      return false;
    }

    replacementPreviewOpen.value = false;
    if (source === 'manual') {
      message.error(toErrorMessage(error, '替换失败。'));
    } else {
      searchError.value = toErrorMessage(error, '替换预览失败。');
    }
    return false;
  } finally {
    // 仅当自己仍是最新请求时才复位忙碌态/控制器；被取代时交给接管的请求处理。
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
  if (hasPreview) {
    await confirmReplacementPreview();
  }
};

const scheduleReplacementPreview = (): void => {
  if (replacementPreviewTimer) {
    clearTimeout(replacementPreviewTimer);
  }

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
    if (requestId !== replacementPreviewRequestId) {
      return;
    }

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
    if (abortController.signal.aborted || requestId !== replacementPreviewRequestId) {
      return;
    }

    message.error(toErrorMessage(error, '刷新替换预览失败。'));
  } finally {
    if (requestId === replacementPreviewRequestId) {
      activeReplacementPreviewAbortController = null;
    }
  }
};

const reportReplacementRefreshOutcome = (
  refreshResult: IRefreshSidecarChangedDocumentsResult,
  replacementCount: number,
  successMessage: string,
): void => {
  const issues: string[] = [];

  if (refreshResult.skippedDirtyNames.length > 0) {
    issues.push(`${refreshResult.skippedDirtyNames.join('、')} 有未保存改动，已跳过自动刷新`);
  }

  if (refreshResult.failedNames.length > 0) {
    issues.push(`${refreshResult.failedNames.join('、')} 刷新失败，请手动重新打开`);
  }

  // 跳过与失败可能同时发生，合并到一条提示，避免漏报其中一类。
  if (issues.length > 0) {
    message.warning(`已替换 ${replacementCount} 处内容，但 ${issues.join('；')}。`);
    return;
  }

  message.success(successMessage);
};

// 「应用替换 + 同步刷新已变更文档」是整页替换与单行替换的公共流程，抽出以避免两处
// 逻辑漂移（如刷新参数不一致）。调用方各自处理预览的开/合。
const applyReplacementAndRefresh = async (
  request: IWorkspaceReplacementRequest,
  expectedFiles: Array<{ path: string; beforeHash: string; includedMatchIds: string[] }>,
) => {
  const payload = await tauriService.applyWorkspaceReplacement({ request, expectedFiles });
  const refreshResult = await refreshSidecarChangedDocuments({
    changedFilePaths: payload.files.map((changedFile: { path: string }) => changedFile.path),
    hasFileMutations: true,
    workspaceRootPath: payload.rootPath,
  });

  return { payload, refreshResult };
};

const confirmReplacementPreview = async (): Promise<void> => {
  const request = replacementPreviewRequest.value;
  const files = visibleReplacementFiles.value;

  if (!request || replacementApplying.value) {
    return;
  }

  if (files.length === 0) {
    message.warning('当前没有待替换项。');
    return;
  }

  replacementApplying.value = true;
  replaceRunning.value = true;

  try {
    const payload = await tauriService.applyWorkspaceReplacement({
      request,
      expectedFiles: files.map((file) => ({
        path: file.path,
        beforeHash: file.beforeHash,
        includedMatchIds: file.visibleLinePreviews.map((line) => line.id),
      })),
    });
    const refreshResult = await refreshSidecarChangedDocuments({
      changedFilePaths: payload.files.map((changedFile: { path: string }) => changedFile.path),
      hasFileMutations: true,
      workspaceRootPath: payload.rootPath,
    });

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
    message.error(toErrorMessage(error, '替换失败。'));
  } finally {
    replacementApplying.value = false;
    replaceRunning.value = false;
    replacementApplyingLineId.value = null;
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
  if (!request || replacementApplying.value) {
    return;
  }

  replacementApplying.value = true;
  replaceRunning.value = true;
  replacementApplyingLineId.value = line.id;

  try {
    const { payload, refreshResult } = await applyReplacementAndRefresh(
      request,
      files.map((file) => ({
        path: file.path,
        beforeHash: file.beforeHash,
        includedMatchIds: file.visibleLinePreviews.map((line) => line.id),
      })),
    );

    replacementPreviewOpen.value = false;
    replacementPreview.value = null;
    replacementPreviewRequest.value = null;
    replacementPreviewRequestId += 1;
    activeReplacementPreviewAbortController?.abort();
    activeReplacementPreviewAbortController = null;

    reportReplacementRefreshOutcome(
      refreshResult,
      payload.replacementCount,
      `已替换 ${payload.changedFileCount} 个文件中的 ${payload.replacementCount} 处内容。`,
    );

    void runSearch();
  } catch (error) {
    message.error(toErrorMessage(error, '替换失败。'));
  } finally {
    replacementApplying.value = false;
    replaceRunning.value = false;
    replacementApplyingLineId.value = null;
  }
};

const emitOpenFile = (payload: IWorkbenchOpenFileRequest): void => {
  emit('open-file', payload);
};

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
    useStructural,
    // 用「生效过滤值」的序列化结果作为依赖：未启用路径过滤、或过滤为空时，
    // 编辑包含/排除输入框或切换过滤开关都不会改变下发内容，从而不触发重复检索。
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
    // 同步重置搜索选项，避免遗留「结构化模式 + scope=all」等自相矛盾的组合
    // （结构化搜索本应锁定 content 范围）。
    matchCase.value = false;
    wholeWord.value = false;
    useRegex.value = false;
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
    if (replacementApplying.value) {
      return;
    }

    const shouldPreviewReplacement =
      replacementQuery.value.length > 0 &&
      hasSearchQuery.value &&
      props.isDesktopRuntime &&
      Boolean(props.workspaceRootPath) &&
      !matcherError.value;

    if (shouldPreviewReplacement) {
      scheduleReplacementPreview();
    } else {
      resetReplacementPreview();
    }
  },
);

watch(activeResults, (results) => {
  const availableKeys = new Set(results.map((result) => result.resultKey));

  if (selectedResultKey.value && !availableKeys.has(selectedResultKey.value)) {
    selectedResultKey.value = null;
  }
});

onScopeDispose(cancelPendingSearch);
</script>
