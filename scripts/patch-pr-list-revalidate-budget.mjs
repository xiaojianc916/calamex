#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

function countOccurrences(text, needle) {
  if (needle.length === 0) return 0;

  let count = 0;
  let index = 0;

  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function replaceExact(relativePath, oldText, newText, expectedCount = 1) {
  const filePath = resolve(root, relativePath);
  const text = readFileSync(filePath, 'utf8');
  const count = countOccurrences(text, oldText);

  if (count !== expectedCount) {
    throw new Error(
      [
        `${relativePath}: expected ${expectedCount} occurrence(s), found ${count}.`,
        'Refusing to modify because the file may have changed.',
      ].join('\n'),
    );
  }

  writeFileSync(filePath, text.split(oldText).join(newText), 'utf8');
  console.log(`patched ${relativePath}: ${expectedCount} replacement(s)`);
}

// 1. Add a small revalidation budget.
// This is not a TTL-only strategy: manual refresh still force-bypasses it.
// It only prevents repeated automatic SWR refreshes caused by tab switching / rerenders.
replaceExact(
  'src/store/git.ts',
  `const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;`,
  `const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
const PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS = 30_000;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;`,
);

// 2. Track the last successful fetch time per repository + PR state.
replaceExact(
  'src/store/git.ts',
  `  const pullRequestListCache = ref<Record<string, IGitPullRequestSummaryPayload[]>>({});
  const pullRequestDetailCache = ref<Record<string, IGitPullRequestDetailPayload>>({});`,
  `  const pullRequestListCache = ref<Record<string, IGitPullRequestSummaryPayload[]>>({});
  const pullRequestListFetchedAt = ref<Record<string, number>>({});
  const pullRequestDetailCache = ref<Record<string, IGitPullRequestDetailPayload>>({});`,
);

// 3. Invalidate freshness metadata together with the list cache.
replaceExact(
  'src/store/git.ts',
  `  const invalidatePullRequestListCache = (): void => {
    pullRequestListCache.value = {};
    pendingPullRequestListRequests.clear();
  };`,
  `  const invalidatePullRequestListCache = (): void => {
    pullRequestListCache.value = {};
    pullRequestListFetchedAt.value = {};
    pendingPullRequestListRequests.clear();
  };`,
);

// 4. When a mutation updates cached PR lists, also mark those cache entries as fresh.
// This mirrors GitHub Desktop's store-first update approach: local mutation result updates store,
// then explicit refresh paths can still reconcile with the server.
replaceExact(
  'src/store/git.ts',
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
);

// 5. Add the revalidation budget to automatic SWR loads.
// Cached data still displays instantly. If it was refreshed very recently, skip the network.
// Manual refresh passes force: true and bypasses this block.
replaceExact(
  'src/store/git.ts',
  `    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    const cached = pullRequestListCache.value[cacheKey];
    if (cached && updateActive) pullRequests.value = cached;

    if (options?.force) {`,
  `    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    const cached = pullRequestListCache.value[cacheKey];
    if (cached && updateActive) pullRequests.value = cached;

    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
    const isFresh =
      Date.now() - fetchedAt < PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS;
    if (cached && !options?.force && isFresh) {
      return cached;
    }

    if (options?.force) {`,
);

// 6. Store the successful fetch timestamp with the list payload.
replaceExact(
  'src/store/git.ts',
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
);

console.log('done');