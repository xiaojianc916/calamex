// 5.mjs — Finding C：github-author 头像缓存迁移到 TanStack Query 统一管线
// 改动文件：
//   1) src/domains/git/services/github-author.ts            （整体重写：删手写缓存，改用 queryClient.fetchQuery）
//   2) src/.../sidebar/source-control/useGitHistoryHoverCard.ts （删 readCachedGithubCommitAuthor 同步读，单次 fetchQuery）
// 安全：仓库根目录运行；任一守卫失败即中止，不写任何文件。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const FILE_AUTHOR = 'src/domains/git/services/github-author.ts';
const FILE_HOVER = 'src/components/workbench/sidebar/source-control/useGitHistoryHoverCard.ts';
const FILE_QUERY_CLIENT = 'src/lib/query-client.ts';

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (!existsSync('src') || !existsSync('package.json')) {
  die('✘ 未检测到 src/ 或 package.json，请在仓库根目录（D:\\com.xiaojianc\\my_desktop_app）下运行。');
}
if (!existsSync(FILE_QUERY_CLIENT)) {
  die(`✘ 找不到 ${FILE_QUERY_CLIENT}，迁移依赖的 queryClient 不存在，已中止。`);
}

const readFile = (rel) => {
  if (!existsSync(rel)) die(`✘ 找不到文件：${rel}`);
  const raw = readFileSync(rel, 'utf8');
  return { raw, usesCRLF: raw.includes('\r\n') };
};
const toLF = (s) => s.replace(/\r\n/g, '\n');
const restoreEOL = (s, usesCRLF) => (usesCRLF ? s.replace(/\n/g, '\r\n') : s);

const replaceOnce = (text, find, replace, label) => {
  const count = text.split(find).length - 1;
  if (count !== 1) die(`✘ 替换「${label}」预期命中 1 次，实际 ${count} 次。文件可能已变更，已中止且未写入。`);
  return text.split(find).join(replace);
};

// ---- 前置守卫：确认是“旧版本”，且无其它文件依赖将被删除的导出 ----
const author = readFile(FILE_AUTHOR);
const authorLF = toLF(author.raw);
if (!authorLF.includes('readCachedGithubCommitAuthor') || !authorLF.includes('pendingGithubAuthorRequests')) {
  die('✘ github-author.ts 不是预期的旧版本（缺少 readCachedGithubCommitAuthor/pendingGithubAuthorRequests），可能已迁移，已中止。');
}

const hover = readFile(FILE_HOVER);
const hoverLF = toLF(hover.raw);
if (!hoverLF.includes('readCachedGithubCommitAuthor')) {
  die('✘ useGitHistoryHoverCard.ts 未引用 readCachedGithubCommitAuthor，可能已变更，已中止。');
}

// 全仓扫描：除两个目标文件外，不允许有其它文件引用 readCachedGithubCommitAuthor
const walk = (dir, acc) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|vue)$/.test(name)) acc.push(p);
  }
  return acc;
};
const norm = (p) => p.split(sep).join('/');
const targets = new Set([norm(FILE_AUTHOR), norm(FILE_HOVER)]);
const offenders = [];
for (const p of walk('src', [])) {
  const np = norm(p);
  if (targets.has(np)) continue;
  if (toLF(readFileSync(p, 'utf8')).includes('readCachedGithubCommitAuthor')) offenders.push(np);
}
if (offenders.length > 0) {
  die(`✘ 以下文件仍引用 readCachedGithubCommitAuthor，本脚本会删除该导出，请先处理：\n  - ${offenders.join('\n  - ')}\n已中止。`);
}

