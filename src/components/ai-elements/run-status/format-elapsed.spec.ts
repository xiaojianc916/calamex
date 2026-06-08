import { describe, expect, it } from 'vitest';

import { formatElapsedCompact } from './format-elapsed';

describe('formatElapsedCompact', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatElapsedCompact(0)).toBe('0s');
    expect(formatElapsedCompact(1)).toBe('1s');
    expect(formatElapsedCompact(59)).toBe('59s');
  });

  it('formats minute durations with zero-padded seconds', () => {
    expect(formatElapsedCompact(60)).toBe('1m 00s');
    expect(formatElapsedCompact(61)).toBe('1m 01s');
    expect(formatElapsedCompact(3 * 60 + 5)).toBe('3m 05s');
    expect(formatElapsedCompact(59 * 60 + 59)).toBe('59m 59s');
  });

  it('formats hour durations with zero-padded minutes and seconds', () => {
    expect(formatElapsedCompact(3600)).toBe('1h 00m 00s');
    expect(formatElapsedCompact(3600 + 60 + 1)).toBe('1h 01m 01s');
    expect(formatElapsedCompact(25 * 3600 + 2 * 60 + 3)).toBe('25h 02m 03s');
  });

  it('guards against negative and non-finite inputs', () => {
    expect(formatElapsedCompact(-5)).toBe('0s');
    expect(formatElapsedCompact(Number.NaN)).toBe('0s');
    expect(formatElapsedCompact(Number.POSITIVE_INFINITY)).toBe('0s');
  });

  it('truncates fractional seconds', () => {
    expect(formatElapsedCompact(61.9)).toBe('1m 01s');
  });
});
