type TTextPreviewSegmentGranularity = 'grapheme' | 'word' | 'sentence';

type TTextPreviewLocale = string | string[];

interface ITextPreviewSegment {
  segment: string;
  isWordLike?: boolean;
}

interface ITextPreviewSegmenter {
  segment: (input: string) => Iterable<ITextPreviewSegment>;
}

interface ITextPreviewSegmenterConstructor {
  new (
    locale?: string | string[],
    options?: {
      granularity?: TTextPreviewSegmentGranularity;
    },
  ): ITextPreviewSegmenter;
}

interface IClipTextPreviewOptions {
  maxGraphemes?: number;
  locale?: TTextPreviewLocale;
  ellipsis?: string;
}

export interface IPrioritizedPreviewField {
  value: string;
  priority: number;
  label?: string;
  minGraphemes?: number;
  maxGraphemes?: number;
}

interface INormalizedPrioritizedPreviewField extends IPrioritizedPreviewField {
  index: number;
}

interface IFormatPrioritizedFieldPreviewOptions {
  maxFields?: number;
  maxGraphemes?: number;
  separator?: string;
  labelSeparator?: string;
  locale?: TTextPreviewLocale;
  ellipsis?: string;
}

const DEFAULT_MAX_GRAPHEMES = 96;
const DEFAULT_MAX_PREVIEW_FIELDS = 3;
const DEFAULT_FIELD_MIN_GRAPHEMES = 8;
const DEFAULT_FIELD_SEPARATOR = ' · ';
const DEFAULT_LABEL_SEPARATOR = '：';
const DEFAULT_SEGMENT_LOCALE: string[] = ['zh-CN', 'en'];
const ELLIPSIS = '...';
const MIN_SENTENCE_CLIP_USAGE = 0.45;

const intlWithSegmenter = Intl as typeof Intl & {
  Segmenter?: ITextPreviewSegmenterConstructor;
};

const segmenterCache = new Map<string, ITextPreviewSegmenter | null>();
const ellipsisGraphemeCountCache = new Map<string, number>();

// 字素切分在补全候选与活动行预览的热路径上会对相同字符串反复调用（clip、count、
// 语义边界查找等会各自重切一遍同一段文本）。这里用「有界 LRU」缓存
// (locale, value) -> 字素数组：命中直接复用上次结果，避免重复构造 Segmenter
// 迭代或回退扫描。容量上限防止长会话内存无界增长，超限时淘汰最久未访问的键。
const GRAPHEME_SEGMENT_CACHE_LIMIT = 1024;
const graphemeSegmentCache = new Map<string, string[]>();

const touchGraphemeSegmentCache = (cacheKey: string): string[] | undefined => {
  const cached = graphemeSegmentCache.get(cacheKey);
  if (cached === undefined) {
    return undefined;
  }

  // 命中后把该键移到 Map 末尾，让最久未访问的键留在头部以便优先淘汰（LRU）。
  graphemeSegmentCache.delete(cacheKey);
  graphemeSegmentCache.set(cacheKey, cached);
  return cached;
};

const storeGraphemeSegmentCache = (cacheKey: string, segments: string[]): void => {
  graphemeSegmentCache.set(cacheKey, segments);

  while (graphemeSegmentCache.size > GRAPHEME_SEGMENT_CACHE_LIMIT) {
    const oldestKey = graphemeSegmentCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }

    graphemeSegmentCache.delete(oldestKey);
  }
};

const toSafeInteger = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
};

const getEffectiveLocale = (locale?: TTextPreviewLocale): TTextPreviewLocale =>
  locale ?? DEFAULT_SEGMENT_LOCALE;

const getLocaleCacheKey = (locale: TTextPreviewLocale): string =>
  Array.isArray(locale) ? locale.join('\u0001') : locale;

const getSegmenterCacheKey = (
  granularity: TTextPreviewSegmentGranularity,
  locale: TTextPreviewLocale,
): string => `${granularity}\u0000${getLocaleCacheKey(locale)}`;

const getSafePriority = (priority: number): number =>
  Number.isFinite(priority) ? Math.max(1, priority) : 1;

const comparePriorityAsc = (left: number, right: number): number => {
  const safeLeft = getSafePriority(left);
  const safeRight = getSafePriority(right);

  if (safeLeft === safeRight) {
    return 0;
  }

  return safeLeft < safeRight ? -1 : 1;
};

