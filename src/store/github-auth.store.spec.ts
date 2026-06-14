import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGitHubAuthStatusPayload } from '@/types/git';

import { useGitHubAuthStore } from './github-auth';

const WORKSPACE_ROOT = 'D:/repo';
const NEXT_WORKSPACE_ROOT = 'D:/next-repo';

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

const createAuthStatus = (
  overrides: Partial<IGitHubAuthStatusPayload> = {},
): IGitHubAuthStatusPayload => ({
  authenticated: true,
  login: 'octocat',
  name: 'Octo Cat',
  avatarUrl: 'https://github.com/images/error/octocat_happy.gif',
  htmlUrl: 'https://github.com/octocat',
  email: 'octocat@example.com',
  source: 'calamex-oauth',
  message: null,
  ...overrides,
});

const cacheKeyFor = (repositoryRootPath: string): string =>
  `calamex.githubAuth.${encodeURIComponent(repositoryRootPath)}`;

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const githubAuthServiceMock = vi.hoisted(() => ({
  beginGithubBrowserAuth: vi.fn(),
  beginGithubDeviceAuth: vi.fn(),
  completeGithubBrowserAuth: vi.fn(),
  completeGithubDeviceAuth: vi.fn(),
  getGithubAuthStatus: vi.fn(),
}));

vi.mock('@/services/tauri.github-auth', () => ({
  beginGithubBrowserAuth: githubAuthServiceMock.beginGithubBrowserAuth,
  beginGithubDeviceAuth: githubAuthServiceMock.beginGithubDeviceAuth,
  completeGithubBrowserAuth: githubAuthServiceMock.completeGithubBrowserAuth,
  completeGithubDeviceAuth: githubAuthServiceMock.completeGithubDeviceAuth,
  getGithubAuthStatus: githubAuthServiceMock.getGithubAuthStatus,
}));

vi.mock('@/utils/browser', () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock('@/utils/clipboard', () => ({
  tryWriteClipboardText: vi.fn(),
}));

describe('useGitHubAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('启动恢复时立即使用缓存的 GitHub 登录快照', async () => {
    const cachedStatus = createAuthStatus({ login: 'cached-octocat' });
    const staleRefresh = createDeferred<IGitHubAuthStatusPayload>();
    window.localStorage.setItem(
      cacheKeyFor(WORKSPACE_ROOT),
      JSON.stringify({ status: cachedStatus, updatedAt: Date.now() }),
    );
    githubAuthServiceMock.getGithubAuthStatus.mockReturnValueOnce(staleRefresh.promise);

    const authStore = useGitHubAuthStore();
    authStore.setRepositoryRootPath(WORKSPACE_ROOT);

    expect(authStore.status.authenticated).toBe(true);
    expect(authStore.status.login).toBe('cached-octocat');
    expect(authStore.isLoading).toBe(false);
    expect(githubAuthServiceMock.getGithubAuthStatus).toHaveBeenCalledWith(WORKSPACE_ROOT);

    staleRefresh.reject(new Error('network offline'));
    await flushPromises();

    expect(authStore.status.authenticated).toBe(true);
    expect(authStore.status.login).toBe('cached-octocat');
    expect(authStore.status.message).toBe('network offline');
  });

  it('旧仓库的登录状态失败响应不会覆盖当前仓库', async () => {
    const staleRefresh = createDeferred<IGitHubAuthStatusPayload>();
    const currentRefresh = createDeferred<IGitHubAuthStatusPayload>();
    githubAuthServiceMock.getGithubAuthStatus
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(currentRefresh.promise);

    const authStore = useGitHubAuthStore();
    authStore.setRepositoryRootPath(WORKSPACE_ROOT);
    authStore.setRepositoryRootPath(NEXT_WORKSPACE_ROOT);

    currentRefresh.resolve(createAuthStatus({ login: 'current-octocat' }));
    await flushPromises();

    expect(authStore.status.authenticated).toBe(true);
    expect(authStore.status.login).toBe('current-octocat');

    staleRefresh.reject(new Error('stale request failed'));
    await flushPromises();

    expect(authStore.status.authenticated).toBe(true);
    expect(authStore.status.login).toBe('current-octocat');
    expect(authStore.isLoading).toBe(false);
  });

  it('连接 GitHub 时优先使用系统浏览器 PKCE 授权', async () => {
    const authStore = useGitHubAuthStore();
    githubAuthServiceMock.getGithubAuthStatus.mockResolvedValueOnce(
      createAuthStatus({ authenticated: false, login: null }),
    );
    githubAuthServiceMock.beginGithubBrowserAuth.mockResolvedValueOnce({
      authorizationUrl: 'https://github.com/login/oauth/authorize?state=abc',
      state: 'abc',
      expiresIn: 180,
    });
    githubAuthServiceMock.completeGithubBrowserAuth.mockResolvedValueOnce(
      createAuthStatus({ login: 'browser-octocat' }),
    );

    authStore.setRepositoryRootPath(WORKSPACE_ROOT);
    await authStore.startDeviceAuth();

    expect(githubAuthServiceMock.beginGithubBrowserAuth).toHaveBeenCalledWith(WORKSPACE_ROOT);
    expect(githubAuthServiceMock.completeGithubBrowserAuth).toHaveBeenCalledWith({
      repositoryRootPath: WORKSPACE_ROOT,
      state: 'abc',
    });
    expect(githubAuthServiceMock.beginGithubDeviceAuth).not.toHaveBeenCalled();
    expect(authStore.status.login).toBe('browser-octocat');
  });

  it('系统浏览器 PKCE 不可用时回退到 Device Flow', async () => {
    const authStore = useGitHubAuthStore();
    githubAuthServiceMock.getGithubAuthStatus.mockResolvedValueOnce(
      createAuthStatus({ authenticated: false, login: null }),
    );
    githubAuthServiceMock.beginGithubBrowserAuth.mockRejectedValueOnce(
      new Error('redirect_uri mismatch'),
    );
    githubAuthServiceMock.beginGithubDeviceAuth.mockResolvedValueOnce({
      deviceCode: 'device-code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      interval: 1,
      expiresIn: 900,
    });
    githubAuthServiceMock.completeGithubDeviceAuth.mockResolvedValueOnce(
      createAuthStatus({ login: 'device-octocat' }),
    );

    authStore.setRepositoryRootPath(WORKSPACE_ROOT);
    await authStore.startDeviceAuth();

    expect(githubAuthServiceMock.beginGithubBrowserAuth).toHaveBeenCalledWith(WORKSPACE_ROOT);
    expect(githubAuthServiceMock.beginGithubDeviceAuth).toHaveBeenCalledWith(WORKSPACE_ROOT);
    expect(githubAuthServiceMock.completeGithubDeviceAuth).toHaveBeenCalledWith({
      repositoryRootPath: WORKSPACE_ROOT,
      deviceCode: 'device-code',
      interval: 1,
    });
    expect(authStore.status.login).toBe('device-octocat');
  });
});
