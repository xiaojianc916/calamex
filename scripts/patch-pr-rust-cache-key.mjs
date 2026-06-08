#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const relativePath = 'src-tauri/src/commands/git/pull_request.rs';
const filePath = resolve(root, relativePath);

const text = readFileSync(filePath, 'utf8');

const startMarker = 'fn pull_request_detail_cache_key(target: &GitHubRepositoryTarget, number: u32) -> String {';
const endMarker = '\n\nfn cached_pull_requests';

const start = text.indexOf(startMarker);
if (start === -1) {
  throw new Error(`${relativePath}: function start not found`);
}

const end = text.indexOf(endMarker, start);
if (end === -1) {
  throw new Error(`${relativePath}: next function marker not found`);
}

const currentFunction = text.slice(start, end);

if (currentFunction.includes('number.to_string().as_str()')) {
  const replacement = `fn pull_request_detail_cache_key(target: &GitHubRepositoryTarget, number: u32) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        target.repository_root.to_string_lossy(),
        target.api_base,
        target.owner,
        target.repo,
        number,
    )
}`;

  const nextText = text.slice(0, start) + replacement + text.slice(end);
  writeFileSync(filePath, nextText, 'utf8');
  console.log(`patched ${relativePath}: fixed temporary string borrow`);
} else if (currentFunction.includes('format!(')) {
  console.log(`${relativePath}: already uses format!, no change needed`);
} else {
  throw new Error(
    [
      `${relativePath}: function found, but it does not match the known unsafe or fixed shape.`,
      'Please inspect this function manually:',
      currentFunction,
    ].join('\n'),
  );
}