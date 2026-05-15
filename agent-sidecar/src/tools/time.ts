import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const resolveSystemTimezone = (): string => {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return resolved && resolved.length > 0 ? resolved : 'UTC';
  } catch {
    return 'UTC';
  }
};

export const DEFAULT_LOCAL_TIMEZONE = resolveSystemTimezone();

const looseModelToolInputSchema = z.object({}).passthrough();

const currentTimeBaseInputSchema = z.object({
  timezone: z.string()
    .optional()
    .describe('IANA timezone name. If omitted, use the local timezone.'),
});

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const convertTimeBaseInputSchema = z.object({
  source_timezone: z.string()
    .optional()
    .describe('Source IANA timezone name. If omitted, use the local timezone.'),
  time: z.string()
    .describe('Time to convert in 24-hour format (HH:MM or HH:MM:SS).'),
  date: z.string()
    .regex(ISO_DATE_PATTERN, 'date must be YYYY-MM-DD')
    .optional()
    .describe('Optional YYYY-MM-DD in the source timezone. Defaults to today in the source timezone.'),
  target_timezone: z.string()
    .optional()
    .describe('Target IANA timezone name. If omitted, use the local timezone.'),
});

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unwrapModelToolInput = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return {};
  }
  if (!isObjectRecord(value)) {
    return value;
  }
  const nestedInput = value.input;
  const nestedArguments = value.arguments;
  if (isObjectRecord(nestedInput)) {
    return nestedInput;
  }
  if (isObjectRecord(nestedArguments)) {
    return nestedArguments;
  }
  return value;
};

const removeNullishFields = (
  value: unknown,
  fields: readonly string[],
): unknown => {
  if (!isObjectRecord(value)) {
    return value;
  }
  let normalized: Record<string, unknown> | null = null;
  for (const field of fields) {
    if (value[field] !== null && value[field] !== undefined) {
      continue;
    }
    normalized ??= { ...value };
    delete normalized[field];
  }
  return normalized ?? value;
};

const currentTimeNormalizedInputSchema = z.preprocess(
  (value) => removeNullishFields(unwrapModelToolInput(value), ['timezone']),
  currentTimeBaseInputSchema,
);

const convertTimeNormalizedInputSchema = z.preprocess(
  (value) => removeNullishFields(unwrapModelToolInput(value), ['source_timezone', 'target_timezone', 'date']),
  convertTimeBaseInputSchema,
);

const timeSnapshotSchema = z.object({
  timezone: z.string(),
  datetime: z.string(),
  day_of_week: z.string(),
  is_dst: z.boolean(),
  unix_epoch_ms: z.number(),
});

const convertTimeOutputSchema = z.object({
  source: timeSnapshotSchema,
  target: timeSnapshotSchema,
  time_difference: z.string(),
  time_difference_minutes: z.number(),
});

type TTimeSnapshot = z.infer<typeof timeSnapshotSchema>;
type TCurrentTimeInput = z.infer<typeof currentTimeBaseInputSchema>;
type TConvertTimeInput = z.infer<typeof convertTimeBaseInputSchema>;

interface IDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface IParsedClockTime {
  hour: number;
  minute: number;
  second: number;
}

export interface IMastraTimeToolOptions {
  now?: () => Date;
  localTimezone?: string;
}

const normalizeUnicodeText = (value: string): string => value.normalize('NFKC').trim();

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatterCache = new Map<string, Intl.DateTimeFormat>();

const createDateTimeFormatter = (timezone: string): Intl.DateTimeFormat => {
  const cached = dateTimeFormatterCache.get(timezone);
  if (cached) {
    return cached;
  }
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  dateTimeFormatterCache.set(timezone, created);
  return created;
};

const createWeekdayFormatter = (timezone: string): Intl.DateTimeFormat => {
  const cached = weekdayFormatterCache.get(timezone);
  if (cached) {
    return cached;
  }
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  });
  weekdayFormatterCache.set(timezone, created);
  return created;
};

const validateTimezone = (value: string): string => {
  const normalized = normalizeUnicodeText(value);
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: normalized }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`无效时区：${value}`);
  }
};

const resolveLocalTimezone = (configuredTimezone?: string): string => {
  const normalized = configuredTimezone ? normalizeUnicodeText(configuredTimezone) : '';
  if (!normalized) {
    return DEFAULT_LOCAL_TIMEZONE;
  }
  try {
    return validateTimezone(normalized);
  } catch {
    return DEFAULT_LOCAL_TIMEZONE;
  }
};

