#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/components/workbench/sidebar/search/useWorkspaceSearch.ts';

let content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const replaceOnce = (source, target, label) => {
  const count = content.split(source).length - 1;

  if (count === 0) {
    console.log(`skipped: ${label}`);
    return;
  }

  if (count !== 1) {
    throw new Error(`${label}: expected 1 match, got ${count}`);
  }

  content = content.replace(source, target);
  console.log(`fixed: ${label}`);
};

replaceOnce(
  `const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_RESULT_LIMIT = 50000;
const SEARCH_STREAM_FLUSH_INTERVAL_MS = 48;
const SEARCH_STREAM_FLUSH_INTERVAL_MS = 48;`,
  `const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_RESULT_LIMIT = 50000;
const SEARCH_STREAM_FLUSH_INTERVAL_MS = 48;`,
  'duplicate SEARCH_STREAM_FLUSH_INTERVAL_MS',
);

replaceOnce(
  `  let streamingSearchId = 0;
  let disposeSearchStream: (() => void) | null = null;
  const pendingStreamResults: IWorkspaceSearchResult[] = [];
  const streamResultsFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingStreamResults: IWorkspaceSearchResult[] = [];
  let streamResultsFlushTimer: ReturnType<typeof setTimeout> | null = null;`,
  `  let streamingSearchId = 0;
  let disposeSearchStream: (() => void) | null = null;
  let pendingStreamResults: IWorkspaceSearchResult[] = [];
  let streamResultsFlushTimer: ReturnType<typeof setTimeout> | null = null;`,
  'duplicate pending stream declarations',
);

writeFileSync(file, content, 'utf8');

console.log('done');