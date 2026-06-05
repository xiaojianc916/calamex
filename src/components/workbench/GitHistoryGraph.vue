<template>
  <div class="git-history-graph source-control-history-timeline">
    <template v-for="group in renderGroups" :key="group.key">
      <header
        v-if="group.showHeader"
        class="git-history-graph-group-header"
        :class="'git-history-graph-group-' + group.tone"
      >
        <span :class="group.icon" class="git-history-graph-group-icon" aria-hidden="true" />
        <span class="git-history-graph-group-title" v-text="group.title" />
        <span class="git-history-graph-group-count" v-text="group.count" />
      </header>

      <template v-for="row in group.rows" :key="row.commit.id">
        <article
          class="source-control-history-item git-history-graph-row"
          :class="{ 'is-active': row.commit.id === activeCommitId, 'is-expanded': row.commit.id === expandedCommitId }"
          @click="handleSelect(row.commit)"
          @contextmenu="handleContextMenu($event, row.commit)"
          @mouseenter="handleRowEnter($event, row.commit)"
          @mouseleave="handleRowLeave"
        >
          <div class="git-history-graph-cell" :style="{ width: graphWidth + 'px' }" aria-hidden="true">
            <svg
              class="git-history-graph-svg"
              :width="graphWidth"
              :height="ROW_HEIGHT"
              :viewBox="'0 0 ' + graphWidth + ' ' + ROW_HEIGHT"
            >
              <path
                v-for="edge in row.paths"
                :key="edge.key"
                :d="edge.d"
                :stroke="edge.color"
                class="git-history-graph-edge"
                fill="none"
              />
              <circle
                :cx="row.nodeX"
                :cy="ROW_HEIGHT / 2"
                :r="NODE_RADIUS"
                :fill="row.nodeColor"
                class="git-history-graph-node"
              />
            </svg>
          </div>

          <div class="git-history-graph-body">
            <span class="git-history-graph-expand-icon" aria-hidden="true">
              <span :class="row.commit.id === expandedCommitId ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--chevron-right]'" />
            </span>
            <span class="git-history-graph-message-text" v-text="row.commit.summary" />
            <span
              v-for="commitRef in row.refs"
              :key="commitRef.name"
              class="git-history-graph-ref"
              :class="refClass(commitRef)"
            >
              <span :class="refIcon(commitRef)" class="git-history-graph-ref-icon" aria-hidden="true" />
              <span class="git-history-graph-ref-name" v-text="commitRef.name" />
            </span>
          </div>

          <span class="source-control-history-author git-history-graph-author" v-text="row.commit.authorName" />
        </article>

        <!-- Inline expanded file list -->
        <div
          v-if="row.commit.id === expandedCommitId"
          class="git-history-graph-filelist"
        >
          <div v-if="expandedLoading && !expandedDetail" class="git-history-graph-filelist-loading">
            <span class="icon-[lucide--loader-circle] git-history-graph-filelist-spinner" aria-hidden="true" />
            <span v-text="'正在读取文件列表…'" />
          </div>
          <template v-else-if="expandedDetail && expandedDetail.files.length > 0">
            <div class="git-history-graph-filelist-summary">
              <span v-text="expandedDetail.files.length + ' 个文件'" />
              <span v-if="expandedDetail.additions > 0" class="git-history-graph-filelist-add" v-text="'+' + expandedDetail.additions" />
              <span v-if="expandedDetail.deletions > 0" class="git-history-graph-filelist-del" v-text="'-' + expandedDetail.deletions" />
            </div>
            <div
              v-for="file in expandedDetail.files"
              :key="file.relativePath"
              class="git-history-graph-filelist-row"
            >
              <span class="git-history-graph-filelist-tag" :class="'is-' + file.status" v-text="resolveFileTag(file.status)" />
              <span class="git-history-graph-filelist-name" v-text="file.fileName" />
              <span v-if="file.previousRelativePath" class="git-history-graph-filelist-renamed" v-text="'← ' + file.previousRelativePath" />
              <span class="git-history-graph-filelist-path" v-text="resolveFileDir(file)" />
              <span v-if="file.additions > 0" class="git-history-graph-filelist-stat git-history-graph-filelist-stat-add" v-text="'+' + file.additions" />
              <span v-if="file.deletions > 0" class="git-history-graph-filelist-stat git-history-graph-filelist-stat-del" v-text="'-' + file.deletions" />
            </div>
          </template>
          <div v-else-if="expandedDetail" class="git-history-graph-filelist-empty">
            <span v-text="'该提交没有文件变更'" />
          </div>
        </div>
      </template>
    </template>

    <section v-if="behind > 0" class="git-history-graph-incoming-note">
      <span class="icon-[lucide--arrow-down] git-history-graph-group-icon" aria-hidden="true" />
      <span v-text="'传入更改 ' + behind + ' 条 · 拉取后查看'" />
    </section>

    <LinearContextMenu
      :open="menu.open"
      :x="menu.x"
      :y="menu.y"
      :groups="menuGroups"
      theme="light"
      submenu-direction="right"
      @select="handleMenuSelect"
    />

    <Teleport to="body">
      <div
        v-if="hover.open && hoverCommit"
        class="git-history-graph-hovercard"
        :style="{ top: hover.y + 'px', left: hover.x + 'px' }"
        @mouseenter="handleCardEnter"
        @mouseleave="handleCardLeave"
      >
        <div class="git-history-graph-hovercard-head">
          <span class="git-history-graph-hovercard-author" v-text="hoverAuthorName" />
          <span class="git-history-graph-hovercard-ago" v-text="formatTime(hoverAuthoredAt)" />
        </div>
        <div
          v-if="formatAbsolute(hoverAuthoredAt)"
          class="git-history-graph-hovercard-date"
          v-text="formatAbsolute(hoverAuthoredAt)"
        />
        <p class="git-history-graph-hovercard-message" v-text="hoverMessage" />
        <div class="git-history-graph-hovercard-stats">
          <span
            v-if="hoverLoading && !hoverDetail"
            class="git-history-graph-hovercard-loading"
            v-text="'正在统计变更…'"
          />
          <template v-else-if="hoverDetail">
            <span class="git-history-graph-hovercard-files" v-text="'已更改 ' + hoverDetail.fileCount + ' 个文件'" />
            <span v-if="hoverDetail.additions > 0" class="git-history-graph-hovercard-add" v-text="'+' + hoverDetail.additions" />
            <span v-if="hoverDetail.deletions > 0" class="git-history-graph-hovercard-del" v-text="'-' + hoverDetail.deletions" />
          </template>
        </div>
        <div class="git-history-graph-hovercard-foot">
          <code class="git-history-graph-hovercard-sha" v-text="hoverShortId" />
          <button
            type="button"
            class="git-history-graph-hovercard-copy"
            title="复制完整提交哈希"
            @click="copyHoverCommitId"
          >
            <span class="icon-[lucide--copy]" aria-hidden="true" />
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type { ILinearContextMenuGroup, ILinearContextMenuItem } from '@/components/common/linear-context-menu.types';
import { useGitStore } from '@/store/git';
import type { IGitCommitDetailPayload, IGitCommitFileChangePayload, IGitCommitSummaryPayload } from '@/types/git';
import { writeClipboardText } from '@/utils/clipboard';
import type { IGitGraphEdge } from '@/utils/git-graph';
import { buildGitGraph, resolveGitGraphLaneColor } from '@/utils/git-graph';

