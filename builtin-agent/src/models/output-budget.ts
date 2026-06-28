// ---- Public types ------------------------------------------------------

export interface ITruncateModelOutputTextResult {
  text: string;
  truncated: boolean;
  originalCharCount: number;
  omittedCharCount: number;
}

export interface ICompactModelOutputOptions {
  maxTotalChars: number;
  maxStringChars?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxDepth?: number;
  locale?: string;
}

export interface ICompactModelOutputUnderBudget {
  truncated: false;
  value: unknown;
}

export interface ICompactModelOutputOverBudget {
  truncated: true;
  serializedCharCount: number;
  preview: string;
}

export type TCompactModelOutputResult =
  | ICompactModelOutputUnderBudget
  | ICompactModelOutputOverBudget;

interface ITruncateModelOutputTextOptions {
  includeNotice?: boolean;
  locale?: string;
}

interface ICompactModelOutputResolvedOptions {
  maxTotalChars: number;
  maxStringChars: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxDepth: number;
  locale: string;
}

interface IGraphemeSegment {
  segment: string;
}

interface IGraphemeSegmenter {
  segment(input: string): Iterable<IGraphemeSegment>;
}

// ---- Constants ---------------------------------------------------------

const DEFAULT_LOCALE = 'zh-CN';
const DEFAULT_MAX_STRING_CHARS = 1_200;
const DEFAULT_MAX_ARRAY_ITEMS = 20;
const DEFAULT_MAX_OBJECT_KEYS = 40;
const DEFAULT_MAX_DEPTH = 6;

// 哨兵字段名 —— 用双下划线包裹避开真实业务 key 的碰撞。
const OMITTED_ITEMS_KEY = '__modelOutputOmittedItems__';
const OMITTED_KEYS_KEY = '__modelOutputOmittedKeys__';

// ---- Grapheme segmenter（per-locale cache） ----------------------------

const segmenterCache = new Map<string, IGraphemeSegmenter | null>();

const hasIntlSegmenter = (): boolean =>
  typeof Intl !== 'undefined'
  && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function';

const getGraphemeSegmenter = (locale: string): IGraphemeSegmenter | null => {
  if (segmenterCache.has(locale)) {
    return segmenterCache.get(locale) ?? null;
  }
  if (!hasIntlSegmenter()) {
    segmenterCache.set(locale, null);
    return null;
  }
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' }) as unknown as IGraphemeSegmenter;
    segmenterCache.set(locale, segmenter);
    return segmenter;
  } catch {
    // 非法 locale tag 等。降级到 codepoint 切分。
    segmenterCache.set(locale, null);
    return null;
  }
};

const segmentGraphemes = (value: string, locale: string): string[] => {
  const segmenter = getGraphemeSegmenter(locale);
  if (segmenter) {
    return Array.from(segmenter.segment(value), (segment) => segment.segment);
  }
  // 兜底：按 Unicode codepoint 切分。能正确处理代理对，但 ZWJ 复合 emoji 会被拆成多个，
  // 仅用于预算估算可接受（会略偏多）。
  return Array.from(value);
};

// ---- Option resolution -------------------------------------------------

const toBoundedInteger = (value: number | undefined, fallback: number, min: number): number => {
  const safeFallback = Math.max(fallback, min);
  const candidate = value ?? safeFallback;
  if (!Number.isFinite(candidate)) {
    return safeFallback;
  }
  const integer = Math.floor(candidate);
  return integer >= min ? integer : safeFallback;
};

const resolveOptions = (options: ICompactModelOutputOptions): ICompactModelOutputResolvedOptions => ({
  maxTotalChars: toBoundedInteger(options.maxTotalChars, DEFAULT_MAX_STRING_CHARS, 0),
  maxStringChars: toBoundedInteger(options.maxStringChars, DEFAULT_MAX_STRING_CHARS, 0),
  maxArrayItems: toBoundedInteger(options.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS, 0),
  maxObjectKeys: toBoundedInteger(options.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS, 0),
  maxDepth: toBoundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 0),
  locale: options.locale ?? DEFAULT_LOCALE,
});

// ---- Notice formatting -------------------------------------------------

const formatTruncationNotice = (kept: number, total: number, locale: string): string => {
  if (locale.toLowerCase().startsWith('zh')) {
    return `[内容已截断：显示前 ${kept} / ${total} 字符。]`;
  }
  return `[Content truncated: showing ${kept} of ${total} characters.]`;
};

const formatDepthExceededNotice = (locale: string): string =>
  locale.toLowerCase().startsWith('zh')
    ? '[内容已省略：超过最大结构深度。]'
    : '[Content omitted: maximum structure depth exceeded.]';

const formatCycleNotice = (locale: string): string =>
  locale.toLowerCase().startsWith('zh')
    ? '[内容已省略：检测到循环引用。]'
    : '[Content omitted: circular reference detected.]';

// ---- Public helpers ----------------------------------------------------

