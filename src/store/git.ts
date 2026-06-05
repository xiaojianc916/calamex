import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { tauriService } from '@/services/tauri';
import type {
  IGitBranchPayload,
  IGitCommitDetailPayload,
  IGitCommitResultPayload,
  IGitCommitSummaryPayload,
  IGitFileBaselinePayload,
  IGitPullRequestDetailPayload,
  IGitPullRequestSummaryPayload,
  IGitPullRequestSupportPayload,
  IGitRepositoryStatusPayload,
  IGitStashEntryPayload,
} from '@/types/git';
import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/path';

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

const MSG_GIT_INIT_NO_REPOSITORY = 'Git 初始化后仍未检测到仓库。';
const MSG_GIT_NO_REPOSITORY_IN_WORKSPACE = '当前工作区未检测到 Git 仓库。';

const formatGitInitMismatch = (expectedPath: string, actualPath: string): string =>
  `Git 初始化目标不一致:期望 ${expectedPath},实际 ${actualPath}。`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TStatusFetcher = (workspaceRootPath: string) => Promise<IGitRepositoryStatusPayload>;

type TPathsMutationRequest = {
  repositoryRootPath: string;
  paths: string[];
};

type TPathsMutator = (request: TPathsMutationRequest) => Promise<IGitRepositoryStatusPayload>;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useGitStore = defineStore('git', () => {
  // -- state -----------------------------------------------------------------

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
  const pullRequestStateFilter = ref('open');
  const pullRequestDetail = ref<IGitPullRequestDetailPayload | null>(null);
  const isPullRequestDetailLoading = ref(false);

  // 提交详情按 commit id 缓存。每个 commit 的详情不可变，可长期缓存；
  // 仓库根变更 / reset 时随 baseline 缓存一起清空。
  const commitDetailCache = ref<Record<string, IGitCommitDetailPayload>>({});

  // -- request-id staleness tokens -----------------------------------------
  // 模块私有计数器,不是 reactive 状态。每个资源的并发 fetch 用 ++ 拿到自己的
  // token,resolve 时与当前 token 比对——不等则视为 stale,既不写结果也不
  // 清 isXxxLoading(把这俩交给最新 in-flight 的那次 finally 处理)。
  let statusRequestId = 0;
  let commitHistoryRequestId = 0;
  let branchesRequestId = 0;
  let stashesRequestId = 0;
  let pullRequestSupportRequestId = 0;
  let pullRequestsRequestId = 0;
  let pullRequestDetailRequestId = 0;

  // de-duplicates concurrent in-flight baseline fetches keyed by normalized path.
  const pendingBaselineRequests = new Map<string, Promise<IGitFileBaselinePayload>>();

  // de-duplicates concurrent in-flight commit-detail fetches keyed by commit id.
  const pendingCommitDetailRequests = new Map<string, Promise<IGitCommitDetailPayload>>();

  // -- getters ---------------------------------------------------------------

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

  // -- baseline cache --------------------------------------------------------

  const clearBaselineCache = (): void => {
    baselineCache.value = {};
    baselineEpoch.value += 1;
    commitDetailCache.value = {};
  };

  const resetCommitHistory = (): void => {
    commitHistoryRequestId += 1; // 让 in-flight loader resolve 后跳过写入
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

  const resetPullRequestSupport = (): void => {
    pullRequestSupportRequestId += 1;
    pullRequestSupport.value = createEmptyPullRequestSupport();
  };

  const resetPullRequests = (): void => {
    pullRequestsRequestId += 1;
    pullRequestDetailRequestId += 1;
    pullRequests.value = [];
    pullRequestStateFilter.value = 'open';
    pullRequestDetail.value = null;
  };

  const resetSupplementaryData = (): void => {
    resetCommitHistory();
    resetBranches();
    resetStashes();
    resetPullRequestSupport();
    resetPullRequests();
  };

  /**
   * 使指定路径的 baseline 缓存失效。
   *
   * 关键修复:必须同时考虑 in-flight 的 getFileBaseline——它 resolve 后
   * 会基于 epochAtRequest 决定是否写缓存。即使当前没有缓存条目,只要
   * pendingBaselineRequests 里有对应 entry,就必须 bump epoch,否则
   * stale payload 会绕过失效写入缓存。
   */
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

  /**
   * 读取单个提交的详情（文件变更 + 增删统计），用于历史悬浮卡片。
   * 按 commit id 缓存；并发同一 commit 的请求会复用同一个 in-flight promise。
   */
  const loadCommitDetail = async (commitId: string): Promise<IGitCommitDetailPayload> => {
    const cached = commitDetailCache.value[commitId];
    if (cached) {
      return cached;
    }

    const pending = pendingCommitDetailRequests.get(commitId);
    if (pending) {
      return pending;
    }

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
        return payload;
      })
      .finally(() => {
        pendingCommitDetailRequests.delete(commitId);
      });

    pendingCommitDetailRequests.set(commitId, request);
    return request;
  };

  // -- status mutators -------------------------------------------------------

  const reset = (): void => {
    // 把所有 in-flight 请求作废:loader 的 finally 会读 *RequestId,
    // 发现已经被 bump 过就不会清 isXxxLoading;这里手动归零。
    statusRequestId += 1;
    commitHistoryRequestId += 1;
    branchesRequestId += 1;
    stashesRequestId += 1;
    pullRequestSupportRequestId += 1;
    pullRequestsRequestId += 1;
    pullRequestDetailRequestId += 1;

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

    // 注意:resetSupplementaryData 内部各 resetXxx 会再 bump 一次 RequestId,
    // 这是无害的——只是再次把更老的 in-flight 关到门外。
    resetSupplementaryData();
  };

  const applyStatus = (payload: IGitRepositoryStatusPayload): IGitRepositoryStatusPayload => {
    const previousRepositoryRoot = normalizeFileSystemPath(status.value.repositoryRootPath);
    const nextRepositoryRoot = normalizeFileSystemPath(payload.repositoryRootPath);
    status.value = payload;
    if (previousRepositoryRoot !== nextRepositoryRoot || !payload.available) {
      clearBaselineCache();
      resetSupplementaryData();
    }
    return payload;
  };

  /**
   * 写操作(stage/unstage/discard/commit/branch/stash)落盘的状态即最新真值。
   * 通过 ++statusRequestId 把任何 in-flight 的 refreshRepositoryStatus 标记为 stale,
   * 防止其稍后 resolve 时用过期 payload 覆盖刚写入的状态;同时把可能残留的
   * isLoading 归位(被作废的那次 refresh 不会再进入自己的 finally 重置分支)。
   */
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

  /**
   * 共享骨架:刷新或初始化仓库状态时的请求竞争控制 + isLoading 切换 + 落盘。
   * `validatePayload` 在 staleness 检查通过、`applyStatus` 之前对 payload 做断言。
   */
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
      if (requestId !== statusRequestId) {
        return status.value;
      }
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

  // -- index / paths mutations ----------------------------------------------

  const requireRepositoryRootPath = (): string => {
    const repositoryRootPath = status.value.repositoryRootPath;
    if (!repositoryRootPath) {
      throw new Error(MSG_GIT_NO_REPOSITORY_IN_WORKSPACE);
    }
    return repositoryRootPath;
  };

  /**
   * 共享骨架:stage / unstage / discard 一类的"按路径列表改写工作区"操作。
   * `onSuccess` 在 `applyStatus` 之前用去重后的路径执行副作用 (例如基准缓存失效)。
   */
  const runPathsMutation = async (
    paths: string[],
    mutate: TPathsMutator,
    onSuccess?: (deduplicatedPaths: string[]) => void,
  ): Promise<IGitRepositoryStatusPayload> => {
    const deduplicatedPaths = deduplicatePaths(paths);
    if (deduplicatedPaths.length === 0) {
      return status.value;
    }
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
        // 空 paths 表示提交整个暂存区,保持既有提交行为。
        paths: [],
      });
      applyStatusFromMutation(payload.status);
      clearBaselineCache();
      return payload;
    } finally {
      isCommitting.value = false;
    }
  };

  // -- supplementary resource loaders ---------------------------------------
  // 每个 loader 都用对应的 *RequestId 做 staleness 检查:
  // 1. 并发同名 loader 时,只有最新一次能写结果;
  // 2. reset() / resetXxx() 期间 in-flight 的 loader 不会污染重置后状态;
  // 3. stale 路径不去清 isXxxLoading,留给最新 in-flight 的 finally。

  const loadCommitHistory = async (options?: {
    append?: boolean;
    limit?: number;
  }): Promise<IGitCommitSummaryPayload[]> => {
    const append = options?.append ?? false;
    const nextOffset = append ? commitHistoryNextOffset.value : 0;
    if (append && nextOffset === null) {
      return commitHistory.value;
    }
    const requestId = ++commitHistoryRequestId;
    isCommitHistoryLoading.value = true;
    try {
      const payload = await tauriService.listGitCommitHistory({
        repositoryRootPath: requireRepositoryRootPath(),
        offset: nextOffset ?? 0,
        limit: options?.limit ?? null,
      });
      if (requestId !== commitHistoryRequestId) {
        return commitHistory.value;
      }
      commitHistory.value = append ? [...commitHistory.value, ...payload.entries] : payload.entries;
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
      if (requestId !== branchesRequestId) {
        return branches.value;
      }
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
      if (requestId !== stashesRequestId) {
        return stashes.value;
      }
      stashes.value = payload.entries;
      return stashes.value;
    } finally {
      if (requestId === stashesRequestId) {
        isStashesLoading.value = false;
      }
    }
  };

  const loadPullRequestSupport = async (): Promise<IGitPullRequestSupportPayload> => {
    const requestId = ++pullRequestSupportRequestId;
    isPullRequestSupportLoading.value = true;
    try {
      const payload = await tauriService.getGitPullRequestSupport({
        repositoryRootPath: requireRepositoryRootPath(),
      });
      if (requestId !== pullRequestSupportRequestId) {
        return pullRequestSupport.value;
      }
      pullRequestSupport.value = payload;
      return pullRequestSupport.value;
    } finally {
      if (requestId === pullRequestSupportRequestId) {
        isPullRequestSupportLoading.value = false;
      }
    }
  };

  const loadPullRequests = async (state?: string): Promise<IGitPullRequestSummaryPayload[]> => {
    if (state !== undefined) {
      pullRequestStateFilter.value = state;
    }
    const requestId = ++pullRequestsRequestId;
    isPullRequestsLoading.value = true;
    try {
      const payload = await tauriService.listGitPullRequests({
        repositoryRootPath: requireRepositoryRootPath(),
        state: pullRequestStateFilter.value,
      });
      if (requestId !== pullRequestsRequestId) {
        return pullRequests.value;
      }
      pullRequests.value = payload;
      return pullRequests.value;
    } finally {
      if (requestId === pullRequestsRequestId) {
        isPullRequestsLoading.value = false;
      }
    }
  };

  const loadPullRequestDetail = async (
    number: number,
  ): Promise<IGitPullRequestDetailPayload> => {
    const requestId = ++pullRequestDetailRequestId;
    isPullRequestDetailLoading.value = true;
    try {
      const payload = await tauriService.getGitPullRequestDetail({
        repositoryRootPath: requireRepositoryRootPath(),
        number,
      });
      if (requestId !== pullRequestDetailRequestId) {
        if (pullRequestDetail.value) return pullRequestDetail.value;
      }
      pullRequestDetail.value = payload;
      return payload;
    } finally {
      if (requestId === pullRequestDetailRequestId) {
        isPullRequestDetailLoading.value = false;
      }
    }
  };

  const createPullRequest = async (payload: {
    title: string;
    body: string | null;
    base: string;
    head: string;
    draft: boolean | null;
  }): Promise<IGitPullRequestSummaryPayload> =>
    tauriService.createGitPullRequest({
      repositoryRootPath: requireRepositoryRootPath(),
      ...payload,
    });

  const mergePullRequest = async (
    number: number,
    mergeMethod: string | null,
  ): Promise<IGitPullRequestSummaryPayload> =>
    tauriService.mergeGitPullRequest({
      repositoryRootPath: requireRepositoryRootPath(),
      number,
      mergeMethod,
    });

  const closePullRequest = async (number: number): Promise<IGitPullRequestSummaryPayload> =>
    tauriService.closeGitPullRequest({
      repositoryRootPath: requireRepositoryRootPath(),
      number,
    });

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
      // 远端写操作落盘即最新真值：bump request-id 让任何 in-flight 的
      // loadPullRequestSupport resolve 后跳过写入，避免旧探测结果覆盖。
      pullRequestSupportRequestId += 1;
      pullRequestSupport.value = payload;
      resetPullRequests();
      return pullRequestSupport.value;
    } finally {
      isSettingRemote.value = false;
    }
  };

  // -- branch / stash / commit write ops -----------------------------------

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
    // HEAD 移动后刷新历史图中 ref 徽章。
    void loadCommitHistory();
    return applyStatusFromMutation(payload);
  };

  const revertCommit = async (commitId: string): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.revertGitCommit({
      repositoryRootPath: requireRepositoryRootPath(),
      commitId,
    });
    // 回滚操作只改工作区 / 索引，不改历史；清基线缓存即可。
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
    if (checkout) {
      clearBaselineCache();
    }
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
    // state
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
    commitDetailCache,
    // getters
    hasRepository,
    totalChangeCount,
    canLoadMoreCommitHistory,
    // baseline
    getFileBaseline,
    invalidateFileBaseline,
    clearBaselineCache,
    // status
    refreshRepositoryStatus,
    initRepository,
    // index / paths
    stagePaths,
    unstagePaths,
    discardPaths,
    commitIndex,
    // supplementary loaders
    loadCommitHistory,
    loadCommitDetail,
    loadBranches,
    loadStashes,
    loadPullRequestSupport,
    loadPullRequests,
    loadPullRequestDetail,
    createPullRequest,
    mergePullRequest,
    closePullRequest,
    setRemote,
    // branch / stash / commit write ops
    checkoutBranch,
    checkoutCommit,
    revertCommit,
    createBranch,
    saveStash,
    applyStash,
    dropStash,
    // lifecycle
    reset,
  };
});
