import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  beginGithubDeviceAuth,
  completeGithubDeviceAuth,
  getGithubAuthStatus,
} from '@/services/tauri.github-auth';
import type { IGitHubAuthStatusPayload, IGitHubDeviceAuthPayload } from '@/types/git';
import { openExternalUrl } from '@/utils/browser';
import { tryWriteClipboardText } from '@/utils/clipboard';

const AUTH_CACHE_PREFIX = 'calamex.githubAuth.';
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTH_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface ICachedGitHubAuthStatus {
  status: IGitHubAuthStatusPayload;
  updatedAt: number;
}

type TDeviceAuthMode = 'connect' | 'switch';

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

const buildVerificationUri = (deviceAuth: IGitHubDeviceAuthPayload): string => {
  const separator = deviceAuth.verificationUri.includes('?') ? '&' : '?';
  return `${deviceAuth.verificationUri}${separator}prompt=select_account`;
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
  const deviceAuth = ref<IGitHubDeviceAuthPayload | null>(null);
  const isLoading = ref(false);
  const isAuthorizing = ref(false);
  let statusUpdatedAt = 0;
  let statusRequestId = 0;
  let deviceAuthRequestId = 0;
  let pendingStatusRequest: Promise<IGitHubAuthStatusPayload> | null = null;
  let pendingDeviceAuthRequest: Promise<IGitHubAuthStatusPayload> | null = null;
  let statusBeforeDeviceAuth: IGitHubAuthStatusPayload | null = null;

  const isAuthenticated = computed(() => status.value.authenticated);
  const verificationUrl = computed(() =>
    deviceAuth.value ? buildVerificationUri(deviceAuth.value) : null,
  );
  const displayLabel = computed(() => {
    if (deviceAuth.value) return '等待授权';
    if (isLoading.value && !status.value.authenticated) return '连接中';
    return status.value.login ?? 'GitHub';
  });
  const title = computed(() => {
    if (deviceAuth.value) {
      return `GitHub 验证码 ${deviceAuth.value.userCode} 已复制，浏览器完成授权后会自动连接。`;
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
    if (options?.visibleLoading || !status.value.authenticated) {
      isLoading.value = true;
    }

    pendingStatusRequest = getGithubAuthStatus(rootPath)
      .then((payload) => {
        if (requestId !== statusRequestId) return status.value;
        return applyStatus(payload);
      })
      .catch((error: unknown) =>
        applyStatus(
          createEmptyGithubAuthStatus(
            error instanceof Error ? error.message : '读取 GitHub 登录状态失败',
          ),
        ),
      )
      .finally(() => {
        pendingStatusRequest = null;
        if (requestId === statusRequestId) isLoading.value = false;
      });

    return pendingStatusRequest;
  };

  const setRepositoryRootPath = (rootPath: string | null): void => {
    if (repositoryRootPath.value === rootPath) return;

    repositoryRootPath.value = rootPath;
    statusRequestId += 1;
    deviceAuthRequestId += 1;
    pendingStatusRequest = null;
    pendingDeviceAuthRequest = null;
    statusBeforeDeviceAuth = null;
    deviceAuth.value = null;
    isLoading.value = false;
    isAuthorizing.value = false;
    statusUpdatedAt = 0;
    status.value = createEmptyGithubAuthStatus();

    if (!rootPath) return;

    const cached = readCachedStatus(rootPath);
    if (cached) {
      status.value = cached.status;
    }

    void loadStatus({ force: true, visibleLoading: !cached });
  };

  const copyDeviceCode = async (): Promise<boolean> => {
    const userCode = deviceAuth.value?.userCode;
    if (!userCode) return false;
    return tryWriteClipboardText(userCode);
  };

  const reopenVerificationPage = (): void => {
    const url = verificationUrl.value;
    if (url) openExternalUrl(url);
  };

  const cancelDeviceAuth = (): void => {
    deviceAuthRequestId += 1;
    pendingDeviceAuthRequest = null;
    deviceAuth.value = null;
    isAuthorizing.value = false;
    isLoading.value = false;

    if (statusBeforeDeviceAuth) {
      applyStatus(statusBeforeDeviceAuth);
      statusBeforeDeviceAuth = null;
      return;
    }

    void loadStatus({ force: true, visibleLoading: false });
  };

  const startDeviceAuth = async (
    mode: TDeviceAuthMode = 'connect',
  ): Promise<IGitHubAuthStatusPayload> => {
    const rootPath = repositoryRootPath.value;
    if (!rootPath) return applyStatus(createEmptyGithubAuthStatus('当前工作区未检测到 Git 仓库。'));
    if (pendingDeviceAuthRequest) return pendingDeviceAuthRequest;

    const requestId = ++deviceAuthRequestId;
    statusBeforeDeviceAuth = status.value.authenticated ? status.value : null;
    isLoading.value = true;
    isAuthorizing.value = true;
    deviceAuth.value = null;

    pendingDeviceAuthRequest = beginGithubDeviceAuth(rootPath)
      .then(async (payload) => {
        if (requestId !== deviceAuthRequestId) return status.value;

        deviceAuth.value = payload;
        status.value = createEmptyGithubAuthStatus(
          mode === 'switch' ? '请在浏览器选择 GitHub 账号。' : '请在浏览器完成 GitHub 授权。',
        );
        statusUpdatedAt = Date.now();
        void copyDeviceCode();
        reopenVerificationPage();
        const nextStatus = await completeGithubDeviceAuth({
          repositoryRootPath: rootPath,
          deviceCode: payload.deviceCode,
          interval: payload.interval,
        });
        return requestId === deviceAuthRequestId ? nextStatus : status.value;
      })
      .then((payload) => {
        if (requestId !== deviceAuthRequestId) return status.value;
        statusBeforeDeviceAuth = null;
        return applyStatus(payload);
      })
      .catch((error: unknown) => {
        if (requestId !== deviceAuthRequestId) return status.value;

        const fallback = statusBeforeDeviceAuth;
        statusBeforeDeviceAuth = null;
        if (fallback) {
          return applyStatus(fallback);
        }

        return applyStatus(
          createEmptyGithubAuthStatus(error instanceof Error ? error.message : 'GitHub 授权失败'),
        );
      })
      .finally(() => {
        if (requestId !== deviceAuthRequestId) return;

        pendingDeviceAuthRequest = null;
        deviceAuth.value = null;
        isLoading.value = false;
        isAuthorizing.value = false;
      });

    return pendingDeviceAuthRequest;
  };

  const switchAccount = async (): Promise<IGitHubAuthStatusPayload> => startDeviceAuth('switch');

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
    deviceAuth,
    isLoading,
    isAuthorizing,
    isAuthenticated,
    verificationUrl,
    displayLabel,
    title,
    setRepositoryRootPath,
    loadStatus,
    copyDeviceCode,
    reopenVerificationPage,
    cancelDeviceAuth,
    startDeviceAuth,
    switchAccount,
    openProfile,
    reset,
  };
});