const comparePriorityDesc = (left: number, right: number): number =>
  comparePriorityAsc(right, left);

const createSegmenter = (
  granularity: TTextPreviewSegmentGranularity,
  locale?: TTextPreviewLocale,
): ITextPreviewSegmenter | null => {
  const effectiveLocale = getEffectiveLocale(locale);
  const cacheKey = getSegmenterCacheKey(granularity, effectiveLocale);

  if (segmenterCache.has(cacheKey)) {
    return segmenterCache.get(cacheKey) ?? null;
  }

  if (!intlWithSegmenter.Segmenter) {
    segmenterCache.set(cacheKey, null);
    return null;
  }

  try {
    const segmenter = new intlWithSegmenter.Segmenter(effectiveLocale, { granularity });
    segmenterCache.set(cacheKey, segmenter);
    return segmenter;
  } catch {
    segmenterCache.set(cacheKey, null);
    return null;
  }
};

const ZERO_WIDTH_JOINER = '\u200d';

const isCodePointInRanges = (value: string, ranges: readonly [number, number][]): boolean => {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }

  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
};

const isCombiningMark = (value: string): boolean =>
  isCodePointInRanges(value, [
    [0x0300, 0x036f],
    [0x1ab0, 0x1aff],
    [0x1dc0, 0x1dff],
    [0x20d0, 0x20ff],
    [0xfe20, 0xfe2f],
  ]);

const isVariationSelector = (value: string): boolean =>
  isCodePointInRanges(value, [[0xfe00, 0xfe0f]]);

const isEmojiModifier = (value: string): boolean =>
  isCodePointInRanges(value, [[0x1f3fb, 0x1f3ff]]);

const splitGraphemesFallback = (value: string): string[] => {
  const codePoints = Array.from(value);
  const graphemes: string[] = [];
  let current = '';

  for (const codePoint of codePoints) {
    if (!current) {
      current = codePoint;
      continue;
    }

    if (
      codePoint === ZERO_WIDTH_JOINER ||
      current.endsWith(ZERO_WIDTH_JOINER) ||
      isCombiningMark(codePoint) ||
      isVariationSelector(codePoint) ||
      isEmojiModifier(codePoint)
    ) {
      current += codePoint;
      continue;
    }

    graphemes.push(current);
    current = codePoint;
  }

  if (current) {
    graphemes.push(current);
  }

  return graphemes;
};

const splitSentencesFallback = (value: string): string[] => {
  const segments = value.match(/[^。！？!?；;\n]+[。！？!?；;]?[”’」』）》】〕〉》\]})]*|\n+/gu);
  return segments?.filter(Boolean) ?? [value];
};

const computeSegments = (
  value: string,
  granularity: TTextPreviewSegmentGranularity,
  locale?: TTextPreviewLocale,
): string[] => {
  const segmenter = createSegmenter(granularity, locale);

  if (segmenter) {
    return Array.from(segmenter.segment(value), (segment) => segment.segment);
  }

  if (granularity === 'sentence') {
    return splitSentencesFallback(value);
  }

  if (granularity === 'word') {
    return value.split(/(\s+)/u).filter(Boolean);
  }

  return splitGraphemesFallback(value);
};

const segmentGraphemes = (value: string, locale?: TTextPreviewLocale): string[] => {
  if (!value) {
    return [];
  }

  const cacheKey = `${getLocaleCacheKey(getEffectiveLocale(locale))}\u0000${value}`;
  const cached = touchGraphemeSegmentCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const segments = computeSegments(value, 'grapheme', locale);
  storeGraphemeSegmentCache(cacheKey, segments);
  return segments;
};

const segmentText = (
  value: string,
  granularity: TTextPreviewSegmentGranularity,
  locale?: TTextPreviewLocale,
): string[] =>
  granularity === 'grapheme'
    ? segmentGraphemes(value, locale)
    : computeSegments(value, granularity, locale);

export const splitTextGraphemes = (value: string, locale?: TTextPreviewLocale): string[] => [
  ...segmentText(value, 'grapheme', locale),
];

const normalizePreviewText = (value: string): string =>
  value.normalize('NFC').replace(/\s+/gu, ' ').trim();

