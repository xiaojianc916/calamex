#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const file = 'src/store/git.ts';
const filePath = resolve(root, file);

const originalText = readFileSync(filePath, 'utf8');
const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
let text = originalText.replace(/\r\n/g, '\n');

const replaceExact = (description, oldText, newText) => {
  const count = text.split(oldText).length - 1;

  if (count === 0) {
    if (text.includes(newText.trim())) {
      console.log(`skipped ${file}: ${description} already applied`);
      return false;
    }

    throw new Error(
      [
        `${file}: ${description} not found`,
        'Expected snippet:',
        oldText,
      ].join('\n'),
    );
  }

  if (count !== 1) {
    throw new Error(`${file}: ${description} expected 1 occurrence, found ${count}`);
  }

  text = text.replace(oldText, newText);
  console.log(`patched ${file}: ${description}`);
  return true;
};

const insertAfter = (description, anchor, insertion, alreadyNeedle) => {
  if (text.includes(alreadyNeedle)) {
    console.log(`skipped ${file}: ${description} already applied`);
    return false;
  }

  if (!text.includes(anchor)) {
    throw new Error(
      [
        `${file}: ${description} anchor not found`,
        'Expected anchor:',
        anchor,
      ].join('\n'),
    );
  }

  text = text.replace(anchor, `${anchor}${insertion}`);
  console.log(`patched ${file}: ${description}`);
  return true;
};

// 1. Add failure backoff constant.
insertAfter(
  'add PR revalidate failure retry interval',
  `const PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS = 30_000;
`,
  `const PULL_REQUEST_REVALIDATE_FAILURE_RETRY_INTERVAL_MS = 60_000;
`,
  `const PULL_REQUEST_REVALIDATE_FAILURE_RETRY_INTERVAL_MS =`,
);

// 2. Add cooling-down helper near structural equality helpers.
insertAfter(
  'add PR revalidate failure cooldown helper',
  `const arePullRequestSummaryListsEqual = (
  left: IGitPullRequestSummaryPayload[] | undefined,
  right: IGitPullRequestSummaryPayload[],
): left is IGitPullRequestSummaryPayload[] => {
  if (!left || left.length !== right.length) return false;
  return left.every((entry, index) => arePullRequestSummariesEqual(entry, right[index]));
};

`,
  `const isPullRequestRevalidateFailureCoolingDown = (failedAt: number | undefined): boolean =>
  Boolean(
    failedAt &&
      Date.now() - failedAt < PULL_REQUEST_REVALIDATE_FAILURE_RETRY_INTERVAL_MS,
  );

`,
  `const isPullRequestRevalidateFailureCoolingDown =`,
);

// 3. Track failed revalidate timestamps.
insertAfter(
  'track PR revalidate failure timestamps',
  `  const pullRequestListFetchedAt = ref<Record<string, number>>({});
  const pullRequestDetailCache = ref<Record<string, IGitPullRequestDetailPayload>>({});
  const pullRequestDetailFetchedAt = ref<Record<string, number>>({});
`,
  `  const pullRequestListRevalidateFailedAt = ref<Record<string, number>>({});
  const pullRequestDetailRevalidateFailedAt = ref<Record<string, number>>({});
`,
  `pullRequestListRevalidateFailedAt`,
);

// 4. Clear list failure metadata on invalidation.
if (!text.includes('pullRequestListRevalidateFailedAt.value = {};')) {
  replaceExact(
    'clear PR list revalidate failure metadata on list invalidation',
    `  const invalidatePullRequestListCache = (): void => {
    pullRequestListCache.value = {};
    pullRequestListFetchedAt.value = {};
    pendingPullRequestListRequests.clear();
  };`,
    `  const invalidatePullRequestListCache = (): void => {
    pullRequestListCache.value = {};
    pullRequestListFetchedAt.value = {};
    pullRequestListRevalidateFailedAt.value = {};
    pendingPullRequestListRequests.clear();
  };`,
  );
} else {
  console.log(`skipped ${file}: PR list failure invalidation already applied`);
}

