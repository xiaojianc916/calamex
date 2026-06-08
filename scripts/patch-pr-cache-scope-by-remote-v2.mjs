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

const replaceIfPresent = (description, oldText, newText) => {
  if (text.includes(newText.trim())) {
    console.log(`skipped ${file}: ${description} already applied`);
    return false;
  }

  if (!text.includes(oldText)) {
    throw new Error(
      [
        `${file}: ${description} could not be located`,
        'Expected old snippet:',
        oldText,
      ].join('\n'),
    );
  }

  return replaceExact(description, oldText, newText);
};

// 1. Cache key helper: add remote repository scope.
if (!text.includes('const createPullRequestRepositoryScope =')) {
  const oldCacheKeyHelpers = `const createPullRequestCacheKey = (repositoryRootPath: string, state: string): string =>
  \`${'${normalizeFileSystemPath(repositoryRootPath)}|${state}'}\`;

const createPullRequestDetailCacheKey = (repositoryRootPath: string, number: number): string =>
  \`${'${normalizeFileSystemPath(repositoryRootPath)}|${number}'}\`;
`;

  const newCacheKeyHelpers = `const createPullRequestRepositoryScope = (repositoryUrl?: string | null): string => {
  const normalizedRepositoryUrl = repositoryUrl?.trim().toLowerCase();
  return normalizedRepositoryUrl || 'unknown';
};

const createPullRequestCacheKey = (
  repositoryRootPath: string,
  state: string,
  repositoryUrl?: string | null,
): string =>
  \`${'${normalizeFileSystemPath(repositoryRootPath)}|${createPullRequestRepositoryScope(repositoryUrl)}|${state}'}\`;

const createPullRequestDetailCacheKey = (
  repositoryRootPath: string,
  number: number,
  repositoryUrl?: string | null,
): string =>
  \`${'${normalizeFileSystemPath(repositoryRootPath)}|${createPullRequestRepositoryScope(repositoryUrl)}|${number}'}\`;
`;

  replaceExact(
    'scope PR cache key helpers by remote repository identity',
    oldCacheKeyHelpers,
    newCacheKeyHelpers,
  );
} else {
  console.log(`skipped ${file}: PR cache key helpers already scoped by remote`);
}

// 2. Detail invalidation must use remote scope.
replaceIfPresent(
  'scope PR detail invalidation cache key by remote',
  `    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, pullRequestNumber);`,
  `    const cacheKey = createPullRequestDetailCacheKey(
      repositoryRootPath,
      pullRequestNumber,
      pullRequestSupport.value.repositoryUrl,
    );`,
);

// 3. Mutation list cache keys must use remote scope.
replaceIfPresent(
  'scope active PR list mutation cache key by remote',
  `    cacheKeys.add(createPullRequestCacheKey(repositoryRootPath, pullRequestStateFilter.value));`,
  `    cacheKeys.add(
      createPullRequestCacheKey(
        repositoryRootPath,
        pullRequestStateFilter.value,
        pullRequestSupport.value.repositoryUrl,
      ),
    );`,
);

replaceIfPresent(
  'scope all PR list mutation cache key by remote',
  `    cacheKeys.add(createPullRequestCacheKey(repositoryRootPath, 'all'));`,
  `    cacheKeys.add(
      createPullRequestCacheKey(repositoryRootPath, 'all', pullRequestSupport.value.repositoryUrl),
    );`,
);

// 4. Main PR list cache read/write must use remote scope.
replaceIfPresent(
  'scope PR list cache key by remote',
  `    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);`,
  `    const cacheKey = createPullRequestCacheKey(
      repositoryRootPath,
      selectedState,
      pullRequestSupport.value.repositoryUrl,
    );`,
);

// 5. PR detail cache read/write must use remote scope.
replaceIfPresent(
  'scope PR detail cache key by remote',
  `    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);`,
  `    const cacheKey = createPullRequestDetailCacheKey(
      repositoryRootPath,
      number,
      pullRequestSupport.value.repositoryUrl,
    );`,
);

// 6. Extra guard: persisted cleanup by repository root still works because scoped keys
// continue to start with "normalizedRoot|". Keep it unchanged intentionally.

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');