// ---- 1) github-author.ts 全量重写 ----
const NEW_AUTHOR = `import { queryClient } from '@/lib/query-client';
import type { IGitCommitSummaryPayload } from '@/types/git';

// 头像快照的新鲜窗口 / 落盘保留窗口，对齐原手写 TTL（30 天）。
const GITHUB_AUTHOR_STALE_TIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface IGitHubCommitAuthorSnapshot {
  login: string | null;
  name: string;
  avatarUrl: string | null;
  htmlUrl: string | null;
  updatedAt: number;
}

/**
 * 统一解析 repo URL 的 host / owner / repo，供所有 GitHub API 构造共用。
 * 一个 URL 只做一次 new URL() 解析，不再各处重复正则后援。
 */
const parseRepoUrl = (repoUrl: string): { host: string; owner: string; repo: string } | null => {
  try {
    const url = new URL(repoUrl);
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo) return null;
    return { host: url.host.toLowerCase(), owner, repo: repo.replace(/\\.git$/, '') };
  } catch {
    return null;
  }
};

const resolveGithubAuthorIdentity = (commit: IGitCommitSummaryPayload): string | null => {
  const email = commit.authorEmail?.trim().toLowerCase();
  if (email) return \`email:\${email}\`;

  const name = commit.authorName?.trim().toLowerCase();
  return name ? \`name:\${name}\` : null;
};

const resolveGithubCommitApiUrl = (repoUrl: string, commitId: string): string | null => {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return null;

  const apiBase =
    parsed.host === 'github.com' ? 'https://api.github.com' : \`https://\${parsed.host}/api/v3\`;
  return \`\${apiBase}/repos/\${encodeURIComponent(parsed.owner)}/\${encodeURIComponent(parsed.repo)}/commits/\${commitId}\`;
};

/**
 * 纯网络请求：失败时抛错（交给 QueryClient 处理，错误不会被当成数据缓存）。
 */
const requestGithubCommitAuthorSnapshot = async (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
): Promise<IGitHubCommitAuthorSnapshot> => {
  const apiUrl = resolveGithubCommitApiUrl(repoUrl, commit.id);
  if (!apiUrl) {
    throw new Error('无法解析 GitHub commit API 地址');
  }

  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(\`GitHub commit API 请求失败：\${response.status}\`);
  }

  const value = (await response.json()) as {
    author?: {
      login?: string | null;
      avatar_url?: string | null;
      html_url?: string | null;
    } | null;
    commit?: { author?: { name?: string | null } | null } | null;
  };

  return {
    login: value.author?.login ?? null,
    name: value.commit?.author?.name ?? commit.authorName,
    avatarUrl: value.author?.avatar_url ?? null,
    htmlUrl: value.author?.html_url ?? null,
    updatedAt: Date.now(),
  };
};

/**
 * 提交作者头像快照。
 *
 * 缓存 / 去重 / 落盘统一交给全局 TanStack QueryClient（与 PR 列表、commit stats 等
 * server-state 同一套管线），不再手写 Map 去重 + TTL + 本地存储缓存：
 * - 相同 host + 作者身份的并发/重复请求按 queryKey 自动去重；命中新鲜缓存直接返回、不发网络；
 * - staleTime/gcTime 复用原 30 天窗口；
 * - meta.persist 让成功结果落盘到 IndexedDB（取代原同步本地存储写盘方案）；
 * - 请求失败不写入缓存，调用方拿到 null（与原 .catch(() => null) 语义一致）。
 */
export const fetchGithubCommitAuthorSnapshot = (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
): Promise<IGitHubCommitAuthorSnapshot | null> => {
  const parsed = parseRepoUrl(repoUrl);
  const identity = resolveGithubAuthorIdentity(commit);
  if (!parsed || !identity) return Promise.resolve(null);

  return queryClient
    .fetchQuery({
      queryKey: ['github-commit-author', parsed.host, identity],
      queryFn: () => requestGithubCommitAuthorSnapshot(repoUrl, commit),
      staleTime: GITHUB_AUTHOR_STALE_TIME_MS,
      gcTime: GITHUB_AUTHOR_STALE_TIME_MS,
      meta: { persist: true },
    })
    .catch(() => null);
};
`;

// ---- 2) useGitHistoryHoverCard.ts 两处定点改动 ----
const H1_FIND = `import {
  fetchGithubCommitAuthorSnapshot,
  type IGitHubCommitAuthorSnapshot,
  readCachedGithubCommitAuthor,
} from '@/domains/git/services/github-author';`;
const H1_REPL = `import {
  fetchGithubCommitAuthorSnapshot,
  type IGitHubCommitAuthorSnapshot,
} from '@/domains/git/services/github-author';`;

const H2_FIND = `    if (!repoUrl) return;
    const cached = readCachedGithubCommitAuthor(repoUrl, commit);
    if (cached) {
      if (hover.commitId === commit.id) hoverAuthorSnapshot.value = cached;
      return;
    }
    const snapshot = await fetchGithubCommitAuthorSnapshot(repoUrl, commit);`;
const H2_REPL = `    if (!repoUrl) return;
    const snapshot = await fetchGithubCommitAuthorSnapshot(repoUrl, commit);`;

let nextHover = hoverLF;
nextHover = replaceOnce(nextHover, H1_FIND, H1_REPL, 'hover: import 去掉 readCachedGithubCommitAuthor');
nextHover = replaceOnce(nextHover, H2_FIND, H2_REPL, 'hover: hydrate 改单次 fetchQuery');

// ---- 后置守卫 ----
for (const bad of ['readCachedGithubCommitAuthor', 'writeCachedGithubCommitAuthor', 'localStorage', 'pendingGithubAuthorRequests']) {
  if (NEW_AUTHOR.includes(bad)) die(`✘ 新 github-author.ts 仍包含「${bad}」，已中止。`);
}
for (const need of ['queryClient', 'fetchQuery', "meta: { persist: true }", 'resolveGithubAuthorIdentity', 'resolveGithubCommitApiUrl']) {
  if (!NEW_AUTHOR.includes(need)) die(`✘ 新 github-author.ts 缺少「${need}」，已中止。`);
}
if (nextHover.includes('readCachedGithubCommitAuthor')) die('✘ useGitHistoryHoverCard.ts 仍残留 readCachedGithubCommitAuthor，已中止。');

// ---- 原子写入 ----
writeFileSync(FILE_AUTHOR, restoreEOL(NEW_AUTHOR, author.usesCRLF), 'utf8');
writeFileSync(FILE_HOVER, restoreEOL(nextHover, hover.usesCRLF), 'utf8');

console.log('✔ 已重写 ' + FILE_AUTHOR + '（删手写缓存/去重/本地存储，改用 queryClient.fetchQuery）');
console.log('✔ 已更新 ' + FILE_HOVER + '（删同步缓存读，单次 fetchQuery 命中即返回）');
console.log('\n下一步：pnpm typecheck && pnpm lint && pnpm test && pnpm build');