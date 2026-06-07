/**
 * 编辑器「外部文档同步」差分。
 *
 * 背景：当外部来源（载入新版本、shfmt 格式化、AI 补丁等）整篇替换 modelValue 时，
 * 旧实现只裁掉公共前后缀，把中间整段当作一次替换下发。只要首尾各有一点不同，中间
 * 一大块（即便其中大部分行没变）都会被一次性 replace，导致：未变区域的折叠/选区/
 * 标记被清空、撤销历史退化成一大步、大文档整段重渲染。
 *
 * 这里改用 Myers O(ND) 最短编辑脚本（《An O(ND) Difference Algorithm and Its
 * Variations》, Eugene W. Myers, 1986；也是 git / diff 的核心算法），在「去掉公共
 * 前后缀」后的中间段上求解，产出多个互不相邻的最小变更区间。CodeMirror 一次 dispatch
 * 多个 change，未变区域原样保留，撤销粒度更细、重渲染面积更小。
 *
 * 复杂度与兜底：
 * - 公共前后缀裁剪 O(n)，把交互式按键这类「单点小改」直接退化为单段替换。
 * - 仅对中间段跑 Myers；中间段过长或编辑距离 D 过大（病态差异，如整篇重写）时放弃
 *   细分、回退单段替换，避免 O(N·D) 时间/内存爆炸。
 * - 返回前做一次「自校验」：把变更应用回 current，若不逐字等于 next 则回退单段替换。
 *   因此本函数对任何边界都不会产出错误文档——最差只是退回旧行为。
 *
 * 注：全程按 UTF-16 code unit 计算；即便公共前后缀恰好落在代理对中间，
 * prefix + 中间变更 + suffix 逐 code unit 仍等于 next，结果文档完全正确。
 */

export interface IDocChange {
  /** 变更区间在「原文档」中的起始偏移（含）。 */
  from: number;
  /** 变更区间在「原文档」中的结束偏移（不含）。 */
  to: number;
  /** 用于替换 [from, to) 的新文本。 */
  insert: string;
}

/** 中间段单侧最大长度（code unit）；超过则不细分，直接单段替换。 */
const MAX_DIFF_MIDDLE_LENGTH = 1 << 12;
/** Myers 最大可接受编辑距离；超过视为病态差异，回退单段替换。 */
const MAX_DIFF_EDIT_DISTANCE = 1 << 10;

/** 操作类型：0=保留(eq) / 1=删除(consume a) / 2=插入(consume b)。 */
type TEditOp = 0 | 1 | 2;

const computeCommonPrefixLength = (a: string, b: string, maxLength: number): number => {
  let index = 0;
  while (index < maxLength && a.charCodeAt(index) === b.charCodeAt(index)) {
    index += 1;
  }
  return index;
};

const computeCommonSuffixLength = (a: string, b: string, maxLength: number): number => {
  const aLength = a.length;
  const bLength = b.length;
  let index = 0;
  while (
    index < maxLength &&
    a.charCodeAt(aLength - 1 - index) === b.charCodeAt(bLength - 1 - index)
  ) {
    index += 1;
  }
  return index;
};

/**
 * Myers 最短编辑脚本：返回作用于中间段 a→b 的操作序列（正序）。
 * 超过编辑距离上限时返回 null，交由调用方回退。
 */
const myersEditScript = (a: string, b: string): TEditOp[] | null => {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let foundD = -1;

  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_DIFF_EDIT_DISTANCE) {
      return null;
    }
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) {
      break;
    }
  }

  if (foundD < 0) {
    return null;
  }

  const reversed: TEditOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d -= 1) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push(0);
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      reversed.push(2);
      y -= 1;
    } else {
      reversed.push(1);
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push(0);
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    reversed.push(1);
    x -= 1;
  }
  while (y > 0) {
    reversed.push(2);
    y -= 1;
  }

  reversed.reverse();
  return reversed;
};

/**
 * 把 Myers 操作序列折叠成「最小变更区间」数组（按原文档坐标，升序、互不重叠）。
 * 连续的删除/插入合并为一个 change；纯插入产出 from===to，纯删除产出 insert===''。
 */
const buildChanges = (
  ops: readonly TEditOp[],
  b: string,
  aStart: number,
): IDocChange[] => {
  const changes: IDocChange[] = [];
  let posA = 0;
  let posB = 0;
  let inRun = false;
  let runStartPosA = 0;
  let runInsert = '';

  const flush = (): void => {
    if (!inRun) {
      return;
    }
    changes.push({ from: aStart + runStartPosA, to: aStart + posA, insert: runInsert });
    inRun = false;
    runInsert = '';
  };

  for (const op of ops) {
    if (op === 0) {
      flush();
      posA += 1;
      posB += 1;
    } else if (op === 1) {
      if (!inRun) {
        inRun = true;
        runStartPosA = posA;
        runInsert = '';
      }
      posA += 1;
    } else {
      if (!inRun) {
        inRun = true;
        runStartPosA = posA;
        runInsert = '';
      }
      runInsert += b.charAt(posB);
      posB += 1;
    }
  }
  flush();
  return changes;
};

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

  const currentLength = current.length;
  const nextLength = next.length;
  const maxPrefix = Math.min(currentLength, nextLength);
  const prefix = computeCommonPrefixLength(current, next, maxPrefix);
  const maxSuffix = Math.min(currentLength, nextLength) - prefix;
  const suffix = computeCommonSuffixLength(current, next, maxSuffix);

  const aStart = prefix;
  const aEnd = currentLength - suffix;
  const bStart = prefix;
  const bEnd = nextLength - suffix;

  const singleReplacement: IDocChange[] = [
    { from: aStart, to: aEnd, insert: next.slice(bStart, bEnd) },
  ];

  const a = current.slice(aStart, aEnd);
  const b = next.slice(bStart, bEnd);

  // 纯插入或纯删除：单段即最小，无需 Myers。
  if (a.length === 0 || b.length === 0) {
    return singleReplacement;
  }

  // 中间段过长：放弃细分，避免 O(N·D) 爆炸。
  if (a.length > MAX_DIFF_MIDDLE_LENGTH || b.length > MAX_DIFF_MIDDLE_LENGTH) {
    return singleReplacement;
  }

  const ops = myersEditScript(a, b);
  if (!ops) {
    return singleReplacement;
  }

  const changes = buildChanges(ops, b, aStart);
  if (changes.length === 0) {
    return singleReplacement;
  }

  // 自校验：应用回 current 必须逐字等于 next，否则回退单段替换。
  if (applyDocChanges(current, changes) !== next) {
    return singleReplacement;
  }

  return changes;
};
