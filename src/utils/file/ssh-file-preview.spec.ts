import { describe, expect, it } from 'vitest';
import {
  buildSshPreviewMatchHits,
  countSshPreviewLines,
  estimateSshPreviewByteSize,
  normalizeSshPreviewContent,
  resolveSshPreviewCursorPosition,
} from '@/utils/file/ssh-file-preview';

describe('ssh-file-preview', () => {
  it('为组合字符与 emoji 保留正确的匹配偏移', () => {
    const hits = buildSshPreviewMatchHits('cafe\u0301\n你好🙂abc', 'é');

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      lineIndex: 0,
      start: 3,
      end: 4,
      lineCodeUnitStart: 3,
      lineCodeUnitEnd: 5,
      globalStart: 3,
      globalEnd: 5,
    });
  });

  it('保存大小估算时保留 BOM 与目标换行格式', () => {
    expect(estimateSshPreviewByteSize('a\nb', 'utf-8-bom', 'crlf')).toBe(7);
    expect(estimateSshPreviewByteSize('甲\n乙', 'utf-8', 'lf')).toBe(
      new TextEncoder().encode('甲\n乙').length,
    );
  });

  it('光标位置与行数统计按 grapheme 与混合换行处理', () => {
    const normalized = normalizeSshPreviewContent('第一行\r第二🙂行\r\n第三行');

    expect(normalized).toBe('第一行\n第二🙂行\n第三行');
    expect(countSshPreviewLines(normalized)).toBe(3);
    expect(resolveSshPreviewCursorPosition('第一行\n第二🙂')).toEqual({
      line: 2,
      column: 4,
    });
  });
});
