import { describe, expect, it } from 'vitest';
import { measureGitCommitHistoryOutput } from './git';

const sampleEntry = () => ({
  id: 'a'.repeat(40),
  shortId: '1234567',
  summary: 'fix: something',
  authorName: 'Jane',
  authorEmail: 'jane@example.com',
  authoredAt: '2026-06-14T10:00:00Z',
  parentIds: ['p1', 'p2'],
  refs: [{ name: 'main', kind: 'branch', isHead: true }],
});

describe('measureGitCommitHistoryOutput', () => {
  it('对非对象输入回退到通用度量并返回数值字节', () => {
    const result = measureGitCommitHistoryOutput(undefined);
    expect(typeof result.bytes).toBe('number');
    expect(result.bytes).toBeGreaterThanOrEqual(0);
  });

  it('空历史只计入固定结构开销', () => {
    expect(
      measureGitCommitHistoryOutput({ entries: [], hasMore: false, nextOffset: null }),
    ).toEqual({ bytes: 32 });
  });

  it('entries 缺失或非数组时视为零条目', () => {
    expect(measureGitCommitHistoryOutput({ hasMore: false })).toEqual({ bytes: 32 });
  });

  it('按已知字段累计单条提交的字节数', () => {
    // 125（标量字段 + 常数 24）+ 20（parentIds）+ 34（refs）+ 32（固定开销）
    expect(measureGitCommitHistoryOutput({ entries: [sampleEntry()] })).toEqual({ bytes: 211 });
  });

  it('条目越多字节线性累加', () => {
    const single = measureGitCommitHistoryOutput({ entries: [sampleEntry()] }).bytes;
    const double = measureGitCommitHistoryOutput({
      entries: [sampleEntry(), sampleEntry()],
    }).bytes;

    expect(double).toBe(single * 2 - 32);
  });

  it('不计入未知字段，度量有界（不做整树序列化）', () => {
    const withHugeUnknown = { ...sampleEntry(), unknownBlob: 'x'.repeat(100_000) };

    expect(measureGitCommitHistoryOutput({ entries: [withHugeUnknown] })).toEqual(
      measureGitCommitHistoryOutput({ entries: [sampleEntry()] }),
    );
  });
});
