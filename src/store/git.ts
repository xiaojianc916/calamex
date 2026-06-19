import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
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
import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/file/path';
import {
  createEmptyPullRequestSupport,
  createPullRequestRepositoryScope,
  normalizePullRequestState,
  PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS,
  PULL_REQUEST_BACKGROUND_PRELOAD_RETRY_INTERVAL_MS,
  PULL_REQUEST_DETAIL_PRELOAD_CONCURRENCY,
  PULL_REQUEST_DETAIL_PRELOAD_LIMIT,
  PULL_REQUEST_LIST_QUERY_PREFIX,
  PULL_REQUEST_QUERY_PREFIX,
  PULL_REQUEST_RETENTION_MS,
  PULL_REQUEST_STALE_TIME_MS,
  pullRequestDetailQueryKey,
  pullRequestListQueryKey,
  type TPullRequestState,
  updatePullRequestListForState,
} from './git-pull-request-helpers';

const MSG_GIT_INIT_NO_REPOSITORY = 'Git 初始化后仍未检测到仓库。';
const MSG_GIT_NO_REPOSITORY_IN_WORKSPACE = '当前工作区未检测到 Git 仓库。';
// commit-stats 的内存缓存/持久化/gc 现由 @tanstack/vue-query 承担(见 src/lib/query-client.ts)。
// 这里只保留后台批量队列(产品逻辑)与 vue-query 的接线参数。
const GIT_COMMIT_STATS_QUERY_PREFIX = ['git', 'commitStats'];
// 保留窗口:作为 commit-stats 查询的 gcTime,使不可变的 commit 统计在缓存/持久化中留存约 30 天。
const GIT_COMMIT_STATS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GIT_COMMIT_STATS_BACKGROUND_BATCH_LIMIT = 30;
const GIT_COMMIT_STATS_BACKGROUND_DELAY_MS = 320;
// 提交详情/文件 diff/diff 预览均按 commit-id(及路径)寻址,内容不可变:
// 交由 vue-query 缓存 + fetchQuery 去重,替代手写 Record 缓存与 pending 请求表。
const GIT_COMMIT_DETAIL_QUERY_PREFIX = ['git', 'commitDetail'];
const GIT_COMMIT_FILE_DIFF_QUERY_PREFIX = ['git', 'commitFileDiff'];
const GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX = ['git', 'commitFileDiffPreview'];

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

