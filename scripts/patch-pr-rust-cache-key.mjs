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

const functionSignature =
  'fn pull_request_detail_cache_key(target: &GitHubRepositoryTarget, number: u32) -> String';

const signatureStart = text.indexOf(functionSignature);

if (signatureStart === -1) {
  throw new Error(`${relativePath}: function signature not found`);
}

const openBrace = text.indexOf('{', signatureStart);

if (openBrace === -1) {
  throw new Error(`${relativePath}: function opening brace not found`);
}

let depth = 0;
let functionEnd = -1;

for (let i = openBrace; i < text.length; i += 1) {
  const char = text[i];

  if (char === '{') {
    depth += 1;
  } else if (char === '}') {
    depth -= 1;

    if (depth === 0) {
      functionEnd = i + 1;
      break;
    }
  }
}

if (functionEnd === -1) {
  throw new Error(`${relativePath}: function closing brace not found`);
}

const currentFunction = text.slice(signatureStart, functionEnd);

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

  const nextText = text.slice(0, signatureStart) + replacement + text.slice(functionEnd);
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