const LANE_WIDTH = 13;
const ROW_HEIGHT = 28;
const NODE_RADIUS = 3;
const HOVER_OPEN_DELAY = 320;
const HOVER_CLOSE_DELAY = 160;
const HOVER_CARD_WIDTH = 320;

interface IGitCommitRef { name: string; kind: string; isHead: boolean; }
interface IGraphEdgePath { key: string; d: string; color: string; }
interface IGraphRow {
  commit: IGitCommitSummaryPayload;
  nodeX: number;
  nodeColor: string;
  refs: IGitCommitRef[];
  paths: IGraphEdgePath[];
}
interface IGraphGroup {
  key: string; title: string; icon: string; tone: string;
  count: number; showHeader: boolean; rows: IGraphRow[];
}

const props = withDefaults(
  defineProps<{ commits: IGitCommitSummaryPayload[]; ahead?: number; behind?: number }>(),
  { ahead: 0, behind: 0 },
);

const emit = defineEmits<{ 'select-commit': [commit: IGitCommitSummaryPayload] }>();

const gitStore = useGitStore();
const activeCommitId = ref<string | null>(null);
const expandedCommitId = ref<string | null>(null);
const expandedDetail = ref<IGitCommitDetailPayload | null>(null);
const expandedLoading = ref(false);

