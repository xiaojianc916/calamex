import { describe, expect, it } from 'vitest';
import { createHiddenWriteBacklog } from '@/utils/hidden-write-backlog';

const MARKER = '<<omitted>>';

describe('hidden write backlog', () => {
  it('未超预算时原样累积并回灌', () => {
    const backlog = createHiddenWriteBacklog({
      maxChars: 1000,
      maxChunkChars: 64,
      omittedMarker: MARKER,
    });
    expect(backlog.isEmpty).toBe(true);
    backlog.append('hello ');
    backlog.append('world');
    expect(backlog.isEmpty).toBe(false);
    expect(backlog.drain()).toBe('hello world');
    expect(backlog.isEmpty).toBe(true);
  });

  it('超出预算时丢弃头部并补上省略提示', () => {
    const backlog = createHiddenWriteBacklog({
      maxChars: MARKER.length + 6,
      maxChunkChars: 4,
      omittedMarker: MARKER,
    });
    backlog.append('1234');
    backlog.append('5678');
    backlog.append('90');
    const drained = backlog.drain();
    expect(drained.startsWith(MARKER)).toBe(true);
    expect(drained.slice(MARKER.length)).toBe('567890');
  });

  it('裁剪不会劈开 UTF-16 代理对', () => {
    const backlog = createHiddenWriteBacklog({
      maxChars: MARKER.length + 3,
      maxChunkChars: 16,
      omittedMarker: MARKER,
    });
    backlog.append('a😀b');
    expect(backlog.drain()).toBe(`${MARKER}😀b`);
  });

  it('drain / clear 后状态复位', () => {
    const backlog = createHiddenWriteBacklog({
      maxChars: 50,
      maxChunkChars: 8,
      omittedMarker: MARKER,
    });
    backlog.append('abc');
    expect(backlog.drain()).toBe('abc');
    expect(backlog.isEmpty).toBe(true);
    backlog.append('xyz');
    backlog.clear();
    expect(backlog.isEmpty).toBe(true);
    expect(backlog.drain()).toBe('');
  });
});
