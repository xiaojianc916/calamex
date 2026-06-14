import type { TAiThreadEntry } from './entry-types';

/**
 * 结构化深度相等。平铺时间线条目均为投影产出的纯数据(无函数 / 无循环引用),
 * 故可安全地做递归比较;按键集合比较以对键顺序保持稳健。
 */
const isDeepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (a === null || b === null) {
    return a === b;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    for (let index = 0; index < a.length; index += 1) {
      if (!isDeepEqual(a[index], b[index])) {
        return false;
      }
    }

    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);

    if (aKeys.length !== bKeys.length) {
      return false;
    }

    for (const key of aKeys) {
      if (!Object.hasOwn(bRecord, key) || !isDeepEqual(aRecord[key], bRecord[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
};

/**
 * 用上一轮条目“吸收”本轮新投影:对 id 相同且内容深度相等的条目沿用旧对象引用,
 * 从而保持逐条对象 identity 稳定。
 *
 * 动机(对齐 Direction A “增量维护现有 TAiThreadEntry”):`buildThreadEntries`
 * 每次都从消息整体重新投影,产出全新对象。流式输出时正在生长的通常只有最后一个
 * 文本块,但若让同一条消息内的全部条目(推理 / 各工具调用 / 文本)都拿到新引用,
 * 子组件就会在每个 delta 全量重渲染(尤以 AiMarkdown 代价最高)。此处按 id 做结构
 * 共享,只让真正变化的条目获得新引用,其余沿用旧引用 → 不变条目的子组件得以跳过更新。
 *
 * 纯函数:不修改入参;返回的数组本身是新引用(无妨),关键在逐条对象 identity。
 */
export const reconcileThreadEntries = (
  previous: readonly TAiThreadEntry[],
  next: TAiThreadEntry[],
): TAiThreadEntry[] => {
  if (previous.length === 0) {
    return next;
  }

  const previousById = new Map<string, TAiThreadEntry>();

  for (const entry of previous) {
    previousById.set(entry.id, entry);
  }

  return next.map((entry) => {
    const prior = previousById.get(entry.id);

    return prior !== undefined && isDeepEqual(prior, entry) ? prior : entry;
  });
};
