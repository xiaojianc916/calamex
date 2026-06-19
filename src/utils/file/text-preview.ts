import type { IPrioritizedPreviewField } from './text-preview-types';

export type { IPrioritizedPreviewField } from './text-preview-types';

// ── 常量 ──────────────────────────────────────────────────────

const DEFAULT_MAX_GRAPHEMES = 96;
const DEFAULT_MAX_PREVIEW_FIELDS = 3;
const DEFAULT_FIELD_MIN_GRAPHEMES = 8;
const DEFAULT_FIELD_SEPARATOR = ' · ';
const DEFAULT_LABEL_SEPARATOR = '：';
const DEFAULT_LOCALE: string[] = ['zh-CN', 'en'];
const ELLIPSIS = '...';

// ── 字素切分（Intl.Segmenter，Node ≥ 26 全平台可用）────────────

const segmenterCache = new Map<string, Intl.Segmenter | null>();

const getLocaleKey = (locale?: string | string[]): string =>
  Array.isArray(locale) ? locale.join('\u0001') : (locale ?? '');

/** 创建（或从缓存取）grapheme 级 Segmenter。不支持时返回 null。 */
const getSegmenter = (locale?: string | string[]): Intl.Segmenter | null => {
  const effectiveLocale = locale ?? DEFAULT_LOCALE;
  const cacheKey = getLocaleKey(effectiveLocale);
  const cached = segmenterCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const segmenter = new Intl.Segmenter(effectiveLocale, { granularity: 'grapheme' });
    segmenterCache.set(cacheKey, segmenter);
    return segmenter;
  } catch {
    segmenterCache.set(cacheKey, null);
    return null;
  }
};

/** 将字符串拆成字素数组。优先用 Intl.Segmenter，回退用 Array.from（按码点拆分，能正确处理代理对）。 */
const splitGraphemes = (value: string, locale?: string | string[]): string[] => {
  if (!value) return [];
  const segmenter = getSegmenter(locale);
  if (segmenter) {
    return Array.from(segmenter.segment(value), (s) => s.segment);
  }
  // 回退：V8 的 Array.from 按码点迭代，正确处理代理对，但不会合并 ZWJ/CVS。
  return Array.from(value);
};

// ── 公开 API ──────────────────────────────────────────────────

/** 将字符串拆成字素数组（返回防御性拷贝，调用方可安全修改）。 */
export const splitTextGraphemes = (value: string, locale?: string | string[]): string[] => [
  ...splitGraphemes(value, locale),
];

interface IClipOptions {
  maxGraphemes?: number;
  locale?: string | string[];
  ellipsis?: string;
}

/** 栽剪文本到 maxGraphemes 个字素，尽量在句子/语义边界截断，末尾加省略号。 */
export const clipTextPreview = (value: string, options: IClipOptions = {}): string => {
  const limit = Math.max(0, Math.floor(options.maxGraphemes ?? DEFAULT_MAX_GRAPHEMES));
  const locale = options.locale;
  const ellipsis = options.ellipsis ?? ELLIPSIS;
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();

  if (!normalized || limit <= 0) return '';

  const graphemes = splitGraphemes(normalized, locale);
  if (graphemes.length <= limit) return normalized;

  const ellipsisLen = splitGraphemes(ellipsis, locale).length;
  if (ellipsisLen <= 0 || limit <= ellipsisLen) {
    return graphemes.slice(0, limit).join('').trim();
  }

  const contentLimit = limit - ellipsisLen;

  // 1) 优先在句子边界裁剪
  const sentenceSegmenter = getSentenceSegmenter(locale);
  if (sentenceSegmenter) {
    let used = 0;
    let output = '';
    for (const { segment } of sentenceSegmenter.segment(normalized)) {
      const segLen = splitGraphemes(segment, locale).length;
      if (used + segLen > contentLimit) break;
      output += segment;
      used += segLen;
    }
    const trimmed = output.trim();
    if (trimmed && used >= Math.floor(contentLimit * 0.45)) {
      return `${trimmed}${ellipsis}`;
    }
  }

  // 2) 回退：硬截断到 contentLimit 个字素
  const content = graphemes.slice(0, contentLimit).join('').trim();
  return content ? `${content}${ellipsis}` : '';
};

