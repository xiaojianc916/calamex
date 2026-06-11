import { describe, expect, it } from 'vitest';
import { externalFormatter } from './external-formatter';
import { resolveFormatter } from './registry';
import { shfmtFormatter } from './shfmt-formatter';

describe('resolveFormatter', () => {
  it('resolves shfmt for shell (WASM, ahead of External)', () => {
    expect(resolveFormatter('shell')).toBe(shfmtFormatter);
  });

  it('resolves the External formatter for backend-supported languages', () => {
    expect(resolveFormatter('typescript')).toBe(externalFormatter);
    expect(resolveFormatter('json')).toBe(externalFormatter);
    expect(resolveFormatter('rust')).toBe(externalFormatter);
  });

  it('returns null for languages without a dedicated formatter', () => {
    expect(resolveFormatter('plaintext')).toBeNull();
  });
});
