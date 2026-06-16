import { describe, expect, it } from 'vitest';
import { createTerminalOutputBuffer } from '@/utils/terminal/terminal-output-buffer';

describe('terminal output buffer', () => {
  it('合并小 chunk 并保持快照顺序', () => {
    const buffer = createTerminalOutputBuffer({ maxLength: 100, maxChunkLength: 8 });

    buffer.append('ab');
    buffer.append('cd');
    buffer.append('efgh');
    buffer.append('ij');

    expect(buffer.snapshotChunks()).toEqual(['abcdefgh', 'ij']);
    expect(buffer.toString()).toBe('abcdefghij');
    expect(buffer.length).toBe(10);
  });

  it('超过字符预算时从头部均摊裁剪', () => {
    const buffer = createTerminalOutputBuffer({ maxLength: 10, maxChunkLength: 4 });

    buffer.append('1234');
    buffer.append('5678');
    buffer.append('90ab');

    expect(buffer.toString()).toBe('34567890ab');
    expect(buffer.length).toBe(10);
  });

  it('裁剪时不会留下半个 UTF-16 代理对', () => {
    const buffer = createTerminalOutputBuffer({ maxLength: 3, maxChunkLength: 16 });

    buffer.append('a😀b');

    expect(buffer.toString()).toBe('😀b');
    expect(buffer.length).toBe(3);
  });

  it('replaceWithChunks 会重建受限缓冲区', () => {
    const buffer = createTerminalOutputBuffer({ maxLength: 6, maxChunkLength: 3 });

    buffer.append('old');
    buffer.replaceWithChunks(['abc', '', 'def', 'ghi']);

    expect(buffer.toString()).toBe('defghi');
    expect(buffer.snapshotChunks()).toEqual(['def', 'ghi']);
    expect(buffer.length).toBe(6);
  });
});
