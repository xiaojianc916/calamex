#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = 'src/store/git.ts';
const filePath = resolve(process.cwd(), path);

let text = readFileSync(filePath, 'utf8');

const fail = (message) => {
  throw new Error(`[${path}] ${message}`);
};

const ensure = (needle, label) => {
  if (!text.includes(needle)) {
    fail(`缺少 ${label}`);
  }
};

const replaceExact = (oldText, newText, label) => {
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 match, got ${count}`);
  }
  text = text.replace(oldText, newText);
};

// 基础检查：必须已经有 round4 commit stats 结构。
ensure(
  `const getCommitStats = (commitId: string): TGitCommitStatsPayload | null => {`,
  'getCommitStats',
);
ensure(
  `const enqueueCommitStatsForCommits = (`,
  'enqueueCommitStatsForCommits',
);
ensure(
  `rememberCommitStats(payload);`,
  'rememberCommitStats(payload)',
);

// 如果已经应用过，直接退出，保证幂等。
if (text.includes('const loadCommitStatsOnly = async (commitId: string): Promise<void> => {')) {
  console.log('Round5 stats-lite cache already applied.');
  process.exit(0);
}

// 1) 在 loadCommitDetail 后面插入 stats-only loader。
//    注意：这里仍然调用现有后端 getGitCommitDetail，避免新增 Tauri command / bindings，降低出错面。
//    但它不会写 commitDetailCache，只写轻量 stats cache。
const loadCommitDetailEnd = `  const loadCommitDetail = async (commitId: string): Promise<IGitCommitDetailPayload> => {
    const cached = commitDetailCache.value[commitId];
    if (cached) return cached;

    const pending = pendingCommitDetailRequests.get(commitId);
    if (pending) return pending;

    const request = tauriService
      .getGitCommitDetail({
        repositoryRootPath: requireRepositoryRootPath(),
        commitId,
      })
      .then((payload) => {
        commitDetailCache.value = {
          ...commitDetailCache.value,
          [commitId]: payload,
        };
        rememberCommitStats(payload);
        return payload;
      })
      .finally(() => {
        pendingCommitDetailRequests.delete(commitId);
      });

    pendingCommitDetailRequests.set(commitId, request);
    return request;
  };
`;

const loadCommitStatsOnly = `${loadCommitDetailEnd}
  const loadCommitStatsOnly = async (commitId: string): Promise<void> => {
    if (getCommitStats(commitId)) return;

    const pending = pendingCommitDetailRequests.get(commitId);
    if (pending) {
      const payload = await pending;
      rememberCommitStats(payload);
      return;
    }

    const request = tauriService
      .getGitCommitDetail({
        repositoryRootPath: requireRepositoryRootPath(),
        commitId,
      })
      .then((payload) => {
        // 后台 stats 只保存轻量统计，不污染完整 commitDetailCache。
        // 完整 files[] 仍然只在用户点击展开 commit 时由 loadCommitDetail 写入缓存。
        rememberCommitStats(payload);
        return payload;
      })
      .finally(() => {
        pendingCommitDetailRequests.delete(commitId);
      });

    pendingCommitDetailRequests.set(commitId, request);
    await request;
  };
`;

replaceExact(
  loadCommitDetailEnd,
  loadCommitStatsOnly,
  'insert loadCommitStatsOnly after loadCommitDetail',
);

// 2) 后台队列从 loadCommitDetail 改为 loadCommitStatsOnly。
replaceExact(
  `          await loadCommitDetail(commitId);`,
  `          await loadCommitStatsOnly(commitId);`,
  'background stats queue should not fill full detail cache',
);

// 3) 完整性检查。
ensure(
  `const loadCommitStatsOnly = async (commitId: string): Promise<void> => {`,
  'loadCommitStatsOnly',
);
ensure(
  `await loadCommitStatsOnly(commitId);`,
  'drain queue uses loadCommitStatsOnly',
);

const statsOnlyStart = text.indexOf(
  `  const loadCommitStatsOnly = async (commitId: string): Promise<void> => {`,
);
const statsOnlyEnd = text.indexOf(
  `  const loadCommitFileDiff = async (`,
  statsOnlyStart,
);

if (statsOnlyStart === -1 || statsOnlyEnd === -1) {
  fail('无法定位 loadCommitStatsOnly 区间');
}

const statsOnlyBlock = text.slice(statsOnlyStart, statsOnlyEnd);
if (statsOnlyBlock.includes('commitDetailCache.value =')) {
  fail('loadCommitStatsOnly 内不应写入 commitDetailCache');
}

writeFileSync(filePath, text, 'utf8');

console.log('Applied round5 stats-lite cache optimization.');
console.log(` - ${path}`);
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${path}`);