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
      return;
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
    throw new Error(
      `${file}: ${description} expected 1 occurrence, found ${count}`,
    );
  }
  text = text.replace(oldText, newText);
  console.log(`patched ${file}: ${description}`);
};

const helperAnchor = `const updatePullRequestListForState = (
  entries: IGitPullRequestSummaryPayload[],
  pullRequest: IGitPullRequestSummaryPayload,
  state: 'open' | 'closed' | 'all',
): IGitPullRequestSummaryPayload[] => {
  if (shouldIncludePullRequestInState(pullRequest, state)) {
    return upsertPullRequestSummary(entries, pullRequest);
  }
  return entries.filter((entry) => entry.number !== pullRequest.number);
};

`;

const helperInsertion = `${helperAnchor}const arePullRequestSummariesEqual = (
  left: IGitPullRequestSummaryPayload,
  right: IGitPullRequestSummaryPayload,
): boolean =>
  left.number === right.number &&
  left.title === right.title &&
  left.state === right.state &&
  left.isDraft === right.isDraft &&
  left.author === right.author &&
  left.headRef === right.headRef &&
  left.baseRef === right.baseRef &&
  left.htmlUrl === right.htmlUrl &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt &&
  left.comments === right.comments;

const arePullRequestSummaryListsEqual = (
  left: IGitPullRequestSummaryPayload[] | undefined,
  right: IGitPullRequestSummaryPayload[],
): left is IGitPullRequestSummaryPayload[] => {
  if (!left || left.length !== right.length) return false;
  return left.every((entry, index) => arePullRequestSummariesEqual(entry, right[index]));
};

`;

if (!text.includes('const arePullRequestSummaryListsEqual =')) {
  replaceExact('add PR summary structural equality helpers', helperAnchor, helperInsertion);
} else {
  console.log(`skipped ${file}: PR summary structural equality helpers already applied`);
}

const oldFetchThen = `      .then((payload) => {
        pullRequestListCache.value = {
          ...pullRequestListCache.value,
          [cacheKey]: payload,
        };
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: Date.now(),
        };
        if (updateActive && requestId === pullRequestsRequestId) {
          pullRequests.value = payload;
        }
        if (shouldPreloadDetails) {
          preloadTopPullRequestDetails(payload);
        }
        return updateActive && requestId === pullRequestsRequestId ? pullRequests.value : payload;
      })`;

const newFetchThen = `      .then((payload) => {
        const previousCachedPullRequests = pullRequestListCache.value[cacheKey];
        const nextPayload = arePullRequestSummaryListsEqual(
          previousCachedPullRequests,
          payload,
        )
          ? previousCachedPullRequests
          : payload;

        pullRequestListCache.value = {
          ...pullRequestListCache.value,
          [cacheKey]: nextPayload,
        };
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: Date.now(),
        };
        if (updateActive && requestId === pullRequestsRequestId) {
          pullRequests.value = nextPayload;
        }
        if (shouldPreloadDetails) {
          preloadTopPullRequestDetails(nextPayload);
        }
        return updateActive && requestId === pullRequestsRequestId ? pullRequests.value : nextPayload;
      })`;

if (!text.includes('const previousCachedPullRequests = pullRequestListCache.value[cacheKey];')) {
  replaceExact('reuse structurally equal PR list payloads', oldFetchThen, newFetchThen);
} else {
  console.log(`skipped ${file}: structurally equal PR list reuse already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');