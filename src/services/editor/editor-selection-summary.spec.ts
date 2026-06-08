import { describe, expect, it } from 'vitest';

import { resolveSelectionLineWindow } from './editor-selection-summary';

describe('resolveSelectionLineWindow', () => {
  it('选区行数在窗口内时原样返回且不截断', () => {
    expect(
      resolveSelectionLineWindow({ startLine: 10, endLine: 20, currentLine: 15, contextLines: 60 }),
    ).toEqual({ startLine: 10, endLine: 20, truncated: false });
  });

  it('超出窗口时以当前行为中心截断', () => {
    expect(
      resolveSelectionLineWindow({
        startLine: 1,
        endLine: 1_000,
        currentLine: 500,
        contextLines: 60,
      }),
    ).toEqual({ startLine: 440, endLine: 560, truncated: true });
  });

  it('当前行靠近选区起点时把多余额度补到下方', () => {
    expect(
      resolveSelectionLineWindow({
        startLine: 1,
        endLine: 1_000,
        currentLine: 1,
        contextLines: 60,
      }),
    ).toEqual({ startLine: 1, endLine: 121, truncated: true });
  });

  it('当前行靠近选区终点时把多余额度补到上方', () => {
    expect(
      resolveSelectionLineWindow({
        startLine: 1,
        endLine: 1_000,
        currentLine: 1_000,
        contextLines: 60,
      }),
    ).toEqual({ startLine: 880, endLine: 1_000, truncated: true });
  });
});
