import { connectGithub, getGithubAuthStatus } from '@/services/tauri.github-auth';
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

const getRepositoryRootPath = (): string | null => {
  try {
    return useGitStore().status.repositoryRootPath;
  } catch {
    return null;
  }
};

const createGitHubIcon = (): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('source-control-github-auth-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M8 .2a8 8 0 0 0-2.53 15.6c.4.07.55-.17.55-.38v-1.32c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.58.82-2.14-.08-.2-.36-1.02.08-2.11 0 0 .67-.21 2.2.82A7.64 7.64 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.52-1.03 2.19-.82 2.19-.82.44 1.09.16 1.91.08 2.11.51.56.82 1.27.82 2.14 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.14.46.55.38A8 8 0 0 0 8 .2Z',
  );
  svg.append(path);
  return svg;
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

  return createGitHubIcon();
};

const createButtonLabel = (): string => {
  if (isLoading) {
    return 'GitHub...';
  }

  if (currentStatus?.authenticated) {
    return currentStatus.login ?? 'GitHub';
  }

  return '连接 GitHub';
};

const createButtonTitle = (): string => {
  if (currentStatus?.authenticated) {
    const displayName = currentStatus.name || currentStatus.login || 'GitHub';
    return `已连接 ${displayName}`;
  }

  return currentStatus?.message || '连接 GitHub 以显示账号与作者信息';
};

const getSnapshot = (repositoryRootPath: string | null): string =>
  JSON.stringify({
    repositoryRootPath,
    isLoading,
    authenticated: currentStatus?.authenticated ?? false,
    login: currentStatus?.login ?? null,
    avatarUrl: currentStatus?.avatarUrl ?? null,
    message: currentStatus?.message ?? null,
  });

const handleButtonClick = async (): Promise<void> => {
  if (isLoading) {
    return;
  }

  if (currentStatus?.authenticated) {
    if (currentStatus.htmlUrl) {
      openExternalUrl(currentStatus.htmlUrl);
    }
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
      openExternalUrl(GITHUB_LOGIN_URL);
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

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-control-github-auth';
  button.disabled = isLoading || !repositoryRootPath;
  button.title = createButtonTitle();
  button.setAttribute('aria-label', button.title);
  button.classList.toggle('is-connected', Boolean(currentStatus?.authenticated));
  button.classList.toggle('is-loading', isLoading);
  button.addEventListener('click', () => {
    void handleButtonClick();
  });

  const visual = currentStatus?.authenticated ? createAvatar(currentStatus) : createGitHubIcon();
  button.append(visual);

  const label = document.createElement('span');
  label.className = 'source-control-github-auth-label';
  label.textContent = createButtonLabel();
  button.append(label);

  container.append(button);
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

  queueRender();
};

export const stopGitHubAuthHeaderEnhancement = (): void => {
  observer?.disconnect();
  observer = null;
  isStarted = false;
};
