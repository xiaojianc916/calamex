#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "==> 拉取最新 main"
git pull --ff-only || true

echo "==> 写入 src/utils/git-graph.ts"
cat > src/utils/git-graph.ts <<'GITGRAPH_TS_EOF'
// Git 提交图布局：把(按时间倒序的)提交序列计算成可绘制的「泳道(lane)」布局。
// 纯函数、无副作用，便于单测。渲染层(GitHistoryGraph.vue)只负责把 column/edge
// 映射成 SVG 坐标。
//
// 约定：
// - 输入按「新→旧」排列(与 git log 默认一致)。
// - 每个提交带 parentIds(首个为第一父提交)。缺失时按根提交处理。
// - 列一旦分配即稳定，经过型泳道始终是直线，避免跨行连线横向漂移；空出的列
//   (null)允许被新提交的起点复用，防止无父链信息时列号无限膨胀。

export interface IGitGraphInputCommit {
  id: string;
  parentIds?: string[];
}

export type TGitGraphEdgeType = 'pass' | 'in' | 'out';

export interface IGitGraphEdge {
  type: TGitGraphEdgeType;
  fromColumn: number;
  toColumn: number;
  color: string;
}

export interface IGitGraphRow {
  id: string;
  column: number;
  color: string;
  edges: IGitGraphEdge[];
}

export interface IGitGraphLayout {
  rows: IGitGraphRow[];
  laneCount: number;
}

// 泳道配色(循环取用)。刻意避开纯红/纯绿等状态色，避免与「变更状态」语义混淆。
const GIT_GRAPH_LANE_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
];

export const resolveGitGraphLaneColor = (column: number): string => {
  if (column < 0) {
    return GIT_GRAPH_LANE_COLORS[0];
  }

  return GIT_GRAPH_LANE_COLORS[column % GIT_GRAPH_LANE_COLORS.length];
};

const findReusableColumn = (lanes: (string | null)[]): number => lanes.indexOf(null);

export const buildGitGraph = (commits: IGitGraphInputCommit[]): IGitGraphLayout => {
  // lanes[i] = 该列当前「期待出现」的提交 id；null 表示空列。
  const lanes: (string | null)[] = [];
  const rows: IGitGraphRow[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    const incoming = [...lanes];

    // 1) 决定当前提交所在列。
    let commitColumn = lanes.indexOf(commit.id);
    if (commitColumn === -1) {
      const reusable = findReusableColumn(lanes);
      if (reusable === -1) {
        commitColumn = lanes.length;
        lanes.push(null);
      } else {
        commitColumn = reusable;
      }
    }

    const nodeColor = resolveGitGraphLaneColor(commitColumn);

    // 2) 其它同样期待本提交的泳道(多个子提交汇入)合并进 commitColumn 并释放。
    for (let j = 0; j < lanes.length; j += 1) {
      if (j !== commitColumn && lanes[j] === commit.id) {
        lanes[j] = null;
      }
    }

    // 3) 安排父提交占位。
    const parentIds = commit.parentIds ?? [];
    if (parentIds.length === 0) {
      lanes[commitColumn] = null;
    } else {
      lanes[commitColumn] = parentIds[0];
      for (let p = 1; p < parentIds.length; p += 1) {
        const parentId = parentIds[p];
        let parentColumn = lanes.indexOf(parentId);
        if (parentColumn === -1) {
          const reusable = findReusableColumn(lanes);
          if (reusable === -1) {
            parentColumn = lanes.length;
            lanes.push(parentId);
          } else {
            parentColumn = reusable;
            lanes[parentColumn] = parentId;
          }
        }
      }
    }

    const outgoing = [...lanes];

    // 4)