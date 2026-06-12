#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const filePath = 'src-tauri/src/commands/git/diff.rs';
const absolutePath = resolve(root, filePath);

const fail = (message) => {
  throw new Error(`[${filePath}] ${message}`);
};

let source = readFileSync(absolutePath, 'utf8');

const helper = `fn are_text_contents_equal_ignoring_cr(left: &str, right: &str) -> bool {
    left.bytes()
        .filter(|byte| *byte != b'\\r')
        .eq(right.bytes().filter(|byte| *byte != b'\\r'))
}

`;

if (!source.includes('fn are_text_contents_equal_ignoring_cr(')) {
  const anchor = 'pub(super) fn parse_git_diff_mode(value: &str) -> Result<GitDiffMode, String> {';
  const index = source.indexOf(anchor);
  if (index === -1) {
    fail('找不到 parse_git_diff_mode 插入锚点');
  }
  source = source.slice(0, index) + helper + source.slice(index);
}

const replacements = [
  {
    label: 'worktree/staged diff preview empty check',
    pattern:
      /let\s+is_empty\s*=\s*content_pair\.original_content\.replace\('\\r',\s*""\)\s*==\s*content_pair\.modified_content\.replace\('\\r',\s*""\);/m,
    replacement:
      'let is_empty = are_text_contents_equal_ignoring_cr(&content_pair.original_content, &content_pair.modified_content);',
  },
  {
    label: 'commit file diff preview empty check',
    pattern:
      /let\s+is_empty\s*=\s*original_content\.replace\('\\r',\s*""\)\s*==\s*modified_content\.replace\('\\r',\s*""\);/m,
    replacement:
      'let is_empty = are_text_contents_equal_ignoring_cr(&original_content, &modified_content);',
  },
];

for (const item of replacements) {
  if (source.includes(item.replacement)) {
    continue;
  }

  const matches = source.match(item.pattern);
  if (!matches) {
    fail(`找不到可替换位置：${item.label}`);
  }

  source = source.replace(item.pattern, item.replacement);
}

writeFileSync(absolutePath, source, 'utf8');

console.log('Applied round8 diff empty-check optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Avoids allocating two normalized strings when checking whether large Git diff previews are empty.');
console.log(' - Keeps CRLF/LF-insensitive behavior unchanged.');
console.log('');
console.log('Next:');
console.log('  cd src-tauri && cargo fmt && cargo check');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);