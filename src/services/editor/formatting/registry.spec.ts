import { describe, expect, it } from 'vitest';
import { resolveFormatter } from './registry';
import { shfmtFormatter } from './shfmt-formatter';

describe('resolveFormatter', () => {
  it('resolves shfmt for shell', () => {
    expect(resolveFormatter('shell')).toBe(shfmtFormatter);
  });

  it('returns null for languages without a dedicated formatter', () => {
    expect(resolveFormatter('typescript')).toBeNull();
    expect(resolveFormatter('plaintext')).toBeNull();
  });
});
