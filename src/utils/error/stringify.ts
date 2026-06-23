/**
 * Serialize any value to string for error display.
 * [round3] stringify: extracted from error-presentation.ts and runtime-diagnostics.ts.
 */
export const stringifyErrorDetail = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
