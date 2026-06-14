import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { queryClient } from '@/lib/query-client';
import { tauriService } from '@/services/tauri';
import type {
  IGitBranchPayload,
  IGitCommitDetailPayload,
  IGitCommitFileDiffPayload,
  IGitCommitResultPayload,
  IGitCommitSummaryPayload,
  IGitDiffPreviewPayload,
  IGitFileBaselinePayload,
  IGitPullRequestDetailPayload,
  IGitPullRequestSummaryPayload,
  IGitPullRequestSupportPayload,
  IGitRepositoryStatusPayload,
  IGitStashEntryPayload,
} from '@/types/git';
import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/path';

const MSG_GIT_INIT_NO_REPOSITORY = 'Git 初始化后仍未检测到仓库。';
const MSG_GIT_NO_REPOSITORY_IN_WORKSPACE = '当前工作区未检测到 Git 仓库。';
const PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS = 1200;
const PULL_REQUEST_BACKGROUND_PRELOAD_RETRY_INTERVAL_MS = 60_000;
// PR 列表/详情的缓存/持久化/去重/重验证现由 @tanstack/vue-query 承担(见 src/lib/query-client.ts)。
// 这里只保留查询接线参数与产品级的后台预加载调度/乐观更新逻辑。
const PULL_REQUEST_STALE_TIME_MS = 30_000;
// 保留窗口:作为 PR 查询的 gcTime,让列表/详情快照在缓存/持久化中留存约 7 天。
const PULL_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;
const PULL_REQUEST_DETAIL_PRELOAD_CONCURRENCY = 4;
const PULL_REQUEST_QUERY_PREFIX = ['git', 'pullRequests'];
const PULL_REQUEST_LIST_QUERY_PREFIX = ['git', 'pullRequests', 'list'];
const PULL_REQUEST_DETAIL_QUERY_PREFIX = ['git', 'pullRequests', 'detail'];
// commit-stats 的内存缓存/持久化/gc 现由 @tanstack/vue-query 承担(见 src/lib/query-client.ts)。
// 这里只保留后台批量队列(产品逻辑)与 vue-query 的接线参数。
const GIT_COMMIT_STATS_QUERY_PREFIX = ['git', 'commitStats'];
// 保留窗口:作为 commit-stats 查询的 gcTime,使不可变的 commit 统计在缓存/持久化中留存约 30 天。
const GIT_COMMIT_STATS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GIT_COMMIT_STATS_BACKGROUND_BATCH_LIMIT = 30;
const GIT_COMMIT_STATS_BACKGROUND_DELAY_MS = 320;

const formatGitInitMismatch = (expectedPath: string, actualPath: string): string =>
  `Git 初始化目标不一致:期望 ${expectedPath},实际 ${actualPath}。`;

const createEmptyGitRepositoryStatus = (): IGitRepositoryStatusPayload => ({
  available: false,
  message: null,
  repositoryRootPath: null,
  repositoryName: null,
  gitDirPath: null,
  headBranchName: null,
  headShortName: null,
  headShortOid: null,
  isDetached: false,
  isClean: true,
  ahead: 0,
  behind: 0,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  files: [],
  lastCommit: null,
});

const createEmptyPullRequestSupport = (): IGitPullRequestSupportPayload => ({
  available: false,
  remoteName: null,
  provider: 'unknown',
  repositoryUrl: null,
  pullRequestsUrl: null,
  createPullRequestUrl: null,
});