const normalizeOptionalPreviewText = (value: string | undefined): string | undefined => {
  const normalized = normalizePreviewText(value ?? '');
  return normalized || undefined;
};

const countSegmentedGraphemes = (value: string, locale?: TTextPreviewLocale): number =>
  segmentText(value, 'grapheme', locale).length;

const countRenderedGraphemes = (value: string, locale?: TTextPreviewLocale): number =>
  countSegmentedGraphemes(value.normalize('NFC'), locale);

const getEllipsisGraphemeCount = (
  ellipsis: string = ELLIPSIS,
  locale?: TTextPreviewLocale,
): number => {
  const cacheKey = `${getLocaleCacheKey(getEffectiveLocale(locale))}\u0000${ellipsis}`;
  const cachedCount = ellipsisGraphemeCountCache.get(cacheKey);

  if (cachedCount !== undefined) {
    return cachedCount;
  }

  const count = countRenderedGraphemes(ellipsis, locale);
  ellipsisGraphemeCountCache.set(cacheKey, count);
  return count;
};

const appendEllipsisWithinBudget = (
  value: string,
  limit: number,
  locale?: TTextPreviewLocale,
  ellipsis: string = ELLIPSIS,
): string => {
  const normalized = normalizePreviewText(value);
  const ellipsisSize = getEllipsisGraphemeCount(ellipsis, locale);

  if (!normalized || limit <= 0) {
    return '';
  }

  if (ellipsisSize <= 0) {
    return segmentText(normalized, 'grapheme', locale).slice(0, limit).join('').trim();
  }

  if (limit <= ellipsisSize) {
    return segmentText(normalized, 'grapheme', locale).slice(0, limit).join('').trim();
  }

  const contentLimit = limit - ellipsisSize;
  const content = segmentText(normalized, 'grapheme', locale)
    .slice(0, contentLimit)
    .join('')
    .trim();

  return content ? `${content}${ellipsis}` : '';
};

const clipBySentenceBoundary = (
  value: string,
  limit: number,
  locale?: TTextPreviewLocale,
): string | null => {
  if (limit <= 0 || !createSegmenter('sentence', locale)) {
    return null;
  }

  const sentences = segmentText(value, 'sentence', locale);
  if (sentences.length <= 1) {
    return null;
  }

  let output = '';
  let used = 0;

  for (const sentence of sentences) {
    const sentenceSize = segmentText(sentence, 'grapheme', locale).length;

    if (used + sentenceSize > limit) {
      break;
    }

    output = `${output}${sentence}`;
    used += sentenceSize;
  }

  const trimmedOutput = output.trim();
  if (!trimmedOutput) {
    return null;
  }

  const minimumUsefulSize = Math.floor(limit * MIN_SENTENCE_CLIP_USAGE);
  return used >= minimumUsefulSize ? trimmedOutput : null;
};

const TRAILING_CLOSER_PATTERN = /^[”’」』）》】〕〉》\]})]+$/u;

const includeTrailingClosers = (
  graphemes: readonly string[],
  boundary: number,
  limit: number,
): number => {
  let nextBoundary = boundary;

  while (
    nextBoundary < limit &&
    nextBoundary < graphemes.length &&
    TRAILING_CLOSER_PATTERN.test(graphemes[nextBoundary] ?? '')
  ) {
    nextBoundary += 1;
  }

  return nextBoundary;
};

const findWordBoundary = (
  value: string,
  limit: number,
  locale?: TTextPreviewLocale,
): number | null => {
  if (limit <= 0) {
    return null;
  }

  const segmenter = createSegmenter('word', locale);

  if (!segmenter) {
    return null;
  }

  let used = 0;
  let boundary = 0;
  const minWordIndex = Math.floor(limit * 0.68);

  for (const segment of segmenter.segment(value)) {
    const segmentSize = segmentText(segment.segment, 'grapheme', locale).length;
    const nextUsed = used + segmentSize;

    if (nextUsed > limit) {
      break;
    }

    used = nextUsed;

    if (used >= minWordIndex) {
      boundary = used;
    }
  }

  return boundary > 0 ? boundary : null;
};

