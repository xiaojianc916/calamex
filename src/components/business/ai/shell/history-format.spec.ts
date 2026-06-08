import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatHistoryClockTime, formatHistoryTimestamp } from './history-format';

describe('formatHistoryClockTime', () => {
  it('返回 HH:mm 格式', () => {
    expect(formatHistoryClockTime('2026-06-09T03:00:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
  });

  it('无法解析时返回“刚刚”', () => {
    expect(formatHistoryClockTime('not-a-date')).toBe('刚刚');
  });
});

describe('formatHistoryTimestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一天显示“今天”', () => {
    expect(formatHistoryTimestamp('2026-06-09T03:00:00.000Z')).toMatch(/^今天 /);
  });

  it('前一天显示“昨天”', () => {
    expect(formatHistoryTimestamp('2026-06-08T03:00:00.000Z')).toMatch(/^昨天 /);
  });

  it('同年更早显示月日', () => {
    expect(formatHistoryTimestamp('2026-01-02T03:00:00.000Z')).toMatch(/\d{2}\/\d{2}/);
  });

  it('跨年显示完整日期', () => {
    expect(formatHistoryTimestamp('2024-01-02T03:00:00.000Z')).toMatch(/2024/);
  });

  it('无法解析时返回“刚刚”', () => {
    expect(formatHistoryTimestamp('nope')).toBe('刚刚');
  });
});
