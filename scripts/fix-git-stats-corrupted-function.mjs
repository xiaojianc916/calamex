#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = 'src/store/git.ts';
const filePath = resolve(process.cwd(), path);

let text = readFileSync(filePath, 'utf8');

const pattern =
  /  const enqueueCommitStatsForCommits = \(\r?\n    commits: readonly IGitCommitSummaryPayload\[\],\r?\n    limit = GIT_COMMIT_STATS_BACKGROUND_BATCH_LIMIT,\r?\n  \): void => \{[\s\S]*?\r?\n  \};/m;

const replacement = `  const enqueueCommitStatsForCommits = (
    commits: readonly IGitCommitSummaryPayload[],
    limit = GIT_COMMIT_STATS_BACKGROUND_BATCH_LIMIT,
  ): void => {
    for (const item of commits.slice(0, limit)) {
      enqueueCommitStats(item.id);
    }
  };`;

if (!pattern.test(text)) {
  throw new Error(
    `[${path}] 找不到 enqueueCommitStatsForCommits 函数。请先检查该文件 1120 行附近。`,
  );
}

text = text.replace(pattern, replacement);
writeFileSync(filePath, text, 'utf8');

console.log('Fixed corrupted enqueueCommitStatsForCommits function.');
console.log(` - ${path}`);