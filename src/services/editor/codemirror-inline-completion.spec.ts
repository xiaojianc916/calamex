import { describe, expect, it } from 'vitest';

import { clipInlineContext } from './codemirror-inline-completion';

describe('clipInlineContext', () => {
  it('保留短文本原样', () => {
    expect(clipInlineContext('echo hello', 20)).toBe('echo hello');
  });

  it('只保留尾部指定数量的 Unicode 码点', () => {
    expect(clipInlineContext('abcdef', 3)).toBe('def');
    expect(clipInlineContext('a😊b😊c', 3)).toBe('b😊c');
  });

  it('不会在代理对中间截断 emoji', () => {
    expect(clipInlineContext('ab😊', 1)).toBe('😊');
  });

  it('limit 非正数时返回空串', () => {
    expect(clipInlineContext('abc', 0)).toBe('');
  });
});
