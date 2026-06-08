import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

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
const PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS = 30_000;
const PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS = 30_000;
const PULL_REQUEST_DETAIL_PRELOAD_LIMIT = 20;
const PULL_REQUEST_DETAIL_PRELOAD_CONCURRENCY = 4;
const PULL_REQUEST_DETAIL_CACHE_LIMIT = 20;
const PULL_REQUEST_PERSISTED_CACHE_PREFIX = 'calamex.gitPullRequests.';
const PULL_REQUEST_PERSISTED_CACHE_VERSION = 1;

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

const createPullRequestCacheKey = (repositoryRootPath: string, state: string): string =>
  `${normalizeFileSystemPath(repositoryRootPath)}|${state}`;

const createPullRequestDetailCacheKey = (repositoryRootPath: string, number: number): string =>
  `${normalizeFileSystemPath(repositoryRootPath)}|${number}`;

type TPersistedPullRequestListCache = {
  version: number;
  fetchedAt: number;
  payload: IGitPullRequestSummaryPayload[];
};

type TPersistedPullRequestDetailCache = {
  version: number;
  fetchedAt: number;
  payload: IGitPullRequestDetailPayload;
};

const createPullRequestPersistedCacheKey = (kind: 'list' | 'detail', cacheKey: string): string =>
  `${PULL_REQUEST_PERSISTED_CACHE_PREFIX}${PULL_REQUEST_PERSISTED_CACHE_VERSION}.${kind}.${encodeURIComponent(cacheKey)}`;

const getPullRequestPersistentStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const readPersistedPullRequestList = (cacheKey: string): TPersistedPullRequestListCache | null => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return null;

  try {
    const rawValue = storage.getItem(createPullRequestPersistedCacheKey('list', cacheKey));
    if (!rawValue) return null;

    const parsed = JSON.parse(rawValue) as Partial<TPersistedPullRequestListCache>;
    if (
      parsed.version !== PULL_REQUEST_PERSISTED_CACHE_VERSION ||
      typeof parsed.fetchedAt !== 'number' ||
      !Array.isArray(parsed.payload)
    ) {
      return null;
    }

    return {
      version: PULL_REQUEST_PERSISTED_CACHE_VERSION,
      fetchedAt: parsed.fetchedAt,
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
};

const writePersistedPullRequestList = (
  cacheKey: string,
  payload: IGitPullRequestSummaryPayload[],
  fetchedAt: number,
): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  try {
    storage.setItem(
      createPullRequestPersistedCacheKey('list', cacheKey),
      JSON.stringify({
        version: PULL_REQUEST_PERSISTED_CACHE_VERSION,
        fetchedAt,
        payload,
      } satisfies TPersistedPullRequestListCache),
    );
  } catch {
    // Best-effort cache snapshot only.
  }
};

const readPersistedPullRequestDetail = (
  cacheKey: string,
): TPersistedPullRequestDetailCache | null => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return null;

  try {
    const rawValue = storage.getItem(createPullRequestPersistedCacheKey('detail', cacheKey));
    if (!rawValue) return null;

    const parsed = JSON.parse(rawValue) as Partial<TPersistedPullRequestDetailCache>;
    if (
      parsed.version !== PULL_REQUEST_PERSISTED_CACHE_VERSION ||
      typeof parsed.fetchedAt !== 'number' ||
      !parsed.payload
    ) {
      return null;
    }

    return {
      version: PULL_REQUEST_PERSISTED_CACHE_VERSION,
      fetchedAt: parsed.fetchedAt,
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
};

const writePersistedPullRequestDetail = (
  cacheKey: string,
  payload: IGitPullRequestDetailPayload,
  fetchedAt: number,
): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  try {
    storage.setItem(
      createPullRequestPersistedCacheKey('detail', cacheKey),
      JSON.stringify({
        version: PULL_REQUEST_PERSISTED_CACHE_VERSION,
        fetchedAt,
        payload,
      } satisfies TPersistedPullRequestDetailCache),
    );
  } catch {
    // Best-effort cache snapshot only.
  }
};

const removePersistedPullRequestCache = (kind: 'list' | 'detail', cacheKey: string): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  try {
    storage.removeItem(createPullRequestPersistedCacheKey(kind, cacheKey));
  } catch {
    // Best-effort cache cleanup only.
  }
};