const deduplicatePaths = (paths: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = normalizeFileSystemPath(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
};

const normalizePullRequestState = (state?: string): 'open' | 'closed' | 'all' => {
  if (state === 'closed' || state === 'all') {
    return state;
  }
  return 'open';
};

const createPullRequestRepositoryScope = (repositoryUrl?: string | null): string => {
  const normalizedRepositoryUrl = repositoryUrl?.trim().toLowerCase();
  return normalizedRepositoryUrl || 'unknown';
};

const createGitCommitStatsCacheKey = (
  repositoryRootPath: string,
  commitId: string,
  repositoryUrl?: string | null,
): string =>
  `${normalizeFileSystemPath(repositoryRootPath)}|${createPullRequestRepositoryScope(repositoryUrl)}|${commitId}`;

// PR 查询键:以(仓库路径, 远端作用域, state/number)唯一标识一个 vue-query 缓存项。
const pullRequestListQueryKey = (
  repositoryRootPath: string,
  state: string,
  repositoryUrl?: string | null,
): Array<string | number> => [
  ...PULL_REQUEST_LIST_QUERY_PREFIX,
  normalizeFileSystemPath(repositoryRootPath),
  createPullRequestRepositoryScope(repositoryUrl),
  state,
];

const pullRequestDetailQueryKey = (
  repositoryRootPath: string,
  pullRequestNumber: number,
  repositoryUrl?: string | null,
): Array<string | number> => [
  ...PULL_REQUEST_DETAIL_QUERY_PREFIX,
  normalizeFileSystemPath(repositoryRootPath),
  createPullRequestRepositoryScope(repositoryUrl),
  pullRequestNumber,
];

const shouldIncludePullRequestInState = (
  pullRequest: IGitPullRequestSummaryPayload,
  state: 'open' | 'closed' | 'all',
): boolean => {
  if (state === 'all') return true;
  if (state === 'open') return pullRequest.state === 'open';
  return pullRequest.state !== 'open';
};

const upsertPullRequestSummary = (
  entries: IGitPullRequestSummaryPayload[],
  pullRequest: IGitPullRequestSummaryPayload,
): IGitPullRequestSummaryPayload[] => {
  const existingIndex = entries.findIndex((entry) => entry.number === pullRequest.number);
  if (existingIndex === -1) return [pullRequest, ...entries];
  const nextEntries = [...entries];
  nextEntries[existingIndex] = pullRequest;
  return nextEntries;
};

const updatePullRequestListForState = (
  entries: IGitPullRequestSummaryPayload[],
  pullRequest: IGitPullRequestSummaryPayload,
  state: 'open' | 'closed' | 'all',
): IGitPullRequestSummaryPayload[] => {
  if (shouldIncludePullRequestInState(pullRequest, state)) {
    return upsertPullRequestSummary(entries, pullRequest);
  }
  return entries.filter((entry) => entry.number !== pullRequest.number);
};

type TStatusFetcher = (workspaceRootPath: string) => Promise<IGitRepositoryStatusPayload>;

type TPathsMutationRequest = {
  repositoryRootPath: string;
  paths: string[];
};

type TPathsMutator = (request: TPathsMutationRequest) => Promise<IGitRepositoryStatusPayload>;

type TLoadPullRequestOptions = {
  force?: boolean;
  preloadDetails?: boolean;
  updateActive?: boolean;
  visibleLoading?: boolean;
};

type TLoadPullRequestDetailOptions = {
  force?: boolean;
  updateActive?: boolean;
  visibleLoading?: boolean;
};

type TGitCommitStatsPayload = {
  commitId: string;
  fileCount: number;
  additions: number;
  deletions: number;
  computedAt: number;
};

export const useGitStore = defineStore('git', () => {
  const status = ref<IGitRepositoryStatusPayload>(createEmptyGitRepositoryStatus());
  const isLoading = ref(false);
  const isCommitting = ref(false);

  const baselineCache = ref<Record<string, IGitFileBaselinePayload>>({});
  const baselineEpoch = ref(0);

  const commitHistory = ref<IGitCommitSummaryPayload[]>([]);
  const commitHistoryHasMore = ref(false);
  const commitHistoryNextOffset = ref<number | null>(0);
  const isCommitHistoryLoading = ref(false);

  const branches = ref<IGitBranchPayload[]>([]);
  const isBranchesLoading = ref(false);

  const stashes = ref<IGitStashEntryPayload[]>([]);
  const isStashesLoading = ref(false);

  const pullRequestSupport = ref<IGitPullRequestSupportPayload>(createEmptyPullRequestSupport());
  const isPullRequestSupportLoading = ref(false);
  const isSettingRemote = ref(false);
  const pullRequests = ref<IGitPullRequestSummaryPayload[]>([]);
  const isPullRequestsLoading = ref(false);
  const pullRequestStateFilter = ref<'open' | 'closed' | 'all'>('open');
  const pullRequestDetail = ref<IGitPullRequestDetailPayload | null>(null);
  const isPullRequestDetailLoading = ref(false);

  const commitDetailCache = ref<Record<string, IGitCommitDetailPayload>>({});
  // commit-stats 的权威缓存在 vue-query;此 ref 仅作响应式镜像,供同步的 getCommitStats 读取并驱动 UI。
  const commitStatsCache = ref<Record<string, TGitCommitStatsPayload>>({});
  const commitFileDiffCache = ref<Record<string, IGitCommitFileDiffPayload>>({});
  const commitFileDiffPreviewCache = ref<Record<string, IGitDiffPreviewPayload>>({});

  // commit-stats 是不可变的 per-commit 统计:大 staleTime 避免重取,gcTime≈30d 作为保留窗口,
  // meta.persist 让官方 persister 仅持久化这一类查询(见 src/lib/query-client.ts)。
  queryClient.setQueryDefaults(GIT_COMMIT_STATS_QUERY_PREFIX, {
    staleTime: GIT_COMMIT_STATS_RETENTION_MS,
    gcTime: GIT_COMMIT_STATS_RETENTION_MS,
    meta: { persist: true },
  });

  // PR 列表/详情:30s 内视为新鲜(对齐原重验证间隔),gcTime≈7d 作为保留窗口,
  // meta.persist 让官方 persister 持久化这一类查询(取代原来的 localStorage 手写快照)。
  queryClient.setQueryDefaults(PULL_REQUEST_QUERY_PREFIX, {
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    gcTime: PULL_REQUEST_RETENTION_MS,
    meta: { persist: true },
  });

  const commitStatsQueryKey = (cacheKey: string): string[] => [
    ...GIT_COMMIT_STATS_QUERY_PREFIX,
    cacheKey,
  ];

  let statusRequestId = 0;
  let commitHistoryRequestId = 0;
  let branchesRequestId = 0;
  let stashesRequestId = 0;
  let pullRequestSupportRequestId = 0;
  let pullRequestsRequestId = 0;
  let pullRequestDetailRequestId = 0;
  let pullRequestDetailPreloadEpoch = 0;
  let pullRequestPreloadTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPullRequestPreloadRepositoryKey: string | null = null;
  let commitStatsBackgroundTimer: ReturnType<typeof setTimeout> | null = null;
  let isCommitStatsBackgroundRunning = false;
  const queuedCommitStatsIds = new Set<string>();
  const pendingCommitStatsRequests = new Set<string>();
  const pullRequestBackgroundPreloadAttemptedAt = new Map<string, number>();

  const pendingBaselineRequests = new Map<string, Promise<IGitFileBaselinePayload>>();
  const pendingCommitDetailRequests = new Map<string, Promise<IGitCommitDetailPayload>>();
  const pendingCommitFileDiffRequests = new Map<string, Promise<IGitCommitFileDiffPayload>>();
  const pendingCommitFileDiffPreviewRequests = new Map<string, Promise<IGitDiffPreviewPayload>>();
  let pendingPullRequestSupportRequest: Promise<IGitPullRequestSupportPayload> | null = null;

  const hasRepository = computed(
    () => status.value.available && Boolean(status.value.repositoryRootPath),
  );
  const totalChangeCount = computed(
    () =>
      status.value.stagedCount +
      status.value.unstagedCount +
      status.value.untrackedCount +
      status.value.conflictedCount,
  );
  const canLoadMoreCommitHistory = computed(
    () => commitHistoryHasMore.value && commitHistoryNextOffset.value !== null,
  );

  const clearPullRequestPreloadTimer = (): void => {
    if (pullRequestPreloadTimer !== null) {
      clearTimeout(pullRequestPreloadTimer);
      pullRequestPreloadTimer = null;
    }
    scheduledPullRequestPreloadRepositoryKey = null;
  };

  const clearCommitStatsBackgroundQueue = (): void => {
    if (commitStatsBackgroundTimer !== null) {
      clearTimeout(commitStatsBackgroundTimer);
      commitStatsBackgroundTimer = null;
    }
    queuedCommitStatsIds.clear();
    pendingCommitStatsRequests.clear();
    isCommitStatsBackgroundRunning = false;
  };

  const clearBaselineCache = (): void => {
    baselineCache.value = {};
    baselineEpoch.value += 1;
    commitDetailCache.value = {};
    commitFileDiffCache.value = {};
    commitFileDiffPreviewCache.value = {};
    clearCommitStatsBackgroundQueue();
  };

  const resetCommitHistory = (): void => {
    commitHistoryRequestId += 1;
    commitHistory.value = [];
    commitHistoryHasMore.value = false;
    commitHistoryNextOffset.value = 0;
  };

  const resetBranches = (): void => {
    branchesRequestId += 1;
    branches.value = [];
  };

  const resetStashes = (): void => {
    stashesRequestId += 1;
    stashes.value = [];
  };

  const createPullRequestSupportIdentity = (support: IGitPullRequestSupportPayload): string =>
    [support.provider || 'unknown', support.remoteName || '', support.repositoryUrl || ''].join(
      '|',
    );

  const hasPullRequestSupportIdentityChanged = (
    previous: IGitPullRequestSupportPayload,
    next: IGitPullRequestSupportPayload,
  ): boolean =>
    createPullRequestSupportIdentity(previous) !== createPullRequestSupportIdentity(next);

  const resetPullRequestSupport = (): void => {
    pullRequestSupportRequestId += 1;
    pendingPullRequestSupportRequest = null;
    pullRequestSupport.value = createEmptyPullRequestSupport();
  };

  // 清除所有 PR 列表/详情查询(vue-query 一并清理内存/持久化/进行中请求)。
  const removePullRequestQueries = (): void => {
    queryClient.removeQueries({ queryKey: PULL_REQUEST_QUERY_PREFIX });
  };

  const shouldPreloadPullRequestDetail = (
    repositoryRootPath: string,
    pullRequestNumber: number,
  ): boolean => {
    const queryKey = pullRequestDetailQueryKey(
      repositoryRootPath,
      pullRequestNumber,
      pullRequestSupport.value.repositoryUrl,
    );
    const query = queryClient.getQueryCache().find({ queryKey });
    if (!query) return true;
    if (query.state.fetchStatus === 'fetching') return false;
    return query.isStale();
  };

  const resetPullRequests = (): void => {
    pullRequestsRequestId += 1;
    pullRequestDetailRequestId += 1;
    pullRequestDetailPreloadEpoch += 1;
    clearPullRequestPreloadTimer();
    pullRequests.value = [];
    pullRequestStateFilter.value = 'open';
    pullRequestDetail.value = null;
    removePullRequestQueries();
  };

  const resetSupplementaryData = (): void => {
    resetCommitHistory();
    resetBranches();
    resetStashes();
    resetPullRequestSupport();
    resetPullRequests();
  };

  const invalidateFileBaseline = (path?: string | null): void => {
    const cacheKey = normalizeFileSystemPath(path);
    if (!cacheKey) return;
    const hasCached = cacheKey in baselineCache.value;
    const hasPending = pendingBaselineRequests.has(cacheKey);
    if (!hasCached && !hasPending) return;
    if (hasCached) {
      const nextCache = { ...baselineCache.value };
      delete nextCache[cacheKey];
      baselineCache.value = nextCache;
    }
    baselineEpoch.value += 1;
  };

  const resolveCommitStatsCacheKey = (commitId: string): string | null => {
    const repositoryRootPath = status.value.repositoryRootPath;
    if (!repositoryRootPath || !commitId) return null;
    return createGitCommitStatsCacheKey(
      repositoryRootPath,
      commitId,
      pullRequestSupport.value.repositoryUrl,
    );
  };

  const rememberCommitStats = (detail: IGitCommitDetailPayload): void => {
    const cacheKey = resolveCommitStatsCacheKey(detail.id);
    if (!cacheKey) return;

    const payload: TGitCommitStatsPayload = {
      commitId: detail.id,
      fileCount: detail.fileCount,
      additions: detail.additions,
      deletions: detail.deletions,
      computedAt: Date.now(),
    };

    // vue-query 承担缓存/gc/持久化;同时写穿响应式镜像,驱动 UI 在后台队列填充时即时更新。
    queryClient.setQueryData(commitStatsQueryKey(cacheKey), payload);
    commitStatsCache.value = {
      ...commitStatsCache.value,
      [cacheKey]: payload,
    };
  };

  const getCommitStats = (commitId: string): TGitCommitStatsPayload | null => {
    const cacheKey = resolveCommitStatsCacheKey(commitId);
    if (!cacheKey) return null;

    const mirrored = commitStatsCache.value[cacheKey];
    if (mirrored) return mirrored;

    // 启动时官方 persister 已把快照恢复进 queryClient;首次读取时回填响应式镜像。
    const restored = queryClient.getQueryData<TGitCommitStatsPayload>(
      commitStatsQueryKey(cacheKey),
    );
    if (restored) {
      commitStatsCache.value = {
        ...commitStatsCache.value,
        [cacheKey]: restored,
      };
      return restored;
    }
    return null;
  };

  const getFileBaseline = async (path: string): Promise<IGitFileBaselinePayload> => {
    const cacheKey = normalizeFileSystemPath(path);
    const cached = baselineCache.value[cacheKey];
    if (cached) return cached;

    const pending = pendingBaselineRequests.get(cacheKey);
    if (pending) return pending;

    const epochAtRequest = baselineEpoch.value;
    const request = tauriService
      .getGitFileBaseline(path)
      .then((payload) => {
        if (epochAtRequest === baselineEpoch.value) {
          baselineCache.value = {
            ...baselineCache.value,
            [cacheKey]: payload,
          };
        }
        return payload;
      })
      .finally(() => {
        pendingBaselineRequests.delete(cacheKey);
      });

    pendingBaselineRequests.set(cacheKey, request);
    return request;
  };

  const loadCommitDetail = async (commitId: string): Promise<IGitCommitDetailPayload> => {
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

  const loadCommitFileDiff = async (
    commitId: string,
    relativePath: string,
  ): Promise<IGitCommitFileDiffPayload> => {
    const cacheKey = `${commitId}:${relativePath}`;
    const cached = commitFileDiffCache.value[cacheKey];
    if (cached) return cached;

    const pending = pendingCommitFileDiffRequests.get(cacheKey);
    if (pending) return pending;

    const request = tauriService
      .getGitCommitFileDiff({
        repositoryRootPath: requireRepositoryRootPath(),
        commitId,
        relativePath,
      })
      .then((payload) => {
        commitFileDiffCache.value = {
          ...commitFileDiffCache.value,
          [cacheKey]: payload,
        };
        return payload;
      })
      .finally(() => {
        pendingCommitFileDiffRequests.delete(cacheKey);
      });

    pendingCommitFileDiffRequests.set(cacheKey, request);
    return request;
  };

  const loadCommitFileDiffPreview = async (
    commitId: string,
    relativePath: string,
  ): Promise<IGitDiffPreviewPayload> => {
    const cacheKey = `${commitId}:${relativePath}`;
    const cached = commitFileDiffPreviewCache.value[cacheKey];
    if (cached) return cached;

    const pending = pendingCommitFileDiffPreviewRequests.get(cacheKey);
    if (pending) return pending;

    const request = tauriService
      .getGitCommitFileDiffPreview({
        repositoryRootPath: requireRepositoryRootPath(),
        commitId,
        relativePath,
      })
      .then((payload) => {
        commitFileDiffPreviewCache.value = {
          ...commitFileDiffPreviewCache.value,
          [cacheKey]: payload,
        };
        return payload;
      })
      .finally(() => {
        pendingCommitFileDiffPreviewR