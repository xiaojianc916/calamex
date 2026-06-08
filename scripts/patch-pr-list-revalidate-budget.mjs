#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function writeProjectFile(relativePath, text) {
  writeFileSync(resolve(root, relativePath), text, 'utf8');
}

function countOccurrences(text, needle) {
  if (!needle) return 0;

  let count = 0;
  let index = 0;

  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function replaceOnce(relativePath, oldText, newText, label) {
  const text = readProjectFile(relativePath);
  const count = countOccurrences(text, oldText);

  if (count !== 1) {
    throw new Error(
      [
        `${relativePath}: ${label}`,
        `expected 1 occurrence, found ${count}.`,
        'Refusing to modify because the file may have changed.',
      ].join('\n'),
    );
  }

  writeProjectFile(relativePath, text.replace(oldText, newText));
  console.log(`patched ${relativePath}: ${label}`);
}

function replaceOnceUnlessContains(relativePath, oldText, newText, alreadyAppliedNeedle, label) {
  const text = readProjectFile(relativePath);

  if (text.includes(alreadyAppliedNeedle)) {
    console.log(`skipped ${relativePath}: ${label} already applied`);
    return;
  }

  replaceOnce(relativePath, oldText, newText, label);
}

const file = 'src/store/git.ts';

// 1. Add automatic PR list revalidation budget.
// Manual refresh still uses force:true and bypasses this budget.
replaceOnceUnlessContains(
  file,
  `const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;`,
  `const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
const PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS = 30_000;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;`,
  'PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS',
  'add PR list revalidation interval',
);

// 2. Track last successful list fetch time per repository/state cache key.
replaceOnceUnlessContains(
  file,
  `  const pullRequestListCache = ref<Record<string, IGitPullRequestSummaryPayload[]>>({});
  const pullRequestDetailCache = ref<Record<string, IGitPullRequestDetailPayload>>({});`,
  `  const pullRequestListCache = ref<Record<string, IGitPullRequestSummaryPayload[]>>({});
  const pullRequestListFetchedAt = ref<Record<string, number>>({});
  const pullRequestDetailCache = ref<Record<string, IGitPullRequestDetailPayload>>({});`,
  'pullRequestListFetchedAt',
  'track PR list freshness',
);

// 3. Clear freshness metadata with list cache.
replaceOnceUnlessContains(
  file,
  `  const invalidatePullRequestListCache = (): void => {
    pullRequestListCache.value = {};
    pendingPullRequestListRequests.clear();
  };`,
  `  const invalidatePullRequestListCache = (): void => {
    pullRequestListCache.value = {};
    pullRequestListFetchedAt.value = {};
    pendingPullRequestListRequests.clear();
  };`,
  `pullRequestListFetchedAt.value = {};`,
  'invalidate PR list freshness metadata',
);

// 4. Mark mutation-updated cache entries as fresh.
// This matches GitHub Desktop's store-first mutation pattern:
// update local cache immediately, then explicit refresh can still reconcile.
replaceOnceUnlessContains(
  file,
  `    const nextCache = { ...pullRequestListCache.value };
    for (const cacheKey of cacheKeys) {
      const state = normalizePullRequestState(cacheKey.split('|').pop());
      nextCache[cacheKey] = updatePullRequestListForState(
        nextCache[cacheKey] ?? [],
        pullRequest,
        state,
      );
    }

    pullRequestListCache.value = nextCache;`,
  `    const nextCache = { ...pullRequestListCache.value };
    const nextFetchedAt = { ...pullRequestListFetchedAt.value };
    const now = Date.now();
    for (const cacheKey of cacheKeys) {
      const state = normalizePullRequestState(cacheKey.split('|').pop());
      nextCache[cacheKey] = updatePullRequestListForState(
        nextCache[cacheKey] ?? [],
        pullRequest,
        state,
      );
      nextFetchedAt[cacheKey] = now;
    }

    pullRequestListCache.value = nextCache;
    pullRequestListFetchedAt.value = nextFetchedAt;`,
  'const nextFetchedAt = { ...pullRequestListFetchedAt.value };',
  'mark mutation-updated PR lists fresh',
);

// 5. Apply the revalidation budget to automatic SWR.
// Cached list still displays immediately.
// If recently fetched, skip network.
// Manual refresh force:true bypasses this block.
replaceOnceUnlessContains(
  file,
  `    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    const cached = pullRequestListCache.value[cacheKey];
    if (cached && updateActive) pullRequests.value = cached;

    if (options?.force) {`,
  `    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    const cached = pullRequestListCache.value[cacheKey];
    if (cached && updateActive) pullRequests.value = cached;

    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
    const isFresh = Date.now() - fetchedAt < PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS;
    if (cached && !options?.force && isFresh) {
      if (shouldPreloadDetails) {
        preloadTopPullRequestDetails(cached);
      }
      return cached;
    }

    if (options?.force) {`,
  'const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;',
  'apply PR list SWR revalidation budget',
);

// 6. Store successful fetch timestamp.
replaceOnceUnlessContains(
  file,
  `        pullRequestListCache.value = {
          ...pullRequestListCache.value,
          [cacheKey]: payload,
        };
        if (updateActive && requestId === pullRequestsRequestId) {`,
  `        pullRequestListCache.value = {
          ...pullRequestListCache.value,
          [cacheKey]: payload,
        };
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: Date.now(),
        };
        if (updateActive && requestId === pullRequestsRequestId) {`,
  'pullRequestListFetchedAt.value = {',
  'store PR list successful fetch timestamp',
);

console.log('done');