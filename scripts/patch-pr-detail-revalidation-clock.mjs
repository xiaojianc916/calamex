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

const alreadyApplied =
  text.includes('const touchPullRequestDetailCache = (cacheKey: string): void =>') &&
  text.includes('pullRequestDetailFetchedAt.value = nextFetchedAt;') &&
  text.includes('touchPullRequestDetailCache(cacheKey);');

if (alreadyApplied) {
  console.log(`${file}: PR detail revalidation clock fix already applied`);
  process.exit(0);
}

const startMarker = `  const rememberPullRequestDetail = (
    cacheKey: string,
    payload: IGitPullRequestDetailPayload,
  ): void => {`;

const endMarker = `

  const resetPullRequests = (): void => {`;

const start = text.indexOf(startMarker);
const end = text.indexOf(endMarker, start);

if (start === -1 || end === -1) {
  throw new Error(
    [
      `${file}: rememberPullRequestDetail block not found`,
      'Expected start marker:',
      startMarker,
      'Expected end marker:',
      endMarker,
    ].join('\n'),
  );
}

const replacement = `  const touchPullRequestDetailCache = (cacheKey: string): void => {
    if (!pullRequestDetailCache.value[cacheKey]) return;
    pullRequestDetailCacheOrder.value = [
      cacheKey,
      ...pullRequestDetailCacheOrder.value.filter((key) => key !== cacheKey),
    ];
  };

  const rememberPullRequestDetail = (
    cacheKey: string,
    payload: IGitPullRequestDetailPayload,
  ): void => {
    const fetchedAt = Date.now();
    const nextCache = {
      ...pullRequestDetailCache.value,
      [cacheKey]: payload,
    };
    const nextFetchedAt = {
      ...pullRequestDetailFetchedAt.value,
      [cacheKey]: fetchedAt,
    };
    const nextOrder = [
      cacheKey,
      ...pullRequestDetailCacheOrder.value.filter((key) => key !== cacheKey),
    ];
    while (nextOrder.length > PULL_REQUEST_DETAIL_CACHE_LIMIT) {
      const evicted = nextOrder.pop();
      if (evicted) {
        delete nextCache[evicted];
        delete nextFetchedAt[evicted];
      }
    }
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;
    pullRequestDetailCacheOrder.value = nextOrder;
  };`;

text = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
console.log(`patched ${file}: fixed PR detail fetchedAt lifecycle`);

const staleTouch = `      rememberPullRequestDetail(cacheKey, cached);`;
const properTouch = `      touchPullRequestDetailCache(cacheKey);`;

const touchCount = text.split(staleTouch).length - 1;

if (touchCount === 1) {
  text = text.replace(staleTouch, properTouch);
  console.log(`patched ${file}: cache hits now only update PR detail LRU order`);
} else if (text.includes(properTouch)) {
  console.log(`skipped ${file}: cache-hit LRU touch already applied`);
} else {
  throw new Error(
    `${file}: expected exactly one cached rememberPullRequestDetail call, found ${touchCount}`,
  );
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');