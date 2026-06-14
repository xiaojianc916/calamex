/**
 * 编辑器「外部文档同步」差分。
 *
 * 背景：当外部来源（载入新版本、格式化、AI 补丁等）整篇替换 modelValue 时，
 * 若把整段当作一次 replace 下发，未变区域的折叠/选区/标记会被清空、撤销历史退化成
 * 一大步、大文档整段重渲染。
 *
 * 小文本仍复用 CodeMirror 官方 `@codemirror/merge` 的 `diff()`（Myers O(ND) 最短编辑脚本），
 * 产出多个互不相邻的最小变更区间。大文本 / 大范围变化则通过 CodeMirror `DiffConfig.override`
 * 统一切到线性前后缀单区间替换：保存时格式化、行尾空白归一、换行归一常会在很多行制造小差异，
 * Myers 即使有 scanLimit 也可能在渲染主线程上形成可感知卡顿；线性算法牺牲一部分最小 diff 粒度，
 * 换取稳定的 O(n) 上界，避免 Ctrl+S 保存路径把 WebView 绘制线程卡到露出整窗白底。
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

type CodeMirrorChange = ReturnType<typeof diff>[number];
type CodeMirrorDiffConfig = NonNullable<Parameters<typeof diff>[2]>;

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
const CODEMIRROR_SCAN_LIMIT = 500;

/**
 * 超过该规模后不再使用 Myers。保存路径上同步 diff 发生在渲染主线程，宁可少保留一些
 * 未变区间，也不能让 Ctrl+S 因多处 whitespace 变化卡住整帧绘制。
 */
const MYERS_TOTAL_LENGTH_LIMIT = 160_000;

/** 单次外部同步涉及的文本变化跨度超过该值时，使用线性单区间替换。 */
const MYERS_CHANGED_SPAN_LIMIT = 48_000;

const OFFICIAL_DIFF_CONFIG = { scanLimit: CODEMIRROR_SCAN_LIMIT } satisfies CodeMirrorDiffConfig;

/**
 * 外部同步专用 diff 配置：仍以 CodeMirror 官方 diff 为主，只在本模块定义的主线程
 * 性能保护阈值命中时，通过官方 `DiffConfig.override` 挂上线性 fallback。
 */
const EXTERNAL_SYNC_DIFF_CONFIG = {
  scanLimit: CODEMIRROR_SCAN_LIMIT,
  override: computeExternalSyncDiff,
} satisfies CodeMirrorDiffConfig;

type SingleRangeBounds = {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
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

const computeSingleRangeBounds = (current: string, next: string): SingleRangeBounds | null => {
  if (current === next) {
    return null;
  }

  let prefixLength = 0;
  const maxPrefixLength = Math.min(current.length, next.length);
  while (
    prefixLength < maxPrefixLength &&
    current.charCodeAt(prefixLength) === next.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }

  let currentSuffixIndex = current.length;
  let nextSuffixIndex = next.length;
  while (
    currentSuffixIndex > prefixLength &&
    nextSuffixIndex > prefixLength &&
    current.charCodeAt(currentSuffixIndex - 1) === next.charCodeAt(nextSuffixIndex - 1)
  ) {
    currentSuffixIndex -= 1;
    nextSuffixIndex -= 1;
  }

  return {
    fromA: prefixLength,
    toA: currentSuffixIndex,
    fromB: prefixLength,
    toB: nextSuffixIndex,
  };
};

const computeSingleRangeDiff = (current: string, next: string): readonly CodeMirrorChange[] => {
  const bounds = computeSingleRangeBounds(current, next);
  if (!bounds) {
    return [];
  }

  return [bounds];
};

const computeSingleRangeChange = (current: string, next: string): IDocChange[] => {
  const bounds = computeSingleRangeBounds(current, next);
  if (!bounds) {
    return [];
  }

  return [
    {
      from: bounds.fromA,
      to: bounds.toA,
      insert: next.slice(bounds.fromB, bounds.toB),
    },
  ];
};

const shouldUseLinearSingleRange = (current: string, next: string): boolean => {
  if (current.length + next.length > MYERS_TOTAL_LENGTH_LIMIT) {
    return true;
  }

  const singleRange = computeSingleRangeBounds(current, next);
  if (!singleRange) {
    return false;
  }

  return (
    singleRange.toA - singleRange.fromA + singleRange.toB - singleRange.fromB >
    MYERS_CHANGED_SPAN_LIMIT
  );
};

const computeExternalSyncDiff = (current: string, next: string): readonly CodeMirrorChange[] => {
  if (shouldUseLinearSingleRange(current, next)) {
    return computeSingleRangeDiff(current, next);
  }

  return diff(current, next, OFFICIAL_DIFF_CONFIG);
};

/**
 * 计算把 current 变成 next 所需的变更区间集合。
 * 返回的数组可直接作为 CodeMirror dispatch 的 changes（ChangeSpec[]）。
 * current === next 时返回空数组（无变更）。
 */
export const computeDocChanges = (current: string, next: string): IDocChange[] => {
  if (current === next) {
    return [];
  }

  // diff 失败 / 自校验不通过时的安全兜底：整段替换。
  const singleReplacement: IDocChange[] = [{ from: 0, to: current.length, insert: next }];

  const changes = diff(current, next, EXTERNAL_SYNC_DIFF_CONFIG).map<IDocChange>((change) => ({
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

export const __test__ = {
  computeSingleRangeChange,
};
