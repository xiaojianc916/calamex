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

const insertBefore = (description, anchor, insertion, alreadyNeedle) => {
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

  text = text.replace(anchor, `${insertion}${anchor}`);
  console.log(`patched ${file}: ${description}`);
  return true;
};

const replaceFunction = (description, functionStart, functionEnd, transform) => {
  const start = text.indexOf(functionStart);
  if (start === -1) {
    throw new Error(`${file}: ${description} function start not found`);
  }

  const end = text.indexOf(functionEnd, start);
  if (end === -1) {
    throw new Error(`${file}: ${description} function end not found`);
  }

  const before = text.slice(0, start);
  const body = text.slice(start, end);
  const after = text.slice(end);

  const nextBody = transform(body);
  if (nextBody === body) {
    console.log(`skipped ${file}: ${description} already applied`);
    return false;
  }

  text = `${before}${nextBody}${after}`;
  console.log(`patched ${file}: ${description}`);
  return true;
};

const replaceInBodyExact = (description, body, oldText, newText) => {
  if (body.includes(newText.trim())) {
    return body;
  }

  const count = body.split(oldText).length - 1;
  if (count === 0) {
    throw new Error(
      [
        `${file}: ${description} not found in function body`,
        'Expected snippet:',
        oldText,
      ].join('\n'),
    );
  }

  if (count !== 1) {
    throw new Error(`${file}: ${description} expected 1 occurrence in function body, found ${count}`);
  }

  return body.replace(oldText, newText);
};

const insertAfterFirstRegex = (description, body, regex, insertion, alreadyNeedle) => {
  if (body.includes(alreadyNeedle)) {
    return body;
  }

  const match = body.match(regex);
  if (!match || match.index === undefined) {
    throw new Error(`${file}: ${description} regex target not found`);
  }

  const insertAt = match.index + match[0].length;
  return `${body.slice(0, insertAt)}${insertion}${body.slice(insertAt)}`;
};

const insertCatchBeforeRequestFinally = (description, body) => {
  if (body.includes('markPullRequestDetailRevalidateFailed(cacheKey);')) {
    return body;
  }

  const requestAnchor = `    const request = tauriService
      .getGitPullRequestDetail({`;

  const requestStart = body.indexOf(requestAnchor);
  if (requestStart === -1) {
    throw new Error(`${file}: ${description} request anchor not found`);
  }

  const finallyNeedle = `\n      .finally(() => {`;
  const finallyIndex = body.indexOf(finallyNeedle, requestStart);
  if (finallyIndex === -1) {
    throw new Error(`${file}: ${description} final request .finally not found`);
  }

  const catchBlock = `
      .catch((error) => {
        if (cached) {
          markPullRequestDetailRevalidateFailed(cacheKey);
          return cached;
        }
        throw error;
      })`;

  return `${body.slice(0, finallyIndex)}${catchBlock}${body.slice(finallyIndex)}`;
};

// 1. Constant.
insertAfter(
  'add PR revalidate failure retry interval',
  `const PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS = 30_000;
`,
  `const PULL_REQUEST_REVALIDATE_FAILURE_RETRY_INTERVAL_MS = 60_000;
`,
  `const PULL_REQUEST_REVALIDATE_FAILURE_RETRY_INTERVAL_MS =`,
);

// 2. Top-level cooldown helper.
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

// 3. Failure timestamp refs.
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