const removePersistedPullRequestCachesForRepository = (
  repositoryRootPath?: string | null,
): void => {
  const storage = getPullRequestPersistentStorage();
  const normalizedRepositoryRootPath = normalizeFileSystemPath(repositoryRootPath);
  if (!storage || !normalizedRepositoryRootPath) return;

  const encodedRepositoryPrefix = encodeURIComponent(`${normalizedRepositoryRootPath}|`);
  const listPrefix = `${PULL_REQUEST_PERSISTED_CACHE_PREFIX}${PULL_REQUEST_PERSISTED_CACHE_VERSION}.list.${encodedRepositoryPrefix}`;
  const detailPrefix = `${PULL_REQUEST_PERSISTED_CACHE_PREFIX}${PULL_REQUEST_PERSISTED_CACHE_VERSION}.detail.${encodedRepositoryPrefix}`;
  const keysToRemove: string[] = [];

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && (key.startsWith(listPrefix) || key.startsWith(detailPrefix))) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => {
      storage.removeItem(key);
    });
  } catch {
    // Best-effort cache cleanup only.
  }
};

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

const arePullRequestSummariesEqual = (
  left: IGitPullRequestSummaryPayload,
  right: IGitPullRequestSummaryPayload,
): boolean =>
  left.number === right.number &&
  left.title === right.title &&
  left.state === right.state &&
  left.isDraft === right.isDraft &&
  left.author === right.author &&
  left.headRef === right.headRef &&
  left.baseRef === right.baseRef &&
  left.htmlUrl === right.htmlUrl &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt &&
  left.comments === right.comments;

