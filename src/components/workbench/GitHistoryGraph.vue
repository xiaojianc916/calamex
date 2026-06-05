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

      <article
        v-for="row in group.rows"
        :key="row.commit.id"
        class="source-control-history-item git-history-graph-item"
        :class="{ 'is-active': row.commit.id === activeCommitId }"
        @click="handleSelect(row.commit)"
        @contextmenu="handleContextMenu($event, row.commit)"
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

        <div class="source-control-history-body git-history-graph-body">
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

        <span class="source-control-history-author" v-text="row.commit.authorName" />

        <time
          class="source-control-history-time"
          :datetime="row.commit.authoredAt"
          v-text="formatTime(row.commit.authoredAt)"
        />
      </article>
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
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import type { IGitCommitSummaryPayload } from '@/types/git';
import { writeClipboardText } from '@/utils/clipboard';
import type { IGitGraphEdge } from '@/utils/git-graph';
import { buildGitGraph, resolveGitGraphLaneColor } from '@/utils/git-graph';

const LANE_WIDTH = 14;
const ROW_HEIGHT = 28;
const NODE_RADIUS = 3.5;

interface IGitCommitRef {
  name: string;
  kind: string;
  isHead: boolean;
}

interface IGraphEdgePath {
  key: string;
  d: string;
  color: string;
}

interface IGraphRow {
  commit: IGitCommitSummaryPayload;
  nodeX: number;
  nodeColor: string;
  refs: IGitCommitRef[];
  paths: IGraphEdgePath[];
}

interface IGraphGroup {
  key: string;
  title: string;
  icon: string;
  tone: string;
  count: number;
  showHeader: boolean;
  rows: IGraphRow[];
}

const props = withDefaults(
  defineProps<{
    commits: IGitCommitSummaryPayload[];
    ahead?: number;
    behind?: number;
  }>(),
  {
    ahead: 0,
    behind: 0,
  },
);

const emit = defineEmits<{
  'select-commit': [commit: IGitCommitSummaryPayload];
}>();

const activeCommitId = ref<string | null>(null);

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

const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;

const buildEdgePath = (edge: IGitGraphEdge, rowHeight: number): string => {
  const x1 = laneX(edge.fromLane);
  const x2 = laneX(edge.toLane);
  const mid = rowHeight / 2;

  if (edge.type === 'pass' && edge.fromLane === edge.toLane) {
    return 'M ' + x1 + ' 0 L ' + x1 + ' ' + rowHeight;
  }

  if (edge.type === 'in') {
    return (
      'M ' + x1 + ' 0 C ' + x1 + ' ' + mid * 0.6 + ' ' + x2 + ' ' + mid * 0.4 + ' ' + x2 + ' ' + mid
    );
  }

  if (edge.type === 'out') {
    return (
      'M ' +
      x1 +
      ' ' +
      mid +
      ' C ' +
      x1 +
      ' ' +
      (mid + mid * 0.4) +
      ' ' +
      x2 +
      ' ' +
      (mid + mid * 0.6) +
      ' ' +
      x2 +
      ' ' +
      rowHeight
    );
  }

  return 'M ' + x1 + ' 0 C ' + x1 + ' ' + mid + ' ' + x2 + ' ' + mid + ' ' + x2 + ' ' + rowHeight;
};

const layout = computed(() =>
  buildGitGraph(
    props.commits.map((commit) => ({
      id: commit.id,
      parentIds: commit.parentIds ?? [],
    })),
  ),
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

const outgoingRows = computed<IGraphRow[]>(() =>
  decorated.value.slice(0, Math.max(0, props.ahead)),
);

const historyRows = computed<IGraphRow[]>(() => decorated.value.slice(Math.max(0, props.ahead)));

const renderGroups = computed<IGraphGroup[]>(() => {
  const groups: IGraphGroup[] = [];

  if (outgoingRows.value.length > 0) {
    groups.push({
      key: 'outgoing',
      title: '传出更改',
      icon: 'icon-[lucide--arrow-up]',
      tone: 'outgoing',
      count: outgoingRows.value.length,
      showHeader: true,
      rows: outgoingRows.value,
    });
  }

  groups.push({
    key: 'history',
    title: '历史',
    icon: 'icon-[lucide--git-commit-horizontal]',
    tone: 'history',
    count: historyRows.value.length,
    showHeader: outgoingRows.value.length > 0,
    rows: historyRows.value,
  });

  return groups;
});

const menuGroups = computed<ILinearContextMenuGroup[]>(() => {
  if (!menu.commit) {
    return [];
  }

  return [
    {
      key: 'commit',
      items: [
        { key: 'copy-sha', label: '复制提交哈希', icon: 'copy' },
        { key: 'copy-short', label: '复制短哈希', icon: 'copy' },
        { key: 'copy-message', label: '复制提交说明', icon: 'copy' },
      ],
    },
  ];
});

const refClass = (commitRef: IGitCommitRef): Record<string, boolean> => ({
  'is-head': commitRef.isHead,
  'is-remote': commitRef.kind === 'remoteBranch',
  'is-local': commitRef.kind === 'localBranch' && !commitRef.isHead,
});

const refIcon = (commitRef: IGitCommitRef): string =>
  commitRef.kind === 'remoteBranch' ? 'icon-[lucide--cloud]' : 'icon-[lucide--git-branch]';

const formatTime = (value: string | null | undefined): string => {
  if (!value) {
    return '';
  }

  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return '';
  }

  const diff = Math.max(0, Date.now() - time);
  if (diff < 30000) {
    return '刚刚';
  }

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) {
    return minutes + ' 分钟前';
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours + ' 小时前';
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return days + ' 天前';
  }

  return new Date(value).toLocaleDateString();
};