// 5. Clear detail failure metadata on invalidation.
if (!text.includes('pullRequestDetailRevalidateFailedAt.value = {};')) {
  replaceExact(
    'clear PR detail revalidate failure metadata on full detail invalidation',
    `      pullRequestDetailCache.value = {};
      pullRequestDetailFetchedAt.value = {};
      pullRequestDetailCacheOrder.value = [];
      pendingPullRequestDetailRequests.clear();`,
    `      pullRequestDetailCache.value = {};
      pullRequestDetailFetchedAt.value = {};
      pullRequestDetailRevalidateFailedAt.value = {};
      pullRequestDetailCacheOrder.value = [];
      pendingPullRequestDetailRequests.clear();`,
  );
} else {
  console.log(`skipped ${file}: PR detail failure full invalidation already applied`);
}

if (!text.includes('delete nextFailedAt[cacheKey];')) {
  replaceExact(
    'clear single PR detail revalidate failure metadata on detail invalidation',
    `    const nextCache = { ...pullRequestDetailCache.value };
    const nextFetchedAt = { ...pullRequestDetailFetchedAt.value };
    delete nextCache[cacheKey];
    delete nextFetchedAt[cacheKey];
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;`,
    `    const nextCache = { ...pullRequestDetailCache.value };
    const nextFetchedAt = { ...pullRequestDetailFetchedAt.value };
    const nextFailedAt = { ...pullRequestDetailRevalidateFailedAt.value };
    delete nextCache[cacheKey];
    delete nextFetchedAt[cacheKey];
    delete nextFailedAt[cacheKey];
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;
    pullRequestDetailRevalidateFailedAt.value = nextFailedAt;`,
  );
} else {
  console.log(`skipped ${file}: PR detail failure single invalidation already applied`);
}

// 6. Add small helpers inside store for marking/clearing failures.
insertAfter(
  'add PR revalidate failure marker helpers',
  `  const resetPullRequests = (): void => {`,
  `  const markPullRequestListRevalidateFailed = (cacheKey: string): void => {
    pullRequestListRevalidateFailedAt.value = {
      ...pullRequestListRevalidateFailedAt.value,
      [cacheKey]: Date.now(),
    };
  };

  const clearPullRequestListRevalidateFailure = (cacheKey: string): void => {
    if (!pullRequestListRevalidateFailedAt.value[cacheKey]) return;
    const nextFailedAt = { ...pullRequestListRevalidateFailedAt.value };
    delete nextFailedAt[cacheKey];
    pullRequestListRevalidateFailedAt.value = nextFailedAt;
  };

  const markPullRequestDetailRevalidateFailed = (cacheKey: string): void => {
    pullRequestDetailRevalidateFailedAt.value = {
      ...pullRequestDetailRevalidateFailedAt.value,
      [cacheKey]: Date.now(),
    };
  };

  const clearPullRequestDetailRevalidateFailure = (cacheKey: string): void => {
    if (!pullRequestDetailRevalidateFailedAt.value[cacheKey]) return;
    const nextFailedAt = { ...pullRequestDetailRevalidateFailedAt.value };
    delete nextFailedAt[cacheKey];
    pullRequestDetailRevalidateFailedAt.value = nextFailedAt;
  };

`,
  `const markPullRequestListRevalidateFailed =`,
);

// 7. Skip automatic list revalidate during failure cooldown.
const listFreshBlock = `    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
    const isFresh = Date.now() - fetchedAt < PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS;
    if (cached && !options?.force && isFresh) {
      if (shouldPreloadDetails) {
        preloadTopPullRequestDetails(cached);
      }
      return cached;
    }`;

const listFreshBlockWithFailureBudget = `    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
    const isFresh = Date.now() - fetchedAt < PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS;
    const isRevalidateFailureCoolingDown = isPullRequestRevalidateFailureCoolingDown(
      pullRequestListRevalidateFailedAt.value[cacheKey],
    );

    if (cached && !options?.force && (isFresh || isRevalidateFailureCoolingDown)) {
      if (shouldPreloadDetails) {
        preloadTopPullRequestDetails(cached);
      }
      return cached;
    }`;

