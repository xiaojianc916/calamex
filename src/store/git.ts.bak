import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { tauriService } from '@/services/tauri';
import type {
  IGitBranchPayload,
  IGitCommitResultPayload,
  IGitCommitSummaryPayload,
  IGitFileBaselinePayload,
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

  // -- request-id staleness tokens -----------------------------------------
  // 模块私有计数器,不是 reactive 状态。每个资源的并发 fetch 用 ++ 拿到自己的
  // token,resolve 时与当前 token 比对——不等则视为 stale,既不写结果也不
  // 清 isXxxLoading(把这俩交给最新 in-flight 的那次 finally 处理)。
  let statusRequestId = 0;
  let commitHistoryRequestId = 0;
  let branchesRequestId = 0;
  let stashesRequestId = 0;
  let pullRequestSupportRequestId = 0;

  // de-duplicates concurrent in-flight baseline fetches keyed by normalized path.
  const pendingBaselineRequests = new Map<string, Promise<IGitFileBaselinePayload>>();

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

  const resetSupplementaryData = (): void => {
    resetCommitHistory();
    resetBranches();
    resetStashes();
    resetPullRequestSupport();
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

  // -- status mutators -------------------------------------------------------

  const reset = (): void => {
    // 把所有 in-flight 请求作废:loader 的 finally 会读 *RequestId,
    // 发现已经被 bump 过就不会清 isXxxLoading;这里手动归零。
    statusRequestId += 1;
    commitHistoryRequestId += 1;
    branchesRequestId += 1;
    stashesRequestId += 1;
    pullRequestSupportRequestId += 1;

    isLoading.value = false;
    isCommitting.value = false;
    isCommitHistoryLoading.value = false;
    isBranchesLoading.value = false;
    isStashesLoading.value = false;
    isPullRequestSupportLoading.value = false;

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
    return applyStatus(payload);
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
      applyStatus(payload.status);
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

  // -- branch / stash write ops ---------------------------------------------

  const checkoutBranch = async (branchName: string): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.checkoutGitBranch({
      repositoryRootPath: requireRepositoryRootPath(),
      branchName,
    });
    clearBaselineCache();
    resetBranches();
    return applyStatus(payload);
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
    return applyStatus(payload);
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
    return applyStatus(payload);
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
    return applyStatus(payload);
  };

  const dropStash = async (stashIndex: number): Promise<IGitRepositoryStatusPayload> => {
    const payload = await tauriService.dropGitStash({
      repositoryRootPath: requireRepositoryRootPath(),
      stashIndex,
    });
    resetStashes();
    return applyStatus(payload);
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
    loadBranches,
    loadStashes,
    loadPullRequestSupport,
    // branch / stash write ops
    checkoutBranch,
    createBranch,
    saveStash,
    applyStash,
    dropStash,
    // lifecycle
    reset,
  };
});