// 4. Clear list failure metadata on list invalidation.
if (!text.includes('pullRequestListRevalidateFailedAt.value = {};')) {
  replaceExact(
    'clear PR list failure metadata on invalidation',
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

// 5. Clear detail failure metadata on full / single detail invalidation.
if (!text.includes('pullRequestDetailRevalidateFailedAt.value = {};')) {
  replaceExact(
    'clear PR detail failure metadata on full invalidation',
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
  console.log(`skipped ${file}: PR detail full failure invalidation already applied`);
}

if (!text.includes('const nextFailedAt = { ...pullRequestDetailRevalidateFailedAt.value };')) {
  replaceExact(
    'clear PR detail failure metadata on single invalidation',
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
  console.log(`skipped ${file}: PR detail single failure invalidation already applied`);
}

// 6. Marker helpers inside store.
insertBefore(
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

// 7. loadPullRequests: cooldown, clear on success, mark on stale fallback.
replaceFunction(
  'apply PR list revalidate failure budget',
  `  const loadPullRequests = async (`,
  `\n\n  const loadPullRequestDetail = async (`,
  (body) => {
    let next = body;

    if (
      !next.includes('pullRequestListRevalidateFailedAt.value[cacheKey]') ||
      !next.includes('(isFresh || isRevalidateFailureCoolingDown)')
    ) {
      const oldFreshBlock = `    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
    const isFresh = Date.now() - fetchedAt < PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS;
    if (cached && !options?.force && isFresh) {
      if (shouldPreloadDetails) {
        preloadTopPullRequestDetails(cached);
      }
      return cached;
    }`;

      const newFreshBlock = `    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
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

      next = replaceInBodyExact(
        'apply PR list cooldown block',
        next,
        oldFreshBlock,
        newFreshBlock,
      );
    }

    next = insertAfterFirstRegex(
      'clear PR list failure marker after success',
      next,
      /writePersistedPullRequestList\(cacheKey,\s*(?:nextPayload|payload),\s*fetchedAt\);/u,
      `\n        clearPullRequestListRevalidateFailure(cacheKey);`,
      `clearPullRequestListRevalidateFailure(cacheKey);`,
    );

    if (!next.includes('markPullRequestListRevalidateFailed(cacheKey);')) {
      const oldCatch = `      .catch((error) => {
        if (cached) return cached;
        throw error;
      })`;

      const newCatch = `      .catch((error) => {
        if (cached) {
          markPullRequestListRevalidateFailed(cacheKey);
          return cached;
        }
        throw error;
      })`;

      next = replaceInBodyExact(
        'mark PR list stale fallback failure',
        next,
        oldCatch,
        newCatch,
      );
    }

    return next;
  },
);

// 8. loadPullRequestDetail: cooldown, clear on success, stale fallback catch.
replaceFunction(
  'apply PR detail revalidate failure budget',
  `  const loadPullRequestDetail = async (`,
  `\n\n  const ensurePullRequestsLoaded = async (`,
  (body) => {
    let next = body;

    if (!next.includes('pullRequestDetailRevalidateFailedAt.value[cacheKey]')) {
      next = replaceInBodyExact(
        'compute PR detail cooldown',
        next,
        `    const shouldRevalidate = Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;`,
        `    const shouldRevalidate = Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;
    const isRevalidateFailureCoolingDown = isPullRequestRevalidateFailureCoolingDown(
      pullRequestDetailRevalidateFailedAt.value[cacheKey],
    );`,
      );
    }

    if (!next.includes('if (!pending && shouldRevalidate && !isRevalidateFailureCoolingDown) {')) {
      next = replaceInBodyExact(
        'skip PR detail revalidate during cooldown',
        next,
        `      if (!pending && shouldRevalidate) {`,
        `      if (!pending && shouldRevalidate && !isRevalidateFailureCoolingDown) {`,
      );
    }

    if (!next.includes('clearPullRequestDetailRevalidateFailure(cacheKey);')) {
      next = replaceInBodyExact(
        'clear PR detail failure marker after success',
        next,
        `        rememberPullRequestDetail(cacheKey, payload);`,
        `        rememberPullRequestDetail(cacheKey, payload);
        clearPullRequestDetailRevalidateFailure(cacheKey);`,
      );
    }

    next = insertCatchBeforeRequestFinally(
      'mark PR detail stale fallback failure',
      next,
    );

    return next;
  },
);

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');