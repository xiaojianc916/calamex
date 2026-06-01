/**
 * Shared character/token measurement helpers.
 *
 * These pure, dependency-free functions estimate code-point counts and a
 * rough input-token budget from text. They are shared by the budget
 * accounting (engines/budget) and the DeepSeek reasoning telemetry
 * (models/providers) so there is a single implementation.
 */

/**
 * Count Unicode code points (not UTF-16 code units) in a string.
 *
 * Behaviorally equivalent to `Array.from(value).length`, but allocation-free:
 * these helpers run on every outbound model request over the full request body
 * (message history + tool schemas), so materializing an array of every code
 * point purely to count it is wasteful. We walk the UTF-16 code units and
 * collapse each well-formed high+low surrogate pair into a single count; lone
 * surrogates are counted individually, matching the string iterator.
 */
export const countTextChars = (value: string): number => {
  let count = 0;
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    count += 1;
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      }
    }
  }
  return count;
};

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
 *
 * Iterates the string's code points directly via `for...of` (same iteration
 * semantics as `Array.from`) instead of building an intermediate array, so the
 * cost stays proportional to the text length without the extra allocation.
 */
export const estimateInputTokensByChars = (value: string): number => {
  let asciiRunLength = 0;
  let tokens = 0;

  for (const char of value) {
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