export const countModelOutputChars = (value: string, locale = DEFAULT_LOCALE): number =>
  segmentGraphemes(value, locale).length;

export const truncateModelOutputText = (
  value: string,
  maxChars: number,
  options: ITruncateModelOutputTextOptions = {},
): ITruncateModelOutputTextResult => {
  const safeMaxChars = Math.max(0, Math.floor(maxChars));
  const locale = options.locale ?? DEFAULT_LOCALE;
  const graphemes = segmentGraphemes(value, locale);
  const originalCharCount = graphemes.length;
  if (originalCharCount <= safeMaxChars) {
    return {
      text: value,
      truncated: false,
      originalCharCount,
      omittedCharCount: 0,
    };
  }
  const clippedText = graphemes.slice(0, safeMaxChars).join('');
  const omittedCharCount = originalCharCount - safeMaxChars;
  const includeNotice = options.includeNotice ?? true;
  if (!includeNotice) {
    return {
      text: clippedText,
      truncated: true,
      originalCharCount,
      omittedCharCount,
    };
  }
  const notice = formatTruncationNotice(safeMaxChars, originalCharCount, locale);
  return {
    text: clippedText.length > 0 ? `${clippedText}\n${notice}` : notice,
    truncated: true,
    originalCharCount,
    omittedCharCount,
  };
};

// ---- Recursive compaction ----------------------------------------------

const isPlainRecord = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const describeOpaqueObject = (value: object): string => {
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  const tag = ctor?.name && ctor.name !== 'Object' ? ctor.name : 'Object';
  let text: string;
  try {
    text = String(value);
  } catch {
    return `[${tag}]`;
  }
  return text === '[object Object]' ? `[${tag}]` : `[${tag} ${text}]`;
};

const compactValue = (
  value: unknown,
  options: ICompactModelOutputResolvedOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  if (typeof value === 'string') {
    return truncateModelOutputText(value, options.maxStringChars, {
      locale: options.locale,
    }).text;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return `[Function: ${(value as { name?: string }).name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value !== 'object') return String(value);

  if (seen.has(value)) return formatCycleNotice(options.locale);
  if (depth >= options.maxDepth) return formatDepthExceededNotice(options.locale);

  seen.add(value);
  try {
    // 特殊形状的非 plain 对象：避免退化成 {}。
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
    }
    if (value instanceof RegExp) {
      return value.toString();
    }
    if (value instanceof Error) {
      return compactValue(
        {
          name: value.name,
          message: value.message,
          ...(value.stack ? { stack: value.stack } : {}),
        },
        options,
        depth + 1,
        seen,
      );
    }
    if (value instanceof Map) {
      return compactValue(Array.from(value.entries()), options, depth + 1, seen);
    }
    if (value instanceof Set) {
      return compactValue(Array.from(value.values()), options, depth + 1, seen);
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView & { length?: number };
      return `[${value.constructor.name}(length=${view.length ?? '?'})]`;
    }

    if (Array.isArray(value)) {
      const kept = value.slice(0, options.maxArrayItems);
      const items = kept.map((item) => compactValue(item, options, depth + 1, seen));
      const omittedItems = value.length - items.length;
      return omittedItems > 0
        ? [...items, { [OMITTED_ITEMS_KEY]: omittedItems }]
        : items;
    }

    if (isPlainRecord(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      const kept = entries.slice(0, options.maxObjectKeys);
      const compacted: Record<string, unknown> = {};
      for (const [key, item] of kept) {
        compacted[key] = compactValue(item, options, depth + 1, seen);
      }
      const omittedKeys = entries.length - kept.length;
      if (omittedKeys > 0) {
        compacted[OMITTED_KEYS_KEY] = omittedKeys;
      }
      return compacted;
    }

    // 未知类实例：toString() / 构造器名兜底。
    return describeOpaqueObject(value);
  } finally {
    seen.delete(value);
  }
};

// ---- Public entry point ------------------------------------------------

const stringifyCompactValue = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const compactModelOutput = (
  value: unknown,
  options: ICompactModelOutputOptions,
): TCompactModelOutputResult => {
  const resolved = resolveOptions(options);
  const compacted = compactValue(value, resolved, 0, new WeakSet<object>());
  const serialized = stringifyCompactValue(compacted);
  // Grapheme segmentation is the expensive step; do it exactly once.
  // truncateModelOutputText measures (originalCharCount) and clips in a single
  // pass, so there's no need for a separate countModelOutputChars scan over the
  // serialized output before deciding whether it is over budget.
  const truncation = truncateModelOutputText(serialized, resolved.maxTotalChars, {
    locale: resolved.locale,
  });
  if (!truncation.truncated) {
    return { truncated: false, value: compacted };
  }
  return {
    truncated: true,
    serializedCharCount: truncation.originalCharCount,
    preview: truncation.text,
  };
};

// ---- Test-only --------------------------------------------------------

/** 仅供测试：清空 segmenter 缓存。 */
export const clearGraphemeSegmenterCacheForTest = (): void => {
  segmenterCache.clear();
};