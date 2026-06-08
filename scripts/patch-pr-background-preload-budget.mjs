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

insertAfter(
  'add PR background preload retry budget constant',
  `const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
`,
  `const PULL_REQUEST_BACKGROUND_PRELOAD_RETRY_INTERVAL_MS = 60_000;
`,
  `const PULL_REQUEST_BACKGROUND_PRELOAD_RETRY_INTERVAL_MS =`,
);

insertAfter(
  'track scheduled/background PR preload repository',
  `  let pullRequestDetailPreloadEpoch = 0;
  let pullRequestPreloadTimer: ReturnType<typeof setTimeout> | null = null;
`,
  `  let scheduledPullRequestPreloadRepositoryKey: string | null = null;
  const pullRequestBackgroundPreloadAttemptedAt = new Map<string, number>();
`,
  `scheduledPullRequestPreloadRepositoryKey`,
);

const oldClearTimer = `  const clearPullRequestPreloadTimer = (): void => {
    if (pullRequestPreloadTimer !== null) {
      clearTimeout(pullRequestPreloadTimer);
      pullRequestPreloadTimer = null;
    }
  };`;

const newClearTimer = `  const clearPullRequestPreloadTimer = (): void => {
    if (pullRequestPreloadTimer !== null) {
      clearTimeout(pullRequestPreloadTimer);
      pullRequestPreloadTimer = null;
    }
    scheduledPullRequestPreloadRepositoryKey = null;
  };`;

if (!text.includes(`scheduledPullRequestPreloadRepositoryKey = null;`)) {
  replaceExact(
    'clear scheduled PR background preload repository key',
    oldClearTimer,
    newClearTimer,
  );
} else {
  console.log(`skipped ${file}: clear scheduled PR preload key already applied`);
}

const oldSchedule = `  const schedulePullRequestPreload = (): void => {
    clearPullRequestPreloadTimer();
    if (!hasRepository.value) return;
    pullRequestPreloadTimer = setTimeout(() => {
      pullRequestPreloadTimer = null;
      void preloadPullRequestsInBackground();
    }, PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS);
  };`;

const newSchedule = `  const schedulePullRequestPreload = (): void => {
    const repositoryRootPath = status.value.repositoryRootPath;
    if (!hasRepository.value || !repositoryRootPath) {
      clearPullRequestPreloadTimer();
      return;
    }

    const repositoryKey = normalizeFileSystemPath(repositoryRootPath);
    if (!repositoryKey) {
      clearPullRequestPreloadTimer();
      return;
    }

    const lastAttemptedAt = pullRequestBackgroundPreloadAttemptedAt.get(repositoryKey) ?? 0;
    const isWithinRetryBudget =
      Date.now() - lastAttemptedAt < PULL_REQUEST_BACKGROUND_PRELOAD_RETRY_INTERVAL_MS;

    if (isWithinRetryBudget) {
      return;
    }

    if (
      pullRequestPreloadTimer !== null &&
      scheduledPullRequestPreloadRepositoryKey === repositoryKey
    ) {
      return;
    }

    clearPullRequestPreloadTimer();
    scheduledPullRequestPreloadRepositoryKey = repositoryKey;

    pullRequestPreloadTimer = setTimeout(() => {
      pullRequestPreloadTimer = null;
      scheduledPullRequestPreloadRepositoryKey = null;
      pullRequestBackgroundPreloadAttemptedAt.set(repositoryKey, Date.now());
      void preloadPullRequestsInBackground();
    }, PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS);
  };`;

if (!text.includes(`pullRequestBackgroundPreloadAttemptedAt.set(repositoryKey, Date.now());`)) {
  replaceExact(
    'budget PR background preload scheduling per repository',
    oldSchedule,
    newSchedule,
  );
} else {
  console.log(`skipped ${file}: PR background preload scheduling budget already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');