const findSemanticBoundary = (
  value: string,
  limit: number,
  locale?: TTextPreviewLocale,
): number => {
  if (limit <= 0) {
    return 0;
  }

  const graphemes = segmentText(value, 'grapheme', locale);
  const clipped = graphemes.slice(0, limit);
  const preferredBoundaryPattern = /[。！？!?；;]/u;
  const softBoundaryPattern = /[，,、：:\s]/u;
  const minPreferredIndex = Math.floor(limit * 0.45);
  const minSoftIndex = Math.floor(limit * 0.68);

  for (let index = clipped.length - 1; index >= minPreferredIndex; index -= 1) {
    if (preferredBoundaryPattern.test(clipped[index] ?? '')) {
      return includeTrailingClosers(graphemes, index + 1, limit);
    }
  }

  for (let index = clipped.length - 1; index >= minSoftIndex; index -= 1) {
    if (softBoundaryPattern.test(clipped[index] ?? '')) {
      return includeTrailingClosers(graphemes, index + 1, limit);
    }
  }

  const wordBoundary = findWordBoundary(value, limit, locale);
  if (wordBoundary) {
    return includeTrailingClosers(graphemes, wordBoundary, limit);
  }

  return clipped.length;
};

export const clipTextPreview = (value: string, options: IClipTextPreviewOptions = {}): string => {
  const limit = toSafeInteger(options.maxGraphemes ?? DEFAULT_MAX_GRAPHEMES, DEFAULT_MAX_GRAPHEMES);
  const locale = options.locale;
  const ellipsis = options.ellipsis ?? ELLIPSIS;
  const normalized = normalizePreviewText(value);

  if (!normalized || limit <= 0) {
    return '';
  }

  const graphemes = segmentText(normalized, 'grapheme', locale);

  if (graphemes.length <= limit) {
    return normalized;
  }

  const ellipsisSize = getEllipsisGraphemeCount(ellipsis, locale);

  if (ellipsisSize <= 0) {
    return graphemes.slice(0, limit).join('').trim();
  }

  if (limit <= ellipsisSize) {
    return graphemes.slice(0, limit).join('').trim();
  }

  const contentLimit = limit - ellipsisSize;
  const sentenceClip = clipBySentenceBoundary(normalized, contentLimit, locale);

  if (sentenceClip) {
    return appendEllipsisWithinBudget(sentenceClip, limit, locale, ellipsis);
  }

  const boundary = findSemanticBoundary(normalized, contentLimit, locale);
  const clipped = graphemes.slice(0, boundary).join('').trim();
  const fallback = graphemes.slice(0, contentLimit).join('').trim();

  return appendEllipsisWithinBudget(clipped || fallback, limit, locale, ellipsis);
};

const createFieldIdentity = (field: IPrioritizedPreviewField): string =>
  `${normalizePreviewText(field.label ?? '')}\u0000${normalizePreviewText(field.value)}`;

const normalizePrioritizedFields = (
  fields: readonly IPrioritizedPreviewField[],
  maxFields: number,
): INormalizedPrioritizedPreviewField[] => {
  const seen = new Set<string>();
  const safeMaxFields = toSafeInteger(maxFields, DEFAULT_MAX_PREVIEW_FIELDS);

  if (safeMaxFields <= 0) {
    return [];
  }

  return fields
    .map((field, index) => ({
      ...field,
      value: normalizePreviewText(field.value),
      label: normalizeOptionalPreviewText(field.label),
      priority: getSafePriority(field.priority),
      index,
    }))
    .filter((field) => {
      if (!field.value) {
        return false;
      }

      const identity = createFieldIdentity(field);
      if (seen.has(identity)) {
        return false;
      }

      seen.add(identity);
      return true;
    })
    .sort(
      (left, right) =>
        comparePriorityDesc(left.priority, right.priority) || left.index - right.index,
    )
    .slice(0, safeMaxFields);
};

const getFieldPrefix = (field: IPrioritizedPreviewField, labelSeparator: string): string =>
  field.label ? `${field.label}${labelSeparator}` : '';

const getFixedFieldPreviewGraphemes = (
  fields: readonly INormalizedPrioritizedPreviewField[],
  separator: string,
  labelSeparator: string,
  locale?: TTextPreviewLocale,
): number => {
  const separatorSize = Math.max(0, fields.length - 1) * countRenderedGraphemes(separator, locale);

  return fields.reduce(
    (total, field) => total + countRenderedGraphemes(getFieldPrefix(field, labelSeparator), locale),
    separatorSize,
  );
};

