#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

function writeFile(relPath, content) {
  const target = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  console.log('  写入 ' + relPath);
}

const gitGraphTs = `export type TGitGraphEdgeType = 'pass' | 'in' | 'out';

export interface IGitGraphInputCommit {
  id: string;
  parentIds: string[];
}

export interface IGitGraphEdge {
  type: TGitGraphEdgeType;
  fromLane: number;
  toLane: number;
  color: string;
}

export interface IGitGraphRow {
  id: string;
  lane: number;
  color: string;
  edges: IGitGraphEdge[];
}

export interface IGitGraphLayout {
  rows: IGitGraphRow[];
  laneCount: number;
}

const GIT_GRAPH_LANE_COLORS: string[] = [
  '#4f9dde',
  '#e0598b',
  '#52b788',
  '#e8a13c',
  '#9d7cd8',
  '#e5645b',
  '#3cb4b0',
  '#c7923e',
];

export function resolveGitGraphLaneColor(lane: number): string {
  const total = GIT_GRAPH_LANE_COLORS.length;
  const index = ((lane % total) + total) % total;
  return GIT_GRAPH_LANE_COLORS[index];
}

function firstFreeLane(lanes: Array<string | null>): number {
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index] === null || lanes[index] === undefined) {
      return index;
    }
  }
  return lanes.length;
}

export function buildGitGraph(commits: IGitGraphInputCommit[]): IGitGraphLayout {
  let lanes: Array<string | null> = [];
  const rows: IGitGraphRow[] = [];
  let laneCount = 0;

  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    const parents = commit.parentIds ? commit.parentIds.slice() : [];
    const beforeLanes = lanes.slice();

    const incomingLanes: number[] = [];
    for (let lane = 0; lane < beforeLanes.length; lane += 1) {
      if (beforeLanes[lane] === commit.id) {
        incomingLanes.push(lane);
      }
    }

    const nodeLane = incomingLanes.length > 0 ? incomingLanes[0] : firstFreeLane(beforeLanes);

    const afterLanes = beforeLanes.slice();
    while (afterLanes.length <= nodeLane) {
      afterLanes.push(null);
    }
    for (let i = 0; i < incomingLanes.length; i += 1) {
      afterLanes[incomingLanes[i]] = null;
    }
    afterLanes[nodeLane] = null;

    const outLanes: number[] = [];
    for (let parentIndex = 0; parentIndex < parents.length; parentIndex += 1) {
      const parentId = parents[parentIndex];

      let existingLane = -1;
      for (let lane = 0; lane < afterLanes.length; lane += 1) {
        if (afterLanes[lane] === parentId) {
          existingLane = lane;
          break;
        }
      }
      if (existingLane !== -1) {
        outLanes.push(existingLane);
        continue;
      }

      const targetLane = parentIndex === 0 ? nodeLane : firstFreeLane(afterLanes);
      while (afterLanes.length <= targetLane) {
        afterLanes.push(null);
      }
      afterLanes[targetLane] = parentId;
      outLanes.push(targetLane);
    }

    while (afterLanes.length > 0 && afterLanes[afterLanes.length - 1] === null) {
      afterLanes.pop();
    }

    const edges: IGitGraphEdge[] = [];
    for (let lane = 0; lane < beforeLanes.length; lane += 1) {
      const value = beforeLanes[lane];
      if (value === null || value === undefined) {
        continue;
      }
      if (value === commit.id) {
        edges.push({
          type: lane === nodeLane ? 'pass' : 'in',
          fromLane: lane,
          toLane: nodeLane,
          color: resolveGitGraphLaneColor(lane),
        });
      } else {
        edges.push({
          type: 'pass',
          fromLane: lane,
          toLane: lane,
          color: resolveGitGraphLaneColor(lane),
        });
      }
    }

    for (let i = 0; i < outLanes.length; i += 1) {
      const target = outLanes[i];
      edges.push({
        type: target === nodeLane ? 'pass' : 'out',
        fromLane: nodeLane,
        toLane: target,
        color: resolveGitGraphLaneColor(target),
      });
    }

    rows.push({
      id: commit.id,
      lane: nodeLane,
      color: resolveGitGraphLaneColor(nodeLane),
      edges,
    });

    laneCount = Math.max(laneCount, beforeLanes.length, afterLanes.length, nodeLane + 1);
    lanes = afterLanes;
  }

  return { rows, laneCount: Math.max(1, laneCount) };
}
`;

