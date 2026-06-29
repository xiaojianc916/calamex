import { queryClient } from '@/lib/query-client';
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
    return { host: url.host.toLowerCase(), owner, repo: repo.replace(/\.git$/, '') };
  } catch {
    return null;
  }
};

const resolveGithubAuthorIdentity = (commit: IGitCommitSummaryPayload): string | null => {
  const email = commit.authorEmail?.trim().toLowerCase();
  if (email) return `email:${email}`;

  const name = commit.authorName?.trim().toLowerCase();
  return name ? `name:${name}` : null;
};

const resolveGithubCommitApiUrl = (repoUrl: string, commitId: string): string | null => {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return null;

  const apiBase =
    parsed.host === 'github.com' ? 'https://api.github.com' : `https://${parsed.host}/api/v3`;
  return `${apiBase}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${commitId}`;
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
    throw new Error(`GitHub commit API 请求失败：${response.status}`);
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
