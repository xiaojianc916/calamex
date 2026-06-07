import {
  connectGithub,
  disconnectGithub,
  getGithubAuthStatus,
} from '@/services/tauri.github-auth';
import { useGitStore } from '@/store/git';
import type { IGitHubAuthStatusPayload } from '@/services/tauri.github-auth';
import { openExternalUrl } from '@/utils/browser';

const BRANCH_SYNC_SELECTOR = '.source-control-branch-sync';
const GITHUB_LOGIN_URL = 'https://github.com/login';

let observer: MutationObserver | null = null;
let currentRepositoryRoot: string | null = null;
let currentStatus: IGitHubAuthStatusPayload | null = null;
let isLoading = false;
let isStarted = false;
let renderQueued = false;
let isMenuOpen = false;

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

const resolveCredentialSourceLabel = (source: string | null): string => {
  switch (source) {
    case 'github-cli':
      return 'GitHub CLI';
    case 'git-credential':
      return 'Git Credential';
    default:
      return 'GitHub';
  }
};

const createButtonLabel = (): string => {
  if (isLoading) {
    return '连接中';
  }

  if (currentStatus?.authenticated) {
    return currentStatus.login ?? 'GitHub';
  }

  return 'GitHub';
};

const createButtonTitle = (): string => {
  if (currentStatus?.authenticated) {
    const displayName = currentStatus.name || currentStatus.login || 'GitHub';
    return `已通过 ${resolveCredentialSourceLabel(currentStatus.source)} 连接 ${displayName}`;
  }

  return currentStatus?.message || '连接 GitHub 账号';
};

const getSnapshot = (repositoryRootPath: string | null): string =>
  JSON.stringify({
    repositoryRootPath,
    isLoading,
    isMenuOpen,
    authenticated: currentStatus?.authenticated ?? false,
    login: currentStatus?.login ?? null,
    avatarUrl: currentStatus?.avatarUrl ?? null,
    source: currentStatus?.source ?? null,
    message: currentStatus?.message ?? null,
  });

const closeMenu = (): void => {
  if (!isMenuOpen) {
    return;
  }
  isMenuOpen = false;
  renderAllGithubAuthHeaders();
};

const promptGitHubLogin = (): void => {
  openExternalUrl(GITHUB_LOGIN_URL);
};

const refreshCurrentRepositoryAuth = (): void => {
  const repositoryRootPath = getRepositoryRootPath();
  if (repositoryRootPath) {
    void refreshAuthStatusForRepository(repositoryRootPath);
  }
};

const handleButtonClick = async (): Promise<void> => {
  if (isLoading) {
    return;
  }

  if (currentStatus?.authenticated) {
    isMenuOpen = !isMenuOpen;
    renderAllGithubAuthHeaders();
    return;
  }

  const repositoryRootPath = getRepositoryRootPath();
  if (!repositoryRootPath) {
    return;
  }

  isLoading = true;
  renderAllGithubAuthHeaders();

  try {
    currentStatus = await connectGithub(repositoryRootPath);
    if (!currentStatus.authenticated) {
      promptGitHubLogin();
    }
  } catch (error) {
    currentStatus = {
      authenticated: false,
      login: null,
      name: null,
      avatarUrl: null,
      htmlUrl: null,
      email: null,
      source: null,
      message: error instanceof Error ? error.message : '连接 GitHub 失败',
    };
  } finally {
    isLoading = false;
    renderAllGithubAuthHeaders();
  }
};

const handleOpenProfile = (): void => {
  const htmlUrl = currentStatus?.htmlUrl;
  closeMenu();
  if (htmlUrl) {
    openExternalUrl(htmlUrl);
  }
};

const handleSwitchAccount = async (): Promise<void> => {
  const repositoryRootPath = getRepositoryRootPath();
  if (!repositoryRootPath || isLoading) {
    return;
  }

  isMenuOpen = false;
  isLoading = true;
  renderAllGithubAuthHeaders();

  try {
    currentStatus = await disconnectGithub(repositoryRootPath);
    promptGitHubLogin();
  } catch (error) {
    currentStatus = {
      authenticated: false,
      login: null,
      name: null,
      avatarUrl: null,
      htmlUrl: null,
      email: null,
      source: null,
      message: error instanceof Error ? error.message : '切换 GitHub 账号失败',
    };
  } finally {
    isLoading = false;
    renderAllGithubAuthHeaders();
  }
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
  if (!(container instanceof HTMLElement)) {
    return;
  }

  const snapshot = getSnapshot(repositoryRootPath);
  if (container.dataset.githubAuthSnapshot === snapshot) {
    return;
  }

  container.dataset.githubAuthSnapshot = snapshot;
  container.classList.add('is-github-auth-slot');
  container.replaceChildren();

  const wrapper = document.createElement('div');
  wrapper.className = 'source-control-github-auth-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-control-github-auth';
  button.disabled = isLoading || !repositoryRootPath;
  button.title = createButtonTitle();
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(isMenuOpen && Boolean(currentStatus?.authenticated)));
  button.classList.toggle('is-connected', Boolean(currentStatus?.authenticated));
  button.classList.toggle('is-loading', isLoading);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void handleButtonClick();
  });

  const visual = currentStatus?.authenticated
    ? createAvatar(currentStatus)
    : createIcon(isLoading ? 'loader' : 'github');
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
  if (typeof document === 'undefined') {
    return;
  }

  const repositoryRootPath = getRepositoryRootPath();
  for (const container of document.querySelectorAll(BRANCH_SYNC_SELECTOR)) {
    renderGithubAuthHeader(container, repositoryRootPath);
  }
};

const refreshAuthStatusForRepository = async (repositoryRootPath: string): Promise<void> => {
  isLoading = true;
  renderAllGithubAuthHeaders();

  try {
    currentStatus = await getGithubAuthStatus(repositoryRootPath);
  } catch (error) {
    currentStatus = {
      authenticated: false,
      login: null,
      name: null,
      avatarUrl: null,
      htmlUrl: null,
      email: null,
      source: null,
      message: error instanceof Error ? error.message : '读取 GitHub 登录状态失败',
    };
  } finally {
    isLoading = false;
    renderAllGithubAuthHeaders();
  }
};

const syncGithubAuthHeader = (): void => {
  const repositoryRootPath = getRepositoryRootPath();
  if (repositoryRootPath !== currentRepositoryRoot) {
    currentRepositoryRoot = repositoryRootPath;
    currentStatus = null;
    isMenuOpen = false;
    if (repositoryRootPath) {
      void refreshAuthStatusForRepository(repositoryRootPath);
    }
  }

  renderAllGithubAuthHeaders();
};

const queueRender = (): void => {
  if (renderQueued) {
    return;
  }

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
  refreshCurrentRepositoryAuth();
};

export const initGitHubAuthHeaderEnhancement = (): void => {
  if (isStarted || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

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
