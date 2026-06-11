import { describe, expect, it, vi } from 'vitest';
import { createExternalFormatter } from './external-formatter';
import type { IFormatterInput } from './types';

describe('externalFormatter', () => {
  it('supports backend external languages but not shell or plaintext', () => {
    const formatter = createExternalFormatter(async ({ text }) => text);

    expect(formatter.supports('typescript')).toBe(true);
    expect(formatter.supports('json')).toBe(true);
    expect(formatter.supports('rust')).toBe(true);
    expect(formatter.supports('python')).toBe(true);
    // shell 由 WASM shfmt 处理，External 不声明 shell。
    expect(formatter.supports('shell')).toBe(false);
    expect(formatter.supports('plaintext')).toBe(false);
  });

  it('delegates to the injected backend port and returns formatted content', async () => {
    const port = vi.fn(async (_input: IFormatterInput) => 'FORMATTED');
    const formatter = createExternalFormatter(port);

    const output = await formatter.format({
      text: 'raw',
      path: '/tmp/a.ts',
      languageId: 'typescript',
    });

    expect(output).toBe('FORMATTED');
    expect(port).toHaveBeenCalledWith({
      text: 'raw',
      path: '/tmp/a.ts',
      languageId: 'typescript',
    });
  });

  it('propagates backend errors so the pipeline can tolerate failures', async () => {
    const formatter = createExternalFormatter(async () => {
      throw new Error('boom');
    });

    await expect(formatter.format({ text: 'x', path: null, languageId: 'go' })).rejects.toThrow(
      'boom',
    );
  });
});
