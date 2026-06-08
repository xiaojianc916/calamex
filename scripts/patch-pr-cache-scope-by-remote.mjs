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

if (!text.includes('const createPullRequestRepositoryScope =')) {
  replaceExact(
    'scope PR cache keys by remote repository identity',
    oldCacheKeyHelpers,
    newCacheKeyHelpers,
  );
} else {
  console.log(`skipped ${file}: PR cache keys already include remote repository scope`);
}

const replacements = [
  {
    description: 'scope detail invalidation key by remote repository',
    oldText: `    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, pullRequestNumber);`,
    newText: `    const cacheKey = createPullRequestDetailCacheKey(
      repositoryRootPath,
      pullRequestNumber,
      pullRequestSupport.value.repositoryUrl,
    );`,
  },
  {
    description: 'scope active filter PR list mutation cache key by remote repository',
    oldText: `    cacheKeys.add(createPullRequestCacheKey(repositoryRootPath, pullRequestStateFilter.value));`,
    newText: `    cacheKeys.add(
      createPullRequestCacheKey(
        repositoryRootPath,
        pullRequestStateFilter.value,
        pullRequestSupport.value.repositoryUrl,
      ),
    );`,
  },
  {
    description: 'scope all PR list mutation cache key by remote repository',
    oldText: `    cacheKeys.add(createPullRequestCacheKey(repositoryRootPath, 'all'));`,
    newText: `    cacheKeys.add(
      createPullRequestCacheKey(repositoryRootPath, 'all', pullRequestSupport.value.repositoryUrl),
    );`,
  },
  {
    description: 'scope PR list cache key by remote repository',
    oldText: `    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);`,
    newText: `    const cacheKey = createPullRequestCacheKey(
      repositoryRootPath,
      selectedState,
      pullRequestSupport.value.repositoryUrl,
    );`,
  },
  {
    description: 'scope PR detail cache key by remote repository',
    oldText: `    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);`,
    newText: `    const cacheKey = createPullRequestDetailCacheKey(
      repositoryRootPath,
      number,
      pullRequestSupport.value.repositoryUrl,
    );`,
  },
];

for (const replacement of replacements) {
  if (text.includes(replacement.oldText)) {
    replaceExact(replacement.description, replacement.oldText, replacement.newText);
  } else if (text.includes(replacement.newText.trim())) {
    console.log(`skipped ${file}: ${replacement.description} already applied`);
  } else {
    throw new Error(
      [
        `${file}: ${replacement.description} could not be located`,
        'Expected old snippet:',
        replacement.oldText,
      ].join('\n'),
    );
  }
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');