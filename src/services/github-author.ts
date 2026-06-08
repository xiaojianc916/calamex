import type { IGitCommitSummaryPayload } from '@/types/git';

const GITHUB_AUTHOR_CACHE_PREFIX = 'calamex.githubAuthor.';
const GITHUB_AUTHOR_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IGitHubCommitAuthorSnapshot {
  login: string | null;
  name: string;
  avatarUrl: string | null;
  htmlUrl: string | null;
  updatedAt: number;
}

const pendingGithubAuthorRequests = new Map<string, Promise<IGitHubCommitAuthorSnapshot | null>>();

const resolveLocalStorage = (): Storage | null => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
};

const resolveGithubHost = (repoUrl: string): string | null => {
  try {
    return new URL(repoUrl).host.toLowerCase();
  } catch {
    const match = repoUrl.match(/^https:\/\/([^/]+)/);
    return match?.[1]?.toLowerCase() ?? null;
  }
};

const resolveGithubAuthorIdentity = (commit: IGitCommitSummaryPayload): string | null => {
  const email = commit.authorEmail?.trim().toLowerCase();
  if (email) return `email:${email}`;

  const name = commit.authorName?.trim().toLowerCase();
  return name ? `name:${name}` : null;
};

const resolveGithubAuthorCacheKey = (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
): string | null => {
  const host = resolveGithubHost(repoUrl);
  const identity = resolveGithubAuthorIdentity(commit);
  if (!host || !identity) return null;
  return `${GITHUB_AUTHOR_CACHE_PREFIX}${encodeURIComponent(host)}:${encodeURIComponent(identity)}`;
};

export const readCachedGithubCommitAuthor = (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
): IGitHubCommitAuthorSnapshot | null => {
  const storage = resolveLocalStorage();
  const cacheKey = resolveGithubAuthorCacheKey(repoUrl, commit);
  if (!storage || !cacheKey) return null;
  try {
    const raw = storage.getItem(cacheKey);
    if (!raw) return null;
    const cached = JSON.parse(raw) as IGitHubCommitAuthorSnapshot;
    if (!cached || typeof cached.updatedAt !== 'number') return null;
    if (Date.now() - cached.updatedAt > GITHUB_AUTHOR_CACHE_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
};

const writeCachedGithubCommitAuthor = (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
  snapshot: IGitHubCommitAuthorSnapshot,
): void => {
  const storage = resolveLocalStorage();
  const cacheKey = resolveGithubAuthorCacheKey(repoUrl, commit);
  if (!storage || !cacheKey) return;
  try {
    storage.setItem(cacheKey, JSON.stringify(snapshot));
  } catch {
    // Avatar cache is best-effort only.
  }
};

const resolveGithubCommitApiUrl = (repoUrl: string, commitId: string): string | null => {
  const match = repoUrl.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return null;

  const [, host, owner, repo] = match;
  const cleanRepo = repo.replace(/\.git$/, '');
  const apiBase =
    host.toLowerCase() === 'github.com'
      ? 'https://api.github.com'
      : ['https://api.', host].join('');
  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(cleanRepo)}/commits/${commitId}`;
};

export const fetchGithubCommitAuthorSnapshot = async (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
): Promise<IGitHubCommitAuthorSnapshot | null> => {
  const apiUrl = resolveGithubCommitApiUrl(repoUrl, commit.id);
  const cacheKey = resolveGithubAuthorCacheKey(repoUrl, commit);
  if (!apiUrl || !cacheKey) return null;

  const pending = pendingGithubAuthorRequests.get(cacheKey);
  if (pending) return pending;

  const request = fetch(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const value = (await response.json()) as {
        author?: {
          login?: string | null;
          avatar_url?: string | null;
          html_url?: string | null;
        } | null;
        commit?: { author?: { name?: string | null } | null } | null;
      };
      const snapshot: IGitHubCommitAuthorSnapshot = {
        login: value.author?.login ?? null,
        name: value.commit?.author?.name ?? commit.authorName,
        avatarUrl: value.author?.avatar_url ?? null,
        htmlUrl: value.author?.html_url ?? null,
        updatedAt: Date.now(),
      };
      writeCachedGithubCommitAuthor(repoUrl, commit, snapshot);
      return snapshot;
    })
    .catch(() => null)
    .finally(() => {
      pendingGithubAuthorRequests.delete(cacheKey);
    });

  pendingGithubAuthorRequests.set(cacheKey, request);
  return request;
};
