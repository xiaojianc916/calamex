import { beforeEach, describe, expect, it } from 'vitest';
import type { IGitGraphInputCommit } from './git-graph';
import {
  buildGitGraph,
  clearGitGraphLayoutCache,
  createGitGraphLayoutCacheKey,
  GIT_GRAPH_LAYOUT_CACHE_LIMIT,
  resolveGitGraphLaneColor,
} from './git-graph';

describe('buildGitGraph', () => {
  beforeEach(() => {
    clearGitGraphLayoutCache();
  });

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
    expect(zRow?.lane).toBe(0);
    expect(wRow?.lane).toBe(0);
  });

  it('多个子提交共享同一父提交时复用单条泳道', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'a', parentIds: ['p'] },
      { id: 'b', parentIds: ['p'] },
      { id: 'c', parentIds: ['p'] },
      { id: 'p', parentIds: [] },
    ];

    const layout = buildGitGraph(commits);

    const pRow = layout.rows.find((row) => row.id === 'p');
    expect(pRow?.lane).toBe(0);
    // p 只占用一条泳道，后续两个子提交通过分叉连线汇入它。
    expect(layout.rows.filter((row) => row.edges.some((edge) => edge.type === 'out')).length).toBe(
      2,
    );
  });

  it('章鱼式合并（三个父提交）展开到三条泳道且连线完整', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'octo', parentIds: ['p1', 'p2', 'p3'] },
      { id: 'p1', parentIds: [] },
      { id: 'p2', parentIds: [] },
      { id: 'p3', parentIds: [] },
    ];

    const layout = buildGitGraph(commits);

    expect(layout.laneCount).toBe(3);
    const octoRow = layout.rows.find((row) => row.id === 'octo');
    expect(octoRow?.lane).toBe(0);
    expect(octoRow?.edges.filter((edge) => edge.type === 'out').length).toBe(2);
  });

  it('多轮 fork/merge 循环下泳道数保持最小并被复用（释放的泳道取最小空闲下标）', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'A', parentIds: ['B', 'C'] },
      { id: 'B', parentIds: ['D'] },
      { id: 'C', parentIds: ['D'] },
      { id: 'D', parentIds: ['E', 'F'] },
      { id: 'E', parentIds: ['G'] },
      { id: 'F', parentIds: ['G'] },
      { id: 'G', parentIds: [] },
    ];

    const layout = buildGitGraph(commits);

    // 并发度始终为 2；释放的泳道应被复用而不是不断分配新泳道。
    expect(layout.rows.length).toBe(7);
    expect(layout.laneCount).toBe(2);
  });

  it('所有边与节点的泳道下标都在 [0, laneCount) 范围内', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'A', parentIds: ['B', 'C'] },
      { id: 'B', parentIds: ['D'] },
      { id: 'C', parentIds: ['E'] },
      { id: 'D', parentIds: ['F'] },
      { id: 'E', parentIds: ['F'] },
      { id: 'F', parentIds: [] },
    ];

    const layout = buildGitGraph(commits);

    for (const row of layout.rows) {
      expect(row.lane).toBeGreaterThanOrEqual(0);
      expect(row.lane).toBeLessThan(layout.laneCount);
      for (const edge of row.edges) {
        expect(edge.fromLane).toBeGreaterThanOrEqual(0);
        expect(edge.fromLane).toBeLessThan(layout.laneCount);
        expect(edge.toLane).toBeGreaterThanOrEqual(0);
        expect(edge.toLane).toBeLessThan(layout.laneCount);
      }
    }
  });

  it('纯函数：相同输入重跑产生完全一致的布局', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'A', parentIds: ['B', 'C'] },
      { id: 'B', parentIds: ['D'] },
      { id: 'C', parentIds: ['D'] },
      { id: 'D', parentIds: ['E', 'F'] },
      { id: 'E', parentIds: ['G'] },
      { id: 'F', parentIds: ['G'] },
      { id: 'G', parentIds: [] },
    ];

    expect(buildGitGraph(commits)).toEqual(buildGitGraph(commits));
  });

  it('相同提交拓扑会复用缓存布局', () => {
    const commits: IGitGraphInputCommit[] = [
      { id: 'A', parentIds: ['B'] },
      { id: 'B', parentIds: [] },
    ];

    const firstLayout = buildGitGraph(commits);
    const secondLayout = buildGitGraph(commits.map((commit) => ({ ...commit })));

    expect(secondLayout).toBe(firstLayout);
  });

  it('缓存 key 使用长度前缀，避免提交 id 与分隔符碰撞', () => {
    const left: IGitGraphInputCommit[] = [{ id: 'a:1', parentIds: ['b;2'] }];
    const right: IGitGraphInputCommit[] = [{ id: 'a', parentIds: ['1:b', '2'] }];

    expect(createGitGraphLayoutCacheKey(left)).not.toBe(createGitGraphLayoutCacheKey(right));
  });

  it('布局缓存超过上限时淘汰最久未使用项', () => {
    const firstCommits: IGitGraphInputCommit[] = [{ id: 'commit-0', parentIds: [] }];
    const firstLayout = buildGitGraph(firstCommits);

    for (let index = 1; index <= GIT_GRAPH_LAYOUT_CACHE_LIMIT; index += 1) {
      buildGitGraph([{ id: `commit-${index}`, parentIds: [] }]);
    }

    expect(buildGitGraph(firstCommits)).not.toBe(firstLayout);
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
