import type { IGitPullRequestSummaryPayload, IGitPullRequestSupportPayload } from '@/types/git';
import { normalizeFileSystemPath } from '@/utils/file/path';

/**
 * PR 域的纯函数与 vue-query 接线常量。
 *
 * 独立成模块:把无副作用的 PR 纯函数与查询常量从 git store 的状态逻辑中解耦,
 * 便于单测,并为 PR 列表/详情统一 vue-query 的 query key 与缓存保留窗口。
 *
 * 缓存/gc/持久化均由 vue-query 的官方 persister(见 src/lib/query-client.ts)统一承担,
 * 本模块不含任何手写 localStorage 持久化逻辑。
 */

export type TPullRequestState = 'open' | 'closed' | 'all';

/** vue-query 中 PR 查询的公共前缀,setQueryDefaults 与批量失效均以此为根。 */
export const PULL_REQUEST_QUERY_PREFIX = ['git', 'pullRequests'] as const;
export const PULL_REQUEST_LIST_QUERY_PREFIX = ['git', 'pullRequests', 'list'] as const;
export const PULL_REQUEST_DETAIL_QUERY_PREFIX = ['git', 'pullRequests', 'detail'] as const;

/** 列表视为 30s 内新鲜(staleTime),超过则后台重验证(SWR)。 */
export const PULL_REQUEST_STALE_TIME_MS = 30_000;
/** PR 缓存保留窗口(gcTime):未被任何查询订阅后,缓存再保留 7 天才回收。 */
export const PULL_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 后台预加载与并发参数:属于产品行为,与缓存实现无关。 */
export const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
export const PULL_REQUEST_BACKGROUND_PRELOAD_RETRY_INTERVAL_MS = 60_000;
export const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;
export const PULL_REQUEST_DETAIL_PRELOAD_CONCURRENCY = 4;

export const createEmptyPullRequestSupport = (): IGitPullRequestSupportPayload => ({
  available: false,
  remoteName: null,
  provider: 'unknown',
  repositoryUrl: null,
  pullRequestsUrl: null,
  createPullRequestUrl: null,
});

export const normalizePullRequestState = (state?: string): TPullRequestState => {
  if (state === 'closed' || state === 'all') {
    return state;
  }
  return 'open';
};

export const createPullRequestRepositoryScope = (repositoryUrl?: string | null): string => {
  const normalizedRepositoryUrl = repositoryUrl?.trim().toLowerCase();
  return normalizedRepositoryUrl || 'unknown';
};

/**
 * PR 列表的 vue-query key:按仓库根路径 + 远端作用域 + 状态分片,
 * 使不同仓库/远端/状态的列表互不干扰。
 */
export const pullRequestListQueryKey = (
  repositoryRootPath: string,
  state: TPullRequestState,
  repositoryUrl?: string | null,
): (string | TPullRequestState)[] => [
  ...PULL_REQUEST_LIST_QUERY_PREFIX,
  normalizeFileSystemPath(repositoryRootPath),
  createPullRequestRepositoryScope(repositoryUrl),
  state,
];

/** PR 详情的 vue-query key:按仓库根路径 + 远端作用域 + PR 编号。 */
export const pullRequestDetailQueryKey = (
  repositoryRootPath: string,
  number: number,
  repositoryUrl?: string | null,
): (string | number)[] => [
  ...PULL_REQUEST_DETAIL_QUERY_PREFIX,
  normalizeFileSystemPath(repositoryRootPath),
  createPullRequestRepositoryScope(repositoryUrl),
  number,
];

export const shouldIncludePullRequestInState = (
  pullRequest: IGitPullRequestSummaryPayload,
  state: TPullRequestState,
): boolean => {
  if (state === 'all') return true;
  if (state === 'open') return pullRequest.state === 'open';
  return pullRequest.state !== 'open';
};

export const upsertPullRequestSummary = (
  entries: IGitPullRequestSummaryPayload[],
  pullRequest: IGitPullRequestSummaryPayload,
): IGitPullRequestSummaryPayload[] => {
  const existingIndex = entries.findIndex((entry) => entry.number === pullRequest.number);
  if (existingIndex === -1) return [pullRequest, ...entries];
  const nextEntries = [...entries];
  nextEntries[existingIndex] = pullRequest;
  return nextEntries;
};

export const updatePullRequestListForState = (
  entries: IGitPullRequestSummaryPayload[],
  pullRequest: IGitPullRequestSummaryPayload,
  state: TPullRequestState,
): IGitPullRequestSummaryPayload[] => {
  if (shouldIncludePullRequestInState(pullRequest, state)) {
    return upsertPullRequestSummary(entries, pullRequest);
  }
  return entries.filter((entry) => entry.number !== pullRequest.number);
};
