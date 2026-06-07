import {
  beginGithubDeviceAuth,
  completeGithubDeviceAuth,
  disconnectGithub,
  getGithubAuthStatus,
} from '@/services/tauri.github-auth';
import { useGitStore } from '@/store/git';
import type {
  IGitHubAuthStatusPayload,
  IGitHubDeviceAuthPayload,
} from '@/services/tauri.github-auth';
import { openExternalUrl } from '@/utils/browser';
import { tryWriteClipboardText } from '@/utils/clipboard';

const BRANCH_SYNC_SELECTOR = '.source-control-branch-sync';
const AUTH_CACHE_PREFIX = 'calamex.githubAuth.';
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const POST_BROWSER_AUTH_REFRESH_MS = 1500;

type CachedAuthStatus = {
  status: IGitHubAuthStatusPayload;
  updatedAt: number;
};

let observer: MutationObserver | null = null;
let currentRepositoryRoot: string | null = null;
let currentStatus: IGitHubAuthStatusPayload | null = null;
let currentStatusUpdatedAt = 0;
let pendingAuthRequest: Promise<IGitHubAuthStatusPayload> | null = null;
let pendingDeviceAuth: Promise<IGitHubAuthStatusPayload> | null = null;
let currentDeviceAuth: IGitHubDeviceAuthPayload | null = null;
let isLoading = false;
let isStarted = false;
let renderQueued = false;
let isMenuOpen = false;
let lastBrowserAuthOpenedAt = 0;

const getRepositoryRootPath = (): string | null => {
  try {
    return useGitStore().status.repositoryRootPath;
  } catch {
    return null;
  }
};

const createIcon = (name: 'github' | 'loader' | 'external' | 'switch'): HTMLSpanElement => {
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.className = `source-control-github-auth-icon ${
    name === 'github'
      ? 'icon-[lucide--github]'
      : name === 'loader'
        ? 'icon-[lucide--loader-circle]'
        : name === 'external'
          ? 'icon-[lucide--external-link]'
          : 'icon-[lucide--refresh-cw]'
  }`;
  return icon;
};

const createAvatar = (status: IGitHubAuthStatusPayload): HTMLElement => {
  if (status.avatarUrl) {
    const image = document.createElement('img');
    image.className = 'source-control-github-auth-avatar';
    image.src = status.avatarUrl;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    return image;
  }

  return createIcon('github');
};

