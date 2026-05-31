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

const weekdayFormatterCache = new Map<string, Intl.DateTimeFormat>();

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

const NANOSECONDS_PER_MINUTE = 60_000_000_000;

const formatZonedDateTime = (zonedDateTime: Temporal.ZonedDateTime): string =>
  zonedDateTime.toString({ smallestUnit: 'second', timeZoneName: 'never' });

const isDaylightSavingTime = (zonedDateTime: Temporal.ZonedDateTime): boolean => {
  const timezone = zonedDateTime.timeZoneId;
  const januaryOffset = Temporal.ZonedDateTime
    .from({ timeZone: timezone, year: zonedDateTime.year, month: 1, day: 1, hour: 12 })
    .offsetNanoseconds;
  const julyOffset = Temporal.ZonedDateTime
    .from({ timeZone: timezone, year: zonedDateTime.year, month: 7, day: 1, hour: 12 })
    .offsetNanoseconds;
  if (januaryOffset === julyOffset) {
    return false;
  }
  return zonedDateTime.offsetNanoseconds === Math.max(januaryOffset, julyOffset);
};

const createTimeSnapshot = (zonedDateTime: Temporal.ZonedDateTime): TTimeSnapshot => ({
  timezone: zonedDateTime.timeZoneId,
  datetime: formatZonedDateTime(zonedDateTime),
  day_of_week: createWeekdayFormatter(zonedDateTime.timeZoneId).format(new Date(zonedDateTime.epochMilliseconds)),
  is_dst: isDaylightSavingTime(zonedDateTime),
  unix_epoch_ms: zonedDateTime.epochMilliseconds,
});

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
  const currentZonedDateTime = (timezone: string): Temporal.ZonedDateTime =>
    Temporal.Instant.fromEpochMilliseconds(now().getTime()).toZonedDateTimeISO(timezone);
  return {
    get_current_time: createTool({
      id: 'get_current_time',
      description: getCurrentTimeDescription,
      inputSchema: looseModelToolInputSchema,
      outputSchema: timeSnapshotSchema,
      execute: async (inputData) => {
        const { timezone } = parseCurrentTimeInput(inputData);
        return createTimeSnapshot(currentZonedDateTime(resolveTimezone(timezone, localTimezone)));
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
        const baseDate = date
          ? parseIsoDate(date)
          : (() => {
            const todayInSource = currentZonedDateTime(sourceTimezone).toPlainDate();
            return { year: todayInSource.year, month: todayInSource.month, day: todayInSource.day };
          })();
        const sourcePlainDateTime = Temporal.PlainDateTime.from({
          year: baseDate.year,
          month: baseDate.month,
          day: baseDate.day,
          hour: parsedTime.hour,
          minute: parsedTime.minute,
          second: parsedTime.second,
        });
        // disambiguation 默认 'compatible'：fall-back 重叠取较早的有效瞬间；
        // spring-forward 跳过的本地时间会被前移，据此判定其不存在。
        const sourceZonedDateTime = sourcePlainDateTime.toZonedDateTime(sourceTimezone);
        if (!sourceZonedDateTime.toPlainDateTime().equals(sourcePlainDateTime)) {
          const formatted = `${String(baseDate.year).padStart(4, '0')}-${String(baseDate.month).padStart(2, '0')}-${String(baseDate.day).padStart(2, '0')} ${String(parsedTime.hour).padStart(2, '0')}:${String(parsedTime.minute).padStart(2, '0')}`;
          throw new Error(`${sourceTimezone} 的本地时间 ${formatted} 不存在（夏令时切换跳过的 1 小时）。`);
        }
        const targetZonedDateTime = sourceZonedDateTime.withTimeZone(targetTimezone);
        const source = createTimeSnapshot(sourceZonedDateTime);
        const target = createTimeSnapshot(targetZonedDateTime);
        const timeDifferenceMinutes = Math.round(
          (targetZonedDateTime.offsetNanoseconds - sourceZonedDateTime.offsetNanoseconds) / NANOSECONDS_PER_MINUTE,
        );
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
