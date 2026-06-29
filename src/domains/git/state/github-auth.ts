import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  beginGithubBrowserAuth,
  completeGithubBrowserAuth,
  getGithubAuthStatus,
} from '@/services/tauri/github-auth';
import type { IGitHubAuthStatusPayload } from '@/types/git';
import { openExternalUrl } from '@/utils/platform/browser';

const AUTH_CACHE_PREFIX = 'calamex.githubAuth.';
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTH_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface ICachedGitHubAuthStatus {
  status: IGitHubAuthStatusPayload;
  updatedAt: number;
}

const createEmptyGithubAuthStatus = (message: string | null = null): IGitHubAuthStatusPayload => ({
  authenticated: false,
  login: null,
  name: null,
  avatarUrl: null,
  htmlUrl: null,
  email: null,
  source: null,
  message,
});

const getCacheKey = (repositoryRootPath: string): string =>
  `${AUTH_CACHE_PREFIX}${encodeURIComponent(repositoryRootPath)}`;

const resolveStorage = (): Storage | null => {
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
};

const readCachedStatus = (repositoryRootPath: string): ICachedGitHubAuthStatus | null => {
  const storage = resolveStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(getCacheKey(repositoryRootPath));
    if (!raw) return null;

    const cached = JSON.parse(raw) as ICachedGitHubAuthStatus;
    if (!cached?.status?.authenticated || typeof cached.updatedAt !== 'number') return null;
    if (Date.now() - cached.updatedAt >= AUTH_SNAPSHOT_MAX_AGE_MS) return null;

    return cached;
  } catch {
    return null;
  }
};

const writeCachedStatus = (repositoryRootPath: string, status: IGitHubAuthStatusPayload): void => {
  const storage = resolveStorage();
  if (!storage) return;

  try {
    const cacheKey = getCacheKey(repositoryRootPath);
    if (!status.authenticated) {
      storage.removeItem(cacheKey);
      return;
    }

    storage.setItem(
      cacheKey,
      JSON.stringify({ status, updatedAt: Date.now() } satisfies ICachedGitHubAuthStatus),
    );
  } catch {
    // Storage is an optimization only; keep the in-memory state authoritative.
  }
};

const resolveCredentialSourceLabel = (source: string | null): string => {
  switch (source) {
    case 'calamex-oauth':
      return 'Calamex OAuth';
    case 'github-cli':
      return 'GitHub CLI';
    case 'git-credential':
      return 'Git Credential';
    default:
      return 'GitHub';
  }
};

