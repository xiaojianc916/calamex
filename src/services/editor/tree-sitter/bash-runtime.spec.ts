import { describe, expect, it } from 'vitest';

import { byteOffsetToCharIndex, getUtf8ByteLength, utf8ByteLengthOfRange } from './bash-runtime';

describe('getUtf8ByteLength', () => {
  it('按 UTF-8 规则统计字节数', () => {
    expect(getUtf8ByteLength('abc')).toBe(3);
    expect(getUtf8ByteLength('é')).toBe(2);
    expect(getUtf8ByteLength('中')).toBe(3);
    expect(getUtf8ByteLength('😀')).toBe(4);
    expect(getUtf8ByteLength('a中b')).toBe(5);
  });
});

describe('utf8ByteLengthOfRange', () => {
  it('只统计指定区间的字节长度', () => {
    const source = 'a中b';
    expect(utf8ByteLengthOfRange(source, 0, 1)).toBe(1);
    expect(utf8ByteLengthOfRange(source, 1, 2)).toBe(3);
    expect(utf8ByteLengthOfRange(source, 0, source.length)).toBe(5);
  });
});

describe('byteOffsetToCharIndex', () => {
  it('与 getUtf8ByteLength 互为逆运算(字符边界处)', () => {
    const source = 'a中b😀c';
    for (let charIndex = 0; charIndex <= source.length; charIndex += 1) {
      const byteOffset = utf8ByteLengthOfRange(source, 0, charIndex);
      expect(byteOffsetToCharIndex(source, byteOffset)).toBe(charIndex);
    }
  });

  it('字节偏移落在多字节字符中间时向上取整到字符边界', () => {
    const source = 'a中b';
    // '中' 占第 1..4 字节;落在其内部的字节偏移应返回其后的字符下标 2。
    expect(byteOffsetToCharIndex(source, 2)).toBe(2);
    expect(byteOffsetToCharIndex(source, 3)).toBe(2);
  });
});
