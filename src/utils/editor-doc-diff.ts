/**
 * 编辑器「外部文档同步」差分。
 *
 * 背景：当外部来源（载入新版本、shfmt 格式化、AI 补丁等）整篇替换 modelValue 时，
 * 若把整段当作一次 replace 下发，未变区域的折叠/选区/标记会被清空、撤销历史退化成
 * 一大步、大文档整段重渲染。
 *
 * 这里直接复用 CodeMirror 官方 `@codemirror/merge` 的 `diff()`（内部即 Myers O(ND)
 * 最短编辑脚本，与 git/diff 同源算法），产出多个互不相邻的最小变更区间。CodeMirror
 * 一次 dispatch 多个 change，未变区域原样保留，撤销粒度更细、重渲染面积更小。
 *
 * `diff()` 返回的 Change 以「文档 A / 文档 B」坐标表示：插入时 toA===fromA，删除时
 * toB===fromB。这里折算为 CodeMirror ChangeSpec 形态 { from, to, insert }。
 *
 * 兜底：返回前做一次自校验——把变更应用回 current，若不逐字等于 next 则回退单段替换，
 * 因此对任何边界都不会产出错误文档（最差只是退回「整段替换」旧行为）。
 *
 * 注：diff 全程按 UTF-16 code unit 计算；即便公共前后缀恰好落在代理对中间，
 * 逐 code unit 拼接仍等于 next，结果文档完全正确。
 */
import { diff } from '@codemirror/merge';

export interface IDocChange {
  /** 变更区间在「原文档」中的起始偏移（含）。 */
  from: number;
  /** 变更区间在「原文档」中的结束偏移（不含）。 */
  to: number;
  /** 用于替换 [from, to) 的新文本。 */
  insert: string;
}

/**
 * 限制 Myers 扫描规模：遇到超大 / 病态差异（如整篇重写）时，diff() 会自行放弃细分、
 * 回退到粗粒度（整段）结果，避免 O(N·D) 时间 / 内存爆炸。
 */
const DIFF_CONFIG = { scanLimit: 500 };

/**
 * 把一组变更区间应用到源串，返回结果串。
 * 要求 changes 升序且互不重叠（computeDocChanges 的产出满足该约束）。
 * 同时用于 computeDocChanges 内部自校验。
 */
export const applyDocChanges = (source: string, changes: readonly IDocChange[]): string => {
  let result = '';
  let cursor = 0;
  for (const change of changes) {
    result += source.slice(cursor, change.from);
    result += change.insert;
    cursor = change.to;
  }
  result += source.slice(cursor);
  return result;
};

/**
 * 计算把 current 变成 next 所需的「最小变更区间」集合。
 * 返回的数组可直接作为 CodeMirror dispatch 的 changes（ChangeSpec[]）。
 * current === next 时返回空数组（无变更）。
 */
export const computeDocChanges = (current: string, next: string): IDocChange[] => {
  if (current === next) {
    return [];
  }

  // diff 失败 / 自校验不通过时的安全兜底：整段替换。
  const singleReplacement: IDocChange[] = [{ from: 0, to: current.length, insert: next }];

  const changes = diff(current, next, DIFF_CONFIG).map<IDocChange>((change) => ({
    from: change.fromA,
    to: change.toA,
    insert: next.slice(change.fromB, change.toB),
  }));

  if (changes.length === 0) {
    return singleReplacement;
  }

  // 自校验：应用回 current 必须逐字等于 next，否则回退单段替换。
  if (applyDocChanges(current, changes) !== next) {
    return singleReplacement;
  }

  return changes;
};
