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

// 1. Add force option for PR detail loads.
// Used only by the silent revalidation path; normal callers still use cache-first behavior.
replaceExact(
  'src/store/git.ts',
  `type TLoadPullRequestDetailOptions = {
  updateActive?: boolean;
  visibleLoading?: boolean;
};`,
  `type TLoadPullRequestDetailOptions = {
  force?: boolean;
  updateActive?: boolean;
  visibleLoading?: boolean;
};`,
);

// 2. Change PR detail cache hit into SWR:
// - return cached detail immediately;
// - if this is the active detail view, silently revalidate in background;
// - keep stale data if background refresh fails;
// - do not force-refresh background preloads.
replaceExact(
  'src/store/git.ts',
  `    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);
    const cached = pullRequestDetailCache.value[cacheKey];
    if (cached) {
      rememberPullRequestDetail(cacheKey, cached);
      if (updateActive) pullRequestDetail.value = cached;
      return cached;
    }

    const pending = pendingPullRequestDetailRequests.get(cacheKey);`,
  `    const force = options?.force ?? false;
    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);
    const pending = pendingPullRequestDetailRequests.get(cacheKey);
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
);

console.log('done');