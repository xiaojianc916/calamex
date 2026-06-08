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

const replaceFirstAfter = (description, anchor, oldText, newText) => {
  const anchorIndex = text.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`${file}: ${description} anchor not found`);
  }

  const before = text.slice(0, anchorIndex);
  const after = text.slice(anchorIndex);
  const count = after.split(oldText).length - 1;

  if (count === 0) {
    if (after.includes(newText.trim())) {
      console.log(`skipped ${file}: ${description} already applied`);
      return false;
    }

    throw new Error(
      [
        `${file}: ${description} target not found after anchor`,
        'Anchor:',
        anchor,
        'Expected snippet:',
        oldText,
      ].join('\n'),
    );
  }

  text = `${before}${after.replace(oldText, newText)}`;
  console.log(`patched ${file}: ${description}`);
  return true;
};

// 1. Add a PR cache epoch.
// This is intentionally separate from requestId: requestId protects active UI,
// while cacheEpoch protects memory/persisted cache writes from stale background work.
if (!text.includes('let pullRequestCacheEpoch = 0;')) {
  replaceExact(
    'add PR cache epoch',
    `  let pullRequestDetailPreloadEpoch = 0;
  let pullRequestPreloadTimer: ReturnType<typeof setTimeout> | null = null;`,
    `  let pullRequestDetailPreloadEpoch = 0;
  let pullRequestCacheEpoch = 0;
  let pullRequestPreloadTimer: ReturnType<typeof setTimeout> | null = null;`,
  );
} else {
  console.log(`skipped ${file}: PR cache epoch already applied`);
}

// 2. Bump epoch whenever PR state/cache is reset.
if (!text.includes('pullRequestCacheEpoch += 1;')) {
  replaceExact(
    'bump PR cache epoch on reset',
    `    pullRequestDetailPreloadEpoch += 1;
    clearPullRequestPreloadTimer();`,
    `    pullRequestDetailPreloadEpoch += 1;
    pullRequestCacheEpoch += 1;
    clearPullRequestPreloadTimer();`,
  );
} else {
  console.log(`skipped ${file}: PR cache epoch reset bump already applied`);
}

// 3. Capture epoch for list requests.
const listCacheKeyScoped = `    const cacheKey = createPullRequestCacheKey(
      repositoryRootPath,
      selectedState,
      pullRequestSupport.value.repositoryUrl,
    );
    hydratePullRequestListCache(cacheKey);`;

const listCacheKeyUnscoped = `    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    hydratePullRequestListCache(cacheKey);`;

if (!text.includes('const cacheEpochAtRequest = pullRequestCacheEpoch;')) {
  if (text.includes(listCacheKeyScoped)) {
    replaceExact(
      'capture PR cache epoch for list requests',
      listCacheKeyScoped,
      `${listCacheKeyScoped}
    const cacheEpochAtRequest = pullRequestCacheEpoch;`,
    );
  } else if (text.includes(listCacheKeyUnscoped)) {
    replaceExact(
      'capture PR cache epoch for list requests',
      listCacheKeyUnscoped,
      `${listCacheKeyUnscoped}
    const cacheEpochAtRequest = pullRequestCacheEpoch;`,
    );
  } else {
    throw new Error(`${file}: PR list cache key block not found`);
  }
} else {
  console.log(`skipped ${file}: PR list cache epoch capture already applied`);
}

// 4. Guard list success cache writes.
// Works with both structural-reuse and non-structural local states.
const listThenAnchor = `    const request = tauriService
      .listGitPullRequests({`;

const oldListThen = `      .then((payload) => {
        const previousCachedPullRequests = pullRequestListCache.value[cacheKey];`;

const newListThen = `      .then((payload) => {
        if (cacheEpochAtRequest !== pullRequestCacheEpoch) {
          return updateActive && requestId === pullRequestsRequestId ? pullRequests.value : payload;
        }

        const previousCachedPullRequests = pullRequestListCache.value[cacheKey];`;

if (!text.includes('if (cacheEpochAtRequest !== pullRequestCacheEpoch)')) {
  replaceFirstAfter(
    'guard stale PR list cache writes by epoch',
    listThenAnchor,
    oldListThen,
    newListThen,
  );
} else {
  console.log(`skipped ${file}: PR list cache epoch guard already applied`);
}

// 5. Capture epoch for detail requests.
// If list request already inserted a const with the same name, detail needs a separate scoped const
// inside loadPullRequestDetail, so we insert after the detail cache key block.
const detailCacheKeyScoped = `    const cacheKey = createPullRequestDetailCacheKey(
      repositoryRootPath,
      number,
      pullRequestSupport.value.repositoryUrl,
    );
    hydratePullRequestDetailCache(cacheKey);`;

const detailCacheKeyUnscoped = `    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);
    hydratePullRequestDetailCache(cacheKey);`;

if (!text.includes('const detailCacheEpochAtRequest = pullRequestCacheEpoch;')) {
  if (text.includes(detailCacheKeyScoped)) {
    replaceExact(
      'capture PR cache epoch for detail requests',
      detailCacheKeyScoped,
      `${detailCacheKeyScoped}
    const detailCacheEpochAtRequest = pullRequestCacheEpoch;`,
    );
  } else if (text.includes(detailCacheKeyUnscoped)) {
    replaceExact(
      'capture PR cache epoch for detail requests',
      detailCacheKeyUnscoped,
      `${detailCacheKeyUnscoped}
    const detailCacheEpochAtRequest = pullRequestCacheEpoch;`,
    );
  } else {
    throw new Error(`${file}: PR detail cache key block not found`);
  }
} else {
  console.log(`skipped ${file}: PR detail cache epoch capture already applied`);
}

// 6. Guard detail success cache writes.
const detailThenAnchor = `    const request = tauriService
      .getGitPullRequestDetail({`;

const oldDetailThen = `      .then((payload) => {
        rememberPullRequestDetail(cacheKey, payload);`;

const newDetailThen = `      .then((payload) => {
        if (detailCacheEpochAtRequest !== pullRequestCacheEpoch) {
          return payload;
        }

        rememberPullRequestDetail(cacheKey, payload);`;

if (!text.includes('if (detailCacheEpochAtRequest !== pullRequestCacheEpoch)')) {
  replaceFirstAfter(
    'guard stale PR detail cache writes by epoch',
    detailThenAnchor,
    oldDetailThen,
    newDetailThen,
  );
} else {
  console.log(`skipped ${file}: PR detail cache epoch guard already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');