const createGitCommitStatsCacheKey = (
  repositoryRootPath: string,
  commitId: string,
  repositoryUrl?: string | null,
): string =>
  `${normalizeFileSystemPath(repositoryRootPath)}|${createPullRequestRepositoryScope(repositoryUrl)}|${commitId}`;

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

  // baseline 缓存已迁入 vue-query：fetchQuery 去重 + staleTime=Infinity，
  // 失效用 removeQueries。baselineEpoch 保留供调用方判断 baseline 是否已刷新。
  const baselineEpoch = ref(0);

  const commitHistory = shallowRef<IGitCommitSummaryPayload[]>([]);
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
  const pullRequestStateFilter = ref<TPullRequestState>('open');
  const pullRequestDetail = ref<IGitPullRequestDetailPayload | null>(null);
  const isPullRequestDetailLoading = ref(false);

  // commit-stats 的权威缓存在 vue-query;此 ref 仅作响应式镜像,供同步的 getCommitStats 读取并驱动 UI。
  const commitStatsCache = ref<Record<string, TGitCommitStatsPayload>>({});

  // commit-stats 是不可变的 per-commit 统计:大 staleTime 避免重取,gcTime≈30d 作为保留窗口,
  // meta.persist 让官方 persister 仅持久化这一类查询(见 src/lib/query-client.ts)。
  queryClient.setQueryDefaults(GIT_COMMIT_STATS_QUERY_PREFIX, {
    staleTime: GIT_COMMIT_STATS_RETENTION_MS,
    gcTime: GIT_COMMIT_STATS_RETENTION_MS,
    meta: { persist: true },
  });

  // PR 列表/详情:列表视为 30s 内新鲜,gcTime≈7d 作为保留窗口(替代原手写 maxAge),
  // meta.persist 交由官方 persister 持久化(替代原手写的 localStorage 缓存)。
  queryClient.setQueryDefaults(PULL_REQUEST_QUERY_PREFIX, {
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    gcTime: PULL_REQUEST_RETENTION_MS,
    meta: { persist: true },
  });

  // 提交详情/文件 diff/diff 预览按 commit-id(及路径)寻址,内容不可变:
  // staleTime=Infinity 命中即复用、永不后台重取;不持久化(无 meta.persist,仅内存),
  // 切换工作树/提交时由 clearBaselineCache 通过 removeQueries 清空。
  queryClient.setQueryDefaults(GIT_COMMIT_DETAIL_QUERY_PREFIX, { staleTime: Infinity });
  queryClient.setQueryDefaults(GIT_COMMIT_FILE_DIFF_QUERY_PREFIX, { staleTime: Infinity });
  queryClient.setQueryDefaults(GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX, { staleTime: Infinity });

  const commitStatsQueryKey = (cacheKey: string): string[] => [
    ...GIT_COMMIT_STATS_QUERY_PREFIX,
    cacheKey,
  ];

  const commitDetailQueryKey = (repositoryRootPath: string, commitId: string): string[] => [
    ...GIT_COMMIT_DETAIL_QUERY_PREFIX,
    normalizeFileSystemPath(repositoryRootPath),
    commitId,
  ];

  const commitFileDiffQueryKey = (
    repositoryRootPath: string,
    commitId: string,
    relativePath: string,
  ): string[] => [
    ...GIT_COMMIT_FILE_DIFF_QUERY_PREFIX,
    normalizeFileSystemPath(repositoryRootPath),
    commitId,
    relativePath,
  ];

  const commitFileDiffPreviewQueryKey = (
    repositoryRootPath: string,
    commitId: string,
    relativePath: string,
  ): string[] => [
    ...GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX,
    normalizeFileSystemPath(repositoryRootPath),
    commitId,
    relativePath,
  ];

  const fileBaselineQueryKey = (path: string): string[] => [
    ...GIT_FILE_BASELINE_QUERY_PREFIX,
    normalizeFileSystemPath(path),
  ];

  let statusRequestId = 0;
  let commitHistoryRequestId = 0;
  let branchesRequestId = 0;
  let stashesRequestId = 0;
  let pullRequestSupportRequestId = 0;
  let pullRequestsRequestId = 0;
  let pullRequestDetailRequestId = 0;
  let pullRequestDetailPreloadEpoch = 0;
  // 仅用于守卫异步结果写回活动 ref:当 reset/setRemote/作用域变更推进 epoch 后,旧请求不再生效。
  let pullRequestCacheEpoch = 0;
  let pullRequestPreloadTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPullRequestPreloadRepositoryKey: string | null = null;
  let commitStatsBackgroundTimer: ReturnType<typeof setTimeout> | null = null;
  let isCommitStatsBackgroundRunning = false;
  const queuedCommitStatsIds = new Set<string>();
  const pendingCommitStatsRequests = new Set<string>();
  const pullRequestBackgroundPreloadAttemptedAt = new Map<string, number>();

  const pendingBaselineRequests = new Map<string, Promise<IGitFileBaselinePayload>>();
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
      // timer 可能是 setTimeout handle 或 requestIdleCallback handle。
      // 两种都尝试取消：cancelIdleCallback 不支持时静默跳过。
      if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(commitStatsBackgroundTimer as unknown as number);
      }
      clearTimeout(commitStatsBackgroundTimer);
      commitStatsBackgroundTimer = null;
    }
    queuedCommitStatsIds.clear();
    pendingCommitStatsRequests.clear();
    isCommitStatsBackgroundRunning = false;
  };

  const clearBaselineCache = (): void => {
    queryClient.removeQueries({ queryKey: [...GIT_FILE_BASELINE_QUERY_PREFIX] });
    baselineEpoch.value += 1;
    // 以 vue-query 为唯一缓存:切换工作树/提交时清空提交详情与文件 diff 查询(含进行中的请求)。
    queryClient.removeQueries({ queryKey: [...GIT_COMMIT_DETAIL_QUERY_PREFIX] });
    queryClient.removeQueries({ queryKey: [...GIT_COMMIT_FILE_DIFF_QUERY_PREFIX] });
    queryClient.removeQueries({ queryKey: [...GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX] });
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

  const resetPullRequests = (): void => {
    pullRequestsRequestId += 1;
    pullRequestDetailRequestId += 1;
    pullRequestDetailPreloadEpoch += 1;
    pullRequestCacheEpoch += 1;
    clearPullRequestPreloadTimer();
    pullRequests.value = [];
    pullRequestStateFilter.value = 'open';
    pullRequestDetail.value = null;
    // 以 vue-query 为唯一缓存:移除所有 PR 列表/详情查询(以及其持久化快照)。
    queryClient.removeQueries({ queryKey: [...PULL_REQUEST_QUERY_PREFIX] });
  };

  const resetSupplementaryData = (): void => {
    resetCommitHistory();
    resetBranches();
    resetStashes();
    resetPullRequestSupport();
    resetPullRequests();
  };

  // invalidateFileBaseline：从 vue-query 移除指定路径的 baseline 查询，
  // 下次 getFileBaseline 会重新发请求。同时推进 epoch 让调用方感知变化。
  const invalidateFileBaseline = (path?: string | null): void => {
    if (!path) return;
    const cacheKey = normalizeFileSystemPath(path);
    if (!cacheKey) return;
    queryClient.removeQueries({ queryKey: fileBaselineQueryKey(path) });
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

  // file baseline 已迁入 vue-query：fetchQuery 自动去重同 key 请求，
  // staleTime=Infinity 命中即复用。文件被修改后由 invalidateFileBaseline 调 removeQueries 失效。
  const getFileBaseline = async (path: string): Promise<IGitFileBaselinePayload> => {
    return queryClient.fetchQuery<IGitFileBaselinePayload>({
      queryKey: fileBaselineQueryKey(path),
      queryFn: () => tauriService.getGitFileBaseline(path),
    });
  };

  const loadCommitDetail = async (commitId: string): Promise<IGitCommitDetailPayload> => {
    const repositoryRootPath = requireRepositoryRootPath();
    // fetchQuery 复用进行中的请求,并按 staleTime=Infinity 永久复用已取详情(commit 内容不可变)。
    const payload = await queryClient.fetchQuery<IGitCommitDetailPayload>({
      queryKey: commitDetailQueryKey(repositoryRootPath, commitId),
      queryFn: () => tauriService.getGitCommitDetail({ repositoryRootPath, commitId }),
    });
    if (!getCommitStats(commitId)) {
      rememberCommitStats(payload);
    }
    return payload;
  };

  const loadCommitStatsOnly = async (commitId: string): Promise<void> => {
    if (getCommitStats(commitId)) return;

    const repositoryRootPath = requireRepositoryRootPath();
    // 复用用户已展开缓存的完整详情(若有);否则后台直取,仅记录轻量统计,
    // 不写入 commitDetail 查询缓存,避免把整段历史的 files[] 灌进内存。
    const cachedDetail = queryClient.getQueryData<IGitCommitDetailPayload>(
      commitDetailQueryKey(repositoryRootPath, commitId),
    );
    if (cachedDetail) {
      rememberCommitStats(cachedDetail);
      return;
    }

    const payload = await tauriService.getGitCommitDetail({ repositoryRootPath, commitId });
    rememberCommitStats(payload);
  };

  const loadCommitFileDiff = async (
    commitId: string,
    relativePath: string,
  ): Promise<IGitCommitFileDiffPayload> => {
    const repositoryRootPath = requireRepositoryRootPath();
    return queryClient.fetchQuery<IGitCommitFileDiffPayload>({
      queryKey: commitFileDiffQueryKey(repositoryRootPath, commitId, relativePath),
      queryFn: () =>
        tauriService.getGitCommitFileDiff({ repositoryRootPath, commitId, relativePath }),
    });
  };

  const loadCommitFileDiffPreview = async (
    commitId: string,
    relativePath: string,
  ): Promise<IGitDiffPreviewPayload> => {
    const repositoryRootPath = requireRepositoryRootPath();
    return queryClient.fetchQuery<IGitDiffPreviewPayload>({
      queryKey: commitFileDiffPreviewQueryKey(repositoryRootPath, commitId, relativePath),
      queryFn: () =>
        tauriService.getGitCommitFileDiffPreview({ repositoryRootPath, commitId, relativePath }),
    });
  };

  const drainCommitStatsBackgroundQueue = async (): Promise<void> => {
    if (isCommitStatsBackgroundRunning) return;

    isCommitStatsBackgroundRunning = true;
    try {
      while (queuedCommitStatsIds.size > 0) {
        const commitId = queuedCommitStatsIds.values().next().value;
        if (!commitId) break;

        queuedCommitStatsIds.delete(commitId);

        if (getCommitStats(commitId) || pendingCommitStatsRequests.has(commitId)) {
          continue;
        }

        pendingCommitStatsRequests.add(commitId);
        try {
          await loadCommitStatsOnly(commitId);
        } catch (error) {
          console.warn('[git] background commit stats load failed', error);
        } finally {
          pendingCommitStatsRequests.delete(commitId);
        }
      }
    } finally {
      isCommitStatsBackgroundRunning = false;
    }
  };

  const scheduleCommitStatsBackgroundQueue = (): void => {
    if (commitStatsBackgroundTimer !== null || isCommitStatsBackgroundRunning) return;

    const run = (): void => {
      commitStatsBackgroundTimer = null;
      void drainCommitStatsBackgroundQueue();
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      // requestIdleCallback 的 timeout 参数保证回调最终一定执行，
      // 不需要额外加 setTimeout fallback（原双层超时是冗余的防御）。
      // commitStatsBackgroundTimer 存 idleId，取消时用 cancelIdleCallback。
      const idleId = window.requestIdleCallback(run, {
        timeout: GIT_COMMIT_STATS_BACKGROUND_DELAY_MS * 4,
      });
      // 保存 idleId 以便 clearCommitStatsBackgroundQueue 取消。
      // 不支持 cancelIdleCallback 的环境（旧 WebView2）退化为 no-op。
      commitStatsBackgroundTimer = idleId as unknown as ReturnType<typeof setTimeout>;
      return;
    }

    commitStatsBackgroundTimer = setTimeout(run, GIT_COMMIT_STATS_BACKGROUND_DELAY_MS);
  };

  const enqueueCommitStats = (commitId: string): void => {
    if (!status.value.repositoryRootPath || !commitId || getCommitStats(commitId)) return;
    if (pendingCommitStatsRequests.has(commitId)) return;
    queuedCommitStatsIds.add(commitId);
    scheduleCommitStatsBackgroundQueue();
  };

  const enqueueCommitStatsForCommits = (
    commits: readonly IGitCommitSummaryPayload[],
    limit = GIT_COMMIT_STATS_BACKGROUND_BATCH_LIMIT,
  ): void => {
    for (const item of commits.slice(0, limit)) {
      enqueueCommitStats(item.id);
    }
  };

  const reset = (): void => {
    statusRequestId += 1;
    commitHistoryRequestId += 1;
    branchesRequestId += 1;
    stashesRequestId += 1;
    pullRequestSupportRequestId += 1;
    pullRequestsRequestId += 1;
    pullRequestDetailRequestId += 1;
    pullRequestDetailPreloadEpoch += 1;
    clearPullRequestPreloadTimer();
    clearCommitStatsBackgroundQueue();

    isLoading.value = false;
    isCommitting.value = false;
    isCommitHistoryLoading.value = false;
    isBranchesLoading.value = false;
    isStashesLoading.value = false;
    isPullRequestSupportLoading.value = false;
    isPullRequestsLoading.value = false;
    isPullRequestDetailLoading.value = false;

    status.value = createEmptyGitRepositoryStatus();
    clearBaselineCache();
    resetSupplementaryData();
  };

  const schedulePullRequestPreload = (): void => {
    const repositoryRootPath = status.value.repositoryRootPath;
    if (!hasRepository.value || !repositoryRootPath) {
      clearPullRequestPreloadTimer();
      return;
    }

    const repositoryKey = normalizeFileSystemPath(repositoryRootPath);
    if (!repositoryKey) {
      clearPullRequestPreloadTimer();
      return;
    }

    const lastAttemptedAt = pullRequestBackgroundPreloadAttemptedAt.get(repositoryKey) ?? 0;
    const isWithinRetryBudget =
      Date.now() - lastAttemptedAt < PULL_REQUEST_BACKGROUND_PRELOAD_RETRY_INTERVAL_MS;

    if (isWithinRetryBudget) {
      return;
    }

    if (
      pullRequestPreloadTimer !== null &&
      scheduledPullRequestPreloadRepositoryKey === repositoryKey
    ) {
      return;
    }

    clearPullRequestPreloadTimer();
    scheduledPullRequestPreloadRepositoryKey = repositoryKey;

    pullRequestPreloadTimer = setTimeout(() => {
      pullRequestPreloadTimer = null;
      scheduledPullRequestPreloadRepositoryKey = null;
      pullRequestBackgroundPreloadAttemptedAt.set(repositoryKey, Date.now());
      void preloadPullRequestsInBackground();
    }, PULL_REQUEST_BACKGROUND_PRELOAD_DELAY_MS);
  };

  const applyStatus = (payload: IGitRepositoryStatusPayload): IGitRepositoryStatusPayload => {
    const previousRepositoryRoot = normalizeFileSystemPath(status.value.repositoryRootPath);
    const nextRepositoryRoot = normalizeFileSystemPath(payload.repositoryRootPath);
    status.value = payload;
    if (previousRepositoryRoot !== nextRepositoryRoot || !payload.available) {
      clearBaselineCache();
      resetSupplementaryData();
    }
    if (payload.available && payload.repositoryRootPath) {
      schedulePullRequestPreload();
    }
    return payload;
  };

  const applyStatusFromMutation = (
    payload: IGitRepositoryStatusPayload,
  ): IGitRepositoryStatusPayload => {
    statusRequestId += 1;
    isLoading.value = false;
    return applyStatus(payload);
  };

  const assertInitializedRepositoryStatus = (
    payload: IGitRepositoryStatusPayload,
    workspaceRootPath: string,
  ): void => {
    if (!payload.available || !payload.repositoryRootPath) {
      throw new Error(payload.message ?? MSG_GIT_INIT_NO_REPOSITORY);
    }
    if (!areFileSystemPathsEqual(payload.repositoryRootPath, workspaceRootPath)) {
      throw new Error(formatGitInitMismatch(workspaceRootPath, payload.repositoryRootPath));
    }
  };

  const runStatusRequest = async (
    workspaceRootPath: string | null | undefined,
    fetchPayload: TStatusFetcher,
    validatePayload?: (payload: IGitRepositoryStatusPayload, workspaceRootPath: string) => void,
  ): Promise<IGitRepositoryStatusPayload> => {
    if (!workspaceRootPath) {
      reset();
      return status.value;
    }
    const requestId = ++statusRequestId;
    isLoading.value = true;
    try {
      const payload = await fetchPayload(workspaceRootPath);
      if (requestId !== statusRequestId) return status.value;
      validatePayload?.(payload, workspaceRootPath);
      return applyStatus(payload);
    } finally {
      if (requestId === statusRequestId) {
        isLoading.value = false;
      }
    }
  };

  const refreshRepositoryStatus = (
    workspaceRootPath?: string | null,
  ): Promise<IGitRepositoryStatusPayload> =>
    runStatusRequest(workspaceRootPath, (path) => tauriService.getGitRepositoryStatus(path));

  const initRepository = (
    workspaceRootPath?: string | null,
  ): Promise<IGitRepositoryStatusPayload> =>
    runStatusRequest(
      workspaceRootPath,
      (path) => tauriService.initGitRepository(path),
      assertInitializedRepositoryStatus,
    );

  const requireRepositoryRootPath = (): string => {
    const repositoryRootPath = status.value.repositoryRootPath;
    if (!repositoryRootPath) {
      throw new Error(MSG_GIT_NO_REPOSITORY_IN_WORKSPACE);
    }
    return repositoryRootPath;
  };

  const runPathsMutation = async (
    paths: string[],
    mutate: TPathsMutator,
    onSuccess?: (deduplicatedPaths: string[]) => void,
  ): Promise<IGitRepositoryStatusPayload> => {
    const deduplicatedPaths = deduplicatePaths(paths);
    if (deduplicatedPaths.length === 0) return status.value;
    const payload = await mutate({
      repositoryRootPath: requireRepositoryRootPath(),
      paths: deduplicatedPaths,
    });
    onSuccess?.(deduplicatedPaths);
    return applyStatusFromMutation(payload);
  };

  const stagePaths = (paths: string[]): Promise<IGitRepositoryStatusPayload> =>
    runPathsMutation(paths, (request) => tauriService.stageGitPaths(request));

  const unstagePaths = (paths: string[]): Promise<IGitRepositoryStatusPayload> =>
    runPathsMutation(paths, (request) => tauriService.unstageGitPaths(request));

  const discardPaths = (paths: string[]): Promise<IGitRepositoryStatusPayload> =>
    runPathsMutation(
      paths,
      (request) => tauriService.discardGitPaths(request),
      (deduplicatedPaths) => deduplicatedPaths.forEach(invalidateFileBaseline),
    );

  const commitIndex = async (message: string): Promise<IGitCommitResultPayload> => {
    isCommitting.value = true;
    try {
      const payload = await tauriService.commitGitIndex({
        repositoryRootPath: requireRepositoryRootPath(),
        message,
        paths: [],
      });
      applyStatusFromMutation(payload.status);
      clearBaselineCache();
      if (payload.commitId) {
        enqueueCommitStats(payload.commitId);
      }
      return payload;
    } finally {
      isCommitting.value = false;
    }
  };

  const loadCommitHistory = async (options?: {
    append?: boolean;
    limit?: number;
  }): Promise<IGitCommitSummaryPayload[]> => {
    const append = options?.append ?? false;
    const nextOffset = append ? commitHistoryNextOffset.value : 0;
    if (append && nextOffset === null) return commitHistory.value;
    const requestId = ++commitHistoryRequestId;
    isCommitHistoryLoading.value = true;
    try {
      const payload = await tauriService.listGitCommitHistory({
        repositoryRootPath: requireRepositoryRootPath(),
        offset: nextOffset ?? 0,
        limit: options?.limit ?? null,
      });
      if (requestId !== commitHistoryRequestId) return commitHistory.value;
      if (append) {
        // shallowRef 不追踪原地 mutate,必须整体替换以触发响应性。
        commitHistory.value = commitHistory.value.concat(payload.entries);
      } else {
        commitHistory.value = payload.entries;
      }
      enqueueCommitStatsForCommits(payload.entries);
      commitHistoryHasMore.value = payload.hasMore;
      commitHistoryNextOffset.value = payload.nextOffset;
      return commitHistory.value;
    } finally {
      if (requestId === commitHistoryRequestId) {
        isCommitHistoryLoading.value = false;
      }
    }
  };

  const loadBranches = async (): Promise<IGitBranchPayload[]> => {
    const requestId = ++branchesRequestId;
    isBranchesLoading.value = true;
    try {
      const payload = await tauriService.listGitBranches({
        repositoryRootPath: requireRepositoryRootPath(),
      });
      if (requestId !== branchesRequestId) return branches.value;
      branches.value = payload.branches;
      return branches.value;
    } finally {
      if (requestId === branchesRequestId) {
        isBranchesLoading.value = false;
      }
    }
  };

  const loadStashes = async (): Promise<IGitStashEntryPayload[]> => {
    const requestId = ++stashesRequestId;
    isStashesLoading.value = true;
    try {
      const payload = await tauriService.listGitStashes({
        repositoryRootPath: requireRepositoryRootPath(),
      });
      if (requestId !== stashesRequestId) return stashes.value;
      stashes.value = payload.entries;
      return stashes.value;
    } finally {
      if (requestId === stashesRequestId) {
        isStashesLoading.value = false;
      }
    }
  };

  const loadPullRequestSupport = async (): Promise<IGitPullRequestSupportPayload> => {
    if (pendingPullRequestSupportRequest) return pendingPullRequestSupportRequest;

    const requestId = ++pullRequestSupportRequestId;
    isPullRequestSupportLoading.value = true;
    const request = tauriService
      .getGitPullRequestSupport({
        repositoryRootPath: requireRepositoryRootPath(),
      })
      .then((payload) => {
        if (requestId === pullRequestSupportRequestId) {
          const previousSupport = pullRequestSupport.value;
          if (hasPullRequestSupportIdentityChanged(previousSupport, payload)) {
            // 远端/作用域变更:清空旧 PR 查询(removeQueries 会一并清理持久化快照)。
            resetPullRequests();
          }
          pullRequestSupport.value = payload;
        }
        return requestId === pullRequestSupportRequestId ? pullRequestSupport.value : payload;
      })
      .finally(() => {
        if (pendingPullRequestSupportRequest === request) pendingPullRequestSupportRequest = null;
        if (requestId === pullRequestSupportRequestId) {
          isPullRequestSupportLoading.value = false;
        }
      });

    pendingPullRequestSupportRequest = request;
    return request;
  };

  const applyPullRequestSummaryMutation = (pullRequest: IGitPullRequestSummaryPayload): void => {
    const repositoryRootPath = status.value.repositoryRootPath;
    if (!repositoryRootPath) return;

    pullRequestsRequestId += 1;
    const repositoryUrl = pullRequestSupport.value.repositoryUrl;

    // 该 PR 的详情可能已变;移除详情查询,下次访问重取。
    queryClient.removeQueries({
      queryKey: pullRequestDetailQueryKey(repositoryRootPath, pullRequest.number, repositoryUrl),
    });

    const normalizedRepositoryRoot = normalizeFileSystemPath(repositoryRootPath);
    const repositoryScope = createPullRequestRepositoryScope(repositoryUrl);

    // 对当前仓库+远端作用域下已缓存的所有列表查询,按状态合并/移除该 PR。
    const existingLists = queryClient.getQueriesData<IGitPullRequestSummaryPayload[]>({
      queryKey: [...PULL_REQUEST_LIST_QUERY_PREFIX],
    });
    const touchedStates = new Set<TPullRequestState>();
    for (const [queryKey, existing] of existingLists) {
      const keyParts = queryKey as Array<string | number>;
      const keyRepositoryRoot = keyParts[3];
      const keyScope = keyParts[4];
      if (keyRepositoryRoot !== normalizedRepositoryRoot || keyScope !== repositoryScope) {
        continue;
      }
      const state = normalizePullRequestState(
        typeof keyParts[5] === 'string' ? keyParts[5] : undefined,
      );
      queryClient.setQueryData<IGitPullRequestSummaryPayload[]>(
        queryKey,
        updatePullRequestListForState(existing ?? [], pullRequest, state),
      );
      touchedStates.add(state);
    }

    // 保证当前过滤状态与 'all' 即使未缓存也被种子,供 UI 立即反映。
    const seedStates: TPullRequestState[] = [pullRequestStateFilter.value, 'all'];
    for (const state of seedStates) {
      if (touchedStates.has(state)) continue;
      const queryKey = pullRequestListQueryKey(repositoryRootPath, state, repositoryUrl);
      const existing = queryClient.getQueryData<IGitPullRequestSummaryPayload[]>(queryKey);
      queryClient.setQueryData<IGitPullRequestSummaryPayload[]>(
        queryKey,
        updatePullRequestListForState(existing ?? [], pullRequest, state),
      );
    }

    pullRequests.value = updatePullRequestListForState(
      pullRequests.value,
      pullRequest,
      pullRequestStateFilter.value,
    );
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
    const queryState = queryClient.getQueryState<IGitPullRequestDetailPayload>(queryKey);
    if (!queryState || queryState.data === undefined) {
      return true;
    }
    if (queryState.fetchStatus === 'fetching') {
      return false;
    }
    return (
      queryState.isInvalidated ||
      Date.now() - queryState.dataUpdatedAt >= PULL_REQUEST_STALE_TIME_MS
    );
  };

  const runPullRequestDetailPreloadQueue = async (
    entries: IGitPullRequestSummaryPayload[],
    epoch: number,
  ): Promise<void> => {
    const repositoryRootPath = status.value.repositoryRootPath;
    if (!repositoryRootPath) return;

    const candidates = entries
      .slice(0, PULL_REQUEST_DETAIL_PRELOAD_LIMIT)
      .filter((pullRequest) =>
        shouldPreloadPullRequestDetail(repositoryRootPath, pullRequest.number),
      );
    let nextIndex = 0;

    const preloadNext = async (): Promise<void> => {
      while (epoch === pullRequestDetailPreloadEpoch && nextIndex < candidates.length) {
        const pullRequest = candidates[nextIndex];
        nextIndex += 1;
        await loadPullRequestDetail(pullRequest.number, {
          updateActive: false,
          visibleLoading: false,
        }).catch((error) => {
          console.warn('[git] background PR detail preload failed', pullRequest.number, error);
        });
      }
    };

    const workerCount = Math.min(PULL_REQUEST_DETAIL_PRELOAD_CONCURRENCY, candidates.length);
    await Promise.all(Array.from({ length: workerCount }, () => preloadNext()));
  };

  const preloadTopPullRequestDetails = (entries: IGitPullRequestSummaryPayload[]): void => {
    if (entries.length === 0) return;
    pullRequestDetailPreloadEpoch += 1;
    const epoch = pullRequestDetailPreloadEpoch;
    void runPullRequestDetailPreloadQueue(entries, epoch);
  };

  const loadPullRequests = async (
    state?: string,
    options?: TLoadPullRequestOptions,
  ): Promise<IGitPullRequestSummaryPayload[]> => {
    const selectedState = normalizePullRequestState(state ?? pullRequestStateFilter.value);
    const updateActive = options?.updateActive ?? true;
    const visibleLoading = options?.visibleLoading ?? updateActive;
    const shouldPreloadDetails = options?.preloadDetails ?? true;
    const force = options?.force ?? false;

    if (updateActive) {
      pullRequestStateFilter.value = selectedState;
    }

    const repositoryRootPath = requireRepositoryRootPath();
    const queryKey = pullRequestListQueryKey(
      repositoryRootPath,
      selectedState,
      pullRequestSupport.value.repositoryUrl,
    );

    // 先用已缓存/持久化恢复的数据即时填充 UI(SWR 的 stale 部分)。
    const cached = queryClient.getQueryData<IGitPullRequestSummaryPayload[]>(queryKey);
    if (cached && updateActive) {
      pullRequests.value = cached;
    }

    const cacheEpochAtRequest = pullRequestCacheEpoch;
    const requestId = updateActive ? ++pullRequestsRequestId : pullRequestsRequestId;
    if (visibleLoading) isPullRequestsLoading.value = true;

    try {
      // fetchQuery 会复用进行中的请求并尊重 staleTime;force 时置 0 强制重取。
      const payload = await queryClient.fetchQuery<IGitPullRequestSummaryPayload[]>({
        queryKey,
        queryFn: () =>
          tauriService.listGitPullRequests({ repositoryRootPath, state: selectedState }),
        staleTime: force ? 0 : PULL_REQUEST_STALE_TIME_MS,
      });

      if (cacheEpochAtRequest !== pullRequestCacheEpoch) {
        return updateActive && requestId === pullRequestsRequestId ? pullRequests.value : payload;
      }

      if (updateActive && requestId === pullRequestsRequestId) {
        pullRequests.value = payload;
      }
      if (shouldPreloadDetails) {
        preloadTopPullRequestDetails(payload);
      }
      return updateActive && requestId === pullRequestsRequestId ? pullRequests.value : payload;
    } catch (error) {
      if (cached) {
        // 重验证失败时降级为以旧缓存继续服务。
        return cached;
      }
      throw error;
    } finally {
      if (visibleLoading && requestId === pullRequestsRequestId) {
        isPullRequestsLoading.value = false;
      }
    }
  };

  const loadPullRequestDetail = async (
    number: number,
    options?: TLoadPullRequestDetailOptions,
  ): Promise<IGitPullRequestDetailPayload> => {
    const updateActive = options?.updateActive ?? true;
    const visibleLoading = options?.visibleLoading ?? updateActive;
    const force = options?.force ?? false;
    const repositoryRootPath = requireRepositoryRootPath();
    const queryKey = pullRequestDetailQueryKey(
      repositoryRootPath,
      number,
      pullRequestSupport.value.repositoryUrl,
    );

    const cached = queryClient.getQueryData<IGitPullRequestDetailPayload>(queryKey);
    if (cached && updateActive) {
      pullRequestDetail.value = cached;
    }

    const cacheEpochAtRequest = pullRequestCacheEpoch;
    const requestId = updateActive ? ++pullRequestDetailRequestId : pullRequestDetailRequestId;
    if (visibleLoading) isPullRequestDetailLoading.value = true;

    try {
      const payload = await queryClient.fetchQuery<IGitPullRequestDetailPayload>({
        queryKey,
        queryFn: () => tauriService.getGitPullRequestDetail({ repositoryRootPath, number }),
        staleTime: force ? 0 : PULL_REQUEST_STALE_TIME_MS,
      });

      if (cacheEpochAtRequest !== pullRequestCacheEpoch) {
        return payload;
      }
      if (updateActive && requestId === pullRequestDetailRequestId) {
        pullRequestDetail.value = payload;
      }
      return payload;
    } catch (error) {
      if (cached) {
        return cached;
      }
      throw error;
    } finally {
      if (visibleLoading && requestId === pullRequestDetailRequestId) {
        isPullRequestDetailLoading.value = false;
      }
    }
  };

  const ensurePullRequestsLoaded = async (
    state?: string,
  ): Promise<IGitPullRequestSummaryPayload[]> => {
    const support = await loadPullRequestSupport();
    if (!support.available) return [];
    return loadPullRequests(state, {
      preloadDetails: false,
      updateActive: true,
      visibleLoading: true,
    });
  };

  const refreshPullRequests = async (state?: string): Promise<IGitPullRequestSummaryPayload[]> => {
    const support = await loadPullRequestSupport();
    if (!support.available) return [];
    return loadPullRequests(state, {
      force: true,
      preloadDetails: false,
      updateActive: true,
      visibleLoading: true,
    });
  };

  const preloadPullRequestsInBackground = async (): Promise<void> => {
    if (!hasRepository.value) return;
    try {
      const support = await loadPullRequestSupport();
      if (!support.available) return;
      await loadPullRequests('open', {
        preloadDetails: false,
        updateActive: false,
        visibleLoading: false,
      });
    } catch (error) {
      console.warn('[git] background PR preload failed', error);
    }
  };

  const createPullRequest = async (payload: {
    title: string;
    body: string | null;
    base: string;
    head: string;
    draft: boolean | null;
  }): Promise<IGitPullRequestSummaryPayload> => {
    const result = await tauriService.createGitPullRequest({
      repositoryRootPath: requireRepositoryRootPath(),
      ...payload,
    });
    applyPullRequestSummaryMutation(result);
    return result;
  };

  const mergePullRequest = async (
    number: number,
    mergeMethod: string | null,
  ): Promise<IGitPullRequestSummaryPayload> => {
    const result = await tauriService.mergeGitPullRequest({
      repositoryRootPath: requireRepositoryRootPath(),
      number,
      mergeMethod,
    });
    applyPullRequestSummaryMutation(result);
    return result;
  };

  const closePullRequest = async (number: number): Promise<IGitPullRequestSummaryPayload> => {
    const result = await tauriService.closeGitPullRequest({
      repositoryRootPath: requireRepositoryRootPath(),
      number,
    });
    applyPullRequestSummaryMutation(result);
    return result;
  };

  const setRemote = async (
    remoteName: string,
    remoteUrl: string,
  ): Promise<IGitPullRequestSupportPayload> => {
    isSettingRemote.value = true;
    try {
      const payload = await tauriService.setGitRemote({
        repositoryRootPath: requireRepositoryRootPath(),
        remoteName,
        remoteUrl,
      });
      pullRequestSupportRequestId += 1;
      pendingPullRequestSupportRequest = null;
      pullRequestSupport.value = payload;
      resetPullRequests();
      return pullRequestSupport.value;
    } finally {
      isSettingRemote.value = false;
    }
  };

  const checkoutBranch = async (branchName: string): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.checkoutGitBranch({
      repositoryRootPath: requireRepositoryRootPath(),
      branchName,
    });
    clearBaselineCache();
    resetBranches();
    return applyStatusFromMutation(payload);
  };

  const checkoutCommit = async (commitId: string): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.checkoutGitCommit({
      repositoryRootPath: requireRepositoryRootPath(),
      commitId,
    });
    clearBaselineCache();
    resetBranches();
    void loadCommitHistory();
    return applyStatusFromMutation(payload);
  };

  const revertCommit = async (commitId: string): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.revertGitCommit({
      repositoryRootPath: requireRepositoryRootPath(),
      commitId,
    });
    clearBaselineCache();
    return applyStatusFromMutation(payload);
  };

  const createBranch = async (
    branchName: string,
    checkout: boolean,
  ): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.createGitBranch({
      repositoryRootPath: requireRepositoryRootPath(),
      branchName,
      checkout,
    });
    if (checkout) clearBaselineCache();
    resetBranches();
    return applyStatusFromMutation(payload);
  };

  const saveStash = async (
    message: string | null,
    includeUntracked: boolean,
  ): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.saveGitStash({
      repositoryRootPath: requireRepositoryRootPath(),
      message,
      includeUntracked,
    });
    clearBaselineCache();
    resetStashes();
    return applyStatusFromMutation(payload);
  };

  const applyStash = async (
    stashIndex: number,
    pop: boolean,
  ): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.applyGitStash({
      repositoryRootPath: requireRepositoryRootPath(),
      stashIndex,
      pop,
    });
    clearBaselineCache();
    resetStashes();
    return applyStatusFromMutation(payload);
  };

  const dropStash = async (stashIndex: number): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.dropGitStash({
      repositoryRootPath: requireRepositoryRootPath(),
      stashIndex,
    });
    resetStashes();
    return applyStatusFromMutation(payload);
  };

  return {
    status,
    isLoading,
    isCommitting,
    baselineEpoch,
    commitHistory,
    commitHistoryHasMore,
    commitHistoryNextOffset,
    isCommitHistoryLoading,
    branches,
    isBranchesLoading,
    stashes,
    isStashesLoading,
    pullRequestSupport,
    isPullRequestSupportLoading,
    isSettingRemote,
    pullRequests,
    isPullRequestsLoading,
    pullRequestStateFilter,
    pullRequestDetail,
    isPullRequestDetailLoading,
    commitStatsCache,
    hasRepository,
    totalChangeCount,
    canLoadMoreCommitHistory,
    getFileBaseline,
    invalidateFileBaseline,
    clearBaselineCache,
    refreshRepositoryStatus,
    initRepository,
    stagePaths,
    unstagePaths,
    discardPaths,
    commitIndex,
    loadCommitHistory,
    loadCommitDetail,
    getCommitStats,
    enqueueCommitStats,
    enqueueCommitStatsForCommits,
    loadCommitFileDiff,
    loadCommitFileDiffPreview,
    loadBranches,
    loadStashes,
    loadPullRequestSupport,
    loadPullRequests,
    loadPullRequestDetail,
    ensurePullRequestsLoaded,
    refreshPullRequests,
    preloadPullRequestsInBackground,
    createPullRequest,
    mergePullRequest,
    closePullRequest,
    setRemote,
    checkoutBranch,
    checkoutCommit,
    revertCommit,
    createBranch,
    saveStash,
    applyStash,
    dropStash,
    reset,
  };
});
