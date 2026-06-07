export type TGitGraphEdgeType = 'pass' | 'in' | 'out';

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
  // 维护 “提交 id -> 当前所在泳道” 的索引，避免每个父提交都线性扫描整条泳道数组。
  // 不变量：在本算法中，任一提交 id 在任一时刻至多占用一条泳道（父提交首次出现时
  // 占位，后续子提交命中索引后复用同一泳道），因此一个 Map<string, number> 足以表达。
  const laneByCommit = new Map<string, number>();
  const rows: IGitGraphRow[] = [];
  let laneCount = 0;

  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    const parents = commit.parentIds ? commit.parentIds.slice() : [];
    const beforeLanes = lanes;

    // O(1) 查到正在等待当前提交的泳道（取代对 beforeLanes 的整体扫描）。
    const incomingLane = laneByCommit.has(commit.id) ? (laneByCommit.get(commit.id) as number) : -1;
    const nodeLane = incomingLane >= 0 ? incomingLane : firstFreeLane(beforeLanes);

    const afterLanes = beforeLanes.slice();
    while (afterLanes.length <= nodeLane) {
      afterLanes.push(null);
    }
    if (incomingLane >= 0) {
      afterLanes[incomingLane] = null;
      laneByCommit.delete(commit.id);
    }
    afterLanes[nodeLane] = null;

    const outLanes: number[] = [];
    for (let parentIndex = 0; parentIndex < parents.length; parentIndex += 1) {
      const parentId = parents[parentIndex];

      // O(1) 复用父提交已占用的泳道（取代对 afterLanes 的整体扫描）。
      const existingLane = laneByCommit.has(parentId)
        ? (laneByCommit.get(parentId) as number)
        : -1;
      if (existingLane !== -1) {
        outLanes.push(existingLane);
        continue;
      }

      const targetLane = parentIndex === 0 ? nodeLane : firstFreeLane(afterLanes);
      while (afterLanes.length <= targetLane) {
        afterLanes.push(null);
      }
      afterLanes[targetLane] = parentId;
      laneByCommit.set(parentId, targetLane);
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