const createEmptyStatus = (message: string | null = null): IGitHubAuthStatusPayload => ({
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

const readCachedStatus = (repositoryRootPath: string): CachedAuthStatus | null => {
  if (typeof sessionStorage === 'undefined') return null;

  try {
    const raw = sessionStorage.getItem(getCacheKey(repositoryRootPath));
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedAuthStatus;
    if (!cached?.status || typeof cached.updatedAt !== 'number') return null;
    return cached;
  } catch {
    return null;
  }
};

const writeCachedStatus = (repositoryRootPath: string, status: IGitHubAuthStatusPayload): void => {
  if (typeof sessionStorage === 'undefined') return;

  try {
    sessionStorage.setItem(
      getCacheKey(repositoryRootPath),
      JSON.stringify({ status, updatedAt: Date.now() } satisfies CachedAuthStatus),
    );
  } catch {
    // Ignore storage pressure/privacy-mode failures; the in-memory cache still works.
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

const createButtonLabel = (): string => {
  if (currentDeviceAuth) {
    return currentDeviceAuth.userCode;
  }

  if (isLoading && !currentStatus) {
    return '连接中';
  }

  if (currentStatus?.authenticated) {
    return currentStatus.login ?? 'GitHub';
  }

  return 'GitHub';
};

const createButtonTitle = (): string => {
  if (currentDeviceAuth) {
    return `GitHub 验证码 ${currentDeviceAuth.userCode} 已复制，浏览器完成授权后会自动连接。`;
  }

  if (currentStatus?.authenticated) {
    const displayName = currentStatus.name || currentStatus.login || 'GitHub';
    return `已通过 ${resolveCredentialSourceLabel(currentStatus.source)} 连接 ${displayName}`;
  }

  return currentStatus?.message || '连接 GitHub 账号';
};

const getSnapshot = (repositoryRootPath: string | null): string =>
  JSON.stringify({
    repositoryRootPath,
    isLoading: isLoading && !currentStatus,
    isMenuOpen,
    deviceUserCode: currentDeviceAuth?.userCode ?? null,
    authenticated: currentStatus?.authenticated ?? false,
    login: currentStatus?.login ?? null,
    avatarUrl: currentStatus?.avatarUrl ?? null,
    source: currentStatus?.source ?? null,
    message: currentStatus?.message ?? null,
  });

const closeMenu = (): void => {
  if (!isMenuOpen) return;
  isMenuOpen = false;
  renderAllGithubAuthHeaders();
};

const buildVerificationUri = (deviceAuth: IGitHubDeviceAuthPayload): string => {
  const separator = deviceAuth.verificationUri.includes('?') ? '&' : '?';
  return `${deviceAuth.verificationUri}${separator}prompt=select_account`;
};

const shouldUseCachedStatus = (): boolean =>
  Boolean(currentStatus) && Date.now() - currentStatusUpdatedAt < AUTH_CACHE_TTL_MS;

const applyStatus = (repositoryRootPath: string, status: IGitHubAuthStatusPayload): void => {
  currentStatus = status;
  currentStatusUpdatedAt = Date.now();
  writeCachedStatus(repositoryRootPath, status);
};

const refreshAuthStatusForRepository = async (
  repositoryRootPath: string,
  options?: { force?: boolean; visibleLoading?: boolean },
): Promise<IGitHubAuthStatusPayload> => {
  if (!options?.force && shouldUseCachedStatus() && currentStatus) {
    renderAllGithubAuthHeaders();
    return currentStatus;
  }

  if (pendingAuthRequest) return pendingAuthRequest;

  if (options?.visibleLoading || !currentStatus) {
    isLoading = true;
    renderAllGithubAuthHeaders();
  }

  pendingAuthRequest = getGithubAuthStatus(repositoryRootPath)
    .then((status) => {
      applyStatus(repositoryRootPath, status);
      return status;
    })
    .catch((error: unknown) => {
      const status = createEmptyStatus(
        error instanceof Error ? error.message : '读取 GitHub 登录状态失败',
      );
      applyStatus(repositoryRootPath, status);
      return status;
    })
    .finally(() => {
      pendingAuthRequest = null;
      isLoading = false;
      renderAllGithubAuthHeaders();
    });

  return pendingAuthRequest;
};

const startDeviceAuth = async (repositoryRootPath: string): Promise<void> => {
  if (pendingDeviceAuth) return;

  isLoading = true;
  currentDeviceAuth = null;
  renderAllGithubAuthHeaders();

  try {
    const deviceAuth = await beginGithubDeviceAuth(repositoryRootPath);
    currentDeviceAuth = deviceAuth;
    currentStatus = createEmptyStatus('请在浏览器完成 GitHub 授权。');
    currentStatusUpdatedAt = Date.now();
    void tryWriteClipboardText(deviceAuth.userCode);
    lastBrowserAuthOpenedAt = Date.now();
    openExternalUrl(buildVerificationUri(deviceAuth));
    renderAllGithubAuthHeaders();

    pendingDeviceAuth = completeGithubDeviceAuth({
      repositoryRootPath,
      deviceCode: deviceAuth.deviceCode,
      interval: deviceAuth.interval,
    });

    const status = await pendingDeviceAuth;
    applyStatus(repositoryRootPath, status);
  } catch (error) {
    applyStatus(
      repositoryRootPath,
      createEmptyStatus(error instanceof Error ? error.message : 'GitHub 授权失败'),
    );
  } finally {
    pendingDeviceAuth = null;
    currentDeviceAuth = null;
    isLoading = false;
    renderAllGithubAuthHeaders();
  }
};

const handleButtonClick = async (): Promise<void> => {
  if (pendingDeviceAuth || (isLoading && !currentStatus)) return;

  if (currentStatus?.authenticated) {
    isMenuOpen = !isMenuOpen;
    renderAllGithubAuthHeaders();
    return;
  }

  const repositoryRootPath = getRepositoryRootPath();
  if (!repositoryRootPath) return;

  await startDeviceAuth(repositoryRootPath);
};

const handleOpenProfile = (): void => {
  const htmlUrl = currentStatus?.htmlUrl;
  closeMenu();
  if (htmlUrl) openExternalUrl(htmlUrl);
};

const handleSwitchAccount = async (): Promise<void> => {
  const repositoryRootPath = getRepositoryRootPath();
  if (!repositoryRootPath || pendingDeviceAuth || (isLoading && !currentStatus)) return;

  isMenuOpen = false;
  currentStatus = createEmptyStatus('请在浏览器选择 GitHub 账号。');
  currentStatusUpdatedAt = Date.now();
  clearCachedStatus(repositoryRootPath);
  renderAllGithubAuthHeaders();

  try {
    await disconnectGithub(repositoryRootPath);
  } catch {
    // The new OAuth token will replace the app credential after authorization.
  }

  await startDeviceAuth(repositoryRootPath);
};

const createMenuButton = (
  iconName: 'external' | 'switch',
  label: string,
  onClick: () => void,
): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-control-github-auth-menu-btn';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(createIcon(iconName));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
};

const createAccountMenu = (): HTMLDivElement => {
  const menu = document.createElement('div');
  menu.className = 'source-control-github-auth-menu';
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  menu.append(
    createMenuButton('external', '打开 GitHub', handleOpenProfile),
    createMenuButton('switch', '切换账号', () => {
      void handleSwitchAccount();
    }),
  );

  return menu;
};

const renderGithubAuthHeader = (container: Element, repositoryRootPath: string | null): void => {
  if (!(container instanceof HTMLElement)) return;

  const snapshot = getSnapshot(repositoryRootPath);
  if (container.dataset.githubAuthSnapshot === snapshot) return;

  container.dataset.githubAuthSnapshot = snapshot;
  container.classList.add('is-github-auth-slot');
  container.replaceChildren();

  const wrapper = document.createElement('div');
  wrapper.className = 'source-control-github-auth-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-control-github-auth';
  button.disabled = (isLoading && !currentStatus) || !repositoryRootPath;
  button.title = createButtonTitle();
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(isMenuOpen && Boolean(currentStatus?.authenticated)));
  button.classList.toggle('is-connected', Boolean(currentStatus?.authenticated));
  button.classList.toggle('is-loading', isLoading && !currentStatus);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void handleButtonClick();
  });

  const visual = currentStatus?.authenticated
    ? createAvatar(currentStatus)
    : createIcon(isLoading && !currentStatus ? 'loader' : 'github');
  button.append(visual);

  const label = document.createElement('span');
  label.className = 'source-control-github-auth-label';
  label.textContent = createButtonLabel();
  button.append(label);

  wrapper.append(button);

  if (currentStatus?.authenticated && isMenuOpen) {
    wrapper.append(createAccountMenu());
  }

  container.append(wrapper);
};

