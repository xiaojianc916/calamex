import { type ComputedRef, computed, type Ref } from 'vue';
import type { IGitGraphEdge } from '@/domains/git/utils/git-graph';
import { buildGitGraph, resolveGitGraphLaneColor } from '@/domains/git/utils/git-graph';
import type { IGitCommitSummaryPayload } from '@/types/git';

export const LANE_WIDTH = 13;
export const ROW_HEIGHT = 28;
export const NODE_RADIUS = 3;

export interface IGitCommitRef {
  name: string;
  kind: string;
  isHead: boolean;
}

export interface IGraphEdgePath {
  key: string;
  d: string;
  color: string;
}

export interface IGraphRow {
  commit: IGitCommitSummaryPayload;
  nodeX: number;
  nodeColor: string;
  refs: IGitCommitRef[];
  paths: IGraphEdgePath[];
}

export interface IGraphGroup {
  key: string;
  title: string;
  icon: string;
  tone: string;
  count: number;
  showHeader: boolean;
  rows: IGraphRow[];
}

export const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;

export const buildEdgePath = (edge: IGitGraphEdge, rowHeight: number): string => {
  const x1 = laneX(edge.fromLane);
  const x2 = laneX(edge.toLane);
  const mid = rowHeight / 2;
  if (edge.type === 'pass' && edge.fromLane === edge.toLane)
    return `M ${x1} 0 L ${x1} ${rowHeight}`;
  if (edge.type === 'in') return `M ${x1} 0 C ${x1} ${mid * 0.6} ${x2} ${mid * 0.4} ${x2} ${mid}`;
  if (edge.type === 'out')
    return `M ${x1} ${mid} C ${x1} ${mid + mid * 0.4} ${x2} ${mid + mid * 0.6} ${x2} ${rowHeight}`;
  return `M ${x1} 0 C ${x1} ${mid} ${x2} ${mid} ${x2} ${rowHeight}`;
};

export interface IUseGitHistoryGraphResult {
  graphWidth: ComputedRef<number>;
  renderGroups: ComputedRef<IGraphGroup[]>;
}

/**
 * 提供提交图的纯布局计算：泳道坐标、边路径与分组。
 * 不持有任何交互状态，便于在组件间复用与测试。
 */
export function useGitHistoryGraph(
  commits: Ref<IGitCommitSummaryPayload[]> | ComputedRef<IGitCommitSummaryPayload[]>,
  ahead: ComputedRef<number>,
): IUseGitHistoryGraphResult {
  const layout = computed(() =>
    buildGitGraph(
      commits.value.map((commit) => ({ id: commit.id, parentIds: commit.parentIds ?? [] })),
    ),
  );

  const graphWidth = computed(() => Math.max(1, layout.value.laneCount) * LANE_WIDTH);

  const decorated = computed<IGraphRow[]>(() =>
    commits.value.map((commit, index) => {
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
          key: `${edge.type}:${edge.fromLane}:${edge.toLane}:${edgeIndex}`,
          d: buildEdgePath(edge, ROW_HEIGHT),
          color: edge.color,
        })),
      };
    }),
  );

  const outgoingRows = computed<IGraphRow[]>(() =>
    decorated.value.slice(0, Math.max(0, ahead.value)),
  );
  const historyRows = computed<IGraphRow[]>(() => decorated.value.slice(Math.max(0, ahead.value)));

  const renderGroups = computed<IGraphGroup[]>(() => {
    const groups: IGraphGroup[] = [];
    if (outgoingRows.value.length > 0) {
      groups.push({
        key: 'outgoing',
        title: '传出更改',
        icon: 'arrow-up',
        tone: 'outgoing',
        count: outgoingRows.value.length,
        showHeader: true,
        rows: outgoingRows.value,
      });
    }
    groups.push({
      key: 'history',
      title: '历史',
      icon: 'git-commit-horizontal',
      tone: 'history',
      count: historyRows.value.length,
      showHeader: outgoingRows.value.length > 0,
      rows: historyRows.value,
    });
    return groups;
  });

  return { graphWidth, renderGroups };
}
