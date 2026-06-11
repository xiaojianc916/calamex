import { describe, expect, it } from 'vitest';
import { runFormatPipeline } from './pipeline';
import type { IFormatter } from './types';

const makeFormatter = (
  impl: (text: string) => Promise<string> | string,
  supportedLanguageId = 'shell',
): IFormatter => ({
  id: 'test',
  supports: (languageId) => languageId === supportedLanguageId,
  format: async ({ text }) => impl(text),
});

describe('runFormatPipeline', () => {
  it('returns changed when the formatter rewrites the text', async () => {
    const result = await runFormatPipeline({
      text: 'echo hi',
      path: 'a.sh',
      languageId: 'shell',
      trigger: 'manual',
      formatter: makeFormatter(() => 'echo hi\n'),
      whitespace: null,
    });
    expect(result).toEqual({
      kind: 'changed',
      text: 'echo hi\n',
      formatterFailed: false,
      formatterError: undefined,
    });
  });

  it('returns unchanged when nothing changes', async () => {
    const result = await runFormatPipeline({
      text: 'echo hi\n',
      path: 'a.sh',
      languageId: 'shell',
      trigger: 'manual',
      formatter: makeFormatter((text) => text),
      whitespace: null,
    });
    expect(result.kind).toBe('unchanged');
    expect(result.formatterFailed).toBe(false);
  });

  it('is failure tolerant: a formatter error still applies whitespace', async () => {
    const result = await runFormatPipeline({
      text: 'echo hi  \r\n',
      path: 'a.sh',
      languageId: 'shell',
      trigger: 'save',
      formatter: makeFormatter(() => {
        throw new Error('syntax error');
      }),
      whitespace: { trimTrailingWhitespace: true, insertFinalNewline: true },
    });
    expect(result).toEqual({
      kind: 'changed',
      text: 'echo hi\n',
      formatterFailed: true,
      formatterError: 'syntax error',
    });
  });

  it('skips a formatter that does not support the language', async () => {
    const result = await runFormatPipeline({
      text: 'plain text',
      path: 'a.txt',
      languageId: 'plaintext',
      trigger: 'manual',
      formatter: makeFormatter(() => 'SHOULD NOT RUN', 'shell'),
      whitespace: null,
    });
    expect(result.kind).toBe('unchanged');
    expect(result.formatterFailed).toBe(false);
  });

  it('applies whitespace-only normalization when no formatter is given', async () => {
    const result = await runFormatPipeline({
      text: 'a  \r\nb  ',
      path: 'a.txt',
      languageId: 'plaintext',
      trigger: 'save',
      formatter: null,
      whitespace: { trimTrailingWhitespace: true, insertFinalNewline: true },
    });
    expect(result).toEqual({
      kind: 'changed',
      text: 'a\nb\n',
      formatterFailed: false,
      formatterError: undefined,
    });
  });
});