const gitGraphSpec = `import { describe, it, expect } from 'vitest';

import { buildGitGraph, resolveGitGraphLaneColor } from './git-graph';
import type { IGitGraphInputCommit } from './git-graph';

describe('buildGitGraph', () => {
  it('单分支线性历史只占用一条泳道', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'a', parentIds: ['b'] },
      { id: 'b', parentIds: ['c'] },
      { id: 'c', parentIds: [] },
    ];

    const layout = buildGitGraph(commits);

    expect(layout.rows.length).toBe(3);
    expect(layout.laneCount).toBe(1);
    for (const row of layout.rows) {
      expect(row.lane).toBe(0);
    }
  });

  it('合并提交会展开第二条泳道并产生分叉连线', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'm', parentIds: ['a', 'b'] },
      { id: 'a', parentIds: ['c'] },
      { id: 'b', parentIds: ['c'] },
      { id: 'c', parentIds: [] },
    ];

    const layout = buildGitGraph(commits);

    expect(layout.laneCount).toBe(2);
    expect(layout.rows[0].lane).toBe(0);
    expect(layout.rows[0].edges.some((edge) => edge.type === 'out')).toBe(true);
    expect(layout.rows[2].lane).toBe(1);
  });

  it('缺失 parentIds 的提交按根提交处理且不会抛错', () => {
    const commits = [{ id: 'solo' }] as unknown as IGitGraphInputCommit[];

    const layout = buildGitGraph(commits);

    expect(layout.rows.length).toBe(1);
    expect(layout.rows[0].lane).toBe(0);
    expect(layout.laneCount).toBe(1);
  });

  it('泳道在分支收敛后会被复用，不会无限增长', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'x', parentIds: ['z'] },
      { id: 'y', parentIds: ['z'] },
      { id: 'z', parentIds: ['w'] },
      { id: 'w', parentIds: [] },
    ];

    const layout = buildGitGraph(commits);

    expect(layout.laneCount).toBe(2);
    const zRow = layout.rows.find((row) => row.id === 'z');
    const wRow = layout.rows.find((row) => row.id === 'w');
    expect(zRow && zRow.lane).toBe(0);
    expect(wRow && wRow.lane).toBe(0);
  });

  it('泳道颜色按调色板循环取值', () => {
    expect(resolveGitGraphLaneColor(0)).toBe(resolveGitGraphLaneColor(8));
    expect(resolveGitGraphLaneColor(-1)).toBe(resolveGitGraphLaneColor(7));

    const colors = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      colors.add(resolveGitGraphLaneColor(index));
    }
    expect(colors.size).toBe(8);
  });
});
`;

const gitHistoryVue = `<template>
  <div class="git-history-graph source-control-history-timeline">
    <template v-for="group in renderGroups" :key="group.key">
      <header
        v-if="group.showHeader"
        class="git-history-graph-group-header"
        :class="'git-history-graph-group-' + group.tone"
      >
        <span :class="group.icon" class="git-history-graph-group-icon" aria-hidden="true" />
        <span class="git-history-graph-group-title"> group.title </span>
        <span class="git-history-graph-group-count"> group.count </span>
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
          <p class="source-control-history-message">
            <span class="git-history-graph-message-text"> row.commit.summary </span>
            <span
              v-for="commitRef in row.refs"
              :key="commitRef.name"
              class="git-history-graph-ref"
              :class="refClass(commitRef)"
            >
              <span :class="refIcon(commitRef)" class="git-history-graph-ref-icon" aria-hidden="true" />
              <span class="git-history-graph-ref-name"> commitRef.name </span>
            </span>
          </p>

          <div class="source-control-history-meta">
            <span class="source-control-history-hash"> row.commit.shortId </span>
            <span class="source-control-history-author"> row.commit.authorName </span>
          </div>
        </div>

        <time class="source-control-history-time" :datetime="row.commit.authoredAt">
           formatTime(row.commit.authoredAt) 
        </time>
      </article>
    </template>

    <section v-if="behind > 0" class="git-history-graph-incoming-note">
      <span class="icon-[lucide--arrow-down] git-history-graph-group-icon" aria-hidden="true" />
      <span>传入更改  behind  条 · 拉取后查看</span>
    </section>

    <LinearContextMenu
      :open="menu.open"
      :x="menu.x"
      :y="menu.y"
      :groups="menuGroups"
      theme="dark"
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
import { buildGitGraph, resolveGitGraphLaneColor } from '@/utils/git-graph';
import type { IGitGraphEdge } from '@/utils/git-graph';

const LANE_WIDTH = 14;
const ROW_HEIGHT = 44;
const NODE_RADIUS = 4;

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
    return 'M ' + x1 + ' 0 C ' + x1 + ' ' + mid * 0.6 + ' ' + x2 + ' ' + mid * 0.4 + ' ' + x2 + ' ' + mid;
  }

  if (edge.type === 'out') {
    return 'M ' + x1 + ' ' + mid + ' C ' + x1 + ' ' + (mid + mid * 0.4) + ' ' + x2 + ' ' + (mid + mid * 0.6) + ' ' + x2 + ' ' + rowHeight;
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

const outgoingRows = computed<IGraphRow[]>(() => decorated.value.slice(0, Math.max(0, props.ahead)));

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
.git-history-graph {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.git-history-graph-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 4px;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--scm-muted, #8b8f98);
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
  padding: 6px 8px;
  font-size: 11px;
  color: var(--scm-muted, #8b8f98);
}

.git-history-graph-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
  min-height: 44px;
  padding: 0 8px;
  border-radius: 6px;
  cursor: pointer;
}

.git-history-graph-item:hover {
  background: var(--scm-hover, rgba(255, 255, 255, 0.04));
}

.git-history-graph-item.is-active {
  background: var(--scm-active, rgba(94, 151, 222, 0.16));
}

.git-history-graph-cell {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}

.git-history-graph-svg {
  display: block;
  overflow: visible;
}

.git-history-graph-edge {
  stroke-width: 1.6;
}

.git-history-graph-node {
  stroke: var(--scm-bg, #1e1f24);
  stroke-width: 1.5;
}

.git-history-graph-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.git-history-graph-body .source-control-history-message {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.git-history-graph-message-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-history-graph-ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.08);
  color: var(--scm-muted, #b7bcc6);
}

.git-history-graph-ref-icon {
  width: 10px;
  height: 10px;
}

.git-history-graph-ref.is-head {
  background: rgba(82, 183, 136, 0.22);
  color: #7fe0ac;
}

.git-history-graph-ref.is-remote {
  background: rgba(94, 151, 222, 0.2);
  color: #8fbdf0;
}

.git-history-graph-ref.is-local {
  background: rgba(224, 161, 60, 0.2);
  color: #e6bd76;
}

.git-history-graph-item .source-control-history-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--scm-muted, #8b8f98);
}

.git-history-graph-item .source-control-history-time {
  flex: 0 0 auto;
  align-self: center;
  font-size: 11px;
  white-space: nowrap;
  color: var(--scm-muted, #8b8f98);
}
</style>
`;

