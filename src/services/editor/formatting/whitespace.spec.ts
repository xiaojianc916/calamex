import { describe, expect, it } from 'vitest';
import {
  applyFinalNewline,
  applyWhitespaceConventions,
  normalizeLineEndings,
  trimTrailingWhitespace,
} from './whitespace';

describe('normalizeLineEndings', () => {
  it('converts CRLF and lone CR to LF', () => {
    expect(normalizeLineEndings('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});

describe('trimTrailingWhitespace', () => {
  it('removes trailing spaces and tabs per line', () => {
    expect(trimTrailingWhitespace('a \t\nb\t \nc')).toBe('a\nb\nc');
  });
});

describe('applyFinalNewline', () => {
  it('ensures a single trailing newline when enabled', () => {
    expect(applyFinalNewline('a\n\n', true)).toBe('a\n');
    expect(applyFinalNewline('a', true)).toBe('a\n');
  });

  it('keeps empty content empty when enabled', () => {
    expect(applyFinalNewline('', true)).toBe('');
  });

  it('strips trailing newlines when disabled', () => {
    expect(applyFinalNewline('a\n\n', false)).toBe('a');
  });
});

describe('applyWhitespaceConventions', () => {
  it('matches the legacy save-normalization behavior', () => {
    const input = 'a \r\n\tb  \r\n\n';
    expect(
      applyWhitespaceConventions(input, {
        trimTrailingWhitespace: true,
        insertFinalNewline: true,
      }),
    ).toBe('a\n\tb\n');
  });

  it('honors disabled toggles', () => {
    const input = 'a  \nb  ';
    expect(
      applyWhitespaceConventions(input, {
        trimTrailingWhitespace: false,
        insertFinalNewline: false,
      }),
    ).toBe('a  \nb  ');
  });
});