const getFieldNeed = (field: IPrioritizedPreviewField, locale?: TTextPreviewLocale): number => {
  const rawNeed = countSegmentedGraphemes(normalizePreviewText(field.value), locale);

  return field.maxGraphemes === undefined
    ? rawNeed
    : Math.min(rawNeed, toSafeInteger(field.maxGraphemes, rawNeed));
};

const getFieldMinBudget = (
  field: IPrioritizedPreviewField,
  locale?: TTextPreviewLocale,
): number => {
  const need = getFieldNeed(field, locale);
  const minBudget = toSafeInteger(
    field.minGraphemes ?? DEFAULT_FIELD_MIN_GRAPHEMES,
    DEFAULT_FIELD_MIN_GRAPHEMES,
  );

  return Math.min(need, minBudget);
};

const getInitialFieldBudget = (
  field: IPrioritizedPreviewField,
  availableBudget: number,
  totalPriority: number,
  locale?: TTextPreviewLocale,
): number => {
  const need = getFieldNeed(field, locale);

  if (availableBudget <= 0 || need <= 0) {
    return 0;
  }

  const weighted = Math.floor((availableBudget * getSafePriority(field.priority)) / totalPriority);
  const minBudget = getFieldMinBudget(field, locale);

  return Math.min(need, Math.max(1, minBudget, weighted));
};

const sumNumbers = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const getMinimumRequiredBudget = (
  fields: readonly INormalizedPrioritizedPreviewField[],
  locale?: TTextPreviewLocale,
): number => fields.reduce((total, field) => total + getFieldMinBudget(field, locale), 0);

const allocateFieldBudgets = (
  fields: readonly INormalizedPrioritizedPreviewField[],
  availableBudget: number,
  locale?: TTextPreviewLocale,
): number[] => {
  const safeAvailableBudget = Math.max(0, Math.floor(availableBudget));

  if (!fields.length) {
    return [];
  }

  if (safeAvailableBudget <= 0) {
    return fields.map(() => 0);
  }

  const priorities = fields.map((field) => getSafePriority(field.priority));
  const totalPriority = Math.max(1, sumNumbers(priorities));
  const needs = fields.map((field) => getFieldNeed(field, locale));
  const budgets = fields.map((field) =>
    getInitialFieldBudget(field, safeAvailableBudget, totalPriority, locale),
  );

  const totalBudget = sumNumbers(budgets);

  if (totalBudget > safeAvailableBudget) {
    // 需要回收的额度：按（优先级升序，下标降序）依次把各字段扣减到 0。
    // 这与旧实现 “每次 -1 并重排” 的逐步结果完全一致，但用一次排序 + 一次遍历完成，
    // 复杂度从 O(B·F·logF) 降到 O(F·logF)。
    let surplus = totalBudget - safeAvailableBudget;
    const reclaimOrder = fields
      .map((field, index) => ({ index, priority: priorities[index] ?? 1 }))
      .sort(
        (left, right) =>
          comparePriorityAsc(left.priority, right.priority) || right.index - left.index,
      );

    for (const { index } of reclaimOrder) {
      if (surplus <= 0) {
        break;
      }

      const reclaimable = Math.min(surplus, budgets[index] ?? 0);
      budgets[index] = (budgets[index] ?? 0) - reclaimable;
      surplus -= reclaimable;
    }
  } else if (totalBudget < safeAvailableBudget) {
    // 需要补足的额度：按（优先级降序，下标升序）依次把各字段补到其 need 上限。
    // 同样与旧的 “每次 +1 并重排” 逐步逼近实现结果一致。
    let deficit = safeAvailableBudget - totalBudget;
    const grantOrder = fields
      .map((field, index) => ({ index, priority: priorities[index] ?? 1 }))
      .sort(
        (left, right) =>
          comparePriorityDesc(left.priority, right.priority) || left.index - right.index,
      );

    for (const { index } of grantOrder) {
      if (deficit <= 0) {
        break;
      }

      const capacity = Math.max(0, (needs[index] ?? 0) - (budgets[index] ?? 0));
      const grantable = Math.min(deficit, capacity);
      budgets[index] = (budgets[index] ?? 0) + grantable;
      deficit -= grantable;
    }
  }

  return budgets.map((budget) => Math.max(0, Math.floor(budget)));
};