if (!text.includes('pullRequestListRevalidateFailedAt.value[cacheKey]')) {
  replaceExact(
    'skip stale PR list revalidate during failure cooldown',
    listFreshBlock,
    listFreshBlockWithFailureBudget,
  );
} else {
  console.log(`skipped ${file}: PR list failure cooldown already applied`);
}

// 8. Clear list failure marker on success.
if (!text.includes('clearPullRequestListRevalidateFailure(cacheKey);')) {
  const listSuccessAnchor = text.includes('writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);')
    ? `        writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);`
    : `        writePersistedPullRequestList(cacheKey, nextPayload);`;

  replaceExact(
    'clear PR list revalidate failure marker on success',
    listSuccessAnchor,
    `${listSuccessAnchor}
        clearPullRequestListRevalidateFailure(cacheKey);`,
  );
} else {
  console.log(`skipped ${file}: PR list failure marker success cleanup already applied`);
}

// 9. Mark list failure when stale cache absorbs an error.
if (!text.includes('markPullRequestListRevalidateFailed(cacheKey);')) {
  replaceExact(
    'mark PR list revalidate failure when returning stale cache',
    `      .catch((error) => {
        if (cached) return cached;
        throw error;
      })`,
    `      .catch((error) => {
        if (cached) {
          markPullRequestListRevalidateFailed(cacheKey);
          return cached;
        }
        throw error;
      })`,
  );
} else {
  console.log(`skipped ${file}: PR list failure marker already applied`);
}

// 10. Apply failure cooldown to detail cached hits.
const detailShouldRevalidateLine = `    const shouldRevalidate = Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;`;

const detailShouldRevalidateWithFailureBudget = `    const shouldRevalidate = Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;
    const isRevalidateFailureCoolingDown = isPullRequestRevalidateFailureCoolingDown(
      pullRequestDetailRevalidateFailedAt.value[cacheKey],
    );`;

if (!text.includes('pullRequestDetailRevalidateFailedAt.value[cacheKey]')) {
  replaceExact(
    'compute PR detail revalidate failure cooldown',
    detailShouldRevalidateLine,
    detailShouldRevalidateWithFailureBudget,
  );
} else {
  console.log(`skipped ${file}: PR detail failure cooldown computation already applied`);
}

replaceExact(
  'skip PR detail background revalidate during failure cooldown',
  `      if (!pending && shouldRevalidate) {`,
  `      if (!pending && shouldRevalidate && !isRevalidateFailureCoolingDown) {`,
);

// 11. Clear detail failure marker on success.
if (!text.includes('clearPullRequestDetailRevalidateFailure(cacheKey);')) {
  replaceExact(
    'clear PR detail revalidate failure marker on success',
    `        rememberPullRequestDetail(cacheKey, payload);
        if (updateActive && requestId === pullRequestDetailRequestId) {`,
    `        rememberPullRequestDetail(cacheKey, payload);
        clearPullRequestDetailRevalidateFailure(cacheKey);
        if (updateActive && requestId === pullRequestDetailRequestId) {`,
  );
} else {
  console.log(`skipped ${file}: PR detail failure marker success cleanup already applied`);
}

// 12. Return stale detail and mark failure when detail revalidate fails.
if (!text.includes('markPullRequestDetailRevalidateFailed(cacheKey);')) {
  replaceExact(
    'return stale PR detail on revalidate failure and mark failure',
    `      .then((payload) => {
        rememberPullRequestDetail(cacheKey, payload);
        clearPullRequestDetailRevalidateFailure(cacheKey);
        if (updateActive && requestId === pullRequestDetailRequestId) {
          pullRequestDetail.value = payload;
        }
        return payload;
      })
      .finally(() => {`,
    `      .then((payload) => {
        rememberPullRequestDetail(cacheKey, payload);
        clearPullRequestDetailRevalidateFailure(cacheKey);
        if (updateActive && requestId === pullRequestDetailRequestId) {
          pullRequestDetail.value = payload;
        }
        return payload;
      })
      .catch((error) => {
        if (cached) {
          markPullRequestDetailRevalidateFailed(cacheKey);
          return cached;
        }
        throw error;
      })
      .finally(() => {`,
  );
} else {
  console.log(`skipped ${file}: PR detail failure marker already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');