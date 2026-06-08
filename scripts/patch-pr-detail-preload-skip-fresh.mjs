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

const isRemoteScoped = text.includes('const createPullRequestRepositoryScope =');

const detailCacheKeyExpression = isRemoteScoped
  ? `createPullRequestDetailCacheKey(
      repositoryRootPath,
      pullRequestNumber,
      pullRequestSupport.value.repositoryUrl,
    )`
  : `createPullRequestDetailCacheKey(repositoryRootPath, pullRequestNumber)`;

if (!text.includes('const shouldPreloadPullRequestDetail = (')) {
  const insertionAnchor = `  const rememberPullRequestDetail = (`;

  if (!text.includes(insertionAnchor)) {
    throw new Error(`${file}: rememberPullRequestDetail anchor not found`);
  }

  const helper = `  const shouldPreloadPullRequestDetail = (
    repositoryRootPath: string,
    pullRequestNumber: number,
  ): boolean => {
    const cacheKey = ${detailCacheKeyExpression};

    hydratePullRequestDetailCache(cacheKey);

    if (pendingPullRequestDetailRequests.has(cacheKey)) {
      return false;
    }

    const cached = pullRequestDetailCache.value[cacheKey];
    if (!cached) {
      return true;
    }

    const fetchedAt = pullRequestDetailFetchedAt.value[cacheKey] ?? 0;
    return Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;
  };

`;

  text = text.replace(insertionAnchor, `${helper}${insertionAnchor}`);
  console.log(`patched ${file}: add PR detail preload freshness guard`);
} else {
  console.log(`skipped ${file}: PR detail preload freshness guard already applied`);
}

const oldCandidates = `    const candidates = entries.slice(0, PULL_REQUEST_DETAIL_PRELOAD_LIMIT);
    let nextIndex = 0;`;

const newCandidates = `    const repositoryRootPath = status.value.repositoryRootPath;
    if (!repositoryRootPath) return;

    const candidates = entries
      .slice(0, PULL_REQUEST_DETAIL_PRELOAD_LIMIT)
      .filter((pullRequest) =>
        shouldPreloadPullRequestDetail(repositoryRootPath, pullRequest.number),
      );
    let nextIndex = 0;`;

if (!text.includes('shouldPreloadPullRequestDetail(repositoryRootPath, pullRequest.number)')) {
  replaceExact(
    'skip fresh or pending PR detail entries before preloading',
    oldCandidates,
    newCandidates,
  );
} else {
  console.log(`skipped ${file}: PR detail preload candidate filtering already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');