console.log('==> 写入新文件');
writeFile('src/utils/git-graph.ts', gitGraphTs);
writeFile('src/utils/git-graph.spec.ts', gitGraphSpec);
writeFile('src/components/workbench/GitHistoryGraph.vue', gitHistoryVue);

console.log('==> 修补 SourceControlPanel.vue');
const scpPath = path.join(ROOT, 'src/components/workbench/SourceControlPanel.vue');
let scp = fs.readFileSync(scpPath, 'utf8');
let changed = false;

// 1) 引入 GitHistoryGraph 组件
const importAnchor = "import LinearContextMenu from '@/components/common/LinearContextMenu.vue';";
const importLine = "import GitHistoryGraph from '@/components/workbench/GitHistoryGraph.vue';";
if (!scp.includes(importLine)) {
  if (!scp.includes(importAnchor)) {
    throw new Error('找不到 LinearContextMenu 的 import 锚点，文件可能已被改动');
  }
  scp = scp.replace(importAnchor, importAnchor + '\n' + importLine);
  changed = true;
  console.log('  已添加 GitHistoryGraph import');
} else {
  console.log('  GitHistoryGraph import 已存在，跳过');
}

// 2) 用 <GitHistoryGraph> 替换旧的历史时间线区块
if (!scp.includes('<GitHistoryGraph')) {
  const timelineRe =
    /<div v-else-if="filteredCommitHistory\.length > 0" class="source-control-history-timeline">[\s\S]*?<\/div>\s*(?=<p v-else class="source-control-info-note source-control-history-note">)/;
  if (!timelineRe.test(scp)) {
    throw new Error('找不到历史时间线区块，文件可能已被改动');
  }
  const replacement =
    '<GitHistoryGraph\n' +
    '            v-else-if="filteredCommitHistory.length > 0"\n' +
    '            :commits="filteredCommitHistory"\n' +
    '            :ahead="status.ahead"\n' +
    '            :behind="status.behind"\n' +
    '          />\n\n          ';
  scp = scp.replace(timelineRe, replacement);
  changed = true;
  console.log('  已用 GitHistoryGraph 替换历史时间线');
} else {
  console.log('  GitHistoryGraph 区块已存在，跳过');
}

// 3) 删除已无引用的时间格式化函数
const fnStart = scp.indexOf('const formatRelativeTime');
const fnEnd = scp.indexOf('const matchesSearchQuery');
if (fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart) {
  scp = scp.slice(0, fnStart) + scp.slice(fnEnd);
  changed = true;
  console.log('  已删除 formatRelativeTime / formatCommitTime');
} else {
  console.log('  时间格式化函数已删除或未找到，跳过');
}

if (changed) {
  fs.writeFileSync(scpPath, scp, 'utf8');
}

console.log('');
console.log('全部完成。请依次执行验证：');
console.log('  pnpm typecheck');
console.log('  pnpm test');
console.log('通过后再 git add / commit / push。');