const resolveTimezone = (value: string | undefined, fallbackTimezone: string): string => {
  const normalized = value ? normalizeUnicodeText(value) : '';
  return normalized ? validateTimezone(normalized) : fallbackTimezone;
};

const parseCurrentTimeInput = (value: unknown): TCurrentTimeInput => currentTimeNormalizedInputSchema.parse(value);
const parseConvertTimeInput = (value: unknown): TConvertTimeInput => convertTimeNormalizedInputSchema.parse(value);

const getDateTimeParts = (date: Date, timezone: string): IDateTimeParts => {
  const parts = createDateTimeFormatter(timezone).formatToParts(date);
  const values: Partial<IDateTimeParts> = {};
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day'
      || part.type === 'hour' || part.type === 'minute' || part.type === 'second') {
      values[part.type] = Number(part.value);
    }
  }
  if (
    values.year === undefined
    || values.month === undefined
    || values.day === undefined
    || values.hour === undefined
    || values.minute === undefined
    || values.second === undefined
  ) {
    throw new Error(`无法读取时区 ${timezone} 的日期时间。`);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
};

const getTimezoneOffsetMinutes = (date: Date, timezone: string): number => {
  const parts = getDateTimeParts(date, timezone);
  const zonedTimestamp = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((zonedTimestamp - date.getTime()) / 60_000);
};

const formatTimezoneOffset = (offsetMinutes: number): string => {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const isDaylightSavingTime = (date: Date, timezone: string): boolean => {
  const zoned = getDateTimeParts(date, timezone);
  const januaryOffset = getTimezoneOffsetMinutes(
    new Date(Date.UTC(zoned.year, 0, 1, 12, 0, 0)),
    timezone,
  );
  const julyOffset = getTimezoneOffsetMinutes(
    new Date(Date.UTC(zoned.year, 6, 1, 12, 0, 0)),
    timezone,
  );
  if (januaryOffset === julyOffset) {
    return false;
  }
  const currentOffset = getTimezoneOffsetMinutes(date, timezone);
  return currentOffset === Math.max(januaryOffset, julyOffset);
};

const createTimeSnapshot = (date: Date, timezone: string): TTimeSnapshot => {
  const parts = getDateTimeParts(date, timezone);
  const offsetMinutes = getTimezoneOffsetMinutes(date, timezone);
  return {
    timezone,
    datetime: `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}${formatTimezoneOffset(offsetMinutes)}`,
    day_of_week: createWeekdayFormatter(timezone).format(date),
    is_dst: isDaylightSavingTime(date, timezone),
    unix_epoch_ms: date.getTime(),
  };
};

const parseClockTime = (value: string): IParsedClockTime => {
  const normalized = normalizeUnicodeText(value);
  const matched = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
  if (!matched) {
    throw new Error('时间格式无效：请使用 24 小时制 HH:MM 或 HH:MM:SS。');
  }
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  const second = Number(matched[3] ?? '0');
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error('时间超出有效范围：小时需在 00-23，分钟和秒需在 00-59。');
  }
  return {
    hour,
    minute,
    second,
  };
};

interface IParsedIsoDate {
  year: number;
  month: number;
  day: number;
}

const parseIsoDate = (value: string): IParsedIsoDate => {
  const normalized = normalizeUnicodeText(value);
  const matched = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!matched) {
    throw new Error('日期格式无效：请使用 YYYY-MM-DD。');
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('日期超出有效范围：月份 01-12，日 01-31。');
  }
  // 用 UTC 校验真实存在的日历日（如 2 月 30 日 → 拒绝）
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`日期不存在：${value}。`);
  }
  return { year, month, day };
};

const createUtcTimestampFromParts = (parts: IDateTimeParts): number => Date.UTC(
  parts.year,
  parts.month - 1,
  parts.day,
  parts.hour,
  parts.minute,
  parts.second,
);

const hasSameDateTimeParts = (left: IDateTimeParts, right: IDateTimeParts): boolean => (
  left.year === right.year
  && left.month === right.month
  && left.day === right.day
  && left.hour === right.hour
  && left.minute === right.minute
  && left.second === right.second
);