const menu = reactive<{ open: boolean; x: number; y: number; commit: IGitCommitSummaryPayload | null }>({
  open: false, x: 0, y: 0, commit: null,
});

const hover = reactive<{ open: boolean; commitId: string | null; x: number; y: number }>({
  open: false, commitId: null, x: 0, y: 0,
});

const hoverCommit = ref<IGitCommitSummaryPayload | null>(null);
const hoverDetail = ref<IGitCommitDetailPayload | null>(null);
const hoverLoading = ref(false);
let hoverOpenTimer: ReturnType<typeof setTimeout> | null = null;
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;

const buildEdgePath = (edge: IGitGraphEdge, rowHeight: number): string => {
  const x1 = laneX(edge.fromLane);
  const x2 = laneX(edge.toLane);
  const mid = rowHeight / 2;
  if (edge.type === 'pass' && edge.fromLane === edge.toLane) return 'M ' + x1 + ' 0 L ' + x1 + ' ' + rowHeight;
  if (edge.type === 'in') return 'M ' + x1 + ' 0 C ' + x1 + ' ' + mid * 0.6 + ' ' + x2 + ' ' + mid * 0.4 + ' ' + x2 + ' ' + mid;
  if (edge.type === 'out') return 'M ' + x1 + ' ' + mid + ' C ' + x1 + ' ' + (mid + mid * 0.4) + ' ' + x2 + ' ' + (mid + mid * 0.6) + ' ' + x2 + ' ' + rowHeight;
  return 'M ' + x1 + ' 0 C ' + x1 + ' ' + mid + ' ' + x2 + ' ' + mid + ' ' + x2 + ' ' + rowHeight;
};

const layout = computed(() =>
  buildGitGraph(props.commits.map((commit) => ({ id: commit.id, parentIds: commit.parentIds ?? [] }))),
);

const graphWidth = computed(() => Math.max(1, layout.value.laneCount) * LANE_WIDTH);

const decorated = computed<IGraphRow[]>(() =>
  props.commits.map((commit, index) => {
    const row = layout.value.rows[index];
    const lane = row ? row.lane : 0;
    const nodeColor = row ? row.color : resolveGitGraphLaneColor(0);
    const edges = row ? row.edges : [];
    return {
      commit,
      nodeX: laneX(lane),
      nodeColor,
      refs: (commit.refs ?? []) as IGitCommitRef[],
      paths: edges.map((edge, edgeIndex) => ({
        key: edge.type + ':' + edge.fromLane + ':' + edge.toLane + ':' + edgeIndex,
        d: buildEdgePath(edge, ROW_HEIGHT),
        color: edge.color,
      })),
    };
  }),
);

const outgoingRows = computed<IGraphRow[]>(() => decorated.value.slice(0, Math.max(0, props.ahead)));
const historyRows = computed<IGraphRow[]>(() => decorated.value.slice(Math.max(0, props.ahead)));

const renderGroups = computed<IGraphGroup[]>(() => {
  const groups: IGraphGroup[] = [];
  if (outgoingRows.value.length > 0) {
    groups.push({
      key: 'outgoing', title: '传出更改', icon: 'icon-[lucide--arrow-up]',
      tone: 'outgoing', count: outgoingRows.value.length, showHeader: true, rows: outgoingRows.value,
    });
  }
  groups.push({
    key: 'history', title: '历史', icon: 'icon-[lucide--git-commit-horizontal]',
    tone: 'history', count: historyRows.value.length,
    showHeader: outgoingRows.value.length > 0, rows: historyRows.value,
  });
  return groups;
});

