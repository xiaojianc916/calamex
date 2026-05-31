import { LanguageSupport } from '@codemirror/language';
import { describe, expect, it } from 'vitest';

import { loadCodeMirrorLanguageSupport } from './codemirror-language';

describe('loadCodeMirrorLanguageSupport', () => {
  it('为 Vue 文件按需加载官方 Vue 语言支持', async () => {
    const support = await loadCodeMirrorLanguageSupport('vue');

    expect(support).toBeInstanceOf(LanguageSupport);
    expect((support as LanguageSupport).language.name).toBe('vue');
  });

  it('为 Shell 文件按需加载 CodeMirror 官方 legacy shell mode', async () => {
    const support = await loadCodeMirrorLanguageSupport('shell');

    expect(support).toBeInstanceOf(LanguageSupport);
  });
});
