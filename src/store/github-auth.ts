import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  beginGithubDeviceAuth,
  completeGithubDeviceAuth,
  disconnectGithub,
  getGithubAuthStatus,
} from '@/services/tauri.github-auth';
import type { IGitHubAuthStatusPayload, IGitHubDeviceAuthPayload } from '@/types/git';
import { openExternalUrl } from '@/utils/browser';
import { tryWriteClipboardText } from '@/utils/clipboard';

const AUTH_CACHE_PREFIX = 'calamex.githubAuth.';
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

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

const readCachedStatus = (repositoryRootPath: string): ICachedGitHubAuthStatus | null => {
  if (typeof sessionStorage === 'undefined') return null;

  try {
    const raw = sessionStorage.getItem(getCacheKey(repositoryRootPath));
    if (!raw) return null;

    const cached = JSON.parse(raw) as ICachedGitHubAuthStatus;
    if (!cached?.status || typeof cached.updatedAt !== 'number') return null;
    if (Date.now() - cached.updatedAt >= AUTH_CACHE_TTL_MS) return null;

    return cached;
  } catch {
    return null;
  }
};

const writeCachedStatus = (
  repositoryRootPath: string,
  status: IGitHubAuthStatusPayload,
): void => {
  if (typeof sessionStorage === 'undefined') return;

  try {
    sessionStorage.setItem(
      getCacheKey(repositoryRootPath),
      JSON.stringify({ status, updatedAt: Date.now() } satisfies ICachedGitHubAuthStatus),
    );
  } catch {
    // Storage is an optimization only; keep the in-memory state authoritative.
  }
};

const clearCachedStatus = (repositoryRootPath: string): void => {
  if (typeof sessionStorage === 'undefined') return;

  try {
    sessionStorage.removeItem(getCacheKey(repositoryRootPath));
  } catch {
    // Best effort only.
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
  let pendingStatusRequest: Promise<IGitHubAuthStatusPayload> | null = null;
  let pendingDeviceAuthRequest: Promise<IGitHubAuthStatusPayload> | null = null;

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
    pendingStatusRequest = null;
    pendingDeviceAuthRequest = null;
    deviceAuth.value = null;
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

    void loadStatus({ visibleLoading: !cached });
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

  const startDeviceAuth = async (): Promise<IGitHubAuthStatusPayload> => {
    const rootPath = repositoryRootPath.value;
    if (!rootPath) return applyStatus(createEmptyGithubAuthStatus('当前工作区未检测到 Git 仓库。'));
    if (pendingDeviceAuthRequest) return pendingDeviceAuthRequest;

    isLoading.value = true;
    isAuthorizing.value = true;
    deviceAuth.value = null;

    pendingDeviceAuthRequest = beginGithubDeviceAuth(rootPath)
      .then(async (payload) => {
        deviceAuth.value = payload;
        status.value = createEmptyGithubAuthStatus('请在浏览器完成 GitHub 授权。');
        statusUpdatedAt = Date.now();
        void copyDeviceCode();
        reopenVerificationPage();
        return completeGithubDeviceAuth({
          repositoryRootPath: rootPath,
          deviceCode: payload.deviceCode,
          interval: payload.interval,
        });
      })
      .then((payload) => applyStatus(payload))
      .catch((error: unknown) =>
        applyStatus(
          createEmptyGithubAuthStatus(error instanceof Error ? error.message : 'GitHub 授权失败'),
        ),
      )
      .finally(() => {
        pendingDeviceAuthRequest = null;
        deviceAuth.value = null;
        isLoading.value = false;
        isAuthorizing.value = false;
      });

    return pendingDeviceAuthRequest;
  };

  const switchAccount = async (): Promise<IGitHubAuthStatusPayload> => {
    const rootPath = repositoryRootPath.value;
    if (!rootPath) return applyStatus(createEmptyGithubAuthStatus('当前工作区未检测到 Git 仓库。'));

    clearCachedStatus(rootPath);
    status.value = createEmptyGithubAuthStatus('请在浏览器选择 GitHub 账号。');
    statusUpdatedAt = Date.now();

    try {
      await disconnectGithub(rootPath);
    } catch {
      // A fresh OAuth token will replace Calamex's saved credential after authorization.
    }

    return startDeviceAuth();
  };

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
    startDeviceAuth,
    switchAccount,
    openProfile,
    reset,
  };
});