const handleSelect = (commit: IGitCommitSummaryPayload): void => {
  activeCommitId.value = commit.id;
  emit('select-commit', commit);
};

const closeMenu = (): void => {
  menu.open = false;
  menu.commit = null;
};

const handleContextMenu = (event: MouseEvent, commit: IGitCommitSummaryPayload): void => {
  event.preventDefault();
  activeCommitId.value = commit.id;
  menu.commit = commit;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.open = true;
};

const handleMenuSelect = async (item: ILinearContextMenuItem): Promise<void> => {
  const commit = menu.commit;
  closeMenu();

  if (!commit) {
    return;
  }

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
  }
};

const handleWindowPointerDown = (event: PointerEvent): void => {
  if (!menu.open) {
    return;
  }

  const target = event.target;
  if (target instanceof Element && target.closest('.linear-context-menu-root')) {
    return;
  }

  closeMenu();
};

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (menu.open && event.key === 'Escape') {
    closeMenu();
  }
};

const handleWindowResize = (): void => {
  if (menu.open) {
    closeMenu();
  }
};

watch(
  () => props.commits,
  (commits) => {
    if (commits.length === 0) {
      activeCommitId.value = null;
      return;
    }

    const stillExists = commits.some((commit) => commit.id === activeCommitId.value);
    if (!stillExists) {
      activeCommitId.value = commits[0].id;
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (typeof window === 'undefined') {
    return;
  }

  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('resize', handleWindowResize);
});

onBeforeUnmount(() => {
  if (typeof window === 'undefined') {
    return;
  }

  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
  window.removeEventListener('resize', handleWindowResize);
});
</script>

<style scoped>
.git-history-graph.source-control-history-timeline {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 4px 12px 10px;
}

.git-history-graph.source-control-history-timeline::before {
  content: none;
}

.git-history-graph-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 6px 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #818b98;
}

.git-history-graph-group-icon {
  width: 13px;
  height: 13px;
}

.git-history-graph-group-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.git-history-graph-incoming-note {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  font-size: 11px;
  color: #818b98;
}

.git-history-graph-item.source-control-history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 6px;
  border-radius: 6px;
  cursor: pointer;
  background: transparent;
  transition: background 0.14s ease;
}

.git-history-graph-item.source-control-history-item:hover,
.git-history-graph-item.source-control-history-item.is-active:hover {
  background: rgba(129, 139, 152, 0.12);
}

.git-history-graph-item.source-control-history-item.is-active {
  background: transparent;
}

.git-history-graph-cell {
  flex: 0 0 auto;
  align-self: stretch;
  display: flex;
  align-items: center;
}

.git-history-graph-svg {
  display: block;
  overflow: visible;
}

.git-history-graph-edge {
  stroke-width: 1.5;
}

.git-history-graph-node {
  stroke: #ffffff;
  stroke-width: 2;
}

.git-history-graph-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.git-history-graph-message-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.3;
  color: #1f2328;
}

.git-history-graph-ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  height: 16px;
  padding: 0 6px;
  border: 1px solid #d1d9e0;
  border-radius: 999px;
  background: #ffffff;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  color: #59636e;
}

.git-history-graph-ref-icon {
  width: 10px;
  height: 10px;
}

.git-history-graph-ref.is-head {
  border-color: #aacbf0;
  background: #ddf4ff;
  color: #0969da;
}

.git-history-graph-ref.is-remote {
  border-color: #a9d3cf;
  background: #e6f6f4;
  color: #137e74;
}

.git-history-graph-ref.is-local {
  color: #59636e;
}

.git-history-graph-item .source-control-history-author {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: #818b98;
}

.git-history-graph-item .source-control-history-time {
  flex: 0 0 auto;
  font-size: 11px;
  white-space: nowrap;
  color: #818b98;
}
</style>

<style>
@keyframes scm-history-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

.source-control-history-refresh:disabled > span {
  animation: scm-history-refresh-spin 0.8s linear infinite;
}
</style>
