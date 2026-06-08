import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IGitCommitSummaryPayload,
  IGitPullRequestDetailPayload,
  IGitPullRequestSummaryPayload,
  IGitRepositoryStatusPayload,
} from '@/types/git';

import { useGitStore } from './git';

const WORKSPACE_ROOT = 'D:/repo';
const PARENT_WORKSPACE_ROOT = 'D:/parent';

const MSG_REPO_UNAVAILABLE = '当前工作区未检测到 Git 仓库。';
const MSG_INIT_MISMATCH = 'Git 初始化目标不一致';

interface IDeferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const createDeferred = <T>(): IDeferred<T> => {
  let resolve!: IDeferred<T>['resolve'];
  let reject!: IDeferred<T>['reject'];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const createStatus = (
  overrides: Partial<IGitRepositoryStatusPayload> = {},
): IGitRepositoryStatusPayload => ({
  available: true,
  message: null,
  repositoryRootPath: WORKSPACE_ROOT,
  repositoryName: 'repo',
  gitDirPath: `${WORKSPACE_ROOT}/.git`,
  headBranchName: 'main',
  headShortName: 'main',
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
  ...overrides,
});

const createCommitSummary = (
  overrides: Partial<IGitCommitSummaryPayload> = {},
): IGitCommitSummaryPayload => ({
  id: 'commit-1',
  shortId: 'commit-',
  summary: 'feat: demo commit',
  authorName: 'Calamex Test',
  authorEmail: 'test@calamex.local',
  authoredAt: '2026-06-07T00:00:00.000Z',
  parentIds: [],
  refs: [],
  ...overrides,
});

const createPullRequest = (
  overrides: Partial<IGitPullRequestSummaryPayload> = {},
): IGitPullRequestSummaryPayload => ({
  number: 1,
  title: 'feat: initial pull request',
  state: 'open',
  isDraft: false,
  author: 'octocat',
  headRef: 'feature/demo',
  baseRef: 'main',
  htmlUrl: 'https://github.com/owner/repo/pull/1',
  createdAt: '2026-04-28T00:00:00.000Z',
  updatedAt: '2026-04-28T00:00:00.000Z',
  comments: 0,
  ...overrides,
});

const createPullRequestDetail = (
  overrides: Partial<IGitPullRequestDetailPayload> = {},
): IGitPullRequestDetailPayload => ({
  ...createPullRequest(),
  body: 'Pull request body',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  mergeable: true,
  mergeableState: 'clean',
  ...overrides,
});

const createUnavailableStatus = (): IGitRepositoryStatusPayload =>
  createStatus({
    available: false,
    message: MSG_REPO_UNAVAILABLE,
    repositoryRootPath: null,
    repositoryName: null,
    gitDirPath: null,
    headBranchName: null,
    headShortName: null,
  });

const pullRequestSupportPayload = {
  available: true,
  remoteName: 'origin',
  provider: 'github',
  repositoryUrl: 'https://github.com/owner/repo',
  pullRequestsUrl: 'https://github.com/owner/repo/pulls',
  createPullRequestUrl: 'https://github.com/owner/repo/compare',
};

const tauriServiceMock = vi.hoisted(() => ({
  getGitRepositoryStatus: vi.fn(),
  initGitRepository: vi.fn(),
  getGitPullRequestSupport: vi.fn(),
  listGitPullRequests: vi.fn(),
  getGitPullRequestDetail: vi.fn(),
  listGitCommitHistory: vi.fn(),
  createGitPullRequest: vi.fn(),
  mergeGitPullRequest: vi.fn(),
  closeGitPullRequest: vi.fn(),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: tauriServiceMock,
}));

describe('useGitStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    tauriServiceMock.getGitPullRequestSupport.mockResolvedValue(pullRequestSupportPayload);
  });

  it('初始化仓库结果不会被旧刷新请求覆盖回未初始化状态', async () => {
    const gitStore = useGitStore();

    const staleRefresh = createDeferred<IGitRepositoryStatusPayload>();
    tauriServiceMock.getGitRepositoryStatus.mockReturnValueOnce(staleRefresh.promise);

    const initializedStatus = createStatus();
    tauriServiceMock.initGitRepository.mockResolvedValueOnce(initializedStatus);

    const refreshPromise = gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);
    await gitStore.initRepository(WORKSPACE_ROOT);

    expect(gitStore.status.available).toBe(true);
    expect(gitStore.status.repositoryRootPath).toBe(WORKSPACE_ROOT);

    staleRefresh.resolve(createUnavailableStatus());
    await refreshPromise;

    expect(gitStore.status.available).toBe(true);
    expect(gitStore.status.repositoryRootPath).toBe(WORKSPACE_ROOT);
    expect(gitStore.isLoading).toBe(false);
  });

  it('初始化返回非当前工作区仓库时会报错且不写入状态', async () => {
    const gitStore = useGitStore();

    const parentRepositoryStatus = createStatus({
      repositoryRootPath: PARENT_WORKSPACE_ROOT,
      repositoryName: 'parent',
      gitDirPath: `${PARENT_WORKSPACE_ROOT}/.git`,
    });
    tauriServiceMock.initGitRepository.mockResolvedValueOnce(parentRepositoryStatus);

    await expect(gitStore.initRepository(WORKSPACE_ROOT)).rejects.toThrow(MSG_INIT_MISMATCH);

    expect(gitStore.status.available).toBe(false);
    expect(gitStore.status.repositoryRootPath).toBeNull();
    expect(gitStore.isLoading).toBe(false);
  });

  it('提交历史分页追加会复用现有数组并避免复制旧列表', async () => {
    const gitStore = useGitStore();
    tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(createStatus());
    await gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);

    const firstCommit = createCommitSummary({ id: 'commit-1', summary: 'feat: first' });
    const secondCommit = createCommitSummary({ id: 'commit-2', summary: 'feat: second' });
    tauriServiceMock.listGitCommitHistory
      .mockResolvedValueOnce({ entries: [firstCommit], hasMore: true, nextOffset: 1 })
      .mockResolvedValueOnce({ entries: [secondCommit], hasMore: false, nextOffset: null });

    await expect(gitStore.loadCommitHistory({ limit: 1 })).resolves.toEqual([firstCommit]);
    const existingHistory = gitStore.commitHistory;

    await expect(gitStore.loadCommitHistory({ append: true, limit: 1 })).resolves.toEqual([
      firstCommit,
      secondCommit,
    ]);

    expect(gitStore.commitHistory).toBe(existingHistory);
    expect(tauriServiceMock.listGitCommitHistory).toHaveBeenNthCalledWith(1, {
      repositoryRootPath: WORKSPACE_ROOT,
      offset: 0,
      limit: 1,
    });
    expect(tauriServiceMock.listGitCommitHistory).toHaveBeenNthCalledWith(2, {
      repositoryRootPath: WORKSPACE_ROOT,
      offset: 1,
      limit: 1,
    });
  });

  it('拉取请求支持检测会合并并发请求', async () => {
    const gitStore = useGitStore();
    tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(createStatus());
    await gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);

    const deferred = createDeferred<typeof pullRequestSupportPayload>();
    tauriServiceMock.getGitPullRequestSupport.mockReturnValueOnce(deferred.promise);

    const firstRequest = gitStore.loadPullRequestSupport();
    const secondRequest = gitStore.loadPullRequestSupport();

    expect(tauriServiceMock.getGitPullRequestSupport).toHaveBeenCalledTimes(1);

    deferred.resolve(pullRequestSupportPayload);
    await expect(firstRequest).resolves.toEqual(pullRequestSupportPayload);
    await expect(secondRequest).resolves.toEqual(pullRequestSupportPayload);
    expect(gitStore.pullRequestSupport.available).toBe(true);
  });

  it('拉取请求列表会合并并发请求并复用缓存', async () => {
    const gitStore = useGitStore();
    tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(createStatus());
    await gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);

    const deferred = createDeferred<IGitPullRequestSummaryPayload[]>();
    tauriServiceMock.listGitPullRequests.mockReturnValueOnce(deferred.promise);

    const firstRequest = gitStore.loadPullRequests('open');
    const secondRequest = gitStore.loadPullRequests('open');

    expect(tauriServiceMock.listGitPullRequests).toHaveBeenCalledTimes(1);
    expect(tauriServiceMock.listGitPullRequests).toHaveBeenCalledWith({
      repositoryRootPath: WORKSPACE_ROOT,
      state: 'open',
    });

    const firstPayload = [createPullRequest({ title: 'feat: cached pr' })];
    deferred.resolve(firstPayload);
    await expect(firstRequest).resolves.toEqual(firstPayload);
    await expect(secondRequest).resolves.toEqual(firstPayload);
    expect(gitStore.pullRequests[0]?.title).toBe('feat: cached pr');

    await expect(gitStore.loadPullRequests('open')).resolves.toEqual(firstPayload);
    expect(tauriServiceMock.listGitPullRequests).toHaveBeenCalledTimes(1);
  });

  it('强制刷新拉取请求时先保留缓存再更新结果', async () => {
    const gitStore = useGitStore();
    tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(createStatus());
    await gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);

    tauriServiceMock.listGitPullRequests.mockResolvedValueOnce([
      createPullRequest({ title: 'feat: old pr' }),
    ]);
    await gitStore.loadPullRequests('open');

    const deferred = createDeferred<IGitPullRequestSummaryPayload[]>();
    tauriServiceMock.listGitPullRequests.mockReturnValueOnce(deferred.promise);

    const refreshPromise = gitStore.loadPullRequests('open', { force: true });
    expect(gitStore.pullRequests[0]?.title).toBe('feat: old pr');

    const nextPayload = [createPullRequest({ number: 2, title: 'feat: fresh pr' })];
    deferred.resolve(nextPayload);
    await expect(refreshPromise).resolves.toEqual(nextPayload);

    expect(gitStore.pullRequests[0]?.title).toBe('feat: fresh pr');
  });

  it('旧的拉取请求详情响应不会覆盖当前选中的详情', async () => {
    const gitStore = useGitStore();
    tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(createStatus());
    await gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);

    const staleDetail = createDeferred<IGitPullRequestDetailPayload>();
    const currentDetail = createDeferred<IGitPullRequestDetailPayload>();
    tauriServiceMock.getGitPullRequestDetail
      .mockReturnValueOnce(staleDetail.promise)
      .mockReturnValueOnce(currentDetail.promise);

    const staleRequest = gitStore.loadPullRequestDetail(1);
    const currentRequest = gitStore.loadPullRequestDetail(2);

    const currentPayload = createPullRequestDetail({
      number: 2,
      title: 'feat: current detail',
      htmlUrl: 'https://github.com/owner/repo/pull/2',
    });
    currentDetail.resolve(currentPayload);
    await expect(currentRequest).resolves.toEqual(currentPayload);
    expect(gitStore.pullRequestDetail?.number).toBe(2);

    const stalePayload = createPullRequestDetail({
      number: 1,
      title: 'feat: stale detail',
    });
    staleDetail.resolve(stalePayload);
    await expect(staleRequest).resolves.toEqual(stalePayload);

    expect(gitStore.pullRequestDetail?.number).toBe(2);
    expect(gitStore.pullRequestDetail?.title).toBe('feat: current detail');
  });

  it('拉取请求变更会立即更新当前列表缓存', async () => {
    const gitStore = useGitStore();
    tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(createStatus());
    await gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);

    tauriServiceMock.listGitPullRequests.mockResolvedValueOnce([
      createPullRequest({ number: 1, title: 'feat: open pr' }),
    ]);
    await gitStore.loadPullRequests('open');

    const mergedPullRequest = createPullRequest({
      number: 1,
      title: 'feat: open pr',
      state: 'merged',
    });
    tauriServiceMock.mergeGitPullRequest.mockResolvedValueOnce(mergedPullRequest);

    await expect(gitStore.mergePullRequest(1, 'squash')).resolves.toEqual(mergedPullRequest);

    expect(gitStore.pullRequests).toHaveLength(0);
    await expect(gitStore.loadPullRequests('open')).resolves.toEqual([]);
    expect(tauriServiceMock.listGitPullRequests).toHaveBeenCalledTimes(1);

    await expect(gitStore.loadPullRequests('all')).resolves.toEqual([mergedPullRequest]);
  });

  it('新鲜拉取请求列表缓存命中时不会重复拉列表但会继续预热详情', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:00.000Z'));

    try {
      const gitStore = useGitStore();
      tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(createStatus());
      await gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);

      const pullRequests = [
        createPullRequest({ number: 1, title: 'feat: first pr' }),
        createPullRequest({
          number: 2,
          title: 'feat: second pr',
          htmlUrl: 'https://github.com/owner/repo/pull/2',
        }),
      ];

      tauriServiceMock.listGitPullRequests.mockResolvedValueOnce(pullRequests);

      await expect(gitStore.loadPullRequests('open', { preloadDetails: false })).resolves.toEqual(
        pullRequests,
      );

      expect(tauriServiceMock.listGitPullRequests).toHaveBeenCalledTimes(1);
      expect(tauriServiceMock.getGitPullRequestDetail).not.toHaveBeenCalled();

      tauriServiceMock.getGitPullRequestDetail.mockImplementation(({ number }) =>
        Promise.resolve(
          createPullRequestDetail({
            number,
            title: `feat: detail ${number}`,
            htmlUrl: `https://github.com/owner/repo/pull/${number}`,
          }),
        ),
      );

      await expect(gitStore.loadPullRequests('open')).resolves.toEqual(pullRequests);

      expect(tauriServiceMock.listGitPullRequests).toHaveBeenCalledTimes(1);
      expect(tauriServiceMock.getGitPullRequestDetail).toHaveBeenCalledWith({
        repositoryRootPath: WORKSPACE_ROOT,
        number: 1,
      });
      expect(tauriServiceMock.getGitPullRequestDetail).toHaveBeenCalledWith({
        repositoryRootPath: WORKSPACE_ROOT,
        number: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('拉取请求详情缓存命中会按刷新预算静默 revalidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:00.000Z'));

    try {
      const gitStore = useGitStore();
      tauriServiceMock.getGitRepositoryStatus.mockResolvedValueOnce(createStatus());
      await gitStore.refreshRepositoryStatus(WORKSPACE_ROOT);

      const cachedDetail = createPullRequestDetail({
        number: 1,
        title: 'feat: cached detail',
      });
      const revalidatedDetail = createPullRequestDetail({
        number: 1,
        title: 'feat: revalidated detail',
      });

      tauriServiceMock.getGitPullRequestDetail.mockResolvedValueOnce(cachedDetail);

      await expect(gitStore.loadPullRequestDetail(1)).resolves.toEqual(cachedDetail);
      expect(tauriServiceMock.getGitPullRequestDetail).toHaveBeenCalledTimes(1);
      expect(gitStore.pullRequestDetail?.title).toBe('feat: cached detail');

      tauriServiceMock.getGitPullRequestDetail.mockResolvedValueOnce(revalidatedDetail);

      await expect(gitStore.loadPullRequestDetail(1)).resolves.toEqual(cachedDetail);

      expect(tauriServiceMock.getGitPullRequestDetail).toHaveBeenCalledTimes(1);
      expect(gitStore.pullRequestDetail?.title).toBe('feat: cached detail');

      await vi.advanceTimersByTimeAsync(30_001);

      await expect(gitStore.loadPullRequestDetail(1)).resolves.toEqual(cachedDetail);

      expect(tauriServiceMock.getGitPullRequestDetail).toHaveBeenCalledTimes(2);

      await Promise.resolve();

      expect(gitStore.pullRequestDetail?.title).toBe('feat: revalidated detail');
    } finally {
      vi.useRealTimers();
    }
  });
});
