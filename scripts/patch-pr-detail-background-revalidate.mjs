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

const oldCachedDetailBlock = `    if (cached && !force) {
      touchPullRequestDetailCache(cacheKey);
      if (updateActive) {
        pullRequestDetail.value = cached;
        if (!pending && shouldRevalidate) {
          void loadPullRequestDetail(number, {
            force: true,
            updateActive: true,
            visibleLoading: false,
          }).catch(() => undefined);
        }
      }
      return cached;
    }`;

const newCachedDetailBlock = `    if (cached && !force) {
      touchPullRequestDetailCache(cacheKey);

      if (updateActive) {
        pullRequestDetail.value = cached;
      }

      if (!pending && shouldRevalidate) {
        void loadPullRequestDetail(number, {
          force: true,
          updateActive,
          visibleLoading: false,
        }).catch(() => undefined);
      }

      return cached;
    }`;

if (!text.includes(`force: true,
          updateActive,
          visibleLoading: false,`)) {
  replaceExact(
    'allow stale PR detail cache hits to revalidate during background preload',
    oldCachedDetailBlock,
    newCachedDetailBlock,
  );
} else {
  console.log(`skipped ${file}: PR detail background revalidation already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');