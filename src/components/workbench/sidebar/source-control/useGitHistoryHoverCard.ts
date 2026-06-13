import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import {
  fetchGithubCommitAuthorSnapshot,
  type IGitHubCommitAuthorSnapshot,
  readCachedGithubCommitAuthor,
} from '@/services/github-author';
import type { useGitStore } from '@/store/git';
import type { IGitCommitDetailPayload, IGitCommitSummaryPayload } from '@/types/git';
import { openExternalUrl } from '@/utils/browser';
import { writeClipboardText } from '@/utils/clipboard';

const HOVER_OPEN_DELAY = 320;
const HOVER_CLOSE_DELAY = 160;
const HOVER_CARD_WIDTH = 340;
// 悬浮卡片高度估算值，仅用于首帧定位；真实尺寸由 adjustHoverCardPosition 实测后再夹取。
const HOVER_CARD_EST_HEIGHT = 210;

type GitStore = ReturnType<typeof useGitStore>;

export interface IUseGitHistoryHoverCardOptions {
  gitStore: GitStore;
  /** 返回悬浮卡片根元素，用于按真实尺寸夹取位置。 */
  getCardEl: () => HTMLElement | null;
  /** 返回图表根元素，用于定位内部滚动容器。 */
  getRootEl: () => HTMLElement | null;
  /** 右键菜单打开时抑制悬浮卡片。 */
  isMenuOpen: () => boolean;
}

/**
 * 提交悬浮卡片的状态机：延迟开关、滚动抑制、视口内定位，
 * 以及提交详情与 GitHub 作者信息的懒加载。
 */
