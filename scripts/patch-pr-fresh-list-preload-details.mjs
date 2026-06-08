#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const file = 'src/store/git.ts';
const filePath = resolve(root, file);

const oldText = `    if (cached && !options?.force && isFresh) {
      return cached;
    }`;

const newText = `    if (cached && !options?.force && isFresh) {
      if (shouldPreloadDetails) {
        preloadTopPullRequestDetails(cached);
      }
      return cached;
    }`;

const text = readFileSync(filePath, 'utf8');

if (text.includes(newText)) {
  console.log(`${file}: fresh-cache detail preload already applied`);
  process.exit(0);
}

const count = text.split(oldText).length - 1;

if (count !== 1) {
  throw new Error(
    [
      `${file}: expected 1 fresh-cache return block, found ${count}.`,
      'Refusing to modify because the file may have changed.',
    ].join('\n'),
  );
}

writeFileSync(filePath, text.replace(oldText, newText), 'utf8');

console.log(`patched ${file}: preload PR details on fresh list cache hit`);