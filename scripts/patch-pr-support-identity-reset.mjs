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

const insertBefore = (description, anchor, insertion, alreadyNeedle) => {
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

  text = text.replace(anchor, `${insertion}${anchor}`);
  console.log(`patched ${file}: ${description}`);
  return true;
};

// 0. If cache epoch did not get fully applied yet, make this script self-contained enough.
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
  console.log(`skipped ${file}: PR cache epoch already exists`);
}

// 1. Add support identity helpers.
insertBefore(
  'add PR support identity helpers',
  `  const resetPullRequestSupport = (): void => {`,
  `  const createPullRequestSupportIdentity = (
    support: IGitPullRequestSupportPayload,
  ): string =>
    [
      support.provider || 'unknown',
      support.remoteName || '',
      support.repositoryUrl || '',
    ].join('|');

  const hasPullRequestSupportIdentityChanged = (
    previous: IGitPullRequestSupportPayload,
    next: IGitPullRequestSupportPayload,
  ): boolean =>
    createPullRequestSupportIdentity(previous) !== createPullRequestSupportIdentity(next);

`,
  `const createPullRequestSupportIdentity =`,
);

// 2. Add a cache-only reset that does NOT reset pullRequestSupport.
// This is important because support is the thing we just refreshed.
insertBefore(
  'add PR cache-only reset for support identity changes',
  `  const resetSupplementaryData = (): void => {`,
  `  const resetPullRequestDataForSupportChange = (): void => {
    pullRequestsRequestId += 1;
    pullRequestDetailRequestId += 1;
    pullRequestDetailPreloadEpoch += 1;
    pullRequestCacheEpoch += 1;
    clearPullRequestPreloadTimer();
    pullRequests.value = [];
    pullRequestStateFilter.value = 'open';
    pullRequestDetail.value = null;
    invalidatePullRequestListCache();
    invalidatePullRequestDetailCache();
  };

`,
  `const resetPullRequestDataForSupportChange =`,
);

// 3. Use the identity check inside loadPullRequestSupport success path.
const oldSupportThen = `      .then((payload) => {
        if (requestId === pullRequestSupportRequestId) {
          pullRequestSupport.value = payload;
        }
        return requestId === pullRequestSupportRequestId ? pullRequestSupport.value : payload;
      })`;

const newSupportThen = `      .then((payload) => {
        if (requestId === pullRequestSupportRequestId) {
          const previousSupport = pullRequestSupport.value;
          if (hasPullRequestSupportIdentityChanged(previousSupport, payload)) {
            removePersistedPullRequestCachesForRepository(status.value.repositoryRootPath);
            resetPullRequestDataForSupportChange();
          }
          pullRequestSupport.value = payload;
        }
        return requestId === pullRequestSupportRequestId ? pullRequestSupport.value : payload;
      })`;

if (!text.includes('hasPullRequestSupportIdentityChanged(previousSupport, payload)')) {
  replaceExact(
    'reset PR data when support identity changes',
    oldSupportThen,
    newSupportThen,
  );
} else {
  console.log(`skipped ${file}: PR support identity reset already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');