// ── 句子级 Segmenter（延迟创建+缓存）──────────────────────────

const sentenceSegmenterCache = new Map<string, Intl.Segmenter | null>();

const getSentenceSegmenter = (locale?: string | string[]): Intl.Segmenter | null => {
  const effectiveLocale = locale ?? DEFAULT_LOCALE;
  const cacheKey = getLocaleKey(effectiveLocale);
  const cached = sentenceSegmenterCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const segmenter = new Intl.Segmenter(effectiveLocale, { granularity: 'sentence' });
    sentenceSegmenterCache.set(cacheKey, segmenter);
    return segmenter;
  } catch {
    sentenceSegmenterCache.set(cacheKey, null);
    return null;
  }
};

// ── 多字段优先级预览 ───────────────────────────────────────────

interface INormalizedField extends IPrioritizedPreviewField {
  index: number;
}

const safeFloor = (v: number, fallback: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;

const safePriority = (p: number): number => (Number.isFinite(p) ? Math.max(1, p) : 1);

/** 规范化、去重、按优先级降序排序，取前 maxFields 个。 */
const normalizeFields = (
  fields: readonly IPrioritizedPreviewField[],
  maxFields: number,
): INormalizedField[] => {
  const limit = safeFloor(maxFields, DEFAULT_MAX_PREVIEW_FIELDS);
  if (limit <= 0) return [];

  const seen = new Set<string>();
  return fields
    .map((f, index) => ({
      ...f,
      value: f.value.normalize('NFC').replace(/\s+/gu, ' ').trim(),
      label: f.label?.normalize('NFC').replace(/\s+/gu, ' ').trim() || undefined,
      priority: safePriority(f.priority),
      index,
    }))
    .filter((f) => {
      if (!f.value) return false;
      const id = `${f.label ?? ''}\u0000${f.value}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, limit);
};

/** 计算字段前缀（label + 分隔符）占用的字素数。 */
const fieldPrefix = (f: INormalizedField, sep: string): string =>
  f.label ? `${f.label}${sep}` : '';

/** 按优先级权重分配预算。needs = 字段值字素数（受 maxGraphemes 限制）。 */
const allocateBudgets = (
  fields: readonly INormalizedField[],
  available: number,
  locale?: string | string[],
): number[] => {
  if (!fields.length || available <= 0) return fields.map(() => 0);

  const totalPriority = Math.max(
    1,
    fields.reduce((s, f) => s + f.priority, 0),
  );
  const needs = fields.map((f) => {
    const raw = splitGraphemes(f.value, locale).length;
    return f.maxGraphemes !== undefined ? Math.min(raw, safeFloor(f.maxGraphemes, raw)) : raw;
  });

  // 初始分配 = max(minBudget, weighted)，但不超过 need
  const budgets = fields.map((f, i) => {
    const min = safeFloor(
      f.minGraphemes ?? DEFAULT_FIELD_MIN_GRAPHEMES,
      DEFAULT_FIELD_MIN_GRAPHEMES,
    );
    const weighted = Math.floor((available * f.priority) / totalPriority);
    return Math.min(needs[i], Math.max(1, min, weighted));
  });

  // 修正：surplus 回收低优先级字段，deficit 补充高优先级字段
  const total = budgets.reduce((s, b) => s + b, 0);
  if (total > available) {
    let surplus = total - available;
    const order = fields
      .map((_, i) => ({ i, p: fields[i].priority }))
      .sort((a, b) => a.p - b.p || b.i - a.i);
    for (const { i } of order) {
      if (surplus <= 0) break;
      const take = Math.min(surplus, budgets[i]);
      budgets[i] -= take;
      surplus -= take;
    }
  } else if (total < available) {
    let deficit = available - total;
    const order = fields
      .map((_, i) => ({ i, p: fields[i].priority }))
      .sort((a, b) => b.p - a.p || a.i - b.i);
    for (const { i } of order) {
      if (deficit <= 0) break;
      const capacity = needs[i] - budgets[i];
      if (capacity > 0) {
        const give = Math.min(deficit, capacity);
        budgets[i] += give;
        deficit -= give;
      }
    }
  }

  return budgets.map((b) => Math.max(0, Math.floor(b)));
};

interface IFormatOptions {
  maxFields?: number;
  maxGraphemes?: number;
  separator?: string;
  labelSeparator?: string;
  locale?: string | string[];
  ellipsis?: string;
}

/** 按字段优先级分配渲染预算，输出 `label：value · label：value` 格式。 */
export const formatPrioritizedFieldPreview = (
  fields: readonly IPrioritizedPreviewField[],
  options: IFormatOptions = {},
): string => {
  const maxGraphemes = safeFloor(
    options.maxGraphemes ?? DEFAULT_MAX_GRAPHEMES,
    DEFAULT_MAX_GRAPHEMES,
  );
  const separator = options.separator ?? DEFAULT_FIELD_SEPARATOR;
  const labelSep = options.labelSeparator ?? DEFAULT_LABEL_SEPARATOR;
  const maxFields = safeFloor(
    options.maxFields ?? DEFAULT_MAX_PREVIEW_FIELDS,
    DEFAULT_MAX_PREVIEW_FIELDS,
  );
  const locale = options.locale;
  const ellipsis = options.ellipsis ?? ELLIPSIS;

  let selected = normalizeFields(fields, maxFields);
  if (maxGraphemes <= 0 || !selected.length) return '';

  // 逐个裁掉最低优先级字段，直到预算能容纳所有字段的最小需求
  while (selected.length > 1) {
    const fixed =
      selected.reduce((s, f) => s + splitGraphemes(fieldPrefix(f, labelSep), locale).length, 0) +
      Math.max(0, selected.length - 1) * splitGraphemes(separator, locale).length;
    const minRequired = selected.reduce((s, f) => {
      const need = splitGraphemes(f.value, locale).length;
      const min = safeFloor(
        f.minGraphemes ?? DEFAULT_FIELD_MIN_GRAPHEMES,
        DEFAULT_FIELD_MIN_GRAPHEMES,
      );
      return s + Math.min(need, min);
    }, 0);
    if (maxGraphemes - fixed >= minRequired) break;
    selected = selected.slice(0, -1);
  }
  if (!selected.length) return '';

  const fixed =
    selected.reduce((s, f) => s + splitGraphemes(fieldPrefix(f, labelSep), locale).length, 0) +
    Math.max(0, selected.length - 1) * splitGraphemes(separator, locale).length;

  // 固定开销已超预算 -> 退化到只有value的模式
  if (fixed >= maxGraphemes) {
    const available = maxGraphemes;
    const budgets = allocateBudgets(selected, available, locale);
    const preview = selected
      .map((f, i) => clipTextPreview(f.value, { maxGraphemes: budgets[i], locale, ellipsis }))
      .join(separator);
    return splitGraphemes(preview, locale).length > maxGraphemes
      ? clipTextPreview(preview, { maxGraphemes, locale, ellipsis })
      : preview;
  }

  const budgets = allocateBudgets(selected, Math.max(0, maxGraphemes - fixed), locale);
  const preview = selected
    .map(
      (f, i) =>
        `${fieldPrefix(f, labelSep)}${clipTextPreview(f.value, { maxGraphemes: budgets[i], locale, ellipsis })}`,
    )
    .join(separator);
  return splitGraphemes(preview, locale).length > maxGraphemes
    ? clipTextPreview(preview, { maxGraphemes, locale, ellipsis })
    : preview;
};
