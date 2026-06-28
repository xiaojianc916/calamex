import { createTool } from '@mastra/core/tools';

import {
  NANOSECONDS_PER_MINUTE,
  convertTimeOutputSchema,
  createTimeSnapshot,
  formatTimeDifference,
  looseModelToolInputSchema,
  parseClockTime,
  parseConvertTimeInput,
  parseIsoDate,
  resolveTimezone,
  type IMastraTimeToolContext,
} from './shared.js';

const convertTimeDescription = [
  'Convert a wall-clock time between timezones. If a timezone is omitted, use the local timezone.',
  'If "date" is omitted, the conversion uses today in the source timezone.',
  '',
  'Examples:',
  '  { "source_timezone": "Asia/Shanghai", "time": "18:30", "target_timezone": "America/New_York" }',
  '  { "source_timezone": "America/New_York", "time": "09:00", "target_timezone": "Europe/London" }',
  '  { "source_timezone": "Asia/Shanghai", "time": "02:00", "date": "2026-05-20", "target_timezone": "America/New_York" }',
].join('\n');

export const createConvertTimeTool = (
  context: IMastraTimeToolContext,
): ReturnType<typeof createTool> =>
  createTool({
    id: 'convert_time',
    description: convertTimeDescription,
    inputSchema: looseModelToolInputSchema,
    outputSchema: convertTimeOutputSchema,
    execute: async (inputData) => {
      const { source_timezone, time, date, target_timezone } = parseConvertTimeInput(inputData);
      const sourceTimezone = resolveTimezone(source_timezone, context.localTimezone);
      const targetTimezone = resolveTimezone(target_timezone, context.localTimezone);
      const parsedTime = parseClockTime(time);
      const baseDate = date
        ? parseIsoDate(date)
        : (() => {
          const todayInSource = context.currentZonedDateTime(sourceTimezone).toPlainDate();
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
  });
