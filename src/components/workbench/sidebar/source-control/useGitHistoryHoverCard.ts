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

  // 悬浮卡片智能排位。先按行右/左侧给初始位置，再用实测尺寸夹取进视口。
  