const menuGroups = computed<ILinearContextMenuGroup[]>(() => {
  if (!menu.commit) return [];
  const repoUrl = gitStore.pullRequestSupport.repositoryUrl;
  return [
    {
      key: 'copy',
      items: [
        { key: 'copy-sha', label: '复制提交哈希', icon: 'copy' },
        { key: 'copy-short', label: '复制短哈希', icon: 'copy' },
        { key: 'copy-message', label: '复制提交说明', icon: 'copy' },
      ],
    },
    {
      key: 'actions',
      items: [
        { key: 'checkout-commit', label: '检出此提交', icon: 'git-branch' },
        { key: 'revert-commit', label: '回滚此提交', icon: 'rotate-ccw' },
        ...(repoUrl
          ? [{ key: 'open-github', label: '在 GitHub 上打开', icon: 'external-link' } as ILinearContextMenuItem]
          : []),
      ],
    },
  ];
});

const hoverMessage = computed<string>(() => {
  const detail = hoverDetail.value;
  if (detail) return detail.body ? detail.summary + '\n\n' + detail.body : detail.summary;
  return hoverCommit.value?.summary ?? '';
});
const hoverAuthorName = computed<string>(() => hoverDetail.value?.authorName ?? hoverCommit.value?.authorName ?? '');
const hoverAuthoredAt = computed<string>(() => hoverDetail.value?.authoredAt ?? hoverCommit.value?.authoredAt ?? '');
const hoverShortId = computed<string>(() => hoverDetail.value?.shortId ?? hoverCommit.value?.shortId ?? '');

const refClass = (commitRef: IGitCommitRef): Record<string, boolean> => ({
  'is-head': commitRef.isHead,
  'is-remote': commitRef.kind === 'remoteBranch',
  'is-local': commitRef.kind === 'localBranch' && !commitRef.isHead,
});

const refIcon = (commitRef: IGitCommitRef): string =>
  commitRef.kind === 'remoteBranch' ? 'icon-[lucide--cloud]' : 'icon-[lucide--git-branch]';

const resolveFileTag = (status: string): string => {
  switch (status) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'binary': return 'B';
    default: return 'M';
  }
};

const resolveFileDir = (file: IGitCommitFileChangePayload): string => {
  const path = file.relativePath;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
};

const formatTime = (value: string | null | undefined): string => {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 30000) return '刚刚';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + ' 天前';
  return new Date(value).toLocaleDateString();
};

const formatAbsolute = (value: string | null | undefined): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return year + '年' + month + '月' + day + '日 ' + hours + ':' + minutes;
};

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

const clearHoverOpenTimer = (): void => {
  if (hoverOpenTimer !== null) { clearTimeout(hoverOpenTimer); hoverOpenTimer = null; }
};

const clearHoverCloseTimer = (): void => {
  if (hoverCloseTimer !== null) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null; }
};

const closeHoverCard = (): void => {
  hover.open = false;
  hover.commitId = null;
  hoverCommit.value = null;
  hoverDetail.value = null;
  hoverLoading.value = false;
};

const positionHoverCard = (rect: DOMRect): { x: number; y: number } => {
  const margin = 8;
  let x = rect.right + margin;
  if (x + HOVER_CARD_WIDTH > window.innerWidth - margin) x = rect.left - HOVER_CARD_WIDTH - margin;
  if (x < margin) x = margin;
  let y = rect.top;
  const maxY = window.innerHeight - 180;
  if (y > maxY) y = Math.max(margin, maxY);
  return { x, y };
};

const openHoverCard = async (rect: DOMRect, commit: IGitCommitSummaryPayload): Promise<void> => {
  const position = positionHoverCard(rect);
  hover.x = position.x;
  hover.y = position.y;
  hover.commitId = commit.id;
  hoverCommit.value = commit;
  hover.open = true;
  if (hoverDetail.value?.id === commit.id) return;
  hoverDetail.value = null;
  hoverLoading.value = true;
  try {
    const detail = await gitStore.loadCommitDetail(commit.id);
    if (hover.commitId === commit.id) hoverDetail.value = detail;
  } catch {
    // 详情失败时保留摘要回退
  } finally {
    if (hover.commitId === commit.id) hoverLoading.value = false;
  }
};

