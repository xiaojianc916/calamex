/**
 * Shared character/token measurement helpers.
 *
 * These pure, dependency-free functions estimate code-point counts and a
 * rough input-token budget from text. They are shared by the budget
 * accounting (engines/budget) and the DeepSeek reasoning telemetry
 * (models/providers) so there is a single implementation.
 *
 * They run on every outbound model request over the full request body
 * (message history + tool schemas, often hundreds of KB), so they avoid
 * intermediate allocations: the walks use `charCodeAt` over UTF-16 code units
 * and never materialize per-character strings or arrays.
 */

/**
 * Count Unicode code points (not UTF-16 code units) in a string.
 *
 * Behaviorally equivalent to `Array.from(value).length`, but allocation-free.
 * We walk the UTF-16 code units and collapse each well-formed high+low
 * surrogate pair into a single count; lone surrogates are counted
 * individually, matching the string iterator.
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

/**
 * Single-pass measurement of a string's code-point count *and* a rough
 * input-token estimate.
 *
 * `charCount` is identical to `countTextChars(value)`. `tokenEstimate` matches
 * the legacy per-code-point estimator: contiguous ASCII runs are counted at
 * ~4 chars/token, every non-ASCII code point counts as one token, floored at 1.
 *
 * Computing both in one allocation-free `charCodeAt` walk avoids scanning the
 * (large) request body twice and avoids the per-code-point string allocations
 * that a `for...of` iteration incurs.
 */
export const measureText = (
  value: string,
): { charCount: number; tokenEstimate: number } => {
  let charCount = 0;
  let asciiRunLength = 0;
  let tokens = 0;
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    charCount += 1;
    const code = value.charCodeAt(index);
    // Collapse a well-formed surrogate pair into a single code point so the
    // counts match the string iterator's notion of "characters".
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      }
    }
    if (code <= 0x7f) {
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
  return { charCount, tokenEstimate: Math.max(tokens, 1) };
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
 * Rough input-token estimate from raw text. Thin wrapper over {@link measureText}
 * so the estimation logic lives in exactly one place.
 */
export const estimateInputTokensByChars = (value: string): number => measureText(value).tokenEstimate;
