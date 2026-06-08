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

  if (!after.includes(oldText)) {
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

const replaceInsideFunction = (description, functionStart, oldText, newText) => {
  const start = text.indexOf(functionStart);
  if (start === -1) {
    throw new Error(`${file}: ${description} function start not found`);
  }

  const nextFunction = text.indexOf('\n  const ', start + functionStart.length);
  if (nextFunction === -1) {
    throw new Error(`${file}: ${description} next function boundary not found`);
  }

  const before = text.slice(0, start);
  const body = text.slice(start, nextFunction);
  const after = text.slice(nextFunction);

  if (body.includes(newText.trim())) {
    console.log(`skipped ${file}: ${description} already applied`);
    return false;
  }

  const count = body.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: ${description} expected 1 occurrence in function, found ${count}`);
  }

  text = `${before}${body.replace(oldText, newText)}${after}`;
  console.log(`patched ${file}: ${description}`);
  return true;
};

// 0. Ensure the epoch variable exists. Your previous run probably already added it.
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

// 1. Bump epoch only inside resetPullRequests.
// The failed script matched both reset() and resetPullRequests(); this scopes it correctly.
replaceInsideFunction(
  'bump PR cache epoch inside resetPullRequests',
  `  const resetPullRequests = (): void => {`,
  `    pullRequestDetailPreloadEpoch += 1;
    clearPullRequestPreloadTimer();`,
  `    pullRequestDetailPreloadEpoch += 1;
    pullRequestCacheEpoch += 1;
    clearPullRequestPreloadTimer();`,
);

// 2. Capture epoch for list requests.
const scopedListCacheKeyBlock = `    const cacheKey = createPullRequestCacheKey(
      repositoryRootPath,
      selectedState,
      pullRequestSupport.value.repositoryUrl,
    );
    hydratePullRequestListCache(cacheKey);`;

const unscopedListCacheKeyBlock = `    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    hydratePullRequestListCache(cacheKey);`;

if (!text.includes('const cacheEpochAtRequest = pullRequestCacheEpoch;')) {
  if (text.includes(scopedListCacheKeyBlock)) {
    replaceExact(
      'capture PR cache epoch for list requests',
      scopedListCacheKeyBlock,
      `${scopedListCacheKeyBlock}
    const cacheEpochAtRequest = pullRequestCacheEpoch;`,
    );
  } else if (text.includes(unscopedListCacheKeyBlock)) {
    replaceExact(
      'capture PR cache epoch for list requests',
      unscopedListCacheKeyBlock,
      `${unscopedListCacheKeyBlock}
    const cacheEpochAtRequest = pullRequestCacheEpoch;`,
    );
  } else {
    throw new Error(`${file}: PR list cache key block not found`);
  }
} else {
  console.log(`skipped ${file}: PR list cache epoch capture already applied`);
}

// 3. Guard list success cache writes.
const listRequestAnchor = `    const request = tauriService
      .listGitPullRequests({`;

const oldListThenStructural = `      .then((payload) => {
        const previousCachedPullRequests = pullRequestListCache.value[cacheKey];`;

const newListThenStructural = `      .then((payload) => {
        if (cacheEpochAtRequest !== pullRequestCacheEpoch) {
          return updateActive && requestId === pullRequestsRequestId ? pullRequests.value : payload;
        }

        const previousCachedPullRequests = pullRequestListCache.value[cacheKey];`;

const oldListThenPlain = `      .then((payload) => {
        pullRequestListCache.value = {`;

const newListThenPlain = `      .then((payload) => {
        if (cacheEpochAtRequest !== pullRequestCacheEpoch) {
          return updateActive && requestId === pullRequestsRequestId ? pullRequests.value : payload;
        }

        pullRequestListCache.value = {`;

if (!text.includes('if (cacheEpochAtRequest !== pullRequestCacheEpoch)')) {
  const afterListAnchor = text.slice(text.indexOf(listRequestAnchor));
  if (afterListAnchor.includes(oldListThenStructural)) {
    replaceFirstAfter(
      'guard stale PR list cache writes by epoch',
      listRequestAnchor,
      oldListThenStructural,
      newListThenStructural,
    );
  } else if (afterListAnchor.includes(oldListThenPlain)) {
    replaceFirstAfter(
      'guard stale PR list cache writes by epoch',
      listRequestAnchor,
      oldListThenPlain,
      newListThenPlain,
    );
  } else {
    throw new Error(`${file}: PR list .then block not found`);
  }
} else {
  console.log(`skipped ${file}: PR list cache epoch guard already applied`);
}

// 4. Capture epoch for detail requests.
const scopedDetailCacheKeyBlock = `    const cacheKey = createPullRequestDetailCacheKey(
      repositoryRootPath,
      number,
      pullRequestSupport.value.repositoryUrl,
    );
    hydratePullRequestDetailCache(cacheKey);`;

const unscopedDetailCacheKeyBlock = `    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);
    hydratePullRequestDetailCache(cacheKey);`;

if (!text.includes('const detailCacheEpochAtRequest = pullRequestCacheEpoch;')) {
  if (text.includes(scopedDetailCacheKeyBlock)) {
    replaceExact(
      'capture PR cache epoch for detail requests',
      scopedDetailCacheKeyBlock,
      `${scopedDetailCacheKeyBlock}
    const detailCacheEpochAtRequest = pullRequestCacheEpoch;`,
    );
  } else if (text.includes(unscopedDetailCacheKeyBlock)) {
    replaceExact(
      'capture PR cache epoch for detail requests',
      unscopedDetailCacheKeyBlock,
      `${unscopedDetailCacheKeyBlock}
    const detailCacheEpochAtRequest = pullRequestCacheEpoch;`,
    );
  } else {
    throw new Error(`${file}: PR detail cache key block not found`);
  }
} else {
  console.log(`skipped ${file}: PR detail cache epoch capture already applied`);
}

// 5. Guard detail success cache writes.
const detailRequestAnchor = `    const request = tauriService
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
    detailRequestAnchor,
    oldDetailThen,
    newDetailThen,
  );
} else {
  console.log(`skipped ${file}: PR detail cache epoch guard already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');