const formatValueOnlyPreview = (
  fields: readonly INormalizedPrioritizedPreviewField[],
  maxGraphemes: number,
  separator: string,
  locale?: TTextPreviewLocale,
  ellipsis: string = ELLIPSIS,
): string => {
  let selectedFields = [...fields];

  while (selectedFields.length > 1) {
    const separatorBudget =
      Math.max(0, selectedFields.length - 1) * countRenderedGraphemes(separator, locale);
    const availableBudget = maxGraphemes - separatorBudget;
    const minimumRequiredBudget = getMinimumRequiredBudget(selectedFields, locale);

    if (availableBudget >= minimumRequiredBudget) {
      break;
    }

    selectedFields = selectedFields.slice(0, -1);
  }

  if (!selectedFields.length || maxGraphemes <= 0) {
    return '';
  }

  const separatorBudget =
    Math.max(0, selectedFields.length - 1) * countRenderedGraphemes(separator, locale);
  const availableBudget = Math.max(0, maxGraphemes - separatorBudget);
  const budgets = allocateFieldBudgets(selectedFields, availableBudget, locale);

  const preview = selectedFields
    .map((field, index) =>
      clipTextPreview(field.value, {
        maxGraphemes: budgets[index] ?? DEFAULT_FIELD_MIN_GRAPHEMES,
        locale,
        ellipsis,
      }),
    )
    .join(separator);

  return countRenderedGraphemes(preview, locale) > maxGraphemes
    ? clipTextPreview(preview, { maxGraphemes, locale, ellipsis })
    : preview;
};

export const formatPrioritizedFieldPreview = (
  fields: readonly IPrioritizedPreviewField[],
  options: IFormatPrioritizedFieldPreviewOptions = {},
): string => {
  const maxGraphemes = toSafeInteger(
    options.maxGraphemes ?? DEFAULT_MAX_GRAPHEMES,
    DEFAULT_MAX_GRAPHEMES,
  );
  const separator = options.separator ?? DEFAULT_FIELD_SEPARATOR;
  const labelSeparator = options.labelSeparator ?? DEFAULT_LABEL_SEPARATOR;
  const maxFields = toSafeInteger(
    options.maxFields ?? DEFAULT_MAX_PREVIEW_FIELDS,
    DEFAULT_MAX_PREVIEW_FIELDS,
  );
  const locale = options.locale;
  const ellipsis = options.ellipsis ?? ELLIPSIS;
  let selectedFields = normalizePrioritizedFields(fields, maxFields);

  if (maxGraphemes <= 0 || !selectedFields.length) {
    return '';
  }

  while (selectedFields.length > 1) {
    const fixedBudget = getFixedFieldPreviewGraphemes(
      selectedFields,
      separator,
      labelSeparator,
      locale,
    );
    const availableBudget = maxGraphemes - fixedBudget;
    const minimumRequiredBudget = getMinimumRequiredBudget(selectedFields, locale);

    if (availableBudget >= minimumRequiredBudget) {
      break;
    }

    selectedFields = selectedFields.slice(0, -1);
  }

  if (!selectedFields.length) {
    return '';
  }

  const fixedBudget = getFixedFieldPreviewGraphemes(
    selectedFields,
    separator,
    labelSeparator,
    locale,
  );

  if (fixedBudget >= maxGraphemes) {
    return formatValueOnlyPreview(selectedFields, maxGraphemes, separator, locale, ellipsis);
  }

  const availableBudget = Math.max(0, maxGraphemes - fixedBudget);
  const budgets = allocateFieldBudgets(selectedFields, availableBudget, locale);

  const preview = selectedFields
    .map((field, index) => {
      const prefix = getFieldPrefix(field, labelSeparator);
      const budget = budgets[index] ?? DEFAULT_FIELD_MIN_GRAPHEMES;

      return `${prefix}${clipTextPreview(field.value, { maxGraphemes: budget, locale, ellipsis })}`;
    })
    .join(separator);

  return countRenderedGraphemes(preview, locale) > maxGraphemes
    ? clipTextPreview(preview, { maxGraphemes, locale, ellipsis })
    : preview;
};