const zonedDateTimeToDate = (parts: IDateTimeParts, timezone: string): Date => {
  let candidateTimestamp = createUtcTimestampFromParts(parts);
  let lastGapMinutes = 0;
  for (let index = 0; index < 4; index += 1) {
    const candidate = new Date(candidateTimestamp);
    const candidateParts = getDateTimeParts(candidate, timezone);
    if (hasSameDateTimeParts(candidateParts, parts)) {
      return candidate;
    }
    const deltaMs = createUtcTimestampFromParts(parts) - createUtcTimestampFromParts(candidateParts);
    lastGapMinutes = Math.round(deltaMs / 60_000);
    candidateTimestamp += deltaMs;
  }
  const finalCandidate = new Date(candidateTimestamp);
  if (!hasSameDateTimeParts(getDateTimeParts(finalCandidate, timezone), parts)) {
    // 不存在的本地时间通常是 DST spring-forward 跳过的 1 小时
    const isLikelySpringForwardGap = Math.abs(lastGapMinutes) === 60;
    const formatted = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    if (isLikelySpringForwardGap) {
      throw new Error(`${timezone} 的本地时间 ${formatted} 不存在（夏令时切换跳过的 1 小时）。`);
    }
    throw new Error(`无法解析 ${timezone} 中的本地时间 ${formatted}。`);
  }
  return finalCandidate;
};

const formatTimeDifference = (offsetMinutes: number): string => {
  if (offsetMinutes === 0) {
    return '0h';
  }
  const decimals = offsetMinutes % 60 === 0 || offsetMinutes % 30 === 0 ? 1 : 2;
  const hours = offsetMinutes / 60;
  const sign = hours >= 0 ? '+' : '';
  return `${sign}${hours.toFixed(decimals)}h`;
};

const getCurrentTimeDescription = [
  'Get current time in a timezone. If the user does not specify one, use the local timezone.',
  '',
  'Examples:',
  '  {}                              → current time in local timezone',
  '  { "timezone": "Asia/Shanghai" } → current time in Shanghai',
  '  { "timezone": "America/New_York" } → current time in New York',
].join('\n');

const convertTimeDescription = [
  'Convert a wall-clock time between timezones. If a timezone is omitted, use the local timezone.',
  'If "date" is omitted, the conversion uses today in the source timezone.',
  '',
  'Examples:',
  '  { "source_timezone": "Asia/Shanghai", "time": "18:30", "target_timezone": "America/New_York" }',
  '  { "source_timezone": "America/New_York", "time": "09:00", "target_timezone": "Europe/London" }',
  '  { "source_timezone": "Asia/Shanghai", "time": "02:00", "date": "2026-05-20", "target_timezone": "America/New_York" }',
].join('\n');

export const createMastraTimeTools = (
  options: IMastraTimeToolOptions = {},
): Record<'get_current_time' | 'convert_time', ReturnType<typeof createTool>> => {
  const now = options.now ?? (() => new Date());
  const localTimezone = resolveLocalTimezone(options.localTimezone ?? process.env.AGENT_MCP_LOCAL_TIMEZONE);
  return {
    get_current_time: createTool({
      id: 'get_current_time',
      description: getCurrentTimeDescription,
      inputSchema: looseModelToolInputSchema,
      outputSchema: timeSnapshotSchema,
      execute: async (inputData) => {
        const { timezone } = parseCurrentTimeInput(inputData);
        return createTimeSnapshot(
          now(),
          resolveTimezone(timezone, localTimezone),
        );
      },
    }),
    convert_time: createTool({
      id: 'convert_time',
      description: convertTimeDescription,
      inputSchema: looseModelToolInputSchema,
      outputSchema: convertTimeOutputSchema,
      execute: async (inputData) => {
        const { source_timezone, time, date, target_timezone } = parseConvertTimeInput(inputData);
        const sourceTimezone = resolveTimezone(source_timezone, localTimezone);
        const targetTimezone = resolveTimezone(target_timezone, localTimezone);
        const parsedTime = parseClockTime(time);
        const baseDateParts = date
          ? parseIsoDate(date)
          : (() => {
            const todayInSource = getDateTimeParts(now(), sourceTimezone);
            return { year: todayInSource.year, month: todayInSource.month, day: todayInSource.day };
          })();
        const sourceDate = zonedDateTimeToDate({
          year: baseDateParts.year,
          month: baseDateParts.month,
          day: baseDateParts.day,
          hour: parsedTime.hour,
          minute: parsedTime.minute,
          second: parsedTime.second,
        }, sourceTimezone);
        const source = createTimeSnapshot(sourceDate, sourceTimezone);
        const target = createTimeSnapshot(sourceDate, targetTimezone);
        const timeDifferenceMinutes = getTimezoneOffsetMinutes(sourceDate, targetTimezone) - getTimezoneOffsetMinutes(sourceDate, sourceTimezone);
        return {
          source,
          target,
          time_difference: formatTimeDifference(timeDifferenceMinutes),
          time_difference_minutes: timeDifferenceMinutes,
        };
      },
    }),
  };
};