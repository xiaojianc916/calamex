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

// 1. Add detail revalidation budget.
// This only throttles automatic silent revalidation. Explicit force:true still bypasses cache.
replaceOnceUnlessContains(
  file,
  `const PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS = 30_000;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;`,
  `const PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS = 30_000;
const PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS = 30_000;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;`,
  'PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS',
  'add PR detail revalidation interval',
);

// Fallback if your local branch does not have the list budget constant yet.
if (!readProjectFile(file).includes('PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS')) {
  replaceOnceUnlessContains(
    file,
    `const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;`,
    `const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
const PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS = 30_000;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;`,
    'PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS',
    'add PR detail revalidation interval fallback',
  );
}

// 2. Track last successful detail fetch time per repository + PR number.
replaceOnceUnlessContains(
  file,
  `  const pullRequestDetailCache = ref<Record<string, IGitPullRequestDetailPayload>>({});
  const pullRequestDetailCacheOrder = ref<string[]>([]);`,
  `  const pullRequestDetailCache = ref<Record<string, IGitPullRequestDetailPayload>>({});
  const pullRequestDetailFetchedAt = ref<Record<string, number>>({});
  const pullRequestDetailCacheOrder = ref<string[]>([]);`,
  'pullRequestDetailFetchedAt',
  'track PR detail freshness',
);

// 3. Clear all detail freshness metadata when the detail cache is fully invalidated.
replaceOnceUnlessContains(
  file,
  `    if (pullRequestNumber === undefined) {
      pullRequestDetailCache.value = {};
      pullRequestDetailCacheOrder.value = [];
      pendingPullRequestDetailRequests.clear();
      return;
    }`,
  `    if (pullRequestNumber === undefined) {
      pullRequestDetailCache.value = {};
      pullRequestDetailFetchedAt.value = {};
      pullRequestDetailCacheOrder.value = [];
      pendingPullRequestDetailRequests.clear();
      return;
    }`,
  `pullRequestDetailFetchedAt.value = {};`,
  'clear all PR detail freshness metadata',
);

// 4. Clear one detail freshness entry when one PR detail is invalidated.
replaceOnceUnlessContains(
  file,
  `    const nextCache = { ...pullRequestDetailCache.value };
    delete nextCache[cacheKey];
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailCacheOrder.value = pullRequestDetailCacheOrder.value.filter(
      (key) => key !== cacheKey,
    );
    pendingPullRequestDetailRequests.delete(cacheKey);`,
  `    const nextCache = { ...pullRequestDetailCache.value };
    const nextFetchedAt = { ...pullRequestDetailFetchedAt.value };
    delete nextCache[cacheKey];
    delete nextFetchedAt[cacheKey];
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;
    pullRequestDetailCacheOrder.value = pullRequestDetailCacheOrder.value.filter(
      (key) => key !== cacheKey,
    );
    pendingPullRequestDetailRequests.delete(cacheKey);`,
  'delete nextFetchedAt[cacheKey];',
  'clear single PR detail freshness metadata',
);

// 5. Apply the revalidation budget to cached detail hits.
// Cached data still renders instantly. Only active detail views silently revalidate,
// and only when the detail was not refreshed recently.
replaceOnceUnlessContains(
  file,
  `    const pending = pendingPullRequestDetailRequests.get(cacheKey);
    const cached = pullRequestDetailCache.value[cacheKey];
    if (cached && !force) {
      rememberPullRequestDetail(cacheKey, cached);
      if (updateActive) {
        pullRequestDetail.value = cached;
        if (!pending) {
          void loadPullRequestDetail(number, {
            force: true,
            updateActive: true,
            visibleLoading: false,
          }).catch(() => undefined);
        }
      }
      return cached;
    }`,
  `    const pending = pendingPullRequestDetailRequests.get(cacheKey);
    const cached = pullRequestDetailCache.value[cacheKey];
    const fetchedAt = pullRequestDetailFetchedAt.value[cacheKey] ?? 0;
    const shouldRevalidate =
      Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;
    if (cached && !force) {
      rememberPullRequestDetail(cacheKey, cached);
      if (updateActive) {
        pullRequestDetail.value = cached;
        if (!pending && shouldRevalidate) {
          void loadPullRequestDetail(number, {
            force: true,
            updateActive: true,
            visibleLoading: false,
          }).catch(() => undefined);
        }
      }
      return cached;
    }`,
  'const shouldRevalidate =',
  'apply PR detail SWR revalidation budget',
);

// 6. Store successful detail fetch timestamp.
// Important: this is only done after a real command result, not on LRU touch.
replaceOnceUnlessContains(
  file,
  `      .then((payload) => {
        rememberPullRequestDetail(cacheKey, payload);
        if (updateActive && requestId === pullRequestDetailRequestId) {`,
  `      .then((payload) => {
        rememberPullRequestDetail(cacheKey, payload);
        pullRequestDetailFetchedAt.value = {
          ...pullRequestDetailFetchedAt.value,
          [cacheKey]: Date.now(),
        };
        if (updateActive && requestId === pullRequestDetailRequestId) {`,
  'pullRequestDetailFetchedAt.value = {',
  'store PR detail successful fetch timestamp',
);

console.log('done');