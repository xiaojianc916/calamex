<script setup lang="ts">
import { ArrowDown } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { ILinearContextMenuItem } from '@/components/common/linear-context-menu.types';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { useEditorStore } from '@/store/editor';
import { useGitStore } from '@/store/git';
import type {
  IGitCommitDetailPayload,
  IGitCommitFileChangePayload,
  IGitCommitSummaryPayload,
} from '@/types/git';
import { openExternalUrl } from '@/utils/browser';
import { writeClipboardText } from '@/utils/clipboard';
import GitCommitFileList from './GitCommitFileList.vue';
import GitHistoryGraphContextMenu from './GitHistoryGraphContextMenu.vue';
import type GitHistoryGraphHoverCard from './GitHistoryGraphHoverCard.vue';
import GitHistoryGraphRow from './GitHistoryGraphRow.vue';
import { useGitHistoryGraph } from './useGitHistoryGraph';
import { useGitHistoryHoverCard } from './useGitHistoryHoverCard';

const props = withDefaults(
  defineProps<{ commits: IGitCommitSummaryPayload[]; ahead?: number; behind?: number }>(),
  { ahead: 0, behind: 0 },
);

const emit = defineEmits<{ 'select-commit': [commit: IGitCommitSummaryPayload] }>();

const gitStore = useGitStore();
const editorStore = useEditorStore();
const rootRef = ref<HTMLElement | null>(null);

const commitsRef = computed<IGitCommitSummaryPayload[]>(() => props.commits);
const aheadRef = computed<number>(() => props.ahead);
const behind = computed<number>(() => props.behind);

const { graphWidth, renderGroups } = useGitHistoryGraph(commitsRef, aheadRef);

const repositoryUrl = computed<string | null>(() => gitStore.pullRequestSupport.repositoryUrl);

const activeCommitId = ref<string | null>(null);
const expandedCommitId = ref<string | null>(null);
const expandedDetail = ref<IGitCommitDetailPayload | null>(null);
const expandedLoading = ref(false);

const menu = reactive<{
  open: boolean;
  x: number;
  y: number;
  commit: IGitCommitSummaryPayload | null;
}>({
  open: false,
  x: 0,
  y: 0,
  commit: null,
});

const hoverCardComp = ref<InstanceType<typeof GitHistoryGraphHoverCard> | null>(null);

const {
  hover,
  hoverCommit,
  hoverDetail,
  hoverLoading,
  hoverAuthorSnapshot,
  hoverGithubCommitUrl,
  handleRowEnter,
  handleRowLeave,
  handleCardEnter,
  handleCardLeave,
  copyHoverCommitId,
  openHoverCommitOnGithub,
  closeHoverCard,
  clearHoverTimers,
} = useGitHistoryHoverCard({
  gitStore,
  getCardEl: () => hoverCardComp.value?.getRootEl() ?? null,
  getRootEl: () => rootRef.value,
  isMenuOpen: () => menu.open,
});

const loadExpandedDetail = async (commit: IGitCommitSummaryPayload): Promise<void> => {
  expandedDetail.value = null;
  expandedLoading.value = true;
  try {
    const detail = await gitStore.loadCommitDetail(commit.id);
    if (expandedCommitId.value === commit.id) {
      expandedDetail.value = detail;
    }
  } catch {
    // ignore errors
  } finally {
    if (expandedCommitId.value === commit.id) {
      expandedLoading.value = false;
    }
  }
};

const handleSelect = (commit: IGitCommitSummaryPayload): void => {
  // toggle expansion
  if (expandedCommitId.value === commit.id) {
    expandedCommitId.value = null;
    expandedDetail.value = null;
    expandedLoading.value = false;
    return;
  }
  activeCommitId.value = commit.id;
  expandedCommitId.value = commit.id;
  emit('select-commit', commit);
  void loadExpandedDetail(commit);
};

