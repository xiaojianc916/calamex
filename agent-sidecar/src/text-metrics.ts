/**
 * Shared character/token measurement helpers.
 *
 * These pure, dependency-free functions estimate code-point counts and a
 * rough input-token budget from text. They are shared by the budget
 * accounting (engines/budget) and the DeepSeek reasoning telemetry
 * (models/providers) so there is a single implementation.
 */

/** Count Unicode code points (not UTF-16 code units) in a string. */
export const countTextChars = (value: string): number => Array.from(value).length;

/** JSON.stringify that never throws; returns '' on failure or undefined. */
export const stringifyForJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

/** Code-point length of a value's JSON serialization. */
export const countJsonChars = (value: unknown): number => countTextChars(stringifyForJson(value));

/**
 * Rough input-token estimate from raw text. Contiguous ASCII runs are counted
 * at ~4 chars/token; every non-ASCII code point counts as one token. The
 * result is always >= 1.
 */
export const estimateInputTokensByChars = (value: string): number => {
  let asciiRunLength = 0;
  let tokens = 0;

  for (const char of Array.from(value)) {
    const codePoint = char.codePointAt(0) ?? 0;

    if (codePoint <= 0x7f) {
      asciiRunLength += 1;
      continue;
    }

    if (asciiRunLength > 0) {
      tokens += Math.ceil(asciiRunLength / 4);
      asciiRunLength = 0;
    }

    tokens += 1;
  }

  if (asciiRunLength > 0) {
    tokens += Math.ceil(asciiRunLength / 4);
  }

  return Math.max(tokens, 1);
};
