import { computed, createApp, defineComponent, h, type App } from 'vue';
import GitHubAuthPill from '@/components/workbench/GitHubAuthPill.vue';
import { pinia } from '@/store';
import { useGitStore } from '@/store/git';

const BRANCH_SYNC_SELECTOR = '.source-control-branch-sync';

let observer: MutationObserver | null = null;
let isStarted = false;
let renderQueued = false;

const mountedApps = new WeakMap<HTMLElement, App<Element>>();
const mountedContainers = new Set<HTMLElement>();

const GitHubAuthHeaderSlot = defineComponent({
  name: 'GitHubAuthHeaderSlot',
  setup() {
    const gitStore = useGitStore();
    const repositoryRootPath = computed(() => gitStore.status.repositoryRootPath);

    return () =>
      h(GitHubAuthPill, {
        repositoryRootPath: repositoryRootPath.value,
      });
  },
});

const mountGithubAuthHeader = (container: Element): void => {
  if (!(container instanceof HTMLElement)) return;
  if (mountedApps.has(container)) return;

  container.classList.add('is-github-auth-slot');
  container.replaceChildren();

  const mountPoint = document.createElement('span');
  mountPoint.className = 'source-control-github-auth-native-slot';
  container.append(mountPoint);

  const app = createApp(GitHubAuthHeaderSlot);
  app.use(pinia);
  app.mount(mountPoint);

  mountedApps.set(container, app);
  mountedContainers.add(container);
};

const unmountGithubAuthHeader = (container: HTMLElement): void => {
  const app = mountedApps.get(container);
  if (app) {
    app.unmount();
  }
  mountedContainers.delete(container);
};

const unmountDetachedHeaders = (): void => {
  for (const container of mountedContainers) {
    if (!document.body.contains(container)) {
      unmountGithubAuthHeader(container);
    }
  }
};

const syncGithubAuthHeaders = (): void => {
  if (typeof document === 'undefined') return;

  unmountDetachedHeaders();

  for (const container of document.querySelectorAll(BRANCH_SYNC_SELECTOR)) {
    mountGithubAuthHeader(container);
  }
};

const queueRender = (): void => {
  if (renderQueued) return;

  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    syncGithubAuthHeaders();
  });
};

export const initGitHubAuthHeaderEnhancement = (): void => {
  if (isStarted || typeof window === 'undefined' || typeof document === 'undefined') return;

  isStarted = true;
  observer = new MutationObserver(queueRender);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  queueRender();
};

export const stopGitHubAuthHeaderEnhancement = (): void => {
  observer?.disconnect();
  observer = null;

  for (const container of mountedContainers) {
    unmountGithubAuthHeader(container);
  }

  isStarted = false;
  renderQueued = false;
};
