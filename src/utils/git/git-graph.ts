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

export const GIT_GRAPH_LAYOUT_CACHE_LIMIT = 16;

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

const gitGraphLayoutCache = new Map<string, IGitGraphLayout>();

export function resolveGitGraphLaneColor(lane: number): string {
  const total = GIT_GRAPH_LANE_COLORS.length;
  const index = ((lane % total) + total) % total;
  return GIT_GRAPH_LANE_COLORS[index];
}

const appendLengthPrefixed = (parts: string[], value: string): void => {
  parts.push(String(value.length), ':', value);
};

export function createGitGraphLayoutCacheKey(commits: IGitGraphInputCommit[]): string {
  const parts: string[] = [String(commits.length), '|'];
  for (const commit of commits) {
    appendLengthPrefixed(parts, commit.id);
    const parents = commit.parentIds ?? [];
    parts.push('(', String(parents.length), ')');
    for (const parentId of parents) {
      appendLengthPrefixed(parts, parentId);
    }
    parts.push(';');
  }
  return parts.join('');
}

export function clearGitGraphLayoutCache(): void {
  gitGraphLayoutCache.clear();
}

const getCachedGitGraphLayout = (cacheKey: string): IGitGraphLayout | undefined => {
  const cached = gitGraphLayoutCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  // Map 删除后重插即可维护 LRU 最近访问顺序。
  gitGraphLayoutCache.delete(cacheKey);
  gitGraphLayoutCache.set(cacheKey, cached);
  return cached;
};

const setCachedGitGraphLayout = (cacheKey: string, layout: IGitGraphLayout): void => {
  gitGraphLayoutCache.set(cacheKey, layout);
  while (gitGraphLayoutCache.size > GIT_GRAPH_LAYOUT_CACHE_LIMIT) {
    const oldestKey = gitGraphLayoutCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    gitGraphLayoutCache.delete(oldestKey);
  }
};

// 二叉最小堆：维护「空闲泳道下标」的候选集合，支持 O(log n) 取最小。
// 配合「惰性删除」使用：泳道被占用/越界时不立即从堆中移除，而是在取最小
// 值时顺手丢弃这些失效条目。只要泳道变空闲时都 push 进堆，取到的堆顶（经校验后）
// 必为当前最小的空闲下标，与原线性扫描语义完全一致。
class MinLaneHeap {
  private readonly heap: number[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(value: number): void {
    const heap = this.heap;
    heap.push(value);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (heap[parent] <= heap[child]) {
        break;
      }
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      child = parent;
    }
  }

  peek(): number | undefined {
    return this.heap[0];
  }

  pop(): number | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      let parent = 0;
      const size = heap.length;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < size && heap[left] < heap[smallest]) {
          smallest = left;
        }
        if (right < size && heap[right] < heap[smallest]) {
          smallest = right;
        }
        if (smallest === parent) {
          break;
        }
        [heap[parent], heap[smallest]] = [heap[smallest], heap[parent]];
        parent = smallest;
      }
    }
    return top;
  }
}

function firstFreeLane(lanes: Array<string | null>, freeLaneHeap: MinLaneHeap): number {
  // 丢弃已失效（越界或已被占用）的堆顶候选，剩下的堆顶即当前最小空闲下标。
  while (freeLaneHeap.size > 0) {
    const candidate = freeLaneHeap.peek() as number;
    if (candidate < lanes.length && (lanes[candidate] === null || lanes[candidate] === undefined)) {
      return candidate;
    }
    freeLaneHeap.pop();
  }
  return lanes.length;
}

export function buildGitGraph(commits: IGitGraphInputCommit[]): IGitGraphLayout {
  const cacheKey = createGitGraphLayoutCacheKey(commits);
  const cached = getCachedGitGraphLayout(cacheKey);
  if (cached) {
    return cached;
  }

  const layout = buildGitGraphUncached(commits);
  setCachedGitGraphLayout(cacheKey, layout);
  return layout;
}

function buildGitGraphUncached(commits: IGitGraphInputCommit[]): IGitGraphLayout {
  let lanes: Array<string | null> = [];
  // 维护 “提交 id -> 当前所在泳道” 的索引，避免每个父提交都线性扫描整条泳道数组。
  // 不变量：在本算法中，任一提交 id 在任一时刻至多占用一条泳道（父提交首次出现时
  // 占位，后续子提交命中索引后复用同一泳道），因此一个 Map<string, number> 足以表达。
  const laneByCommit = new Map<string, number>();
  // 空闲泳道的最小堆（惰性删除），取代对 lanes 的线性扫描。
  const freeLaneHeap = new MinLaneHeap();
  const rows: IGitGraphRow[] = [];
  let laneCount = 0;

  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    const parents = commit.parentIds ? commit.parentIds.slice() : [];
    const beforeLanes = lanes;

    // O(1) 查到正在等待当前提交的泳道（取代对 beforeLanes 的整体扫描）。
    const incomingLane = laneByCommit.has(commit.id) ? (laneByCommit.get(commit.id) as number) : -1;
    const nodeLane = incomingLane >= 0 ? incomingLane : firstFreeLane(beforeLanes, freeLaneHeap);

    const afterLanes = beforeLanes.slice();
    while (afterLanes.length <= nodeLane) {
      afterLanes.push(null);
    }
    if (incomingLane >= 0) {
      afterLanes[incomingLane] = null;
      laneByCommit.delete(commit.id);
      freeLaneHeap.push(incomingLane);
    }
    afterLanes[nodeLane] = null;
    freeLaneHeap.push(nodeLane);

    const outLanes: number[] = [];
    for (let parentIndex = 0; parentIndex < parents.length; parentIndex += 1) {
      const parentId = parents[parentIndex];

      // O(1) 复用父提交已占用的泳道（取代对 afterLanes 的整体扫描）。
      const existingLane = laneByCommit.has(parentId) ? (laneByCommit.get(parentId) as number) : -1;
      if (existingLane !== -1) {
        outLanes.push(existingLane);
        continue;
      }

      const targetLane = parentIndex === 0 ? nodeLane : firstFreeLane(afterLanes, freeLaneHeap);
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
