#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const read = (file) => readFileSync(join(root, file), 'utf8');
const write = (file, content) => writeFileSync(join(root, file), content, 'utf8');
const lines = (items) => `${items.join('\n')}\n`;

const replaceOnce = (file, source, target, label) => {
  const content = read(file);
  const count = content.split(source).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: ${label} expected 1 match, got ${count}`);
  }
  write(file, content.replace(source, target));
  console.log(`updated ${file}: ${label}`);
};

// 第四批：搜索面板的流式结果热路径。
// 后端会按文件发现顺序分批推送 search stream events。旧实现每个事件都：
//   backendResults.value = [...backendResults.value, ...event.results]
// 这在大量命中时会反复复制已累积的大数组，退化成 O(n^2) 分配。
// 改为短窗口批量 flush：用户仍能看到渐进式结果，但数组复制次数从“每个事件一次”
// 降到最多约 20fps，且隐藏/取消/权威结果返回时会清空 pending buffer。
const searchFile = 'src/components/workbench/sidebar/search/useWorkspaceSearch.ts';

replaceOnce(
  searchFile,
  lines([
    'const SEARCH_DEBOUNCE_MS = 180;',
    'const SEARCH_RESULT_LIMIT = 50000;',
  ]),
  lines([
    'const SEARCH_DEBOUNCE_MS = 180;',
    'const SEARCH_RESULT_LIMIT = 50000;',
    'const SEARCH_STREAM_FLUSH_INTERVAL_MS = 48;',
  ]),
  'add streamed search flush interval',
);

replaceOnce(
  searchFile,
  lines([
    '  // 当前接受流式事件的关联标识：与传给后端的 streamToken 一致，过期搜索的残留事件据此忽略。',
    '  let streamingSearchId = 0;',
    '  let disposeSearchStream: (() => void) | null = null;',
  ]),
  lines([
    '  // 当前接受流式事件的关联标识：与传给后端的 streamToken 一致，过期搜索的残留事件据此忽略。',
    '  let streamingSearchId = 0;',
    '  let disposeSearchStream: (() => void) | null = null;',
    '  let pendingStreamResults: IWorkspaceSearchResult[] = [];',
    '  let streamResultsFlushTimer: ReturnType<typeof setTimeout> | null = null;',
  ]),
  'add streamed search pending buffer',
);

replaceOnce(
  searchFile,
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
    '    backendResults.value = [...backendResults.value, ...nextResults];',
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
    '    backendResults.value = [];',
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
  'batch streamed search result appends',
);

replaceOnce(
  searchFile,
  lines([
    '    streamingSearchId = lifecycle.requestId;',
    '    scannedFileCount.value = 0;',
    '    backendResults.value = [];',
    '    searchIndexing.value = true;',
    "    searchError.value = '';",
  ]),
  lines([
    '    streamingSearchId = lifecycle.requestId;',
    '    clearPendingStreamResults();',
    '    scannedFileCount.value = 0;',
    '    backendResults.value = [];',
    '    searchIndexing.value = true;',
    "    searchError.value = '';",
  ]),
  'clear pending streamed results before new search',
);

replaceOnce(
  searchFile,
  lines([
    '      // 一次性返回的权威结果（已排序、含文件名/符号命中）覆盖流式累积的预览。',
    '      streamingSearchId = 0;',
    '      scannedFileCount.value = payload.scannedFileCount;',
    '      backendResults.value = payload.results;',
  ]),
  lines([
    '      // 一次性返回的权威结果（已排序、含文件名/符号命中）覆盖流式累积的预览。',
    '      streamingSearchId = 0;',
    '      clearPendingStreamResults();',
    '      scannedFileCount.value = payload.scannedFileCount;',
    '      backendResults.value = payload.results;',
  ]),
  'drop pending streamed previews before authoritative search result',
);

replaceOnce(
  searchFile,
  lines([
    '      if (lifecycle.signal.aborted || !isSearchLifecycleCurrent(lifecycle)) return;',
    '      streamingSearchId = 0;',
    '      backendResults.value = [];',
    "      searchError.value = toErrorMessage(error, '搜索失败。');",
  ]),
  lines([
    '      if (lifecycle.signal.aborted || !isSearchLifecycleCurrent(lifecycle)) return;',
    '      streamingSearchId = 0;',
    '      clearPendingStreamResults();',
    '      backendResults.value = [];',
    "      searchError.value = toErrorMessage(error, '搜索失败。');",
  ]),
  'clear pending streamed previews on search error',
);

replaceOnce(
  searchFile,
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
  'fully invalidate pending search when hidden or disposed',
);

replaceOnce(
  searchFile,
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
  'avoid allocating selected-result key set for every search update',
);

replaceOnce(
  searchFile,
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
  'clear streamed search buffer on dispose',
);

console.log('\nFourth performance patch script completed. No backup files were created.');