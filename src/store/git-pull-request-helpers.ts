import type {
  IGitPullRequestSummaryPayload,
  IGitPullRequestSupportPayload,
} from '@/types/git';
import { normalizeFileSystemPath } from '@/utils/path';

/**
 * PR 域的纯函数与 vue-query 接线常量。
 *
 * 这些内容从 src/store/git.ts 抽离,目的是:
 * 1) 缩小 git.ts,使其能在单次编辑中可靠地全量重写;
 * 2) 为 PR 列表/详情迁移到 @tanstack/vue-query 提供统一的 query key 与保留窗口。
 *
 * 注意:这里不包含任何手写 localStorage 持久化逻辑——迁移后由 vue-query
 * 的官方 persister(见 src/lib/query-client.ts)统一承担缓存/gc/持久化。
 */

export type TPullRequestState = 'open' | 'closed' | 'all';

/** vue-query 中 PR 查询的公共前缀,setQueryDefaults 与批量失效均以此为根。 */
export const PULL_REQUEST_QUERY_PREFIX = ['git', 'pullRequests'] as const;
export const PULL_REQUEST_LIST_QUERY_PREFIX = ['git', 'pullRequests', 'list'] as const;
export const PULL_REQUEST_DETAIL_QUERY_PREFIX = ['git', 'pullRequests', 'detail'] as const;

/** 列表视为 30s 内新鲜(staleTime),超过则后台重验证(SWR)。 */
export const PULL_REQUEST_STALE_TIME_MS = 30_000;
/** PR 缓存保留窗口(gcTime):未被订阅后保留 7 天,与原手写持久化的 maxAge 保持一致。 */
export const PULL_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 后台预加载与并发参数(产品逻辑,与缓存实现无关,保留)。 */
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
