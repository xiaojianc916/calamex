interface IGraphemeSegment {
  segment: string;
}

interface IGraphemeSegmenter {
  segment(input: string): Iterable<IGraphemeSegment>;
}

interface IGraphemeSegmenterConstructor {
  new(locale: string, options: { granularity: 'grapheme' }): IGraphemeSegmenter;
}

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

const DEFAULT_LOCALE = 'zh-CN';
const DEFAULT_MAX_STRING_CHARS = 1_200;
const DEFAULT_MAX_ARRAY_ITEMS = 20;
const DEFAULT_MAX_OBJECT_KEYS = 40;
const DEFAULT_MAX_DEPTH = 6;

const intlWithSegmenter = Intl as typeof Intl & {
  Segmenter?: IGraphemeSegmenterConstructor;
};

let graphemeSegmenter: IGraphemeSegmenter | null | undefined;

const getGraphemeSegmenter = (locale: string): IGraphemeSegmenter | null => {
  if (graphemeSegmenter !== undefined) {
    return graphemeSegmenter;
  }

  if (!intlWithSegmenter.Segmenter) {
    graphemeSegmenter = null;
    return graphemeSegmenter;
  }

  graphemeSegmenter = new intlWithSegmenter.Segmenter(locale, { granularity: 'grapheme' });
  return graphemeSegmenter;
};

const segmentGraphemes = (value: string, locale = DEFAULT_LOCALE): string[] => {
  const segmenter = getGraphemeSegmenter(locale);

  if (segmenter) {
    return Array.from(segmenter.segment(value), (segment) => segment.segment);
  }

  return Array.from(value);
};

const toBoundedInteger = (value: number, fallback: number, min: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const integer = Math.floor(value);

  return integer >= min ? integer : fallback;
};

const resolveOptions = (options: ICompactModelOutputOptions): ICompactModelOutputResolvedOptions => ({
  maxTotalChars: toBoundedInteger(options.maxTotalChars, DEFAULT_MAX_STRING_CHARS, 0),
  maxStringChars: toBoundedInteger(
    options.maxStringChars ?? DEFAULT_MAX_STRING_CHARS,
    DEFAULT_MAX_STRING_CHARS,
    0,
  ),
  maxArrayItems: toBoundedInteger(
    options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS,
    DEFAULT_MAX_ARRAY_ITEMS,
    0,
  ),
  maxObjectKeys: toBoundedInteger(
    options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
    DEFAULT_MAX_OBJECT_KEYS,
    0,
  ),
  maxDepth: toBoundedInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH, 1),
  locale: options.locale ?? DEFAULT_LOCALE,
});

export const countModelOutputChars = (value: string, locale = DEFAULT_LOCALE): number =>
  segmentGraphemes(value, locale).length;

export const truncateModelOutputText = (
  value: string,
  maxChars: number,
  options: ITruncateModelOutputTextOptions = {},
): ITruncateModelOutputTextResult => {
  const safeMaxChars = Math.max(0, Math.floor(maxChars));
  const graphemes = segmentGraphemes(value, options.locale ?? DEFAULT_LOCALE);
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

  return {
    text: includeNotice
      ? [
        clippedText,
        `[内容已截断：显示前 ${safeMaxChars} / ${originalCharCount} 字符。]`,
      ].filter((line) => line.length > 0).join('\n')
      : clippedText,
    truncated: true,
    originalCharCount,
    omittedCharCount,
  };
};

const toRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const stringifyCompactValue = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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

  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }

  if (
    typeof value === 'undefined'
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
  ) {
    return String(value);
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[内容已省略：检测到循环引用。]';
  }

  if (depth >= options.maxDepth) {
    return '[内容已省略：超过最大结构深度。]';
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, options.maxArrayItems)
        .map((item) => compactValue(item, options, depth + 1, seen));
      const omittedItems = value.length - items.length;

      return omittedItems > 0
        ? [...items, { modelOutputOmittedItems: omittedItems }]
        : items;
    }

    const record = toRecord(value);

    if (!record) {
      return String(value);
    }

    const entries = Object.entries(record);
    const compacted: Record<string, unknown> = {};

    for (const [key, item] of entries.slice(0, options.maxObjectKeys)) {
      compacted[key] = compactValue(item, options, depth + 1, seen);
    }

    const omittedKeys = entries.length - Object.keys(compacted).length;

    if (omittedKeys > 0) {
      compacted.modelOutputOmittedKeys = omittedKeys;
    }

    return compacted;
  } finally {
    seen.delete(value);
  }
};

export const compactModelOutput = (
  value: unknown,
  options: ICompactModelOutputOptions,
): unknown => {
  const resolvedOptions = resolveOptions(options);
  const compacted = compactValue(value, resolvedOptions, 0, new WeakSet<object>());
  const serialized = stringifyCompactValue(compacted);
  const serializedCharCount = countModelOutputChars(serialized, resolvedOptions.locale);

  if (serializedCharCount <= resolvedOptions.maxTotalChars) {
    return compacted;
  }

  return {
    modelOutputTruncated: true,
    serializedCharCount,
    preview: truncateModelOutputText(serialized, resolvedOptions.maxTotalChars, {
      locale: resolvedOptions.locale,
    }).text,
  };
};