const arePullRequestSummaryListsEqual = (
  left: IGitPullRequestSummaryPayload[] | undefined,
  right: IGitPullRequestSummaryPayload[],
): left is IGitPullRequestSummaryPayload[] => {
  if (!left || left.length !== right.length) return false;
  return left.every((entry, index) => arePullRequestSummariesEqual(entry, right[index]));
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
  const pullRequestListCache = ref<Record<string, IGitPullRequestSummaryPayload[]>>({});
  const pullRequestListFetchedAt = ref<Record<string, number>>({});
  const pullRequestDetailCache = ref<Record<string, IGitPullRequestDetailPayload>>({});
  const pullRequestDetailFetchedAt = ref<Record<string, number>>({});
  const pullRequestDetailCacheOrder = ref<string[]>([]);

  const commitDetailCache = ref<Record<string, IGitCommitDetailPayload>>({});
  const commitFileDiffCache = ref<Record<string, IGitCommitFileDiffPayload>>({});
  const commitFileDiffPreviewCache = ref<Record<string, IGitDiffPreviewPayload>>({});

  let statusRequestId = 0;
  let commitHistoryRequestId = 0;
  let branchesRequestId = 0;
  let stashesRequestId = 0;
  let pullRequestSupportRequestId = 0;
  let pullRequestsRequestId = 0;
  let pullRequestDetailRequestId = 0;
  let pullRequestDetailPreloadEpoch = 0;
  let pullRequestPreloadTimer: ReturnType<typeof setTimeout> | null = null;

  const pendingBaselineRequests = new Map<string, Promise<IGitFileBaselinePayload>>();
  const pendingCommitDetailRequests = new Map<string, Promise<IGitCommitDetailPayload>>();
  const pendingCommitFileDiffRequests = new Map<string, Promise<IGitCommitFileDiffPayload>>();
  const pendingCommitFileDiffPreviewRequests = new Map<string, Promise<IGitDiffPreviewPayload>>();
  const pendingPullRequestListRequests = new Map<
    string,
    Promise<IGitPullRequestSummaryPayload[]>
  >();
  const pendingPullRequestDetailRequests = new Map<string, Promise<IGitPullRequestDetailPayload>>();
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
  };

  const clearBaselineCache = (): void => {
    baselineCache.value = {};
    baselineEpoch.value += 1;
    commitDetailCache.value = {};
    commitFileDiffCache.value = {};
    commitFileDiffPreviewCache.value = {};
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

  const resetPullRequestSupport = (): void => {
    pullRequestSupportRequestId += 1;
    pendingPullRequestSupportRequest = null;
    pullRequestSupport.value = createEmptyPullRequestSupport();
  };

  const invalidatePullRequestListCache = (): void => {
    pullRequestListCache.value = {};
    pullRequestListFetchedAt.value = {};
    pendingPullRequestListRequests.clear();
  };

  const hydratePullRequestListCache = (cacheKey: string): void => {
    if (pullRequestListCache.value[cacheKey]) return;

    const persisted = readPersistedPullRequestList(cacheKey);
    if (!persisted) return;

    pullRequestListCache.value = {
      ...pullRequestListCache.value,
      [cacheKey]: persisted.payload,
    };
    pullRequestListFetchedAt.value = {
      ...pullRequestListFetchedAt.value,
      [cacheKey]: persisted.fetchedAt,
    };
  };

  const hydratePullRequestDetailCache = (cacheKey: string): void => {
    if (pullRequestDetailCache.value[cacheKey]) return;

    const persisted = readPersistedPullRequestDetail(cacheKey);
    if (!persisted) return;

    pullRequestDetailCache.value = {
      ...pullRequestDetailCache.value,
      [cacheKey]: persisted.payload,
    };
    pullRequestDetailFetchedAt.value = {
      ...pullRequestDetailFetchedAt.value,
      [cacheKey]: persisted.fetchedAt,
    };
    pullRequestDetailCacheOrder.value = [
      cacheKey,
      ...pullRequestDetailCacheOrder.value.filter((key) => key !== cacheKey),
    ];
  };

  const invalidatePullRequestDetailCache = (pullRequestNumber?: number): void => {
    if (pullRequestNumber === undefined) {
      pullRequestDetailCache.value = {};
      pullRequestDetailFetchedAt.value = {};
      pullRequestDetailCacheOrder.value = [];
      pendingPullRequestDetailRequests.clear();
      return;
    }
    const repositoryRootPath = status.value.repositoryRootPath;
    if (!repositoryRootPath) return;
    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, pullRequestNumber);
    const nextCache = { ...pullRequestDetailCache.value };
    const nextFetchedAt = { ...pullRequestDetailFetchedAt.value };
    delete nextCache[cacheKey];
    delete nextFetchedAt[cacheKey];
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;
    pullRequestDetailCacheOrder.value = pullRequestDetailCacheOrder.value.filter(
      (key) => key !== cacheKey,
    );
    pendingPullRequestDetailRequests.delete(cacheKey);
  };

  const touchPullRequestDetailCache = (cacheKey: string): void => {
    if (!pullRequestDetailCache.value[cacheKey]) return;
    pullRequestDetailCacheOrder.value = [
      cacheKey,
      ...pullRequestDetailCacheOrder.value.filter((key) => key !== cacheKey),
    ];
  };

  const rememberPullRequestDetail = (
    cacheKey: string,
    payload: IGitPullRequestDetailPayload,
  ): void => {
    const fetchedAt = Date.now();
    const nextCache = {
      ...pullRequestDetailCache.value,
      [cacheKey]: payload,
    };
    const nextFetchedAt = {
      ...pullRequestDetailFetchedAt.value,
      [cacheKey]: fetchedAt,
    };
    const nextOrder = [
      cacheKey,
      ...pullRequestDetailCacheOrder.value.filter((key) => key !== cacheKey),
    ];
    while (nextOrder.length > PULL_REQUEST_DETAIL_CACHE_LIMIT) {
      const evicted = nextOrder.pop();
      if (evicted) {
        delete nextCache[evicted];
        delete nextFetchedAt[evicted];
      }
    }
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;
    pullRequestDetailCacheOrder.value = nextOrder;
  };

  const resetPullRequests = (): void => {
    pullRequestsRequestId += 1;
    pullRequestDetailRequestId += 1;
    pullRequestDetailPreloadEpoch += 1;
    clearPullRequestPreloadTimer();
    pullRequests.value = [];
    pullRequestStateFilter.value = 'open';
    pullRequestDetail.value = null;
    invalidatePullRequestListCache();
    invalidatePullRequestDetailCache();
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
        return payload;
      })
      .finally(() => {
        pendingCommitDetailRequests.delete(commitId);
      });

    pendingCommitDetailRequests.set(commitId, request);
    return request;
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
        pendingCommitFileDiffPreviewRequests.delete(cacheKey);
      });

    pendingCommitFileDiffPreviewRequests.set(cacheKey, request);
    return request;
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
    clearPullRequestPreloadTimer();
    if (!hasRepository.value) return;
    pullRequestPreloadTimer = setTimeout(() => {
      pullRequestPreloadTimer = null;
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
        commitHistory.value.push(...payload.entries);
      } else {
        commitHistory.value = payload.entries;
      }
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
    pendingPullRequestListRequests.clear();
    invalidatePullRequestDetailCache(pullRequest.number);

    const repositoryCachePrefix = `${normalizeFileSystemPath(repositoryRootPath)}|`;
    const cacheKeys = new Set<string>(
      Object.keys(pullRequestListCache.value).filter((key) =>
        key.startsWith(repositoryCachePrefix),
      ),
    );
    cacheKeys.add(createPullRequestCacheKey(repositoryRootPath, pullRequestStateFilter.value));
    cacheKeys.add(createPullRequestCacheKey(repositoryRootPath, 'all'));

    const nextCache = { ...pullRequestListCache.value };
    const nextFetchedAt = { ...pullRequestListFetchedAt.value };
    const now = Date.now();
    for (const cacheKey of cacheKeys) {
      const state = normalizePullRequestState(cacheKey.split('|').pop());
      nextCache[cacheKey] = updatePullRequestListForState(
        nextCache[cacheKey] ?? [],
        pullRequest,
        state,
      );
      nextFetchedAt[cacheKey] = now;
      writePersistedPullRequestList(cacheKey, nextCache[cacheKey], now);
    }

    pullRequestListCache.value = nextCache;
    pullRequestListFetchedAt.value = nextFetchedAt;
    pullRequests.value = updatePullRequestListForState(
      pullRequests.value,
      pullRequest,
      pullRequestStateFilter.value,
    );
  };

  const runPullRequestDetailPreloadQueue = async (
    entries: IGitPullRequestSummaryPayload[],
    epoch: number,
  ): Promise<void> => {
    const candidates = entries.slice(0, PULL_REQUEST_DETAIL_PRELOAD_LIMIT);
    let nextIndex = 0;

    const preloadNext = async (): Promise<void> => {
      while (epoch === pullRequestDetailPreloadEpoch && nextIndex < candidates.length) {
        const pullRequest = candidates[nextIndex];
        nextIndex += 1;
        await loadPullRequestDetail(pullRequest.number, {
          updateActive: false,
          visibleLoading: false,
        }).catch(() => undefined);
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

    if (updateActive) {
      pullRequestStateFilter.value = selectedState;
    }

    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    hydratePullRequestListCache(cacheKey);
    const cached = pullRequestListCache.value[cacheKey];
    if (cached && updateActive) pullRequests.value = cached;

    const fetchedAt = pullRequestListFetchedAt.value[cacheKey] ?? 0;
    const isFresh = Date.now() - fetchedAt < PULL_REQUEST_LIST_REVALIDATE_INTERVAL_MS;
    if (cached && !options?.force && isFresh) {
      if (shouldPreloadDetails) {
        preloadTopPullRequestDetails(cached);
      }
      return cached;
    }

    if (options?.force) {
      pendingPullRequestListRequests.delete(cacheKey);
    } else {
      const pending = pendingPullRequestListRequests.get(cacheKey);
      if (pending) {
        if (!updateActive) return pending.catch(() => cached ?? []);
        const requestId = ++pullRequestsRequestId;
        if (visibleLoading) isPullRequestsLoading.value = true;
        try {
          const payload = await pending;
          if (requestId === pullRequestsRequestId) {
            pullRequests.value = pullRequestListCache.value[cacheKey] ?? payload;
          }
          return requestId === pullRequestsRequestId ? pullRequests.value : payload;
        } catch (error) {
          if (cached) return cached;
          throw error;
        } finally {
          if (visibleLoading && requestId === pullRequestsRequestId) {
            isPullRequestsLoading.value = false;
          }
        }
      }
    }

    const requestId = updateActive ? ++pullRequestsRequestId : pullRequestsRequestId;
    if (visibleLoading) isPullRequestsLoading.value = true;
    const request = tauriService
      .listGitPullRequests({
        repositoryRootPath,
        state: selectedState,
      })
      .then((payload) => {
        const previousCachedPullRequests = pullRequestListCache.value[cacheKey];
        const nextPayload = arePullRequestSummaryListsEqual(previousCachedPullRequests, payload)
          ? previousCachedPullRequests
          : payload;

        pullRequestListCache.value = {
          ...pullRequestListCache.value,
          [cacheKey]: nextPayload,
        };
        const fetchedAt = Date.now();
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: fetchedAt,
        };
        writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);
        if (updateActive && requestId === pullRequestsRequestId) {
          pullRequests.value = nextPayload;
        }
        if (shouldPreloadDetails) {
          preloadTopPullRequestDetails(nextPayload);
        }
        return updateActive && requestId === pullRequestsRequestId
          ? pullRequests.value
          : nextPayload;
      })
      .catch((error) => {
        if (cached) return cached;
        throw error;
      })
      .finally(() => {
        pendingPullRequestListRequests.delete(cacheKey);
        if (visibleLoading && requestId === pullRequestsRequestId) {
          isPullRequestsLoading.value = false;
        }
      });

    pendingPullRequestListRequests.set(cacheKey, request);
    return request;
  };

  const loadPullRequestDetail = async (
    number: number,
    options?: TLoadPullRequestDetailOptions,
  ): Promise<IGitPullRequestDetailPayload> => {
    const updateActive = options?.updateActive ?? true;
    const visibleLoading = options?.visibleLoading ?? updateActive;
    const force = options?.force ?? false;
    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);
    hydratePullRequestDetailCache(cacheKey);
    const pending = pendingPullRequestDetailRequests.get(cacheKey);
    const cached = pullRequestDetailCache.value[cacheKey];
    const fetchedAt = pullRequestDetailFetchedAt.value[cacheKey] ?? 0;
    const shouldRevalidate = Date.now() - fetchedAt >= PULL_REQUEST_DETAIL_REVALIDATE_INTERVAL_MS;
    if (cached && !force) {
      touchPullRequestDetailCache(cacheKey);
      if (updateActive) {
        pullRequestDetail.value = cached;
        if (!pending && shouldRevalidate) {
          void loadPullRequestDetail(number, {
            force: true,
            updateActive: true,
            visibleLoading: false,
          }).catch(() => undefined);
        }
      }
      return cached;
    }
    if (pending) {
      if (!updateActive) return pending;
      const requestId = ++pullRequestDetailRequestId;
      if (visibleLoading) isPullRequestDetailLoading.value = true;
      try {
        const payload = await pending;
        if (requestId === pullRequestDetailRequestId) {
          pullRequestDetail.value = payload;
        }
        return payload;
      } finally {
        if (visibleLoading && requestId === pullRequestDetailRequestId) {
          isPullRequestDetailLoading.value = false;
        }
      }
    }

    const requestId = updateActive ? ++pullRequestDetailRequestId : pullRequestDetailRequestId;
    if (visibleLoading) isPullRequestDetailLoading.value = true;
    const request = tauriService
      .getGitPullRequestDetail({
        repositoryRootPath,
        number,
      })
      .then((payload) => {
        rememberPullRequestDetail(cacheKey, payload);
        if (updateActive && requestId === pullRequestDetailRequestId) {
          pullRequestDetail.value = payload;
        }
        return payload;
      })
      .finally(() => {
        pendingPullRequestDetailRequests.delete(cacheKey);
        if (visibleLoading && requestId === pullRequestDetailRequestId) {
          isPullRequestDetailLoading.value = false;
        }
      });

    pendingPullRequestDetailRequests.set(cacheKey, request);
    return request;
  };

  const ensurePullRequestsLoaded = async (
    state?: string,
  ): Promise<IGitPullRequestSummaryPayload[]> => {
    const support = await loadPullRequestSupport();
    if (!support.available) return [];
    return loadPullRequests(state, {
      preloadDetails: true,
      updateActive: true,
      visibleLoading: true,
    });
  };

  const refreshPullRequests = async (state?: string): Promise<IGitPullRequestSummaryPayload[]> => {
    const support = await loadPullRequestSupport();
    if (!support.available) return [];
    return loadPullRequests(state, {
      force: true,
      preloadDetails: true,
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
        preloadDetails: true,
        updateActive: false,
        visibleLoading: false,
      });
    } catch {
      // Background PR preloading is best-effort only.
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
      removePersistedPullRequestCachesForRepository(status.value.repositoryRootPath);
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
    commitDetailCache,
    commitFileDiffCache,
    commitFileDiffPreviewCache,
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