const renderAllGithubAuthHeaders = (): void => {
  if (typeof document === 'undefined') return;

  const repositoryRootPath = getRepositoryRootPath();
  for (const container of document.querySelectorAll(BRANCH_SYNC_SELECTOR)) {
    renderGithubAuthHeader(container, repositoryRootPath);
  }
};

const syncGithubAuthHeader = (): void => {
  const repositoryRootPath = getRepositoryRootPath();
  if (repositoryRootPath !== currentRepositoryRoot) {
    currentRepositoryRoot = repositoryRootPath;
    currentStatus = null;
    currentStatusUpdatedAt = 0;
    pendingAuthRequest = null;
    pendingDeviceAuth = null;
    currentDeviceAuth = null;
    isLoading = false;
    isMenuOpen = false;

    if (repositoryRootPath) {
      const cached = readCachedStatus(repositoryRootPath);
      if (cached && Date.now() - cached.updatedAt < AUTH_CACHE_TTL_MS) {
        currentStatus = cached.status;
        currentStatusUpdatedAt = cached.updatedAt;
      }

      void refreshAuthStatusForRepository(repositoryRootPath, {
        visibleLoading: !currentStatus,
      });
    }
  }

  renderAllGithubAuthHeaders();
};

const queueRender = (): void => {
  if (renderQueued) return;

  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    syncGithubAuthHeader();
  });
};

const handleDocumentPointerDown = (event: PointerEvent): void => {
  if (
    event.target instanceof Element &&
    event.target.closest('.source-control-github-auth-wrap')
  ) {
    return;
  }
  closeMenu();
};

const handleWindowFocus = (): void => {
  const repositoryRootPath = getRepositoryRootPath();
  if (!repositoryRootPath || Date.now() - lastBrowserAuthOpenedAt < POST_BROWSER_AUTH_REFRESH_MS) {
    return;
  }

  if (lastBrowserAuthOpenedAt > 0 || Date.now() - currentStatusUpdatedAt >= AUTH_CACHE_TTL_MS) {
    lastBrowserAuthOpenedAt = 0;
    void refreshAuthStatusForRepository(repositoryRootPath, {
      force: true,
      visibleLoading: false,
    });
  }
};

export const initGitHubAuthHeaderEnhancement = (): void => {
  if (isStarted || typeof window === 'undefined' || typeof document === 'undefined') return;

  isStarted = true;
  observer = new MutationObserver(queueRender);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  window.addEventListener('focus', handleWindowFocus);

  queueRender();
};

export const stopGitHubAuthHeaderEnhancement = (): void => {
  observer?.disconnect();
  observer = null;
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  window.removeEventListener('focus', handleWindowFocus);
  isStarted = false;
  isMenuOpen = false;
};