const handleRowEnter = (event: MouseEvent, commit: IGitCommitSummaryPayload): void => {
  if (menu.open) return;
  clearHoverCloseTimer();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const rect = target.getBoundingClientRect();
  clearHoverOpenTimer();
  hoverOpenTimer = setTimeout(() => { void openHoverCard(rect, commit); }, HOVER_OPEN_DELAY);
};

const handleRowLeave = (): void => {
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  hoverCloseTimer = setTimeout(closeHoverCard, HOVER_CLOSE_DELAY);
};

const handleCardEnter = (): void => { clearHoverCloseTimer(); };
const handleCardLeave = (): void => { handleRowLeave(); };

const copyHoverCommitId = async (): Promise<void> => {
  const commitId = hoverDetail.value?.id ?? hoverCommit.value?.id;
  if (commitId) await writeClipboardText(commitId);
};

const closeMenu = (): void => { menu.open = false; menu.commit = null; };

const handleContextMenu = (event: MouseEvent, commit: IGitCommitSummaryPayload): void => {
  event.preventDefault();
  clearHoverOpenTimer();
  clearHoverCloseTimer();
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

  if (item.key === 'copy-sha') { await writeClipboardText(commit.id); return; }
  if (item.key === 'copy-short') { await writeClipboardText(commit.shortId); return; }
  if (item.key === 'copy-message') { await writeClipboardText(commit.summary); return; }

  if (item.key === 'checkout-commit') {
    try { await gitStore.checkoutCommit(commit.id); }
    catch (error) { console.error('[GitHistoryGraph] checkout commit failed:', error); }
    return;
  }

  if (item.key === 'revert-commit') {
    try { await gitStore.revertCommit(commit.id); }
    catch (error) { console.error('[GitHistoryGraph] revert commit failed:', error); }
    return;
  }

  if (item.key === 'open-github') {
    const repoUrl = gitStore.pullRequestSupport.repositoryUrl;
    if (repoUrl) window.open(repoUrl + '/commit/' + commit.id, '_blank', 'noopener,noreferrer');
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
  if (hover.open) { clearHoverOpenTimer(); clearHoverCloseTimer(); closeHoverCard(); }
};

const handleWindowResize = (): void => {
  if (menu.open) closeMenu();
  if (hover.open) { clearHoverOpenTimer(); clearHoverCloseTimer(); closeHoverCard(); }
};

watch(
  () => props.commits,
  (commits) => {
    if (commits.length === 0) { activeCommitId.value = null; return; }
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
});

onBeforeUnmount(() => {
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  if (typeof window === 'undefined') return;
  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
  window.removeEventListener('resize', handleWindowResize);
});
</script>

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

.git-history-graph-row.source-control-history-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  box-sizing: border-box;
  height: 28px;
  min-height: 28px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  background: transparent;
  overflow: hidden;
  text-align: left;
  transition: background 0.14s ease;
}

.git-history-graph-row.source-control-history-item:hover {
  background: rgba(129, 139, 152, 0.12);
}

.git-history-graph-row.source-control-history-item.is-expanded {
  background: rgba(9, 105, 218, 0.07);
  border-radius: 6px 6px 0 0;
}

.git-history-graph-cell { flex: 0 0 auto; height: 28px; display: block; }
.git-history-graph-svg { display: block; overflow: visible; }
.git-history-graph-edge { stroke-width: 1.5; fill: none; }
.git-history-graph-node { stroke: #ffffff; stroke-width: 2; }

.git-history-graph-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 5px;
  overflow: hidden;
}

.git-history-graph-expand-icon {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  color: #818b98;
  display: flex;
  align-items: center;
  justify-content: center;
}

.git-history-graph-message-text {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #1f2328;
}

.git-history-graph-ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  max-width: 120px;
  height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: rgba(129, 139, 152, 0.15);
  color: #59636e;
}

