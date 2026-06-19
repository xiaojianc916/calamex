/**
 * Escapes all RegExp special characters in a string so it can be safely used
 * as a literal pattern inside `new RegExp(...)`.
 *
 * Equivalent to Lodash's `_.escapeRegExp` but dependency-free — the character
 * class covers all 12 metacharacters defined in ECMAScript (MDN "Escaping").
 */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