export function useGitHistoryHoverCard(options: IUseGitHistoryHoverCardOptions) {
  const { gitStore, getCardEl, getRootEl, isMenuOpen } = options;

  const hover = reactive<{ open: boolean; commitId: string | null; x: number; y: number }>({
    open: false,
    commitId: null,
    x: 0,
    y: 0,
  });
  const hoverCommit = ref<IGitCommitSummaryPayload | null>(null);
  const hoverDetail = ref<IGitCommitDetailPayload | null>(null);
  const hoverLoading = ref(false);
  const hoverAuthorSnapshot = ref<IGitHubCommitAuthorSnapshot | null>(null);

  let hoverOpenTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

  // 滚动期间抑制悬浮卡片，避免滑动时小卡片打扰。
  const isScrolling = ref(false);
  let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let historyScrollTarget: HTMLElement | Window | null = null;
  let historyScrollCapture = false;

  const hoverGithubCommitUrl = computed<string | null>(() => {
    const repoUrl = gitStore.pullRequestSupport.repositoryUrl;
    const commitId = hoverDetail.value?.id ?? hoverCommit.value?.id;
    return repoUrl && commitId ? `${repoUrl}/commit/${commitId}` : null;
  });

  const clearHoverOpenTimer = (): void => {
    if (hoverOpenTimer !== null) {
      clearTimeout(hoverOpenTimer);
      hoverOpenTimer = null;
    }
  };

  const clearHoverCloseTimer = (): void => {
    if (hoverCloseTimer !== null) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  };

  const clearHoverTimers = (): void => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
  };

  const closeHoverCard = (): void => {
    hover.open = false;
    hover.commitId = null;
    hoverCommit.value = null;
    hoverDetail.value = null;
    hoverAuthorSnapshot.value = null;
    hoverLoading.value = false;
  };

  const positionHoverCard = (rect: DOMRect): { x: number; y: number } => {
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let x = rect.right + margin;
    if (x + HOVER_CARD_WIDTH > viewportWidth - margin) {
      const leftX = rect.left - HOVER_CARD_WIDTH - margin;
      x = leftX >= margin ? leftX : Math.max(margin, viewportWidth - HOVER_CARD_WIDTH - margin);
    }
    if (x < margin) x = margin;
    let y = rect.top;
    if (y + HOVER_CARD_EST_HEIGHT > viewportHeight - margin) {
      y = viewportHeight - HOVER_CARD_EST_HEIGHT - margin;
    }
    if (y < margin) y = margin;
    return { x, y };
  };

  const adjustHoverCardPosition = async (): Promise<void> => {
    if (typeof window === 'undefined') return;
    await nextTick();
    const el = getCardEl();
    if (!el || !hover.open) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    let x = hover.x;
    let y = hover.y;
    if (rect.right > window.innerWidth - margin) x = window.innerWidth - rect.width - margin;
    if (x < margin) x = margin;
    if (rect.bottom > window.innerHeight - margin) y = window.innerHeight - rect.height - margin;
    if (y < margin) y = margin;
    hover.x = x;
    hover.y = y;
  };

  const hydrateHoverGithubAuthor = async (commit: IGitCommitSummaryPayload): Promise<void> => {
    let repoUrl = gitStore.pullRequestSupport.repositoryUrl;
    if (!repoUrl) {
      try {
        repoUrl = (await gitStore.loadPullRequestSupport()).repositoryUrl;
      } catch {
        repoUrl = null;
      }
    }
    if (!repoUrl) return;
    const cached = readCachedGithubCommitAuthor(repoUrl, commit);
    if (cached) {
      if (hover.commitId === commit.id) hoverAuthorSnapshot.value = cached;
      return;
    }
    const snapshot = await fetchGithubCommitAuthorSnapshot(repoUrl, commit);
    if (snapshot && hover.commitId === commit.id) {
      hoverAuthorSnapshot.value = snapshot;
      void adjustHoverCardPosition();
    }
  };

  const openHoverCard = async (rect: DOMRect, commit: IGitCommitSummaryPayload): Promise<void> => {
    if (isScrolling.value) return;
    const position = positionHoverCard(rect);
    hover.x = position.x;
    hover.y = position.y;
    hover.commitId = commit.id;
    hoverCommit.value = commit;
    hoverAuthorSnapshot.value = null;
    hover.open = true;
    void adjustHoverCardPosition();
    void hydrateHoverGithubAuthor(commit);
    if (hoverDetail.value?.id === commit.id) return;
    hoverDetail.value = null;
    hoverLoading.value = true;
    try {
      const detail = await gitStore.loadCommitDetail(commit.id);
      if (hover.commitId === commit.id) {
        hoverDetail.value = detail;
        void adjustHoverCardPosition();
      }
    } catch {
      // 详情加载失败时保留摘要回退。
    } finally {
      if (hover.commitId === commit.id) hoverLoading.value = false;
    }
  };

  const handleRowEnter = (event: MouseEvent, commit: IGitCommitSummaryPayload): void => {
    if (isMenuOpen() || isScrolling.value) return;
    clearHoverCloseTimer();
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const rect = target.getBoundingClientRect();
    clearHoverOpenTimer();
    hoverOpenTimer = setTimeout(() => {
      void openHoverCard(rect, commit);
    }, HOVER_OPEN_DELAY);
  };

  const handleRowLeave = (): void => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverCloseTimer = setTimeout(closeHoverCard, HOVER_CLOSE_DELAY);
  };

  const handleCardEnter = (): void => {
    clearHoverCloseTimer();
  };

  const handleCardLeave = (): void => {
    handleRowLeave();
  };

  const copyHoverCommitId = async (): Promise<void> => {
    const commitId = hoverDetail.value?.id ?? hoverCommit.value?.id;
    if (commitId) await writeClipboardText(commitId);
  };

  const openHoverCommitOnGithub = (): void => {
    const url = hoverGithubCommitUrl.value;
    if (url) openExternalUrl(url);
  };

  const handleHistoryScroll = (): void => {
    isScrolling.value = true;
    clearHoverOpenTimer();
    if (hover.open) closeHoverCard();
    if (scrollSettleTimer !== null) clearTimeout(scrollSettleTimer);
    scrollSettleTimer = setTimeout(() => {
      isScrolling.value = false;
    }, 180);
  };

  const teardownHistoryScrollListener = (): void => {
    if (historyScrollTarget) {
      historyScrollTarget.removeEventListener('scroll', handleHistoryScroll, historyScrollCapture);
      historyScrollTarget = null;
    }
  };

  const setupHistoryScrollListener = (): void => {
    teardownHistoryScrollListener();
    if (typeof window === 'undefined') return;
    const scrollEl = getRootEl()?.closest('.source-control-scroll') ?? null;
    if (scrollEl instanceof HTMLElement) {
      historyScrollTarget = scrollEl;
      historyScrollCapture = false;
      scrollEl.addEventListener('scroll', handleHistoryScroll, { passive: true });
    } else {
      historyScrollTarget = window;
      historyScrollCapture = true;
      window.addEventListener('scroll', handleHistoryScroll, { passive: true, capture: true });
    }
  };

  onMounted(() => {
    setupHistoryScrollListener();
  });

  onBeforeUnmount(() => {
    clearHoverTimers();
    if (scrollSettleTimer !== null) {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
    }
    teardownHistoryScrollListener();
  });

  return {
    hover,
    hoverCommit,
    hoverDetail,
    hoverLoading,
    hoverAuthorSnapshot,
    hoverGithubCommitUrl,
    isScrolling,
    handleRowEnter,
    handleRowLeave,
    handleCardEnter,
    handleCardLeave,
    copyHoverCommitId,
    openHoverCommitOnGithub,
    closeHoverCard,
    clearHoverTimers,
  };
}
