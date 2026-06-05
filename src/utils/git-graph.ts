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