.git-history-graph-ref.is-head { background: rgba(31, 136, 61, 0.15); color: #1a7f37; }
.git-history-graph-ref.is-remote { background: rgba(9, 105, 218, 0.12); color: #0550ae; }
.git-history-graph-ref-icon { width: 10px; height: 10px; flex: 0 0 auto; }
.git-history-graph-ref-name { overflow: hidden; text-overflow: ellipsis; }

.source-control-history-author.git-history-graph-author {
  flex: 0 0 auto;
  font-size: 11px;
  color: #818b98;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 80px;
}

/* === Inline file list === */
.git-history-graph-filelist {
  margin: 0 0 4px;
  border: 1px solid #d1d9e0;
  border-top: none;
  border-radius: 0 0 6px 6px;
  background: #f6f8fa;
  overflow: hidden;
}

.git-history-graph-filelist-loading,
.git-history-graph-filelist-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 11px;
  color: #818b98;
}

.git-history-graph-filelist-spinner {
  width: 12px;
  height: 12px;
  animation: git-history-spin 1s linear infinite;
}

@keyframes git-history-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.git-history-graph-filelist-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 4px;
  font-size: 10.5px;
  font-weight: 600;
  color: #59636e;
  border-bottom: 1px solid #d1d9e0;
  background: #f0f2f5;
}

.git-history-graph-filelist-add { color: #1a7f37; }
.git-history-graph-filelist-del { color: #cf222e; }

.git-history-graph-filelist-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11.5px;
  color: #1f2328;
  border-bottom: 1px solid rgba(209, 217, 224, 0.5);
  min-height: 24px;
  box-sizing: border-box;
}

.git-history-graph-filelist-row:last-child { border-bottom: none; }

.git-history-graph-filelist-tag {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  background: rgba(129, 139, 152, 0.15);
  color: #59636e;
}
.git-history-graph-filelist-tag.is-added { background: rgba(31, 136, 61, 0.12); color: #1a7f37; }
.git-history-graph-filelist-tag.is-deleted { background: rgba(207, 34, 46, 0.12); color: #cf222e; }
.git-history-graph-filelist-tag.is-renamed { background: rgba(130, 80, 223, 0.12); color: #6e40c9; }
.git-history-graph-filelist-tag.is-modified { background: rgba(9, 105, 218, 0.1); color: #0550ae; }

.git-history-graph-filelist-name {
  flex: 0 0 auto;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.git-history-graph-filelist-renamed {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: #818b98;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-history-graph-filelist-path {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: #818b98;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-history-graph-filelist-stat {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.git-history-graph-filelist-stat-add { color: #1a7f37; }
.git-history-graph-filelist-stat-del { color: #cf222e; }

/* Hover card */
.git-history-graph-hovercard {
  position: fixed;
  z-index: 9999;
  width: 320px;
  background: #ffffff;
  border: 1px solid #d1d9e0;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(31, 35, 40, 0.12);
  padding: 12px 14px 10px;
  pointer-events: auto;
}

.git-history-graph-hovercard-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}

.git-history-graph-hovercard-author {
  font-size: 12px;
  font-weight: 600;
  color: #1f2328;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-history-graph-hovercard-ago {
  font-size: 11px;
  color: #818b98;
  flex-shrink: 0;
  white-space: nowrap;
}

.git-history-graph-hovercard-date {
  font-size: 11px;
  color: #818b98;
  margin-bottom: 8px;
}

.git-history-graph-hovercard-message {
  font-size: 12px;
  color: #1f2328;
  margin: 0 0 10px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}

.git-history-graph-hovercard-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
}

.git-history-graph-hovercard-loading { color: #818b98; }
.git-history-graph-hovercard-files { color: #59636e; }
.git-history-graph-hovercard-add { color: #1a7f37; font-weight: 600; }
.git-history-graph-hovercard-del { color: #cf222e; font-weight: 600; }

.git-history-graph-hovercard-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid #d1d9e0;
  padding-top: 8px;
}

.git-history-graph-hovercard-sha {
  font-family: ui-monospace, 'SFMono-Regular', monospace;
  font-size: 11px;
  color: #818b98;
  background: rgba(129, 139, 152, 0.1);
  padding: 1px 5px;
  border-radius: 4px;
}

.git-history-graph-hovercard-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #818b98;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  padding: 0;
}

.git-history-graph-hovercard-copy:hover {
  background: rgba(129, 139, 152, 0.15);
  color: #1f2328;
}
</style>
