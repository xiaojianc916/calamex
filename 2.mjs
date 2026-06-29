// 6.mjs — 简化 git-graph.ts：删除 MinLaneHeap，firstFreeLane 回退线性扫描（语义等价）
// 改动文件：
//   1) src/domains/git/utils/git-graph.ts        （删 MinLaneHeap 类 + 堆相关调用）
//   2) src/domains/git/utils/git-graph.spec.ts   （仅改一条测试名：去掉“最小堆”措辞）
// 安全：仓库根目录运行；任一守卫失败即中止，不写任何文件。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const FILE_GRAPH = 'src/domains/git/utils/git-graph.ts';
const FILE_SPEC = 'src/domains/git/utils/git-graph.spec.ts';

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!existsSync('src') || !existsSync('package.json')) {
  die('✘ 未检测到 src/ 或 package.json，请在仓库根目录（D:\\com.xiaojianc\\my_desktop_app）下运行。');
}

const readFile = (rel) => {
  if (!existsSync(rel)) die(`✘ 找不到文件：${rel}`);
  const raw = readFileSync(rel, 'utf8');
  return { raw, usesCRLF: raw.includes('\r\n') };
};
const toLF = (s) => s.replace(/\r\n/g, '\n');
const restoreEOL = (s, usesCRLF) => (usesCRLF ? s.replace(/\n/g, '\r\n') : s);
const replaceOnce = (text, find, replace, label) => {
  const count = text.split(find).length - 1;
  if (count !== 1) die(`✘ 替换「${label}」预期命中 1 次，实际 ${count} 次。文件可能已变更，已中止且未写入。`);
  return text.split(find).join(replace);
};

// ---- 前置守卫 ----
const graph = readFile(FILE_GRAPH);
let g = toLF(graph.raw);
if (!g.includes('MinLaneHeap') || !g.includes('freeLaneHeap')) {
  die('✘ git-graph.ts 未包含 MinLaneHeap/freeLaneHeap，可能已简化或已变更，已中止。');
}
const spec = readFile(FILE_SPEC);
let s = toLF(spec.raw);
if (!s.includes('（最小堆取最小空闲泳道）')) {
  die('✘ git-graph.spec.ts 未找到目标测试名（最小堆取最小空闲泳道），已中止。');
}

// 全仓扫描：MinLaneHeap 是局部类、不应被任何其它文件引用
const walk = (dir, acc) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p, acc) : /\.(ts|tsx|vue)$/.test(name) && acc.push(p);
  }
  return acc;
};
const norm = (p) => p.split(sep).join('/');
for (const p of walk('src', [])) {
  if (norm(p) === norm(FILE_GRAPH)) continue;
  if (toLF(readFileSync(p, 'utf8')).includes('MinLaneHeap')) {
    die(`✘ 其它文件引用了 MinLaneHeap：${norm(p)}，已中止。`);
  }
}

// ---- git-graph.ts 五处改动 ----
const G1_FIND = `// 二叉最小堆：维护「空闲泳道下标」的候选集合，支持 O(log n) 取最小。
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
}`;
const G1_REPL = `function firstFreeLane(lanes: Array<string | null>): number {
  // 返回最小的空闲泳道下标；没有空闲则追加到末尾。
  // 泳道数等于并发分支数，量级很小，线性扫描既直白又足够快。
  for (let lane = 0; lane < lanes.length; lane += 1) {
    if (lanes[lane] === null || lanes[lane] === undefined) {
      return lane;
    }
  }
  return lanes.length;
}`;

const G2_FIND = `  const laneByCommit = new Map<string, number>();
  // 空闲泳道的最小堆（惰性删除），取代对 lanes 的线性扫描。
  const freeLaneHeap = new MinLaneHeap();
  const rows: IGitGraphRow[] = [];`;
const G2_REPL = `  const laneByCommit = new Map<string, number>();
  const rows: IGitGraphRow[] = [];`;

const G3_FIND = `    const nodeLane = incomingLane >= 0 ? incomingLane : firstFreeLane(beforeLanes, freeLaneHeap);`;
const G3_REPL = `    const nodeLane = incomingLane >= 0 ? incomingLane : firstFreeLane(beforeLanes);`;

const G4_FIND = `    if (incomingLane >= 0) {
      afterLanes[incomingLane] = null;
      laneByCommit.delete(commit.id);
      freeLaneHeap.push(incomingLane);
    }
    afterLanes[nodeLane] = null;
    freeLaneHeap.push(nodeLane);`;
const G4_REPL = `    if (incomingLane >= 0) {
      afterLanes[incomingLane] = null;
      laneByCommit.delete(commit.id);
    }
    afterLanes[nodeLane] = null;`;

const G5_FIND = `      const targetLane = parentIndex === 0 ? nodeLane : firstFreeLane(afterLanes, freeLaneHeap);`;
const G5_REPL = `      const targetLane = parentIndex === 0 ? nodeLane : firstFreeLane(afterLanes);`;

g = replaceOnce(g, G1_FIND, G1_REPL, 'graph: 删除 MinLaneHeap，firstFreeLane 改线性扫描');
g = replaceOnce(g, G2_FIND, G2_REPL, 'graph: 删除 freeLaneHeap 声明');
g = replaceOnce(g, G3_FIND, G3_REPL, 'graph: nodeLane 调用去 heap 参数');
g = replaceOnce(g, G4_FIND, G4_REPL, 'graph: 去掉两处 freeLaneHeap.push');
g = replaceOnce(g, G5_FIND, G5_REPL, 'graph: targetLane 调用去 heap 参数');

// ---- git-graph.spec.ts 测试名改写 ----
const S1_FIND = `  it('多轮 fork/merge 循环下泳道数保持最小并被复用（最小堆取最小空闲泳道）', () => {`;
const S1_REPL = `  it('多轮 fork/merge 循环下泳道数保持最小并被复用（释放的泳道取最小空闲下标）', () => {`;
s = replaceOnce(s, S1_FIND, S1_REPL, 'spec: 测试名去掉“最小堆”措辞');

// ---- 后置守卫 ----
for (const bad of ['MinLaneHeap', 'freeLaneHeap']) {
  if (g.includes(bad)) die(`✘ 新 git-graph.ts 仍残留「${bad}」，已中止。`);
}
if (!g.includes('function firstFreeLane(lanes: Array<string | null>): number {')) {
  die('✘ 新 git-graph.ts 缺少简化后的 firstFreeLane 签名，已中止。');
}
if (s.includes('最小堆')) die('✘ git-graph.spec.ts 仍残留“最小堆”，已中止。');

// ---- 原子写入 ----
writeFileSync(FILE_GRAPH, restoreEOL(g, graph.usesCRLF), 'utf8');
writeFileSync(FILE_SPEC, restoreEOL(s, spec.usesCRLF), 'utf8');

console.log('✔ 已简化 ' + FILE_GRAPH + '（删除 MinLaneHeap，firstFreeLane 改线性扫描）');
console.log('✔ 已更新 ' + FILE_SPEC + '（测试名去掉“最小堆”措辞）');
console.log('\n下一步：pnpm typecheck && pnpm lint && pnpm test && pnpm build');