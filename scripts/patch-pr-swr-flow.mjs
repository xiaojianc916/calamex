#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

function countOccurrences(text, needle) {
  if (needle.length === 0) return 0;

  let count = 0;
  let index = 0;

  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function readProjectFile(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function writeProjectFile(relativePath, text) {
  writeFileSync(resolve(root, relativePath), text, 'utf8');
}

function replaceExact(relativePath, oldText, newText, expectedCount = 1) {
  const text = readProjectFile(relativePath);
  const count = countOccurrences(text, oldText);

  if (count !== expectedCount) {
    throw new Error(
      [
        `${relativePath}: expected ${expectedCount} occurrence(s), found ${count}.`,
        'Refusing to modify because the file may have changed.',
      ].join('\n'),
    );
  }

  writeProjectFile(relativePath, text.split(oldText).join(newText));
  console.log(`patched ${relativePath}: ${expectedCount} replacement(s)`);
}

function replaceExactInRange(
  relativePath,
  startNeedle,
  endNeedle,
  oldText,
  newText,
  expectedCount = 1,
) {
  const text = readProjectFile(relativePath);
  const start = text.indexOf(startNeedle);

  if (start === -1) {
    throw new Error(`${relativePath}: start marker not found: ${startNeedle}`);
  }

  const end = text.indexOf(endNeedle, start + startNeedle.length);

  if (end === -1) {
    throw new Error(`${relativePath}: end marker not found after start marker: ${endNeedle}`);
  }

  const before = text.slice(0, start);
  const target = text.slice(start, end);
  const after = text.slice(end);

  const count = countOccurrences(target, oldText);

  if (count !== expectedCount) {
    throw new Error(
      [
        `${relativePath}: expected ${expectedCount} occurrence(s) inside scoped range, found ${count}.`,
        `Scope start: ${startNeedle}`,
        `Scope end: ${endNeedle}`,
        'Refusing to modify because the file may have changed.',
      ].join('\n'),
    );
  }

  writeProjectFile(relativePath, before + target.split(oldText).join(newText) + after);
  console.log(`patched ${relativePath}: ${expectedCount} scoped replacement(s)`);
}

// 1. PR tab lazy entry:
// Only patch inside ensureActiveTabData(), because the same old snippet also appears in the manual refresh handler.
replaceExactInRange(
  'src/components/workbench/SourceControlPanel.vue',
  `async function ensureActiveTabData(tabKey: TGitNavKey): Promise<void> {`,
  `const conflictedEntries = computed`,
  `    await gitStore.loadPullRequestSupport();
    if (gitStore.pullRequestSupport.available) {
      await gitStore.loadPullRequests();
    }`,
  `    await gitStore.ensurePullRequestsLoaded(pullRequestStateFilter.value);`,
);

// 2. PR filter switch:
// Use the cache-aware/SWR store entry, not raw list loading.
replaceExact(
  'src/components/workbench/SourceControlPanel.vue',
  `    await gitStore.loadPullRequests(stateKey);`,
  `    await gitStore.ensurePullRequestsLoaded(stateKey);`,
);

// 3. PR create / merge / close:
// After server-side mutation, force-refresh through frontend cache boundary.
replaceExact(
  'src/components/workbench/SourceControlPanel.vue',
  `    await gitStore.loadPullRequests(pullRequestStateFilter.value);`,
  `    await gitStore.refreshPullRequests(pullRequestStateFilter.value);`,
  3,
);

// 4. Manual refresh button:
// Explicitly force-refresh PRs via store API.
replaceExact(
  'src/components/workbench/SourceControlPanel.vue',
  `const handleReloadPullRequestSupport = async (): Promise<void> => {
  try {
    await gitStore.loadPullRequestSupport();
    if (gitStore.pullRequestSupport.available) {
      await gitStore.loadPullRequests();
    }
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 列表失败'));
  }
};`,
  `const handleReloadPullRequestSupport = async (): Promise<void> => {
  try {
    await gitStore.refreshPullRequests(pullRequestStateFilter.value);
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Pull Request 列表失败'));
  }
};`,
);

// 5. Bounded PR detail preload:
// Make worker invocation explicit.
replaceExact(
  'src/store/git.ts',
  `    await Promise.all(Array.from({ length: workerCount }, preloadNext));`,
  `    await Promise.all(Array.from({ length: workerCount }, () => preloadNext()));`,
);

// 6. Rust cache key:
// Avoid borrowing from a temporary number.to_string().
replaceExact(
  'src-tauri/src/commands/git/pull_request.rs',
  `fn pull_request_detail_cache_key(target: &GitHubRepositoryTarget, number: u32) -> String {
    [
        target.repository_root.to_string_lossy().as_ref(),
        target.api_base.as_str(),
        target.owner.as_str(),
        target.repo.as_str(),
        number.to_string().as_str(),
    ]
    .join("|")
}`,
  `fn pull_request_detail_cache_key(target: &GitHubRepositoryTarget, number: u32) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        target.repository_root.to_string_lossy(),
        target.api_base,
        target.owner,
        target.repo,
        number,
    )
}`,
);

console.log('done');