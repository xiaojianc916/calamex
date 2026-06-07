import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGitPullRequestSummaryPayload, IGitRepositoryStatusPayload } from '@/types/git';

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

const tauriServiceMock = vi.hoisted(() => ({
  getGitRepositoryStatus: vi.fn(),
  initGitRepository: vi.fn(),
  listGitPullRequests: vi.fn(),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: tauriServiceMock,
}));

describe('useGitStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
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
});
