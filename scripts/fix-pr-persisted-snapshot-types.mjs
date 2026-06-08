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

const replaceAllExact = (description, oldText, newText) => {
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

  text = text.split(oldText).join(newText);
  console.log(`patched ${file}: ${description} (${count})`);
  return true;
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

// 1. 修复成功拉取 PR list 后的持久化调用：补 fetchedAt。
replaceAllExact(
  'pass fetchedAt to fetched PR list snapshot persistence',
  `writePersistedPullRequestList(cacheKey, nextPayload);`,
  `writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);`,
);

// 2. 修复 mutation 更新 PR list 后的持久化调用：补 now。
replaceAllExact(
  'pass now to mutation PR list snapshot persistence',
  `writePersistedPullRequestList(cacheKey, nextCache[cacheKey]);`,
  `writePersistedPullRequestList(cacheKey, nextCache[cacheKey], now);`,
);

// 3. 如果 detail 持久化 helper 已声明但没被调用，则补上调用。
// 注意：这里沿用你本地 3 参数 helper 版本，传 fetchedAt。
if (
  text.includes('const writePersistedPullRequestDetail =') &&
  !text.includes('writePersistedPullRequestDetail(cacheKey, payload, fetchedAt);')
) {
  replaceExact(
    'persist PR detail snapshots from rememberPullRequestDetail',
    `    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;
    pullRequestDetailCacheOrder.value = nextOrder;
  };`,
    `    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;
    pullRequestDetailCacheOrder.value = nextOrder;
    writePersistedPullRequestDetail(cacheKey, payload, fetchedAt);
  };`,
  );
} else {
  console.log(`skipped ${file}: PR detail snapshot persistence call already applied or helper absent`);
}

// 4. 如果 removePersistedPullRequestCache 已声明但还没被调用，则在 detail LRU 淘汰时使用。
// 这样既修复 noUnusedLocals，也保证持久化快照和内存 LRU 一起淘汰。
if (
  text.includes('const removePersistedPullRequestCache =') &&
  !text.includes(`removePersistedPullRequestCache('detail', evicted);`)
) {
  replaceExact(
    'remove persisted PR detail snapshot on LRU eviction',
    `      if (evicted) {
        delete nextCache[evicted];
        delete nextFetchedAt[evicted];
      }`,
    `      if (evicted) {
        delete nextCache[evicted];
        delete nextFetchedAt[evicted];
        removePersistedPullRequestCache('detail', evicted);
      }`,
  );
} else {
  console.log(`skipped ${file}: persisted PR detail LRU cleanup already applied or helper absent`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');