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

const assertHas = (needle, message) => {
  if (!text.includes(needle)) {
    throw new Error(`${file}: ${message}`);
  }
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

assertHas(
  'const writePersistedPullRequestList =',
  'persisted PR snapshot helpers are missing; run the base script first',
);

assertHas(
  'const writePersistedPullRequestDetail =',
  'persisted PR detail helper is missing; run the base script first',
);

// 1. Persist successfully fetched PR list snapshots.
// 支持两种本地状态：
// - 老状态：[cacheKey]: Date.now()
// - 新状态：const fetchedAt = Date.now(); [cacheKey]: fetchedAt
if (text.includes('writePersistedPullRequestList(cacheKey, nextPayload);')) {
  console.log(`skipped ${file}: fetched PR list persistence already applied`);
} else if (text.includes('writePersistedPullRequestList(cacheKey, payload);')) {
  console.log(`skipped ${file}: fetched PR list persistence already applied with payload`);
} else {
  const listPayloadName = text.includes('const nextPayload =') ? 'nextPayload' : 'payload';

  const oldDateNowBlock = `        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: Date.now(),
        };`;

  const newDateNowBlock = `        const fetchedAt = Date.now();
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: fetchedAt,
        };
        writePersistedPullRequestList(cacheKey, ${listPayloadName});`;

  const oldFetchedAtBlock = `        const fetchedAt = Date.now();
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: fetchedAt,
        };`;

  const newFetchedAtBlock = `        const fetchedAt = Date.now();
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: fetchedAt,
        };
        writePersistedPullRequestList(cacheKey, ${listPayloadName});`;

  if (text.includes(oldDateNowBlock)) {
    replaceExact(
      'persist successfully fetched PR list snapshots from Date.now block',
      oldDateNowBlock,
      newDateNowBlock,
    );
  } else if (text.includes(oldFetchedAtBlock)) {
    replaceExact(
      'persist successfully fetched PR list snapshots from fetchedAt block',
      oldFetchedAtBlock,
      newFetchedAtBlock,
    );
  } else {
    const anchor = `        if (updateActive && requestId === pullRequestsRequestId) {`;
    if (!text.includes(anchor)) {
      throw new Error(
        [
          `${file}: cannot locate PR list success block`,
          'Expected anchor:',
          anchor,
        ].join('\n'),
      );
    }

    text = text.replace(
      anchor,
      `        writePersistedPullRequestList(cacheKey, ${listPayloadName});
${anchor}`,
    );
    console.log(`patched ${file}: inserted fetched PR list persistence before active update`);
  }
}

// 2. Persist mutation-updated PR list snapshots.
if (text.includes('writePersistedPullRequestList(cacheKey, nextCache[cacheKey]);')) {
  console.log(`skipped ${file}: mutation PR list persistence already applied`);
} else {
  const oldMutationLine = `      nextFetchedAt[cacheKey] = now;`;
  const newMutationLine = `      nextFetchedAt[cacheKey] = now;
      writePersistedPullRequestList(cacheKey, nextCache[cacheKey]);`;

  replaceExact(
    'persist mutation-updated PR list snapshots',
    oldMutationLine,
    newMutationLine,
  );
}

// 3. Clear persisted PR snapshots when remote changes.
if (text.includes('removePersistedPullRequestCachesForRepository(status.value.repositoryRootPath);')) {
  console.log(`skipped ${file}: remote-change PR snapshot cleanup already applied`);
} else {
  const oldSetRemoteReset = `      pullRequestSupport.value = payload;
      resetPullRequests();
      return pullRequestSupport.value;`;

  const newSetRemoteReset = `      pullRequestSupport.value = payload;
      removePersistedPullRequestCachesForRepository(status.value.repositoryRootPath);
      resetPullRequests();
      return pullRequestSupport.value;`;

  replaceExact(
    'clear persisted PR snapshots when remote changes',
    oldSetRemoteReset,
    newSetRemoteReset,
  );
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');