// 点击具体文件：复用主界面原有的只读 Diff 视图（与右键菜单“查看 Diff”一致），
// 打开该提交对比父提交的文件 Diff。
const handleFileClick = async (file: IGitCommitFileChangePayload): Promise<void> => {
  const commitId = expandedCommitId.value;
  if (!commitId) return;
  try {
    const preview = await gitStore.loadCommitFileDiffPreview(commitId, file.relativePath);
    editorStore.openGitDiffDocument(preview);
  } catch (error) {
    console.error('[GitHistoryGraph] open commit file diff failed:', error);
  }
};

const closeMenu = (): void => {
  menu.open = false;
  menu.commit = null;
};

const handleContextMenu = (event: MouseEvent, commit: IGitCommitSummaryPayload): void => {
  event.preventDefault();
  clearHoverTimers();
  closeHoverCard();
  activeCommitId.value = commit.id;
  menu.commit = commit;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.open = true;
  if (!gitStore.pullRequestSupport.repositoryUrl) {
    void gitStore.loadPullRequestSupport().catch(() => undefined);
  }
};

const handleMenuSelect = async (item: ILinearContextMenuItem): Promise<void> => {
  const commit = menu.commit;
  closeMenu();
  if (!commit) return;

  if (item.key === 'copy-sha') {
    await writeClipboardText(commit.id);
    return;
  }
  if (item.key === 'copy-short') {
    await writeClipboardText(commit.shortId);
    return;
  }
  if (item.key === 'copy-message') {
    await writeClipboardText(commit.summary);
    return;
  }

  if (item.key === 'checkout-commit') {
    try {
      await gitStore.checkoutCommit(commit.id);
    } catch (error) {
      console.error('[GitHistoryGraph] checkout commit failed:', error);
    }
    return;
  }

  if (item.key === 'revert-commit') {
    try {
      await gitStore.revertCommit(commit.id);
    } catch (error) {
      console.error('[GitHistoryGraph] revert commit failed:', error);
    }
    return;
  }

  if (item.key === 'open-github') {
    const repoUrl = gitStore.pullRequestSupport.repositoryUrl;
    if (repoUrl) openExternalUrl(`${repoUrl}/commit/${commit.id}`);
  }
};

const handleWindowPointerDown = (event: PointerEvent): void => {
  if (!menu.open) return;
  const target = event.target;
  if (target instanceof Element && target.closest('.linear-context-menu-root')) return;
  closeMenu();
};

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return;
  if (menu.open) closeMenu();
  if (hover.open) {
    clearHoverTimers();
    closeHoverCard();
  }
};

const handleWindowResize = (): void => {
  if (menu.open) closeMenu();
  if (hover.open) {
    clearHoverTimers();
    closeHoverCard();
  }
};

// 滚动到底部时无限懒加载：哨兵进入(内部滚动容器的)视口就追加下一段历史。
const historySentinelRef = ref<HTMLElement | null>(null);
let historyObserver: IntersectionObserver | null = null;

const loadMoreHistory = (): void => {
  if (!gitStore.canLoadMoreCommitHistory || gitStore.isCommitHistoryLoading) return;
  void gitStore.loadCommitHistory({ append: true }).catch((error) => {
    console.error('[GitHistoryGraph] load more commit history failed:', error);
  });
};

const disconnectHistoryObserver = (): void => {
  if (historyObserver) {
    historyObserver.disconnect();
    historyObserver = null;
  }
};

const setupHistoryObserver = (): void => {
  disconnectHistoryObserver();
  const sentinel = historySentinelRef.value;
  if (!sentinel || typeof IntersectionObserver === 'undefined') return;
  // 历史列表渲染在 SourceControlPanel 的 .source-control-scroll 内部滚动容器里，
  // 用它当 IntersectionObserver 的 root，回退到视口。
  const scrollRoot = sentinel.closest('.source-control-scroll');
  historyObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreHistory();
    },
    { root: scrollRoot instanceof HTMLElement ? scrollRoot : null, rootMargin: '240px 0px' },
  );
  historyObserver.observe(sentinel);
};