export const useGitHubAuthStore = defineStore('github-auth', () => {
  const repositoryRootPath = ref<string | null>(null);
  const status = ref<IGitHubAuthStatusPayload>(createEmptyGithubAuthStatus());
  const isLoading = ref(false);
  const isAuthorizing = ref(false);
  let statusUpdatedAt = 0;
  let statusRequestId = 0;
  let authRequestId = 0;
  let pendingStatusRequest: Promise<IGitHubAuthStatusPayload> | null = null;
  let pendingAuthRequest: Promise<IGitHubAuthStatusPayload> | null = null;
  let statusBeforeAuth: IGitHubAuthStatusPayload | null = null;

  const isAuthenticated = computed(() => status.value.authenticated);
  const displayLabel = computed(() => {
    if (isAuthorizing.value) return '等待授权';
    if (isLoading.value && !status.value.authenticated) return '连接中';
    return status.value.login ?? 'GitHub';
  });
  const title = computed(() => {
    if (isAuthorizing.value) {
      return '请在系统浏览器完成 GitHub 授权。';
    }

    if (status.value.authenticated) {
      const displayName = status.value.name || status.value.login || 'GitHub';
      return `已通过 ${resolveCredentialSourceLabel(status.value.source)} 连接 ${displayName}`;
    }

    return status.value.message || '连接 GitHub 账号';
  });

  const applyStatus = (payload: IGitHubAuthStatusPayload): IGitHubAuthStatusPayload => {
    status.value = payload;
    statusUpdatedAt = Date.now();
    if (repositoryRootPath.value) {
      writeCachedStatus(repositoryRootPath.value, payload);
    }
    return payload;
  };

  const loadStatus = async (options?: {
    force?: boolean;
    visibleLoading?: boolean;
    preserveAuthenticatedOnError?: boolean;
  }): Promise<IGitHubAuthStatusPayload> => {
    const rootPath = repositoryRootPath.value;
    if (!rootPath) {
      return applyStatus(createEmptyGithubAuthStatus());
    }

    if (!options?.force && Date.now() - statusUpdatedAt < AUTH_CACHE_TTL_MS) {
      return status.value;
    }

    if (pendingStatusRequest) return pendingStatusRequest;

    const requestId = ++statusRequestId;
    const fallbackStatus =
      options?.preserveAuthenticatedOnError && status.value.authenticated ? status.value : null;
    if (options?.visibleLoading || !status.value.authenticated) {
      isLoading.value = true;
    }

    pendingStatusRequest = getGithubAuthStatus(rootPath)
      .then((payload) => {
        if (requestId !== statusRequestId) return status.value;
        return applyStatus(payload);
      })
      .catch((error: unknown) => {
        if (requestId !== statusRequestId) return status.value;

        if (fallbackStatus) {
          return applyStatus({
            ...fallbackStatus,
            message: error instanceof Error ? error.message : '读取 GitHub 登录状态失败',
          });
        }

        return applyStatus(
          createEmptyGithubAuthStatus(
            error instanceof Error ? error.message : '读取 GitHub 登录状态失败',
          ),
        );
      })
      .finally(() => {
        if (requestId !== statusRequestId) return;

        pendingStatusRequest = null;
        isLoading.value = false;
      });

    return pendingStatusRequest;
  };

  const setRepositoryRootPath = (rootPath: string | null): void => {
    if (repositoryRootPath.value === rootPath) return;

    repositoryRootPath.value = rootPath;
    statusRequestId += 1;
    authRequestId += 1;
    pendingStatusRequest = null;
    pendingAuthRequest = null;
    statusBeforeAuth = null;
    isLoading.value = false;
    isAuthorizing.value = false;
    statusUpdatedAt = 0;
    status.value = createEmptyGithubAuthStatus();

    if (!rootPath) return;

    const cached = readCachedStatus(rootPath);
    if (cached) {
      status.value = cached.status;
      statusUpdatedAt = cached.updatedAt;
    }

    void loadStatus({
      force: true,
      preserveAuthenticatedOnError: Boolean(cached),
      visibleLoading: !cached,
    });
  };

  const cancelAuth = (): void => {
    authRequestId += 1;
    pendingAuthRequest = null;
    isAuthorizing.value = false;
    isLoading.value = false;

    if (statusBeforeAuth) {
      applyStatus(statusBeforeAuth);
      statusBeforeAuth = null;
      return;
    }

    void loadStatus({ force: true, visibleLoading: false });
  };

  const startAuth = async (options?: {
    switchAccount?: boolean;
  }): Promise<IGitHubAuthStatusPayload> => {
    const rootPath = repositoryRootPath.value;
    if (!rootPath) return applyStatus(createEmptyGithubAuthStatus('当前工作区未检测到 Git 仓库。'));
    if (pendingAuthRequest) return pendingAuthRequest;

    const requestId = ++authRequestId;
    statusBeforeAuth = status.value.authenticated ? status.value : null;
    isLoading.value = true;
    isAuthorizing.value = true;

    pendingAuthRequest = beginGithubBrowserAuth(rootPath)
      .then(async (payload) => {
        if (requestId !== authRequestId) return status.value;

        status.value = createEmptyGithubAuthStatus(
          options?.switchAccount
            ? '请在系统浏览器选择 GitHub 账号。'
            : '请在系统浏览器完成 GitHub 授权。',
        );
        statusUpdatedAt = Date.now();
        openExternalUrl(payload.authorizationUrl);
        const nextStatus = await completeGithubBrowserAuth({
          repositoryRootPath: rootPath,
          state: payload.state,
        });
        return requestId === authRequestId ? nextStatus : status.value;
      })
      .then((payload) => {
        if (requestId !== authRequestId) return status.value;
        statusBeforeAuth = null;
        return applyStatus(payload);
      })
      .catch((error: unknown) => {
        if (requestId !== authRequestId) return status.value;

        const fallback = statusBeforeAuth;
        statusBeforeAuth = null;
        if (fallback) {
          return applyStatus({
            ...fallback,
            message: error instanceof Error ? error.message : 'GitHub 授权失败',
          });
        }

        return applyStatus(
          createEmptyGithubAuthStatus(error instanceof Error ? error.message : 'GitHub 授权失败'),
        );
      })
      .finally(() => {
        if (requestId !== authRequestId) return;

        pendingAuthRequest = null;
        isLoading.value = false;
        isAuthorizing.value = false;
      });

    return pendingAuthRequest;
  };

  const switchAccount = async (): Promise<IGitHubAuthStatusPayload> =>
    startAuth({ switchAccount: true });

  const openProfile = (): void => {
    if (status.value.htmlUrl) {
      openExternalUrl(status.value.htmlUrl);
    }
  };

  const reset = (): void => {
    setRepositoryRootPath(null);
  };

  return {
    status,
    isLoading,
    isAuthorizing,
    isAuthenticated,
    displayLabel,
    title,
    setRepositoryRootPath,
    loadStatus,
    cancelAuth,
    startAuth,
    switchAccount,
    openProfile,
    reset,
  };
});
