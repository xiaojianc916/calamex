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

const assertHas = (needle, message) => {
  if (!text.includes(needle)) {
    throw new Error(`${file}: ${message}`);
  }
};

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

assertHas(
  'const markPullRequestListRevalidateFailed =',
  'failure marker helpers missing; do not run this repair before the base script',
);

assertHas(
  'const markPullRequestDetailRevalidateFailed =',
  'detail failure marker helper missing; do not run this repair before the base script',
);

// 1. Ensure list cached stale path respects failure cooldown.
// 原脚本这里可能误判 skipped，所以 repair 再精确检查 loadPullRequests 内部。
replaceFunction(
  'ensure PR list failure cooldown condition',
  `  const loadPullRequests = async (`,
  `\n\n  const loadPullRequestDetail = async (`,
  (body) => {
    if (
      body.includes('pullRequestListRevalidateFailedAt.value[cacheKey]') &&
      body.includes('(isFresh || isRevalidateFailureCoolingDown)')
    ) {
      return body;
    }

    const oldBlock = `    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
    const isFresh = Date.now() - fetchedAt < PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS;
    if (cached && !options?.force && isFresh) {
      if (shouldPreloadDetails) {
        preloadTopPullRequestDetails(cached);
      }
      return cached;
    }`;

    const newBlock = `    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
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

    return replaceInBodyExact(
      'apply PR list failure cooldown',
      body,
      oldBlock,
      newBlock,
    );
  },
);

// 2. Clear list failure marker on successful list fetch.
// 注意：只在 loadPullRequests 内插入，避免命中 mutation 的持久化写入。
replaceFunction(
  'clear PR list failure marker on successful fetch',
  `  const loadPullRequests = async (`,
  `\n\n  const loadPullRequestDetail = async (`,
  (body) =>
    insertAfterFirstRegex(
      'clear PR list failure marker after persisted fetch snapshot',
      body,
      /writePersistedPullRequestList\(cacheKey,\s*(?:nextPayload|payload),\s*fetchedAt\);/u,
      `\n        clearPullRequestListRevalidateFailure(cacheKey);`,
      `clearPullRequestListRevalidateFailure(cacheKey);`,
    ),
);

// 3. Mark list failure when stale list cache absorbs an error.
replaceFunction(
  'mark PR list revalidate failure on stale fallback',
  `  const loadPullRequests = async (`,
  `\n\n  const loadPullRequestDetail = async (`,
  (body) => {
    if (body.includes('markPullRequestListRevalidateFailed(cacheKey);')) {
      return body;
    }

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

    return replaceInBodyExact(
      'mark PR list failure fallback',
      body,
      oldCatch,
      newCatch,
    );
  },
);

// 4. Ensure detail cached stale path has failure cooldown computation.
replaceFunction(
  'compute PR detail failure cooldown',
  `  const loadPullRequestDetail = async (`,
  `\n\n  const ensurePullRequestsLoaded = async (`,
  (body) => {
    if (body.includes('pullRequestDetailRevalidateFailedAt.value[cacheKey]')) {
      return body;
    }

    const oldLine = `    const shouldRevalidate = Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;`;

    const newLine = `    const shouldRevalidate = Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;
    const isRevalidateFailureCoolingDown = isPullRequestRevalidateFailureCoolingDown(
      pullRequestDetailRevalidateFailedAt.value[cacheKey],
    );`;

    return replaceInBodyExact(
      'compute detail failure cooldown',
      body,
      oldLine,
      newLine,
    );
  },
);

// 5. Skip detail background revalidate during failure cooldown.
replaceFunction(
  'skip PR detail revalidate during failure cooldown',
  `  const loadPullRequestDetail = async (`,
  `\n\n  const ensurePullRequestsLoaded = async (`,
  (body) => {
    if (body.includes('if (!pending && shouldRevalidate && !isRevalidateFailureCoolingDown) {')) {
      return body;
    }

    return replaceInBodyExact(
      'guard detail revalidate with failure cooldown',
      body,
      `      if (!pending && shouldRevalidate) {`,
      `      if (!pending && shouldRevalidate && !isRevalidateFailureCoolingDown) {`,
    );
  },
);

// 6. Clear detail failure marker on successful detail fetch.
replaceFunction(
  'clear PR detail failure marker on successful fetch',
  `  const loadPullRequestDetail = async (`,
  `\n\n  const ensurePullRequestsLoaded = async (`,
  (body) => {
    if (body.includes('clearPullRequestDetailRevalidateFailure(cacheKey);')) {
      return body;
    }

    return replaceInBodyExact(
      'clear detail failure marker after rememberPullRequestDetail',
      body,
      `        rememberPullRequestDetail(cacheKey, payload);
        if (updateActive && requestId === pullRequestDetailRequestId) {`,
      `        rememberPullRequestDetail(cacheKey, payload);
        clearPullRequestDetailRevalidateFailure(cacheKey);
        if (updateActive && requestId === pullRequestDetailRequestId) {`,
    );
  },
);

// 7. Return stale detail and mark failure when detail revalidate fails.
replaceFunction(
  'return stale PR detail on revalidate failure',
  `  const loadPullRequestDetail = async (`,
  `\n\n  const ensurePullRequestsLoaded = async (`,
  (body) => {
    if (body.includes('markPullRequestDetailRevalidateFailed(cacheKey);')) {
      return body;
    }

    const oldThenFinally = `      .then((payload) => {
        rememberPullRequestDetail(cacheKey, payload);
        clearPullRequestDetailRevalidateFailure(cacheKey);
        if (updateActive && requestId === pullRequestDetailRequestId) {
          pullRequestDetail.value = payload;
        }
        return payload;
      })
      .finally(() => {`;

    const newThenCatchFinally = `      .then((payload) => {
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
      .finally(() => {`;

    return replaceInBodyExact(
      'add detail stale fallback catch',
      body,
      oldThenFinally,
      newThenCatchFinally,
    );
  },
);

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');