// 哨兵随 canLoadMoreCommitHistory 显隐而挂载/卸载，跟随重建/断开观察器。
watch(historySentinelRef, () => {
  setupHistoryObserver();
});

watch(
  () => props.commits,
  (commits) => {
    if (commits.length === 0) {
      activeCommitId.value = null;
      return;
    }
    const stillExists = commits.some((commit) => commit.id === activeCommitId.value);
    if (!stillExists) activeCommitId.value = commits[0].id;
    // collapse if expanded commit is no longer in list
    if (expandedCommitId.value && !commits.some((c) => c.id === expandedCommitId.value)) {
      expandedCommitId.value = null;
      expandedDetail.value = null;
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (typeof window === 'undefined') return;
  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('resize', handleWindowResize);
  setupHistoryObserver();
});

onBeforeUnmount(() => {
  disconnectHistoryObserver();
  if (typeof window === 'undefined') return;
  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
  window.removeEventListener('resize', handleWindowResize);
});
</script>

<template>
  <div ref="rootRef" class="git-history-graph source-control-history-timeline">
    <template v-for="group in renderGroups" :key="group.key">
      <header
        v-if="group.showHeader"
        class="git-history-graph-group-header"
        :class="'git-history-graph-group-' + group.tone"
      >
        <LucideIcon :name="group.icon" class="git-history-graph-group-icon" aria-hidden="true" />
        <span class="git-history-graph-group-title" v-text="group.title" />
        <span class="git-history-graph-group-count" v-text="group.count" />
      </header>

      <template v-for="row in group.rows" :key="row.commit.id">
        <GitHistoryGraphRow
          :row="row"
          :graph-width="graphWidth"
          :is-active="row.commit.id === activeCommitId"
          :is-expanded="row.commit.id === expandedCommitId"
          @select="handleSelect"
          @context-menu="handleContextMenu"
          @row-enter="handleRowEnter"
          @row-leave="handleRowLeave"
        />
        <GitCommitFileList
          v-if="row.commit.id === expandedCommitId"
          :loading="expandedLoading"
          :detail="expandedDetail"
          @open-file="handleFileClick"
        />
      </template>
    </template>

    <div
      v-if="gitStore.canLoadMoreCommitHistory"
      ref="historySentinelRef"
      class="git-history-graph-sentinel"
      aria-hidden="true"
    />

    <section v-if="behind > 0" class="git-history-graph-incoming-note">
      <ArrowDown class="git-history-graph-group-icon" aria-hidden="true" />
      <span v-text="'传入更改 ' + behind + ' 条 · 拉取后查看'" />
    </section>

    <GitHistoryGraphContextMenu
      :open="menu.open"
      :x="menu.x"
      :y="menu.y"
      :commit="menu.commit"
      :repository-url="repositoryUrl"
      @select="handleMenuSelect"
    />

    <GitHistoryGraphHoverCard
      ref="hoverCardComp"
      :visible="hover.open"
      :commit="hoverCommit"
      :detail="hoverDetail"
      :loading="hoverLoading"
      :author-snapshot="hoverAuthorSnapshot"
      :x="hover.x"
      :y="hover.y"
      :github-url="hoverGithubCommitUrl"
      @copy-sha="copyHoverCommitId"
      @open-github="openHoverCommitOnGithub"
      @card-enter="handleCardEnter"
      @card-leave="handleCardLeave"
    />
  </div>
</template>

<style scoped>
.git-history-graph.source-control-history-timeline {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 6px 10px 10px 8px;
  text-align: left;
}

.git-history-graph.source-control-history-timeline::before { content: none; }

.git-history-graph-group-header {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 6px;
  margin-top: 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #818b98;
}

.git-history-graph-group-icon { width: 13px; height: 13px; flex: 0 0 auto; }
.git-history-graph-group-count { margin-left: auto; font-variant-numeric: tabular-nums; }

.git-history-graph-incoming-note {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  font-size: 11px;
  color: #818b98;
}

.git-history-graph-sentinel {
  width: 100%;
  height: 1px;
  flex: 0 0 auto;
}
</style>
